/**
 * Fourth-audit fixes, all about live Alpaca prices:
 *   - live quotes reach the shared price table whether or not the
 *     auto-trader runs (portfolio values, manual trades, signals);
 *   - a grid bot on a live ticker holds when its quote goes stale instead of
 *     switching to a simulated walk from the startup price;
 *   - manual trades fill like the engine's: live stocks at the ask/bid, only
 *     in session with a fresh quote; simulated ones pay the modelled spread.
 *
 * Alpaca is exercised with placeholder credentials and a stubbed fetch; no
 * request leaves the process.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/live-prices.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `live-prices-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;
process.env.ALPACA_KEY_ID = "placeholder";
process.env.ALPACA_SECRET_KEY = "placeholder";

// What the stubbed Alpaca REST endpoint quotes for NVDA.
const quote = { bid: 250, ask: 250.2, ageMs: 1_000 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({
  quotes: { NVDA: { bp: quote.bid, ap: quote.ask, t: new Date(Date.now() - quote.ageMs).toISOString() } },
}), { status: 200 })) as typeof fetch;

const alpaca = await import("../alpaca.js");
const st = await import("../storage.js");
const at = await import("../auto-trader.js");
const grid = await import("../grid-engine.js");

const realNow = Date.now;
const staleBy = (ms: number) => { Date.now = () => realNow() + ms; };
const fresh = () => { Date.now = realNow; };

after(() => {
  fresh();
  globalThis.fetch = realFetch;
  grid.shutdownGridEngine();
  try { st.sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

const OPEN = new Date(2026, 8, 28, 11, 0);   // Monday 11:00 ET
const CLOSED = new Date(2026, 8, 27, 11, 0); // Sunday

test("live quotes update the shared price with the auto-trader stopped", async () => {
  const startup = st.getStockByTicker("NVDA")!.price;
  assert.notEqual(startup, 250.1);
  assert.equal(at.isAutoTraderRunning(), false);
  await alpaca.refreshAllPrices();
  assert.equal(st.getStockByTicker("NVDA")!.price, 250.1, "the portfolio and manual trades see the live mid");
});

test("a live grid bot holds on a stale quote instead of simulating from the startup price", async () => {
  await alpaca.refreshAllPrices();
  assert.equal(st.advanceGridPrice("NVDA"), 250.1);
  try {
    staleBy(60_000);
    assert.equal(st.isGridPriceHeld("NVDA"), true);
    assert.equal(st.advanceGridPrice("NVDA"), 0, "0 = hold");
    assert.equal(st.getGridPrice("NVDA"), 250.1, "valued at the last live price");
  } finally { fresh(); }
  // Simulated tickers are never held.
  assert.equal(st.isGridPriceHeld("BTC"), false);
  assert.ok(st.advanceGridPrice("BTC") > 0);
});

test("a stale quote doesn't trip a live grid bot's range-exit stop", async () => {
  await alpaca.refreshAllPrices();
  const bot = grid.createGridBot({ ticker: "NVDA", lowerPrice: 245, upperPrice: 255, gridCount: 10, totalInvestment: 100, stopBufferPct: 0.02 });
  grid.stopGridBotLoop(bot.id);
  grid.tickGridBot(bot.id); // first look at the live price: the opening buy
  const before = grid.getGridOrders(bot.id).length;
  try {
    staleBy(60_000);
    for (let i = 0; i < 20; i++) grid.tickGridBot(bot.id);
    const b = grid.getGridBot(bot.id)!;
    assert.equal(b.status, "active", "no range exit on a simulated price");
    assert.equal(grid.getGridOrders(bot.id).length, before, "no fills while held");
  } finally { fresh(); }
  grid.stopGridBot(bot.id);
});

test("manual buys of live stocks fill at the ask, in session, on a fresh quote", async () => {
  await alpaca.refreshAllPrices();
  assert.deepEqual(at.manualFill("NVDA", "buy", 1, OPEN), { price: 250.2, cost: 0 });
  assert.deepEqual(at.manualFill("NVDA", "sell", 1, OPEN), { price: 250, cost: 0 });
  const closed = at.manualFill("NVDA", "buy", 1, CLOSED);
  assert.ok("error" in closed && closed.status === 409 && /market is closed/.test(closed.error));
  try {
    staleBy(60_000);
    const stale = at.manualFill("NVDA", "sell", 1, OPEN);
    assert.ok("error" in stale && /No fresh live quote/.test(stale.error));
  } finally { fresh(); }
});

test("manual trades in simulated instruments pay the modelled spread", () => {
  const s = st.getStockByTicker("BTC")!;
  const f = at.manualFill("BTC", "buy", 0.01, OPEN);
  assert.ok(!("error" in f));
  assert.equal(f.price, s.price);
  assert.equal(f.cost, at.modelledCost(0.01, s.price, "crypto"));
  assert.ok(f.cost > 0);
  const missing = at.manualFill("NOPE", "buy", 1, OPEN);
  assert.ok("error" in missing && missing.status === 404);
});
