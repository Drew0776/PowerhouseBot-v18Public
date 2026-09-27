/**
 * Task #60 — Automated coverage for the grid engine's range-exit stop-loss.
 *
 * Task #57 already covers the global drawdown circuit breaker; this file
 * locks down the *per-bot* safety net in tickGridBot():
 *
 *   if (currentPrice < lower*(1-buf) || currentPrice > upper*(1+buf)) {
 *     closeAllOpenPositions(bot, currentPrice);
 *     stopGridBotLoop(botId);
 *     bot.status = "stopped_range_exit";
 *     return null;
 *   }
 *
 * Verifies:
 *   1. Price above upper*(1+buf) → bot transitions to stopped_range_exit,
 *      every open buy is flattened by a synthetic SELL at market, the tick
 *      loop is killed, and subsequent ticks place no further fills.
 *   2. Symmetric trip on the lower side: price below lower*(1-buf).
 *   3. Price that stays just inside the buffer band does NOT trip the stop —
 *      the bot stays "active" and ticking is unaffected.
 *
 * Run from the project root with:
 *   npx tsx --test server/__tests__/grid-range-exit.test.ts
 *
 * Uses a dedicated DATA_DB_PATH so the dev DB is never touched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Isolate the test DB BEFORE storage.ts loads.
const TEST_DB = path.join(os.tmpdir(), `grid-range-exit-test-${process.pid}.db`);
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

/** Pick the first stock from the seed cache; its frozen seed price (mu) is
 * the centre of the simulator's deterministic ±25% band. */
function pickTicker(): { ticker: string; seedPrice: number } {
  const stocks = getStockData();
  const s = stocks[0];
  return { ticker: s.ticker, seedPrice: s.price };
}

/** Insert an "established" open BUY for the bot directly into grid_orders so
 * the next tick has something concrete to flatten. */
function injectOpenBuy(botId: number, ticker: string, level: number, price: number, shares: number) {
  sqlite.prepare(
    `INSERT INTO grid_orders
       (bot_id, ticker, level, grid_price, action, fill_price, shares, total, pnl, filled_at)
     VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, NULL, ?)`
  ).run(
    botId, ticker, level, price, price, shares,
    Math.round(price * shares * 100) / 100,
    new Date().toISOString(),
  );
}

/** Count currently-open (unmatched) buys for a bot using the same level-pairing
 * rule the engine itself uses. */
function countOpenBuys(botId: number): number {
  const orders = getGridOrders(botId);
  const open = new Map<number, unknown>();
  for (const o of [...orders].reverse()) {
    if (o.action === "buy") open.set(o.level, o);
    else if (o.action === "sell") open.delete(o.level - 1);
  }
  return open.size;
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

test("range-exit stop (upper): price above upper*(1+buf) flattens open buys, parks bot, halts ticks", () => {
  const { ticker, seedPrice: mu } = pickTicker();

  // advancePrice() clamps to [mu*0.75, mu*1.25]. Putting the entire bot range
  // below mu*0.75 guarantees the next tick's price exceeds upper*(1+buf).
  const lower = Math.round(mu * 0.50 * 100) / 100;
  const upper = Math.round(mu * 0.60 * 100) / 100;
  const buf   = 0.05; // stopUpper = mu*0.60*1.05 = mu*0.63 ≪ mu*0.75

  // Keep the breaker dormant so we know any trip is the range-exit path.
  storage.getPortfolio = () => fakePortfolio(1000);

  const bot = createGridBot({
    ticker, lowerPrice: lower, upperPrice: upper,
    gridCount: 4, totalInvestment: 100, stopBufferPct: buf,
  });
  stopGridBotLoop(bot.id); // drive ticks manually

  // Seed a known open buy at level 1 so the flatten path has work to do.
  const levels = computeBotLevels(bot);
  const buyLevel = 1;
  const buyPrice = levels[buyLevel];
  const buyShares = 0.5;
  injectOpenBuy(bot.id, ticker, buyLevel, buyPrice, buyShares);
  assert.equal(countOpenBuys(bot.id), 1, "precondition: one open buy");

  const fillsBefore = getGridOrders(bot.id).length;
  const realizedBefore = getGridBot(bot.id)!.realizedPnl;
  const totalFillsBefore = getGridBot(bot.id)!.totalGridFills;

  // Trip the upper-side range-exit stop.
  const tripResult = tickGridBot(bot.id);
  assert.equal(tripResult, null, "tick that trips range-exit returns null");

  const after = getGridBot(bot.id)!;
  assert.equal(after.status, "stopped_range_exit", "bot parked with stopped_range_exit");
  assert.ok(after.stoppedAt, "stoppedAt timestamp persisted");

  const ordersAfter = getGridOrders(bot.id);
  assert.equal(
    ordersAfter.length,
    fillsBefore + 1,
    "exactly one synthetic flatten-SELL recorded for the open buy",
  );
  const flatten = ordersAfter[0]; // newest first (desc by id)
  assert.equal(flatten.action, "sell", "flatten order is a SELL");
  assert.equal(flatten.level, buyLevel + 1, "flatten SELL tagged one level above the closed buy");
  assert.equal(flatten.shares, buyShares, "flatten SELL closes the full open size");

  // Open-buy ledger is empty after flatten (sell at level+1 cancels buy at level).
  assert.equal(countOpenBuys(bot.id), 0, "all open buys flattened");

  // Realized P&L + totalGridFills rolled forward by the flatten.
  assert.equal(after.totalGridFills, totalFillsBefore + 1, "totalGridFills incremented by flatten");
  assert.notEqual(after.realizedPnl, realizedBefore, "realizedPnl updated by flatten sell");

  // Bot is no longer "active" — every subsequent tick must be a no-op.
  const snapshotLen = getGridOrders(bot.id).length;
  for (let i = 0; i < 5; i++) {
    const r = tickGridBot(bot.id);
    assert.equal(r, null, "tick on stopped_range_exit bot is a no-op");
  }
  assert.equal(
    getGridOrders(bot.id).length,
    snapshotLen,
    "no further fills recorded after range-exit stop",
  );
});

test("range-exit stop (lower): price below lower*(1-buf) flattens open buys and parks bot", () => {
  const { ticker, seedPrice: mu } = pickTicker();

  // Mirror of the upper test: put the range entirely above mu*1.25 so the
  // next simulated price is always below lower*(1-buf).
  const lower = Math.round(mu * 1.40 * 100) / 100;
  const upper = Math.round(mu * 1.50 * 100) / 100;
  const buf   = 0.05; // stopLower = mu*1.40*0.95 = mu*1.33 ≫ mu*1.25

  storage.getPortfolio = () => fakePortfolio(1000);

  const bot = createGridBot({
    ticker, lowerPrice: lower, upperPrice: upper,
    gridCount: 4, totalInvestment: 100, stopBufferPct: buf,
  });
  stopGridBotLoop(bot.id);

  const levels = computeBotLevels(bot);
  const buyLevel = 1;
  const buyPrice = levels[buyLevel];
  const buyShares = 0.5;
  injectOpenBuy(bot.id, ticker, buyLevel, buyPrice, buyShares);
  assert.equal(countOpenBuys(bot.id), 1, "precondition: one open buy");

  const fillsBefore = getGridOrders(bot.id).length;

  const tripResult = tickGridBot(bot.id);
  assert.equal(tripResult, null, "tick that trips range-exit returns null");

  const after = getGridBot(bot.id)!;
  assert.equal(after.status, "stopped_range_exit", "bot parked with stopped_range_exit");
  assert.ok(after.stoppedAt, "stoppedAt timestamp persisted");

  const ordersAfter = getGridOrders(bot.id);
  assert.equal(
    ordersAfter.length,
    fillsBefore + 1,
    "exactly one synthetic flatten-SELL recorded for the open buy",
  );
  const flatten = ordersAfter[0];
  assert.equal(flatten.action, "sell");
  assert.equal(flatten.level, buyLevel + 1);
  assert.equal(countOpenBuys(bot.id), 0, "all open buys flattened");

  // Further ticks must be no-ops.
  const snapshotLen = getGridOrders(bot.id).length;
  for (let i = 0; i < 5; i++) {
    assert.equal(tickGridBot(bot.id), null, "tick on stopped bot is a no-op");
  }
  assert.equal(
    getGridOrders(bot.id).length,
    snapshotLen,
    "no further fills recorded after range-exit stop",
  );
});

test("range-exit stop does NOT trigger when price stays inside the buffer band", () => {
  const { ticker, seedPrice: mu } = pickTicker();

  // advancePrice() is hard-bounded to [mu*0.75, mu*1.25]. Range [mu*0.70, mu*1.30]
  // with a 5% buffer ⇒ stop band [mu*0.665, mu*1.365] strictly contains every
  // simulated price, so no tick may ever trip the range-exit stop.
  const lower = Math.round(mu * 0.70 * 100) / 100;
  const upper = Math.round(mu * 1.30 * 100) / 100;
  const buf   = 0.05;

  storage.getPortfolio = () => fakePortfolio(1000);

  const bot = createGridBot({
    ticker, lowerPrice: lower, upperPrice: upper,
    gridCount: 8, totalInvestment: 100, stopBufferPct: buf,
  });
  stopGridBotLoop(bot.id);

  // Drive enough ticks to exercise a wide slice of the price oscillator.
  for (let i = 0; i < 60; i++) {
    tickGridBot(bot.id);
    const snap = getGridBot(bot.id)!;
    assert.notEqual(
      snap.status,
      "stopped_range_exit",
      `bot must stay active while price is inside the buffer (tick ${i})`,
    );
  }

  const finalBot = getGridBot(bot.id)!;
  assert.equal(finalBot.status, "active", "bot is still active after 60 in-band ticks");
  assert.equal(finalBot.stoppedAt, null, "stoppedAt never set while in-band");
});
