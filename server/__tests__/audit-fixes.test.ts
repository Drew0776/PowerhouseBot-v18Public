/**
 * Coverage for the audit fixes:
 *   1. requireAuth actually gates requests.
 *   2. Only US stocks are sent to Alpaca (no crypto/forex/commodity/index
 *      symbols that collide with unrelated real tickers).
 *   3. T1 partial exits are recorded in the DB, keeping portfolio cash in
 *      line with the engine's P&L.
 *   4. Grid bots use their own price source and their reserve trade is valued
 *      from grid P&L, then settled back into cash when the bot stops.
 *   5. A tripped breaker survives stop/start; the scan preview moves no prices;
 *      the US session gate; backtest in-sample vs out-of-sample balances.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/audit-fixes.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Isolate the test DB BEFORE storage.ts loads.
const TEST_DB = path.join(os.tmpdir(), `audit-fixes-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(TEST_DB + ext); } catch { /* nothing to clean */ }
}
process.env.DATA_DB_PATH = TEST_DB;

const storageMod    = await import("../storage.js");
const gridEngineMod = await import("../grid-engine.js");
const authMod       = await import("../auth.js");
const alpacaMod     = await import("../alpaca.js");
const autoTraderMod = await import("../auto-trader.js");

const { storage, sqlite, getStockData, getStockByTicker, advanceGridPrice, getGridPrice, STARTING_BALANCE } = storageMod;
const { createGridBot, stopGridBot, stopGridBotLoop, getGridBot, isGridReserveTrade } = gridEngineMod;
const {
  evaluateCircuitBreaker, isCircuitBreakerActive, resetCircuitBreaker, resetAutoTraderState,
  startAutoTrader, stopAutoTrader, scanForBreakouts, isUsMarketOpen, runWalkForwardBacktest,
} = autoTraderMod;

const ORIG_getPortfolio = storage.getPortfolio.bind(storage);
function fakePortfolio(totalValue: number) {
  return {
    totalValue, cash: totalValue, investedValue: 0, dayPnl: 0, dayPnlPercent: 0,
    totalPnl: 0, totalPnlPercent: 0, winRate: 0, openPositions: 0, riskScore: 0, positions: [],
  } as any;
}

function firstStock() {
  const s = getStockData().find(x => !(x as any).marketType || (x as any).marketType === "stock")!;
  return { ticker: s.ticker, price: s.price };
}

beforeEach(() => {
  sqlite.exec("DELETE FROM trades; DELETE FROM grid_orders; DELETE FROM grid_bots;");
  storage.getPortfolio = ORIG_getPortfolio;
  resetAutoTraderState();
});

after(() => {
  storage.getPortfolio = ORIG_getPortfolio;
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ }
  }
});

test("requireAuth rejects anonymous requests with 401 and passes logged-in ones", () => {
  let status = 0;
  let nextCalled = false;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as any;

  authMod.requireAuth({ isAuthenticated: () => false } as any, res, () => { nextCalled = true; });
  assert.equal(status, 401);
  assert.equal(nextCalled, false);

  authMod.requireAuth({ isAuthenticated: () => true } as any, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("Alpaca symbol set contains stocks only", () => {
  const set = alpacaMod.ALPACA_STOCK_TICKERS;
  for (const t of ["BTC", "ETH", "LINK", "CORN", "GOLD", "EURUSD", "SPX"]) {
    assert.equal(set.has(t), false, `${t} must not be queried on Alpaca's stock endpoints`);
  }
  assert.equal(set.has("NVDA"), true);
});

test("partialCloseTrade splits the row and keeps cash consistent", () => {
  const { ticker } = firstStock();
  const startCash = storage.getPortfolio().cash;
  const t = storage.createTrade({
    ticker, action: "buy", shares: 10, price: 10, total: 100,
    stopLoss: null, takeProfit: null, openedAt: new Date().toISOString(),
  });

  const sold = storage.partialCloseTrade(t.id, 4, 12)!;
  assert.equal(sold.status, "closed");
  assert.equal(sold.shares, 4);
  assert.equal(sold.pnl, 8);

  const open = storage.getOpenTrades().find(x => x.id === t.id)!;
  assert.equal(open.shares, 6);
  assert.equal(open.total, 60);
  assert.equal(storage.getPortfolio().cash, startCash - 100 + 40 + 8);

  // Closing the rest realizes P&L only on the remaining shares.
  const rest = storage.closeTrade(t.id, 12)!;
  assert.equal(rest.pnl, 12);
  assert.equal(storage.getPortfolio().cash, startCash + 8 + 12);
});

test("grid price source does not overwrite the shared stock price", () => {
  const { ticker } = firstStock();
  const before = getStockByTicker(ticker)!.price;
  for (let i = 0; i < 5; i++) advanceGridPrice(ticker);
  assert.equal(getStockByTicker(ticker)!.price, before);
  assert.ok(getGridPrice(ticker) > 0);
});

test("grid reserve is valued from grid P&L and settled into cash on stop", () => {
  const { ticker } = firstStock();
  const startCash = storage.getPortfolio().cash;
  const price = getGridPrice(ticker);

  const reserve = storage.createTrade({
    ticker, action: "buy", shares: 100 / price, price, total: 100,
    stopLoss: null, takeProfit: null, openedAt: new Date().toISOString(),
  });
  const bot = createGridBot({
    ticker, lowerPrice: price * 0.5, upperPrice: price * 1.5,
    gridCount: 4, totalInvestment: 100, reserveTradeId: reserve.id,
  });
  stopGridBotLoop(bot.id);
  assert.equal(isGridReserveTrade(reserve.id), true);

  // One open buy 10% below the current grid price.
  const buyPrice = Math.round(price * 0.9 * 100) / 100;
  sqlite.prepare(
    `INSERT INTO grid_orders (bot_id, ticker, level, grid_price, action, fill_price, shares, total, pnl, filled_at)
     VALUES (?, ?, 1, ?, 'buy', ?, 2, ?, NULL, ?)`,
  ).run(bot.id, ticker, buyPrice, buyPrice, buyPrice * 2, new Date().toISOString());
  const expectedPnl = (getGridPrice(ticker) - buyPrice) * 2;

  const p = storage.getPortfolio();
  assert.equal(p.cash, Math.round((startCash - 100) * 100) / 100);
  const pos = p.positions.find(x => x.ticker === ticker)!;
  assert.equal(pos.marketValue, Math.round((100 + expectedPnl) * 100) / 100);

  const stopped = stopGridBot(bot.id)!;
  assert.equal(stopped.status, "stopped");
  // Stopping flattens the open buy with a market sell, which pays the half-spread.
  const mt = (getStockByTicker(ticker) as { marketType?: string }).marketType ?? "stock";
  const flattenCost = autoTraderMod.modelledCost(2, getGridPrice(ticker), mt);
  assert.equal(Math.round(getGridBot(bot.id)!.realizedPnl * 100), Math.round((expectedPnl - flattenCost) * 100));

  const settled = storage.getTrades().find(x => x.id === reserve.id)!;
  assert.equal(settled.status, "closed");
  assert.equal(
    storage.getPortfolio().cash,
    Math.round((startCash + settled.pnl!) * 100) / 100,
  );

  // Stopping again must not settle twice.
  stopGridBot(bot.id);
  assert.equal(storage.getTrades().filter(x => x.status === "closed").length, 1);
});

test("a tripped breaker survives stop/start instead of being cleared", () => {
  storage.getPortfolio = () => fakePortfolio(1000);
  resetCircuitBreaker();
  evaluateCircuitBreaker(); // anchor $1000 for today
  storage.getPortfolio = () => fakePortfolio(960); // 4% dd → tier-1 trip
  evaluateCircuitBreaker();
  assert.equal(isCircuitBreakerActive(), true, "precondition: tripped");

  try {
    stopAutoTrader();  // persists state
    startAutoTrader(); // restores it — same ET day
    assert.equal(isCircuitBreakerActive(), true, "restart must not bypass the daily-loss breaker");
  } finally {
    stopAutoTrader();
  }
});

test("scan preview does not move prices", () => {
  const before = getStockData().map(s => s.price);
  scanForBreakouts({ advance: false });
  assert.deepEqual(getStockData().map(s => s.price), before);
});

test("US session gate: 9:30–16:00 ET on weekdays only", () => {
  // Dates are constructed as ET wall-clock times.
  assert.equal(isUsMarketOpen(new Date(2026, 8, 28, 9, 29)), false);  // Mon 9:29
  assert.equal(isUsMarketOpen(new Date(2026, 8, 28, 9, 30)), true);   // Mon 9:30
  assert.equal(isUsMarketOpen(new Date(2026, 8, 28, 15, 59)), true);  // Mon 15:59
  assert.equal(isUsMarketOpen(new Date(2026, 8, 28, 16, 0)), false);  // Mon 16:00
  assert.equal(isUsMarketOpen(new Date(2026, 8, 26, 12, 0)), false);  // Sat noon
});

test("backtest reports the in-sample balance at the split, not the final one", async () => {
  const r = await runWalkForwardBacktest(400);
  const expectedOosReturn = ((r.outOfSample.finalBalance - r.inSample.finalBalance) / r.inSample.finalBalance) * 100;
  assert.ok(
    Math.abs(r.outOfSample.totalReturn - expectedOosReturn) < 0.05,
    `OOS return ${r.outOfSample.totalReturn}% must be measured from the IS end balance`,
  );
});

test("getPortfolio's SQL aggregates match the row-by-row arithmetic", () => {
  const tickers = getStockData().slice(0, 4).map(s => s.ticker);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ins = sqlite.prepare(
    `INSERT INTO trades (ticker, action, shares, price, total, status, pnl, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01', ?)`,
  );
  for (let i = 0; i < 300; i++) {
    const shares = Math.round(rnd() * 1000) / 100 + 0.01;
    const price = Math.round(rnd() * 5000) / 100 + 1;
    const status = rnd() < 0.7 ? "closed" : "open";
    // Include the odd shapes the old loop tolerated: closed with no P&L, non-buy actions.
    const pnl = status === "closed" && rnd() < 0.9 ? Math.round((rnd() - 0.5) * 2000) / 100 : null;
    const action = rnd() < 0.95 ? "buy" : "sell";
    ins.run(tickers[i % 4], action, shares, price, Math.round(shares * price * 100) / 100, status, pnl,
      status === "closed" ? "2026-01-02" : null);
  }

  // The previous implementation, verbatim, over the full trade list.
  const all = storage.getTrades();
  let cash = STARTING_BALANCE;
  for (const t of all) {
    if (t.action === "buy") cash -= t.total;
    if (t.status === "closed" && t.pnl !== null) cash += t.total + t.pnl;
  }
  // Win rate is per position: closed rows sharing ticker, open time and entry
  // price (a T1 partial and its remainder) are one position, counted once it
  // has no open row left.
  const key = (t: typeof all[number]) => `${t.ticker}|${t.openedAt}|${t.price}`;
  const stillOpen = new Set(all.filter(t => t.status === "open").map(key));
  const positions = new Map<string, number>();
  for (const t of all) {
    if (t.status !== "closed" || stillOpen.has(key(t))) continue;
    positions.set(key(t), (positions.get(key(t)) ?? 0) + (t.pnl ?? 0));
  }
  const wins = [...positions.values()].filter(v => v > 0).length;
  const expectedWinRate = positions.size > 0 ? Math.round((wins / positions.size) * 10000) / 100 : 0;

  const p = storage.getPortfolio();
  assert.equal(p.cash, Math.round(cash * 100) / 100);
  assert.equal(p.winRate, expectedWinRate);
  const openTickers = new Set(all.filter(t => t.status === "open").map(t => t.ticker));
  assert.equal(p.openPositions, openTickers.size);
});

test("day P&L is measured from the value at the start of the ET day", () => {
  sqlite.exec("DELETE FROM equity_curve;");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 36 * 3600 * 1000).toISOString();
  // No history at all: the day starts at the starting balance.
  assert.equal(storage.dayStartValue(now), STARTING_BALANCE);
  // Only points from today: the first one is the day's start.
  storage.addEquityCurvePoint({ timestamp: new Date(now.getTime() - 60_000).toISOString(), value: 490 });
  storage.addEquityCurvePoint({ timestamp: now.toISOString(), value: 495 });
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const minutesIntoEtDay = et.getHours() * 60 + et.getMinutes();
  if (minutesIntoEtDay > 2) assert.equal(storage.dayStartValue(now), 490);
  // A point from before ET midnight wins.
  storage.addEquityCurvePoint({ timestamp: yesterday, value: 480 });
  assert.equal(storage.dayStartValue(now), 480);
  const p = storage.getPortfolio();
  assert.equal(p.dayPnl, Math.round((p.totalValue - 480) * 100) / 100);
});

test("cross-site state-changing requests are refused; same-origin ones pass", () => {
  const run = (method: string, headers: Record<string, string>) => {
    let status = 0, passed = false;
    const req = { method, get: (h: string) => headers[h.toLowerCase()] } as any;
    const res = { status(c: number) { status = c; return this; }, json() { return this; } } as any;
    authMod.sameOriginGuard(req, res, () => { passed = true; });
    return passed ? "next" : status;
  };
  assert.equal(run("POST", { host: "bot.example.com", origin: "https://evil.example.net" }), 403);
  assert.equal(run("POST", { host: "bot.example.com", origin: "https://bot.example.com" }), "next");
  assert.equal(run("POST", { host: "internal:5000", "x-forwarded-host": "bot.example.com", origin: "https://bot.example.com" }), "next");
  assert.equal(run("POST", { host: "bot.example.com" }), "next", "no Origin: left to the session check");
  assert.equal(run("GET", { host: "bot.example.com", origin: "https://evil.example.net" }), "next", "safe methods pass");
  assert.equal(run("POST", { host: "bot.example.com", origin: "null" }), 403, "opaque origins are refused");
});
