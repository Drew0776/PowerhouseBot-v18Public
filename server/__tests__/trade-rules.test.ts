/**
 * Second-audit fixes:
 *   - exits fill at the market (not the stop) and pay the spread;
 *   - sizing respects the per-position caps and the stop-out risk limit;
 *   - diversification / recycling rules the live engine and backtest share;
 *   - the backtest pays for positions out of cash (no leverage);
 *   - the market-bar session clock follows the NYSE calendar in ET;
 *   - the grid simulator is a bounded random walk, grid fills need the price
 *     to reach the level, and duplicate bots are refused;
 *   - forex isn't simulated at penny-stock volatility;
 *   - signed money formatting.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/trade-rules.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `trade-rules-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;

const at = await import("../auto-trader.js");
const grid = await import("../grid-engine.js");
const { sqlite, getStockByTicker, advanceGridPrice } = await import("../storage.js");
const { nextSessionChange } = await import("../market-calendar.js");
const { simTickVol } = await import("../sim-vol.js");
const { signedUsd } = await import("../../shared/price.js");

after(() => {
  grid.shutdownGridEngine();
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

const pos = { entry: 100, trailingStop: 98, tp2: 110, tier1Hit: false, ticks: 5, rsi: 50 };

test("a stop-out sells at the market price, below the stop, and pays the spread", () => {
  const reason = at.exitReasonFor({ ...pos, price: 97.6, sellable: 97.6 }, false);
  assert.equal(reason, "stopped_out");
  const fill = at.exitFill(reason!, { tp2: 110, sellable: 97.6 }, price => price * 0.0002);
  assert.equal(fill.price, 97.6, "not the 98 stop");
  assert.ok(fill.cost > 0);
});

test("the target is a resting limit: it fills at T2 once the bid reaches it", () => {
  assert.equal(at.exitReasonFor({ ...pos, price: 110.02, sellable: 109.98 }, false), null, "bid still below T2");
  const reason = at.exitReasonFor({ ...pos, price: 110.3, sellable: 110.2 }, false);
  assert.equal(reason, "full_target");
  assert.equal(at.exitFill(reason!, { tp2: 110, sellable: 110.2 }, () => 0).price, 110);
});

test("exit priority: breaker, then target, then max hold, then stop", () => {
  assert.equal(at.exitReasonFor({ ...pos, price: 90, sellable: 90 }, true), "circuit_breaker");
  assert.equal(at.exitReasonFor({ ...pos, price: 97, sellable: 97, ticks: 50 }, false), "max_hold");
  assert.equal(at.exitReasonFor({ ...pos, price: 99, sellable: 99, ticks: 41 }, false), "gate_exit");
  assert.equal(at.exitReasonFor({ ...pos, price: 99.8, sellable: 99.8 }, false), null);
});

test("trailing stop only rises, and only after T1", () => {
  const p = { entry: 100, highWaterMark: 104, atr: 1, trailingStop: 98.5 };
  assert.equal(at.raiseTrail({ ...p, tier1Hit: false }), 98.5);
  assert.equal(at.raiseTrail({ ...p, tier1Hit: true }), 103.5);
  assert.equal(at.raiseTrail({ ...p, tier1Hit: true, trailingStop: 103.9 }), 103.9);
});

test("sizing: a stop-out never loses more than the risk limit, and position caps hold", () => {
  const record = { wins: 0, losses: 0, totalWin: 0, totalLoss: 0 };
  const portfolio = { cash: 500, totalValue: 500 };
  for (const grade of ["A+", "A", "B", "C"] as const) {
    for (const mt of ["stock", "forex", "crypto"]) {
      const plan = at.planEntry(100, 0.8, 90, grade, mt, portfolio, record);
      const stopLoss = (100 - plan.stop) * plan.shares;
      assert.ok(stopLoss <= portfolio.totalValue * plan.kf + 1e-6, `${grade}/${mt}: stop-out $${stopLoss} vs limit $${portfolio.totalValue * plan.kf}`);
      assert.ok(plan.posSize <= portfolio.totalValue * (mt === "forex" ? 0.15 : 0.25) + 1e-6);
    }
  }
});

test("diversification: two stocks, one of every other class", () => {
  assert.equal(at.typeSlotFree(["stock"], "stock"), true);
  assert.equal(at.typeSlotFree(["stock", "stock"], "stock"), false);
  assert.equal(at.typeSlotFree(["crypto"], "crypto"), false);
  assert.equal(at.typeSlotFree(["crypto"], "forex"), true);
});

test("recycling picks the weakest eligible position, or none", () => {
  const v = (p: { tier1Hit: boolean; ticks: number; pnlPct: number }) => p;
  const open = [
    { tier1Hit: false, ticks: 20, pnlPct: -0.4 },
    { tier1Hit: false, ticks: 20, pnlPct: -1.2 },
    { tier1Hit: true, ticks: 30, pnlPct: -2 },    // past T1: keep
    { tier1Hit: false, ticks: 3, pnlPct: -3 },     // too new
  ];
  assert.equal(at.recycleCandidate(open, v), open[1]);
  assert.equal(at.recycleCandidate([open[2], open[3]], v), null);
});

test("backtest pays for positions out of cash", async () => {
  const r = await at.runWalkForwardBacktest(600);
  // With the old leverage (5 × 50% of balance) drawdowns ran far past what
  // cash-funded positions sized to a 0.25–8% stop-out can produce.
  assert.ok(r.inSample.finalBalance > 0 && r.outOfSample.finalBalance > 0);
  assert.ok(r.inSample.maxDrawdown < 50, `IS drawdown ${r.inSample.maxDrawdown}%`);
  for (const half of [r.inSample, r.outOfSample]) assert.equal(half.wins + half.losses, half.trades);
});

test("session clock: ET open/close with weekends, holidays, early closes and DST", () => {
  const cases: [string, boolean, string][] = [
    ["2026-09-26T11:45:00Z", false, "2026-09-28T13:30:00.000Z"], // Saturday → Monday 9:30 EDT
    ["2026-09-28T15:00:00Z", true,  "2026-09-28T20:00:00.000Z"], // open → 16:00 EDT
    ["2026-11-27T17:30:00Z", true,  "2026-11-27T18:00:00.000Z"], // day after Thanksgiving: 13:00 EST
    ["2026-03-06T20:00:00Z", true,  "2026-03-06T21:00:00.000Z"], // before DST: 16:00 EST
    ["2026-03-09T13:00:00Z", false, "2026-03-09T13:30:00.000Z"], // after DST: 9:30 EDT
    ["2026-12-31T22:00:00Z", false, "2027-01-04T14:30:00.000Z"], // New Year's Day off
  ];
  for (const [now, open, at_] of cases) {
    const r = nextSessionChange(new Date(now));
    assert.equal(r.open, open, now);
    assert.equal(r.at.toISOString(), at_, now);
  }
});

test("forex is simulated at forex volatility, not penny-stock volatility", () => {
  assert.equal(simTickVol(1.08, "forex"), simTickVol(150, "forex"));
  assert.ok(simTickVol(1.08, "forex") < simTickVol(100, "stock"));
  assert.ok(simTickVol(3, "stock") > simTickVol(100, "stock"));
});

test("grid simulator is a bounded random walk, not an oscillator", () => {
  const t = "AAPL";
  const mu = getStockByTicker(t)!.price;
  const px: number[] = [];
  for (let i = 0; i < 2000; i++) px.push(advanceGridPrice(t));
  assert.ok(px.every(p => p >= mu * 0.75 - 1e-9 && p <= mu * 1.25 + 1e-9));
  const r = px.slice(1).map((p, i) => Math.log(p / px[i]));
  const sd = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / r.length);
  const vol = simTickVol(mu, "stock");
  assert.ok(sd > vol * 0.8 && sd < vol * 1.2, `per-tick σ ${sd} vs ${vol}`);
  // No oscillation to harvest: the old sine moved 10%+ within 20 ticks.
  const swing = Math.max(...px.slice(0, 20)) / Math.min(...px.slice(0, 20)) - 1;
  assert.ok(swing < 0.03, `20-tick swing ${swing}`);
});

test("grid fills: buys only at levels the price fell through, booked at the level", () => {
  sqlite.exec("DELETE FROM grid_orders; DELETE FROM grid_bots;");
  const t = "MSFT";
  const mu = getStockByTicker(t)!.price;
  // Tight grid so the random walk crosses levels within the test.
  const bot = grid.createGridBot({ ticker: t, lowerPrice: mu * 0.9, upperPrice: mu * 1.1, gridCount: 40, totalInvestment: 100, stopBufferPct: 0.5 });
  grid.stopGridBotLoop(bot.id);
  let prev: number | null = null;
  for (let i = 0; i < 1500; i++) {
    const before = grid.getGridOrders(bot.id).length;
    grid.tickGridBot(bot.id);
    const price = grid.getGridBotSummary(bot.id)!.currentPrice;
    const fresh = grid.getGridOrders(bot.id).slice(0, grid.getGridOrders(bot.id).length - before);
    const levels = grid.computeBotLevels(grid.getGridBot(bot.id)!, { persist: false });
    for (const o of fresh) {
      if (prev === null) continue; // the opening market buy
      if (o.action === "buy") {
        assert.equal(o.fillPrice, levels[o.level], "buy booked at its level");
        assert.ok(price <= levels[o.level] && levels[o.level] < prev, `buy at ${levels[o.level]} needs a fall through it (${prev} → ${price})`);
      } else {
        assert.ok(price >= o.fillPrice, "sell only once the price reaches the level");
      }
    }
    prev = price;
  }
  assert.ok(grid.getGridOrders(bot.id).length > 1, "the walk produced some fills");
});

test("signed money formatting", () => {
  assert.equal(signedUsd(1.2), "+$1.20");
  assert.equal(signedUsd(-1.2), "-$1.20");
  assert.equal(signedUsd(-0.004), "$0.00");
  assert.equal(signedUsd(null), "—");
});

test("a running backtest leaves the event loop free for requests and bot loops", async () => {
  // Longest stretch the event loop goes without running a timer while a
  // backtest is in progress. A blocking run stalls for its whole duration.
  let last = Date.now(), worst = 0;
  const hb = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const t0 = Date.now();
  await at.runWalkForwardBacktest(800);
  clearInterval(hb);
  worst = Math.max(worst, Date.now() - last); // a fully blocked run never ticks at all
  const ms = Date.now() - t0;
  assert.ok(ms > 200, `run long enough to measure (${ms} ms)`);
  assert.ok(worst < 100, `longest stall ${worst} ms during a ${ms} ms run`);
});
