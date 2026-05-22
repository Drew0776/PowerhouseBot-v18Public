/**
 * Task #61 — Automated tests for the auto-trader's graduated daily-loss
 * circuit breaker (server/auto-trader.ts:checkCircuitBreaker /
 * evaluateCircuitBreaker / dailyStart).
 *
 * Coverage:
 *   1. Tier 1 (portfolio ≥ $500): 3% drawdown trips.
 *   2. Tier 2 ($200 ≤ portfolio < $500): 5% drawdown trips, 4% does not.
 *   3. Tier 3 (portfolio < $200): 8% drawdown (DAILY_DD_LIMIT) trips.
 *   4. Hard floor: portfolio ≤ $50 trips regardless of drawdown size.
 *   5. Recovery: breaker resets once portfolio recovers above its tier limit.
 *   6. While the breaker is active, autoTraderTick() enters no new positions
 *      (scanForBreakouts / enterTrade gated by state.circuitBreakerActive).
 *   7. ET-midnight dateKey rollover re-baselines dailyStart.value, so a fresh
 *      day starts measuring drawdown from the new opening value.
 *
 * Run: npm test  (or  npx tsx --test server/__tests__/auto-trader-breaker.test.ts)
 *
 * Like grid-breaker.test.ts, this isolates DATA_DB_PATH so the dev DB is
 * untouched, and stubs storage.getPortfolio to drive the breaker's inputs
 * deterministically without running real trading logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Isolate the test DB BEFORE storage.ts loads.
const TEST_DB = path.join(os.tmpdir(), `auto-trader-breaker-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TEST_DB + ext); } catch { /* nothing to clean */ }
}
process.env.DATA_DB_PATH = TEST_DB;

// Task #65: ensure startAutoTrader()'s call to startAlpacaFeed() is a no-op
// (the feed early-returns when these creds are absent), so the test never
// touches the network or opens a WebSocket.
delete process.env.ALPACA_KEY_ID;
delete process.env.ALPACA_SECRET_KEY;

// Task #65: server/auto-trader.ts uses a bare `require("./storage")` inside
// persistState() / restoreState() for sync access to the shared sqlite
// handle. Under tsx-ESM (how this test file runs), `require` is not in
// scope and the call throws ReferenceError, which is swallowed by the
// surrounding try/catch — meaning restoreState() silently does nothing and
// the Task #64 same-day-anchor branch can never be reached from a test.
// Install a real CJS require so restoreState() actually loads our seeded
// engine_state row. Production runs via the bundled build where `require`
// is defined; this only patches the dev/test runtime.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Anchor the polyfilled require at server/auto-trader.ts so its
// `require("./storage")` resolves to server/storage.ts (not relative to
// this test file, which would yield server/__tests__/storage and ENOENT).
const _autoTraderPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "auto-trader.ts");
(globalThis as any).require = createRequire(_autoTraderPath);

const storageMod    = await import("../storage.js");
const autoTraderMod = await import("../auto-trader.js");

const { storage, sqlite } = storageMod;
const {
  evaluateCircuitBreaker,
  isCircuitBreakerActive,
  resetCircuitBreaker,
  resetAutoTraderState,
  autoTraderTick,
  getAutoTraderState,
  startAutoTrader,
  stopAutoTrader,
} = autoTraderMod;

const ORIG_getPortfolio = storage.getPortfolio.bind(storage);

/** Minimal PortfolioSummary stub — only totalValue matters for the breaker. */
function fakePortfolio(totalValue: number) {
  return {
    totalValue,
    cash: totalValue,
    investedValue: 0,
    dayPnl: 0,
    dayPnlPercent: 0,
    totalPnl: 0,
    totalPnlPercent: 0,
    winRate: 0,
    openPositions: 0,
    riskScore: 0,
    positions: [],
  } as any;
}

/**
 * Seed dailyStart deterministically:
 *   1. resetAutoTraderState() zeroes state.totalTicks AND clears
 *      state.circuitBreakerActive.
 *   2. resetCircuitBreaker() then sets dailyStart.tick = state.totalTicks
 *      (= 0), which makes the very next evaluateCircuitBreaker() treat the
 *      situation as "uninitialised" and re-baseline dailyStart.value from
 *      the currently stubbed portfolio. After that call, dailyStart.tick
 *      is bumped to ≥ 1 so subsequent calls run the drawdown math instead
 *      of re-baselining.
 */
function seedDailyStart(value: number) {
  resetAutoTraderState();
  storage.getPortfolio = () => fakePortfolio(value);
  resetCircuitBreaker();          // dailyStart.tick ← 0
  evaluateCircuitBreaker();       // dailyStart.value ← value, dailyStart.tick ← 1
  assert.equal(isCircuitBreakerActive(), false, "seed must leave breaker inactive");
}

before(() => { /* nothing to do — DB is isolated via DATA_DB_PATH */ });

beforeEach(() => {
  storage.getPortfolio = ORIG_getPortfolio;
  resetAutoTraderState();
});

afterEach(() => {
  storage.getPortfolio = ORIG_getPortfolio;
});

after(() => {
  storage.getPortfolio = ORIG_getPortfolio;
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ }
  }
});

// ── Tier 1: portfolio ≥ $500 → 3% drawdown limit ─────────────────────────────
test("tier 1 (≥$500): 3% drawdown trips, <3% does not", () => {
  // Just under 3% — must NOT trip.
  seedDailyStart(1000);
  storage.getPortfolio = () => fakePortfolio(975); // 2.5% dd
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "2.5% drawdown below tier-1 3% limit must not trip");

  // Cross the threshold — must trip at the first qualifying tick.
  storage.getPortfolio = () => fakePortfolio(960); // 4% dd, totalValue still ≥ $500
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "4% drawdown ≥ tier-1 3% limit must trip");
});

// ── Tier 2: $200 ≤ portfolio < $500 → 5% drawdown limit ──────────────────────
test("tier 2 ($200–$500): 5% drawdown trips, 4% does not", () => {
  seedDailyStart(300);

  storage.getPortfolio = () => fakePortfolio(288); // 4% dd → below 5% limit
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "4% drawdown below tier-2 5% limit must not trip");

  storage.getPortfolio = () => fakePortfolio(282); // 6% dd → above 5% limit, totalValue still ≥ $200
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "6% drawdown ≥ tier-2 5% limit must trip");
});

// ── Tier 3: portfolio < $200 → 8% drawdown limit (DAILY_DD_LIMIT) ────────────
test("tier 3 (<$200): 8% drawdown trips, 7% does not", () => {
  seedDailyStart(100);

  storage.getPortfolio = () => fakePortfolio(93); // 7% dd → below 8% limit
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "7% drawdown below tier-3 8% limit must not trip");

  storage.getPortfolio = () => fakePortfolio(90); // 10% dd → above 8% limit
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "10% drawdown ≥ tier-3 8% limit must trip");
});

// ── Hard floor: portfolio ≤ $50 always trips, no drawdown calc needed ────────
test("hard floor $50: trips regardless of drawdown size", () => {
  // Baseline at $200 — a drop to $40 is only a 80% drawdown vs baseline, but
  // the hard floor branch must trip the instant totalValue ≤ $50, even if
  // dailyStart were never high enough for the percentage rules to matter.
  seedDailyStart(200);
  storage.getPortfolio = () => fakePortfolio(40);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "$40 ≤ $50 hard-floor must trip the breaker");
});

// ── Recovery resets the breaker ──────────────────────────────────────────────
test("breaker resets when portfolio recovers above its tier limit", () => {
  seedDailyStart(1000);

  // Trip: 4% drawdown at tier 1 (3% limit).
  storage.getPortfolio = () => fakePortfolio(960);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "precondition: breaker is tripped");

  // Recover above baseline → dd ≤ 0, totalValue > $50 → breaker must reset.
  storage.getPortfolio = () => fakePortfolio(1000);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "breaker must reset after recovery");

  // Re-trip works after a reset (no latched state).
  storage.getPortfolio = () => fakePortfolio(960);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "breaker must be re-armable after reset");
});

// ── autoTraderTick: no new positions while breaker active ────────────────────
//
// Task #62 — This test must first PROVE that under the controlled conditions
// at least one autoTraderTick() call would have produced an entry with the
// breaker INACTIVE, then trip the breaker and prove that the same conditions
// yield no entries. Without the control phase, the "no entry while active"
// assertion could pass simply because the seeded scanner produced no signal
// for unrelated reasons — masking a real regression in the entry gate.
test("autoTraderTick enters no new positions while breaker is active (control: would have entered)", () => {
  seedDailyStart(1000);

  // Keep cash plentiful so an entry isn't blocked by the cash check.
  storage.getPortfolio = () => fakePortfolio(1000);

  const startState = getAutoTraderState();
  assert.equal(startState.openPositions.length, 0, "precondition: no open positions");

  // ── Phase A (control): breaker INACTIVE — at least one entry MUST fire.
  //
  // The default-seeded scanner needs ~25 ticks of price/MTF history before
  // the freshness + cooldown gates align with a passing composite signal
  // (verified empirically: first entry around tick 25 with these seeds).
  // We give it a generous 60-tick budget and require at least one entry.
  // If this assertion fails, the gated-path assertion below would be
  // meaningless — the engine wasn't going to enter anyway.
  let controlEntries = 0;
  for (let i = 0; i < 60; i++) {
    assert.equal(isCircuitBreakerActive(), false, `control tick ${i}: breaker must stay inactive`);
    const r = autoTraderTick();
    if (r.entered) controlEntries++;
  }
  assert.ok(
    controlEntries > 0,
    "control: at least one entry MUST fire with breaker INACTIVE — otherwise the no-entry-while-active assertion proves nothing",
  );
  const openAfterControl = getAutoTraderState().openPositions.length;
  assert.ok(
    openAfterControl > 0,
    "control: state.openPositions must reflect at least one filled entry",
  );

  // ── Phase B: trip the breaker, then re-run ticks under the SAME conditions.
  //
  // The portfolio drops to $800 vs the $1000 dailyStart baseline — a 20%
  // drawdown, well above the tier-1 3% limit. checkCircuitBreaker() runs
  // at the top of every autoTraderTick() and will keep the breaker active
  // as long as totalValue stays at $800.
  storage.getPortfolio = () => fakePortfolio(800);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "precondition: breaker tripped");

  const openBeforeGated = getAutoTraderState().openPositions.length;

  // Drive several full ticks. scanForBreakouts may still run, but the
  // `!state.circuitBreakerActive` guards around the entry loop in
  // autoTraderTick() and at the top of enterTrade() / fillPendingEntry()
  // must prevent ANY new entry. Pre-existing open positions will be force-
  // exited by managePositions() (circuit_breaker priority-1 exit), so we
  // track NEW entries via r.entered and via the openPositions count not
  // exceeding the count at the start of Phase B.
  let gatedEntries = 0;
  let maxOpenSeenInB = openBeforeGated;
  for (let i = 0; i < 20; i++) {
    const r = autoTraderTick();
    if (r.entered) gatedEntries++;
    maxOpenSeenInB = Math.max(maxOpenSeenInB, getAutoTraderState().openPositions.length);
    assert.equal(r.entered, null, `gated tick ${i}: no entry while breaker active`);
    assert.equal(
      isCircuitBreakerActive(),
      true,
      `gated tick ${i}: breaker must remain active while portfolio has not recovered`,
    );
  }
  assert.equal(gatedEntries, 0, "no new entries may fire while the breaker is active");
  assert.ok(
    maxOpenSeenInB <= openBeforeGated,
    `openPositions must not grow while breaker is active (saw ${maxOpenSeenInB}, started at ${openBeforeGated})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #63 — Boundary-precision tests
//
// The tier-1/2/3 tests above use drawdowns safely above each limit. The cases
// below pin the EXACT thresholds in server/auto-trader.ts:checkCircuitBreaker
// (~line 1093–1106), so a strict `>` ↔ `>=` flip in either the drawdown
// comparison or the tier selector would now fail loudly instead of slipping
// through. Each assertion cites the line of intent it locks down.
// ─────────────────────────────────────────────────────────────────────────────

// ── Exact-drawdown thresholds (`dd >= limit`) ────────────────────────────────
// Pins line 1100: `} else if (dd >= limit && !state.circuitBreakerActive) {`
test("dd === 0.03 (exactly the tier-1 limit) trips because the comparison is >=", () => {
  // dailyStart=1000, portfolio=970 → dd = 30/1000 = 0.03 exactly.
  // totalValue=970 ≥ 500 selects the 3% tier (line 1096).
  seedDailyStart(1000);
  storage.getPortfolio = () => fakePortfolio(970);
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "dd === 0.03 must trip the tier-1 3% limit (>=, not >). If this fails, line 1100 was flipped to `>`.",
  );
});

test("dd === 0.05 (exactly the tier-2 limit) trips because the comparison is >=", () => {
  // dailyStart=400, portfolio=380 → dd = 20/400 = 0.05 exactly.
  // totalValue=380 is in [200, 500) → 5% tier (line 1096).
  seedDailyStart(400);
  storage.getPortfolio = () => fakePortfolio(380);
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "dd === 0.05 must trip the tier-2 5% limit. If this fails, line 1100 was flipped to `>`.",
  );
});

test("dd === 0.08 (exactly the tier-3 DAILY_DD_LIMIT) trips because the comparison is >=", () => {
  // dailyStart=100, portfolio=92 → dd = 8/100 = 0.08 exactly.
  // totalValue=92 < 200 → DAILY_DD_LIMIT (0.08) tier (line 1096).
  // 92 > 50 keeps us out of the hard-floor branch at line 1097.
  seedDailyStart(100);
  storage.getPortfolio = () => fakePortfolio(92);
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "dd === 0.08 must trip the tier-3 8% (DAILY_DD_LIMIT) limit. If this fails, line 1100 was flipped to `>`.",
  );
});

// ── Tier-selector boundaries (`tierAnchor >= 500`, `tierAnchor >= 200`, `<= 50`) ─
// Task #64 changed tier selection to anchor on dailyStart.value, not on the
// per-tick portfolio value (server/auto-trader.ts:checkCircuitBreaker line
// 1106). The cutoff tests therefore drive the BOUNDARY through dailyStart,
// not through the current portfolio. The hard-floor branch still uses
// p.totalValue (it's a real-dollar liquidation safety net, line 1107).

test("dailyStart === $500 selects tier 1 (3% limit), $499 selects tier 2 (5% limit)", () => {
  // Drawdown ≈ 4% — above tier-1's 3% limit, below tier-2's 5% limit. The
  // only way the assertions flip is if the tier SELECTOR moves.

  // Anchor at exactly $500 → tier 1 (limit 3%); 4% dd trips.
  seedDailyStart(500);
  storage.getPortfolio = () => fakePortfolio(500 * 0.96); // dd = 0.04 exactly
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "dailyStart $500 must select tier 1 (>=500 in line 1106); 4% dd ≥ 3% trips. If this fails, `>= 500` was flipped to `> 500`.",
  );

  // Anchor at $499 (one cent below) → tier 2 (limit 5%); same dd does NOT trip.
  seedDailyStart(499);
  storage.getPortfolio = () => fakePortfolio(499 * 0.96); // dd = 0.04 exactly
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    false,
    "dailyStart $499 must select tier 2 (5% limit); 4% dd is below 5% and must NOT trip.",
  );
});

test("dailyStart === $200 selects tier 2 (5% limit), $199 selects tier 3 (8% limit)", () => {
  // Drawdown ≈ 6% — above tier-2's 5% limit, below tier-3's 8% limit.

  seedDailyStart(200);
  storage.getPortfolio = () => fakePortfolio(200 * 0.94); // dd = 0.06 exactly
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "dailyStart $200 must select tier 2 (>=200 in line 1106); 6% dd ≥ 5% trips. If this fails, `>= 200` was flipped to `> 200`.",
  );

  seedDailyStart(199);
  storage.getPortfolio = () => fakePortfolio(199 * 0.94); // dd = 0.06 exactly
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    false,
    "dailyStart $199 must select tier 3 (8% limit); 6% dd is below 8% and must NOT trip.",
  );
});

// ── Task #64 — Tier no longer flips when the portfolio jitters across $500/$200 ─
// Before #64, the tier was picked from the CURRENT portfolio every tick, so a
// portfolio bouncing 501 ↔ 499 silently toggled between the 3% and 5% limits
// tick-to-tick. After #64, the tier is anchored to dailyStart.value, so the
// limit is stable for the whole session.

test("$500 boundary: portfolio oscillating across $500 keeps the same tier and trips identically", () => {
  // Anchor above $500 so the session is locked to tier 1 (3% limit). Drive
  // drawdowns at ~3.65% (portfolio $501) and ~4.04% (portfolio $499). Both
  // are above tier 1's 3% limit, so BOTH must trip. Under the old per-tick
  // selector, only $501 would have tripped — $499 would have switched to
  // tier 2 (5% limit) and slipped past at 4.04% dd.
  seedDailyStart(520);

  storage.getPortfolio = () => fakePortfolio(501); // dd ≈ 3.65%
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "portfolio $501 must trip at the tier-1 3% limit anchored by dailyStart $520",
  );

  // Recover so the breaker resets, then probe at $499.
  storage.getPortfolio = () => fakePortfolio(520);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "precondition: breaker reset before second probe");

  storage.getPortfolio = () => fakePortfolio(499); // dd ≈ 4.04%
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "portfolio $499 must ALSO trip — tier stays anchored to dailyStart, not the jittery current value. Under the pre-#64 selector this would have silently flipped to tier 2 (5% limit) and not tripped.",
  );
});

test("$200 boundary: portfolio oscillating across $200 keeps the same tier and trips identically", () => {
  // Anchor above $200 so the session is locked to tier 2 (5% limit). Drive
  // drawdowns at ~5.24% (portfolio $200) and ~5.71% (portfolio $199). Both
  // are above tier 2's 5% limit, so BOTH must trip. Under the old per-tick
  // selector, $199 would have switched to tier 3 (8% limit) and slipped
  // past at 5.71% dd.
  seedDailyStart(211);

  storage.getPortfolio = () => fakePortfolio(200); // dd ≈ 5.21%
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "portfolio $200 must trip at the tier-2 5% limit anchored by dailyStart $211",
  );

  storage.getPortfolio = () => fakePortfolio(211);
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), false, "precondition: breaker reset before second probe");

  storage.getPortfolio = () => fakePortfolio(199); // dd ≈ 5.69%
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "portfolio $199 must ALSO trip — tier stays anchored to dailyStart. Under the pre-#64 selector this would have silently flipped to tier 3 (8% limit) and not tripped.",
  );
});

test("totalValue === $50 hits the hard floor, $51 does not", () => {
  // Hard-floor branch fires regardless of dd, so use a baseline where dd is
  // small enough that the dd-comparison branch alone would not trip. Then a
  // shift from $51 → $50 isolates the `<= 50` check itself.
  seedDailyStart(52);

  // $51 → above the hard floor; dd = 1/52 ≈ 1.92%, below tier-3's 8% limit.
  storage.getPortfolio = () => fakePortfolio(51);
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    false,
    "$51 is above the $50 hard floor and ~1.9% dd is below the tier-3 8% limit; must NOT trip.",
  );

  // $50 → exactly the hard floor (<= 50 in line 1097); must trip.
  storage.getPortfolio = () => fakePortfolio(50);
  evaluateCircuitBreaker();
  assert.equal(
    isCircuitBreakerActive(),
    true,
    "$50 must hit the hard floor (<=50 in line 1097). If this fails, `<= 50` was flipped to `< 50`.",
  );
});

// ── ET-midnight dateKey rollover re-baselines dailyStart ─────────────────────
test("ET-midnight rollover re-baselines dailyStart so the new day starts at 0% dd", () => {
  // Day N: trip the breaker.
  seedDailyStart(1000);
  storage.getPortfolio = () => fakePortfolio(960); // 4% dd → trips tier 1
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "precondition: breaker tripped on day N");

  // Roll the ET clock forward by +1 day. evaluateCircuitBreaker derives the
  // day key from `new Date().toLocaleString("en-US", { timeZone: ... })`, so
  // patching Date.prototype.toLocaleString is enough to simulate midnight ET.
  const origToLocale = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function patched(this: Date, ...args: any[]) {
    const out = origToLocale.apply(this, args as any);
    if (typeof out !== "string") return out;
    // Only shift the ET-zoned call the breaker makes. Everything else
    // (timestamps in logs, etc.) is left untouched to avoid disturbing
    // unrelated code paths.
    const looksLikeBreakerCall =
      args[0] === "en-US" &&
      args[1] &&
      typeof args[1] === "object" &&
      (args[1] as Intl.DateTimeFormatOptions).timeZone === "America/New_York";
    if (!looksLikeBreakerCall) return out;
    const d = new Date(out);
    d.setDate(d.getDate() + 1);
    return d.toLocaleString("en-US");
  } as typeof Date.prototype.toLocaleString;

  try {
    // Portfolio is unchanged at $960, but it is now a NEW DAY. The rollover
    // path must re-baseline dailyStart.value to the current $960 (so the new
    // day's drawdown is 0%) and let the breaker reset because dd < limit.
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      false,
      "after ET midnight, dailyStart must re-baseline so today's dd is 0% and the breaker resets",
    );

    // To prove the baseline was actually moved to $960 (not still $1000):
    // a 2% drop from $960 ($940.80) is well under the tier-1 3% limit and
    // therefore MUST NOT trip. If dailyStart still pointed at $1000, $940
    // would be a 6% dd and WOULD trip — so a non-trip here is the proof.
    storage.getPortfolio = () => fakePortfolio(940);
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      false,
      "$940 is ~2% below the new $960 baseline and must not trip the tier-1 3% limit",
    );
  } finally {
    Date.prototype.toLocaleString = origToLocale;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #65 — Prove the daily-loss limit survives a server restart on the same
// ET day. Task #64 made startAutoTrader() preserve the day's anchor across
// same-day restarts (server/auto-trader.ts ~line 1470–1486), but no automated
// test drove the full restart path end-to-end. These two variants do:
//
//   1. Same-day restart: persist a dailyStart for today's ET dateKey, call
//      startAutoTrader(), and prove the anchor is unchanged (so a trader
//      already 4% down from a $520 start doesn't silently lose tier-1
//      protection on a process restart).
//   2. New-day restart: roll the ET dateKey forward by one day across the
//      startAutoTrader() call and prove the anchor IS re-baselined to the
//      current portfolio (so a fresh trading day starts at 0% dd).
//
// Both variants stub Alpaca-feed creds away (top-of-file) so startAlpacaFeed()
// early-returns without network, and call stopAutoTrader() in finally{} to
// clear the 2 s tick + 5 min equity-snapshot intervals.
// ─────────────────────────────────────────────────────────────────────────────

/** Build today's ET dateKey in the exact format the breaker uses. */
function todayETKey(): string {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
}

/**
 * Write a persisted engine_state row that restoreState() will load on the
 * next startAutoTrader() call. Mirrors the payload shape in
 * server/auto-trader.ts:persistState() so all the `?? 0` fallbacks in
 * restoreState() get satisfied and dailyStart.tick > 0 (the precondition
 * for `sameDayAnchorRestored` at line 1478).
 */
function seedPersistedDailyStart(value: number, dateKey: string, totalTicks = 5) {
  const payload = {
    isRunning: false,
    totalTicks,
    totalTrades: 0,
    closedTrades: 0,
    winRate: 0,
    totalPnl: 0,
    dailyPnl: 0,
    totalSlippageCost: 0,
    roiPct: 0,
    wins: 0, losses: 0, totalWinAmt: 0, totalLossAmt: 0,
    pnlHistory: [],
    dailyStartValue: value,
    dailyStartTick: totalTicks,
    dailyStartDateKey: dateKey,
    openPositions: [],
  };
  sqlite
    .prepare(`INSERT OR REPLACE INTO engine_state (id, state_json, updated_at) VALUES (1, ?, ?)`)
    .run(JSON.stringify(payload), new Date().toISOString());
}

test("Task #65 — same-day restart: startAutoTrader preserves dailyStart anchor; tier-1 breaker still trips at the original limit", () => {
  // Persist a $520 anchor for TODAY (ET). This simulates a trader who
  // started the day at $520 and is now restarting the server while still
  // mid-session — they must keep tier 1 (3% limit) because dailyStart $520
  // ≥ 500. resetAutoTraderState() in beforeEach cleared engine_state, so
  // seeding here is a clean write.
  const todayKey = todayETKey();
  seedPersistedDailyStart(520, todayKey);

  // Portfolio at restart is $499 — a 4.04% drawdown vs the $520 anchor.
  // This is ABOVE tier 1's 3% limit (anchor ≥ $500 → tier 1) but BELOW
  // tier 2's 5% limit. If startAutoTrader() silently re-baselined the
  // anchor to $499, the new dd would be 0% AND the new tier would be
  // tier 2 (anchor < $500), and the breaker would not trip — the
  // exact regression Task #64 fixed.
  storage.getPortfolio = () => fakePortfolio(499);

  startAutoTrader();
  try {
    // Sanity: restoreState() must have run end-to-end. If `require("./storage")`
    // ever silently fails again (e.g. the top-of-file polyfill is removed),
    // state.totalTicks would stay at 0 and the breaker assertion below would
    // pass for the wrong reason (dailyStart left at the default $100 baseline).
    assert.ok(
      getAutoTraderState().totalTicks > 0,
      "restoreState() must have loaded the persisted row (totalTicks > 0); otherwise the same-day-anchor branch was never reached and this test proves nothing",
    );
    // Behavioural proof that dailyStart.value is unchanged: evaluate the
    // breaker under the same $499 portfolio and require it to trip. This
    // can only happen if the anchor is still $520 AND the tier is still
    // tier 1 (3% limit). A re-baseline would silently disarm both.
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      true,
      "same-day restart: $499 portfolio must trip tier-1 3% limit because dailyStart stays at $520. If this fails, startAutoTrader() silently re-baselined the anchor and tier-1 protection was lost across the restart.",
    );
  } finally {
    stopAutoTrader();
  }
});

test("Task #65 — new-day restart: startAutoTrader DOES re-baseline dailyStart when ET dateKey has rolled forward", () => {
  // Persist a $520 anchor for TODAY, then patch Date so the ET-zoned call
  // inside startAutoTrader (line 1476) returns TOMORROW. restoreState()
  // still loads dateKey=today, but the comparison `dailyStart.dateKey ===
  // todayKey` is now false → re-baseline branch (line 1482) must fire.
  const todayKey = todayETKey();
  seedPersistedDailyStart(520, todayKey);

  storage.getPortfolio = () => fakePortfolio(499);

  const origToLocale = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function patched(this: Date, ...args: any[]) {
    const out = origToLocale.apply(this, args as any);
    if (typeof out !== "string") return out;
    // Only shift the ET-zoned breaker call. Inner Date(out).toLocaleString("en-US")
    // (no options object) is left untouched so the parsed shifted date is
    // formatted normally.
    const looksLikeBreakerCall =
      args[0] === "en-US" &&
      args[1] &&
      typeof args[1] === "object" &&
      (args[1] as Intl.DateTimeFormatOptions).timeZone === "America/New_York";
    if (!looksLikeBreakerCall) return out;
    const d = new Date(out);
    d.setDate(d.getDate() + 1);
    return d.toLocaleString("en-US");
  } as typeof Date.prototype.toLocaleString;

  try {
    startAutoTrader();
    assert.ok(
      getAutoTraderState().totalTicks > 0,
      "restoreState() must have loaded the persisted row (totalTicks > 0); otherwise the re-baseline branch was never reached",
    );

    // Re-baselined: dailyStart.value should now equal the current $499
    // portfolio, so today starts at 0% dd and the breaker must NOT trip.
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      false,
      "new-day restart: dd must be 0% because dailyStart was re-baselined to today's opening $499 portfolio",
    );

    // Prove the baseline actually moved to $499 (not still $520). With
    // anchor $499 we are in tier 2 (anchor < $500 → 5% limit). A $469
    // portfolio is a 6.01% drawdown and MUST trip tier 2. Under the old
    // (non-rolled) $520 anchor, $469 would be a 9.8% dd in tier 1
    // (3% limit) and would also trip — so to disambiguate we ALSO check
    // a tier-2-only case below.
    storage.getPortfolio = () => fakePortfolio(469);
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      true,
      "after re-baseline to $499, a 6% drawdown ($469) must trip tier-2's 5% limit",
    );

    // Tier-2-only disambiguation: reset and probe $474 (5.01% dd vs $499
    // anchor → trips tier-2 5%). Under the OLD $520 anchor this would be
    // 8.85% dd in tier 1 (3% limit) and would also trip — so we instead
    // use $475 (4.81% dd vs $499 anchor) which must NOT trip tier 2's
    // 5% limit. Under the OLD $520 anchor $475 would be 8.65% dd in
    // tier 1 (3% limit) and WOULD trip. So a non-trip here uniquely
    // proves the new $499 anchor is in effect.
    storage.getPortfolio = () => fakePortfolio(499);
    evaluateCircuitBreaker();
    assert.equal(isCircuitBreakerActive(), false, "precondition: breaker reset after recovery to $499");

    storage.getPortfolio = () => fakePortfolio(475);
    evaluateCircuitBreaker();
    assert.equal(
      isCircuitBreakerActive(),
      false,
      "$475 is 4.81% dd vs the new $499 anchor (below tier-2 5%) and must NOT trip. Under the pre-restart $520 anchor, $475 would be 8.65% dd in tier 1 (3% limit) and WOULD trip — so a non-trip here proves the anchor was re-baselined.",
    );
  } finally {
    Date.prototype.toLocaleString = origToLocale;
    stopAutoTrader();
  }
});
