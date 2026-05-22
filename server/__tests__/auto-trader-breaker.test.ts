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
test("autoTraderTick enters no new positions while breaker is active", () => {
  seedDailyStart(1000);

  // Trip the breaker.
  storage.getPortfolio = () => fakePortfolio(800); // 20% dd
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "precondition: breaker tripped");

  const before = getAutoTraderState();
  assert.equal(before.openPositions.length, 0, "precondition: no open positions");

  // Drive several full ticks. Because state.circuitBreakerActive gates
  // enterTrade() and the entry block in autoTraderTick(), scanForBreakouts
  // may still run but must not yield any new positions.
  for (let i = 0; i < 5; i++) {
    const r = autoTraderTick();
    assert.equal(r.entered, null, `tick ${i}: no entry while breaker active`);
  }

  const after = getAutoTraderState();
  assert.equal(after.openPositions.length, 0, "openPositions must stay empty while breaker is active");
  assert.equal(isCircuitBreakerActive(), true, "breaker must remain active when portfolio has not recovered");
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
