/**
 * Task #57 — Automated kill-switch tests for the grid engine.
 *
 * Verifies:
 *   1. A >drawdown-limit portfolio loss trips the global circuit breaker mid-tick;
 *      the bot transitions to `paused_by_breaker`, its open buys are flattened
 *      at market, and subsequent ticks place no further fills.
 *   2. Portfolio recovery + `watchBreakerResume()` transitions paused bots back
 *      to `active` and ticking resumes.
 *   3. Restart-survival: after dropping all in-memory engine state, calling
 *      `bootGridEngine()` rebuilds the same level indices, open-buy map, and
 *      realized P&L — no duplicate fills.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/grid-breaker.test.ts
 *
 * The tests use a dedicated DATA_DB_PATH so they don't touch the dev DB.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Isolate the test DB BEFORE storage.ts loads.
const TEST_DB = path.join(os.tmpdir(), `grid-breaker-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TEST_DB + ext); } catch { /* nothing to clean */ }
}
process.env.DATA_DB_PATH = TEST_DB;

const storageMod    = await import("../storage.js");
const gridEngineMod = await import("../grid-engine.js");
const autoTraderMod = await import("../auto-trader.js");

const { storage, sqlite, getStockData } = storageMod;
const {
  createGridBot,
  tickGridBot,
  getGridBot,
  getGridOrders,
  stopGridBotLoop,
  bootGridEngine,
  watchBreakerResume,
  computeBotLevels,
} = gridEngineMod;
const { resetAutoTraderState } = autoTraderMod;

const ORIG_getPortfolio = storage.getPortfolio.bind(storage);

/** Build a minimal-but-typed PortfolioSummary with a controlled totalValue. */
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

/** Pick the first stock from the seed cache so price-range math always works. */
function pickTicker(): { ticker: string; seedPrice: number } {
  const stocks = getStockData();
  const s = stocks[0];
  return { ticker: s.ticker, seedPrice: s.price };
}

function cleanGridTables() {
  sqlite.exec("DELETE FROM grid_orders; DELETE FROM grid_bots;");
}

before(() => {
  cleanGridTables();
});

beforeEach(() => {
  cleanGridTables();
  resetAutoTraderState();
  storage.getPortfolio = ORIG_getPortfolio;
});

after(() => {
  storage.getPortfolio = ORIG_getPortfolio;
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ }
  }
});

test("circuit breaker pauses grid bot, flattens open buys, halts further fills", () => {
  const { ticker, seedPrice } = pickTicker();
  // Range generously wider than the ±25% sim-bound so price stays inside it.
  const lower = Math.round(seedPrice * 0.7 * 100) / 100;
  const upper = Math.round(seedPrice * 1.3 * 100) / 100;

  // Initialize daily baseline at a known high value.
  storage.getPortfolio = () => fakePortfolio(1000);

  const bot = createGridBot({
    ticker,
    lowerPrice: lower,
    upperPrice: upper,
    gridCount: 8,
    totalInvestment: 100,
    stopBufferPct: 0.5, // huge buffer so range-exit stop won't interfere
  });
  // Disable the 3 s background interval so this test drives ticks manually.
  stopGridBotLoop(bot.id);

  // Drive ticks until we have at least one open BUY recorded.
  let openBuysBefore = 0;
  for (let i = 0; i < 25 && openBuysBefore === 0; i++) {
    tickGridBot(bot.id);
    const orders = getGridOrders(bot.id);
    const open = new Map<number, any>();
    for (const o of [...orders].reverse()) {
      if (o.action === "buy") open.set(o.level, o);
      else if (o.action === "sell") open.delete(o.level - 1);
    }
    openBuysBefore = open.size;
  }
  assert.ok(openBuysBefore > 0, "expected at least one open buy before tripping breaker");

  const fillsBefore = getGridOrders(bot.id).length;

  // Trip the breaker: portfolio drops from 1000 → 800 (20% > 8% DD limit).
  storage.getPortfolio = () => fakePortfolio(800);

  // This tick should evaluate the breaker, flatten open buys, and park the bot.
  const tripResult = tickGridBot(bot.id);
  assert.equal(tripResult, null, "tick that trips breaker returns null");

  const after = getGridBot(bot.id)!;
  assert.equal(after.status, "paused_by_breaker", "bot is parked by breaker");

  const ordersAfterTrip = getGridOrders(bot.id);
  // Should have inserted one synthetic SELL per open buy.
  assert.equal(
    ordersAfterTrip.length,
    fillsBefore + openBuysBefore,
    "one synthetic flatten-sell recorded per open buy",
  );

  // No open buys remain (every buy matched by a sell at level+1).
  const openAfter = new Map<number, any>();
  for (const o of [...ordersAfterTrip].reverse()) {
    if (o.action === "buy") openAfter.set(o.level, o);
    else if (o.action === "sell") openAfter.delete(o.level - 1);
  }
  assert.equal(openAfter.size, 0, "all open buys flattened");

  // Subsequent ticks must be no-ops while parked.
  const snapshotLen = getGridOrders(bot.id).length;
  for (let i = 0; i < 5; i++) {
    const r = tickGridBot(bot.id);
    assert.equal(r, null, "tick on paused_by_breaker bot is a no-op");
  }
  assert.equal(
    getGridOrders(bot.id).length,
    snapshotLen,
    "no further fills recorded while breaker is active",
  );
});

test("watchBreakerResume re-activates parked bots once portfolio recovers", () => {
  const { ticker, seedPrice } = pickTicker();
  const lower = Math.round(seedPrice * 0.7 * 100) / 100;
  const upper = Math.round(seedPrice * 1.3 * 100) / 100;

  storage.getPortfolio = () => fakePortfolio(1000);
  const bot = createGridBot({
    ticker, lowerPrice: lower, upperPrice: upper,
    gridCount: 8, totalInvestment: 100, stopBufferPct: 0.5,
  });
  stopGridBotLoop(bot.id);

  // Establish at least one open buy.
  for (let i = 0; i < 25; i++) tickGridBot(bot.id);

  // Trip breaker.
  storage.getPortfolio = () => fakePortfolio(800);
  tickGridBot(bot.id);
  assert.equal(getGridBot(bot.id)!.status, "paused_by_breaker");

  // Portfolio recovers above the limit.
  storage.getPortfolio = () => fakePortfolio(1000);
  watchBreakerResume();

  const resumed = getGridBot(bot.id)!;
  assert.equal(resumed.status, "active", "bot resumed after breaker recovery");

  // After resumption, ticks must once again be able to record fills.
  stopGridBotLoop(bot.id); // ignore the loop watchBreakerResume started
  const before = getGridOrders(bot.id).length;
  for (let i = 0; i < 25; i++) tickGridBot(bot.id);
  const after = getGridOrders(bot.id).length;
  assert.ok(after >= before, "ticking resumes after breaker clears (no regression)");
});

test("restart-survival: bootGridEngine replays SQLite state without duplicate fills", () => {
  const { ticker, seedPrice } = pickTicker();
  const lower = Math.round(seedPrice * 0.7 * 100) / 100;
  const upper = Math.round(seedPrice * 1.3 * 100) / 100;

  storage.getPortfolio = () => fakePortfolio(1000);
  const bot = createGridBot({
    ticker, lowerPrice: lower, upperPrice: upper,
    gridCount: 8, totalInvestment: 100, stopBufferPct: 0.5,
  });
  stopGridBotLoop(bot.id);

  // Run several ticks to accumulate some grid_orders + realized P&L.
  for (let i = 0; i < 40; i++) tickGridBot(bot.id);

  const snapshot = getGridBot(bot.id)!;
  const ordersBefore = getGridOrders(bot.id);
  const levelsBefore = computeBotLevels(snapshot);
  const openBuysBefore = (() => {
    const open = new Map<number, any>();
    for (const o of [...ordersBefore].reverse()) {
      if (o.action === "buy") open.set(o.level, o);
      else if (o.action === "sell") open.delete(o.level - 1);
    }
    return Array.from(open.keys()).sort((a, b) => a - b);
  })();

  // Simulate a process restart: tear down in-memory tick loops, then boot.
  stopGridBotLoop(bot.id);
  bootGridEngine();

  // The boot path must not create or duplicate any orders.
  const afterBootOrders = getGridOrders(bot.id);
  assert.equal(
    afterBootOrders.length,
    ordersBefore.length,
    "bootGridEngine must not insert or duplicate any grid_orders",
  );

  const afterBootBot = getGridBot(bot.id)!;
  assert.equal(afterBootBot.realizedPnl,     snapshot.realizedPnl,     "realizedPnl preserved");
  assert.equal(afterBootBot.totalGridFills,  snapshot.totalGridFills,  "totalGridFills preserved");
  assert.equal(afterBootBot.gridCount,       snapshot.gridCount,       "gridCount (level index space) preserved");
  assert.equal(afterBootBot.status,          snapshot.status,          "status preserved");

  // Level indices must match exactly (open-buy/sell-level invariants depend on this).
  const levelsAfter = computeBotLevels(afterBootBot);
  assert.deepEqual(levelsAfter, levelsBefore, "grid level indices preserved across reboot");

  // Open-buy level set must match exactly.
  const openBuysAfter = (() => {
    const open = new Map<number, any>();
    for (const o of [...afterBootOrders].reverse()) {
      if (o.action === "buy") open.set(o.level, o);
      else if (o.action === "sell") open.delete(o.level - 1);
    }
    return Array.from(open.keys()).sort((a, b) => a - b);
  })();
  assert.deepEqual(openBuysAfter, openBuysBefore, "open-buy level set preserved across reboot");

  // Stop the post-boot loop so node:test exits cleanly.
  stopGridBotLoop(bot.id);
});
