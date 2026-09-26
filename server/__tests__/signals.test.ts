/**
 * The auto-trader's signals come from the prices it observes:
 *   - nothing is scored until enough evenly spaced history exists (warm-up);
 *   - scores move as prices move (they used to be frozen seeded values);
 *   - every simulated instrument has its own random path (no seed collisions);
 *   - sub-cent instruments keep finite prices and sane stops;
 *   - scores stay within 0–100 without piling up at the cap;
 *   - risk per trade comes from the Kelly bounds, and the backtest counts each
 *     trade once and only rules with enough out-of-sample trades.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/signals.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `signals-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;

const storageMod = await import("../storage.js");
const at = await import("../auto-trader.js");
const grid = await import("../grid-engine.js");
const { hashString } = await import("../../shared/hash.js");
const { STOCK_INFO } = await import("../seed.js");

const { sqlite, getStockByTicker } = storageMod;
const scores = () => new Map(at.getScanDebug().candidates.filter(c => c.score !== null).map(c => [c.ticker, c.score!]));
const tick = (n: number) => { for (let i = 0; i < n; i++) at.autoTraderTick(); };

before(() => at.resetAutoTraderState());
after(() => {
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

test("sub-cent instruments start with finite prices", () => {
  for (const t of ["PEPE", "BONK"]) {
    const p = getStockByTicker(t)!.price;
    assert.ok(Number.isFinite(p) && p > 0 && p < 0.001, `${t} = ${p}`);
  }
});

test("every instrument gets its own simulator seed", () => {
  const ks = Object.keys(STOCK_INFO);
  assert.equal(new Set(ks.map(hashString)).size, ks.length);
});

test("nothing is scored before the price history warms up", () => {
  tick(5);
  const d = at.getScanDebug();
  assert.equal(d.passed, 0);
  assert.ok(d.candidates.every(c => c.gateFailed === "warmup" || c.gateFailed === "open_position"));
});

test("scores move with prices instead of staying frozen", () => {
  tick(25);                       // tick 30
  const a = scores();
  tick(30);                       // tick 60
  const b = scores();
  const common = [...a.keys()].filter(k => b.has(k));
  assert.ok(common.length >= 20, `enough tickers scored at both points (${common.length})`);
  const changed = common.filter(k => a.get(k) !== b.get(k)).length;
  assert.ok(changed / common.length > 0.5, `${changed}/${common.length} scores changed`);
});

test("formerly colliding tickers now follow different paths", () => {
  // RIOT, WULF and KULR used to share a seed and move in lockstep.
  const px = ["RIOT", "WULF", "KULR"].map(t => getStockByTicker(t)!.price / STOCK_INFO[t].price);
  assert.equal(new Set(px.map(v => v.toFixed(6))).size, 3, `relative moves ${px.join(", ")}`);
});

test("signals have stops below entry and scores within 0–100", () => {
  const sigs = at.scanForBreakouts({ advance: false });
  assert.ok(sigs.length > 0, "some signals once warmed up");
  for (const s of sigs) {
    assert.ok(s.stopLoss > 0 && s.stopLoss < s.entryPrice && s.takeProfit1 > s.entryPrice, `${s.ticker}: stop ${s.stopLoss} entry ${s.entryPrice} T1 ${s.takeProfit1}`);
    assert.ok(Number.isFinite(s.shares) && s.shares > 0, `${s.ticker} shares ${s.shares}`);
    assert.ok(s.score >= 0 && s.score <= 100);
  }
  const top = sigs.slice(0, 10).map(s => s.score);
  assert.ok(new Set(top).size > 1, `top scores are not all tied: ${top.join(", ")}`);
});

test("grid levels keep sub-cent precision", () => {
  const levels = grid.buildGridLevels(0.0000082, 0.0000122, 4);
  assert.deepEqual(levels, [0.0000082, 0.0000092, 0.0000102, 0.0000112, 0.0000122]);
});

test("risk per trade stays within the Kelly probe and cap", () => {
  const sigs = at.scanForBreakouts({ advance: false });
  for (const s of sigs) assert.ok(s.kellyFraction >= 0.0025 && s.kellyFraction <= 0.08, `${s.ticker} kf ${s.kellyFraction}`);
});

test("backtest counts each trade once and needs 30 out-of-sample trades to rule", () => {
  const short = at.runWalkForwardBacktest(400);
  for (const half of [short.inSample, short.outOfSample]) {
    assert.equal(half.wins + half.losses, half.trades, "every trade is a win or a loss, T1 partials included");
  }
  if (short.outOfSample.trades < 30) {
    assert.equal(short.verdict, "MARGINAL");
    assert.match(short.verdictMessage, /at least 30/);
  }
});
