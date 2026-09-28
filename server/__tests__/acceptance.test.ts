/**
 * Validation ideas from the "Opus 5.5 + Jev" field report, adapted to this
 * engine:
 *   - the backtest's pass/fail is an acceptance test (Sharpe, drawdown, hit
 *     rate, t-statistic, history length, net P&L), not only a CI on the mean;
 *   - entries need a fresh live quote, and a live position with a stale quote
 *     holds instead of exiting on the last price seen;
 *   - Kelly sizing uses each market class's own win rate and payoff ratio;
 *   - the win probability each trade was sized with is scored against the
 *     result (Brier score, reliability table).
 *
 * Alpaca is exercised with placeholder credentials and a stubbed fetch; no
 * request leaves the process.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/acceptance.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `acceptance-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;
process.env.ALPACA_KEY_ID = "placeholder";
process.env.ALPACA_SECRET_KEY = "placeholder";

// Quotes the stubbed Alpaca REST endpoint returns: ticker → quote age in ms.
const quoteAge = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  const quotes: Record<string, { bp: number; ap: number; t: string }> = {};
  for (const [t, age] of quoteAge) quotes[t] = { bp: 99.9, ap: 100.1, t: new Date(Date.now() - age).toISOString() };
  return new Response(JSON.stringify({ quotes }), { status: 200 });
}) as typeof fetch;

const at = await import("../auto-trader.js");
const alpaca = await import("../alpaca.js");
const { sqlite, recordCalibration, clearCalibration } = await import("../storage.js");
const stats = await import("../stats.js");

after(() => {
  globalThis.fetch = realFetch;
  at.resetAutoTraderState();
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

// ── 1. Acceptance test ─────────────────────────────────────────────────────

const good = { sharpe: 2, maxDrawdownPct: 10, hitRatePct: 60, tStat: 3, years: 6, netPnl: 50 };

test("acceptance: every gate must pass, at the paper's thresholds", () => {
  assert.ok(at.acceptanceGates(good).every(g => g.pass));
  const fails = (m: Partial<typeof good> & Record<string, unknown>) =>
    at.acceptanceGates({ ...good, ...m }).filter(g => !g.pass).map(g => g.key);
  assert.deepEqual(fails({ sharpe: 1.49 }), ["sharpe"]);
  assert.deepEqual(fails({ sharpe: null }), ["sharpe"]);
  assert.deepEqual(fails({ maxDrawdownPct: 15.01 }), ["maxDrawdown"]);
  assert.deepEqual(fails({ hitRatePct: 54.9 }), ["hitRate"]);
  assert.deepEqual(fails({ tStat: 1.99 }), ["tStat"]);
  assert.deepEqual(fails({ years: 4.9 }), ["history"]);
  assert.deepEqual(fails({ netPnl: 0 }), ["netPnl"]);
  // Boundaries are inclusive where the paper says ≥ / ≤.
  assert.deepEqual(fails({ sharpe: 1.5, maxDrawdownPct: 15, hitRatePct: 55, tStat: 2, years: 5 }), []);
});

test("backtest rules with the acceptance test and reports every gate", async () => {
  const r = await at.runWalkForwardBacktest(2000);
  assert.equal(r.acceptance.gates.length, 6);
  assert.deepEqual(r.acceptance.gates.map(g => g.key), ["sharpe", "maxDrawdown", "hitRate", "tStat", "history", "netPnl"]);
  // A 2,000-tick run covers about an hour of market time, far short of 5 years.
  const history = r.acceptance.gates.find(g => g.key === "history")!;
  assert.ok(history.value! < 0.01 && !history.pass);
  assert.equal(r.acceptance.passed, false);
  if (r.outOfSample.trades >= 30) {
    assert.equal(r.verdict, "FAIL");
    assert.match(r.verdictMessage, /acceptance gates/);
    assert.match(r.verdictMessage, /History tested/);
  } else {
    assert.equal(r.verdict, "MARGINAL");
  }
  // Out-of-sample calibration counts every out-of-sample trade.
  assert.equal(r.calibration.n, r.outOfSample.trades);
});

test("statistics behind the gates", () => {
  near(stats.tStat([1, 2, 3, 4])!, 2.5 / (Math.sqrt(5 / 3) / 2));
  assert.equal(stats.tStat([1, 1, 1]), null);
  assert.equal(stats.tStat([1]), null);
  // Constant growth has no variance, so no Sharpe; a noisy rising curve has a positive one.
  assert.equal(stats.annualisedSharpe([100, 101, 102.01], 252), null);
  const up = [100, 101, 100.5, 102, 101.8, 103];
  assert.ok(stats.annualisedSharpe(up, 252)! > 0);
  assert.ok(stats.annualisedSharpe([...up].reverse(), 252)! < 0);
  // Annualising scales with √periods.
  near(stats.annualisedSharpe(up, 400)! / stats.annualisedSharpe(up, 100)!, 2, 1e-9);
});

// ── 2. Stale quotes ─────────────────────────────────────────────────────────

test("entries need a quote fresher than ENTRY_MAX_QUOTE_AGE_MS during the session", async () => {
  const t = "AAPL";
  assert.ok(alpaca.ALPACA_STOCK_TICKERS.has(t));
  const open = new Date(2026, 8, 28, 11, 0);   // Monday 11:00 ET
  const closed = new Date(2026, 8, 27, 11, 0); // Sunday
  assert.equal(at.entryBlockReason(t, open), "no_live_quote");
  assert.equal(at.entryBlockReason(t, closed), "market_closed");

  quoteAge.set(t, 25_000); // older than the entry limit, younger than the 30 s cut-off
  await alpaca.refreshAllPrices();
  assert.ok(alpaca.getAlpacaQuote(t), "still a usable mark");
  assert.equal(at.entryBlockReason(t, open), "stale_quote");
  assert.equal(at.holdsOnStaleQuote(t), false, "a 25 s quote is fresh enough to manage a position");

  quoteAge.set(t, 2_000);
  await alpaca.refreshAllPrices();
  assert.equal(at.entryBlockReason(t, open), null);

  // Simulated instruments have no quote to go stale.
  assert.equal(at.entryBlockReason("BTC", open), null);
  assert.equal(at.holdsOnStaleQuote("BTC"), false);
});

test("a live position whose quote has gone stale holds", () => {
  const t = "AAPL";
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000; // the last quote is now over 30 s old
    assert.equal(alpaca.getAlpacaQuote(t), null);
    assert.equal(at.holdsOnStaleQuote(t), true);
  } finally {
    Date.now = realNow;
  }
  assert.equal(at.holdsOnStaleQuote(t), false);
});

// ── 3. Per-class Kelly ──────────────────────────────────────────────────────

test("sizing uses the class's own record, shrunk toward the pooled one", () => {
  const pooled = { wins: 50, losses: 50, totalWin: 50, totalLoss: 50 };
  // Default prior unchanged: the pooled estimate is what sizing used before.
  assert.deepEqual(stats.classEdge(undefined, pooled), stats.estimateEdge(pooled));
  // A class with no trades sizes exactly like the pooled record.
  const empty = stats.classEdge({ wins: 0, losses: 0, totalWin: 0, totalLoss: 0 }, pooled);
  near(empty.p, stats.estimateEdge(pooled).p);
  near(empty.b, stats.estimateEdge(pooled).b);
  // A long, clearly profitable class record moves its own estimate well above the pooled one.
  const strong = stats.classEdge({ wins: 140, losses: 60, totalWin: 280, totalLoss: 60 }, pooled);
  assert.ok(strong.p > 0.65 && strong.b > 1.9 && strong.kelly > 0.5, JSON.stringify(strong));
  // Three lucky trades move it less than two hundred good ones.
  const lucky = stats.classEdge({ wins: 3, losses: 0, totalWin: 9, totalLoss: 0 }, pooled);
  assert.ok(lucky.p < strong.p && lucky.kelly < strong.kelly, JSON.stringify(lucky));
});

test("planEntry sizes from the class record and reports its win probability", () => {
  const pooled = { wins: 50, losses: 50, totalWin: 50, totalLoss: 50 };
  const cls = { wins: 140, losses: 60, totalWin: 280, totalLoss: 60 };
  const portfolio = { cash: 10_000, totalValue: 10_000 };
  const base = at.planEntry(100, 0.8, 90, "A+", "crypto", portfolio, pooled);
  const withClass = at.planEntry(100, 0.8, 90, "A+", "crypto", portfolio, pooled, cls);
  assert.ok(withClass.kf > base.kf, `${withClass.kf} > ${base.kf}`);
  near(withClass.pWin, stats.classEdge(cls, pooled).p);
  near(base.pWin, stats.estimateEdge(pooled).p);
  // The risk cap still binds however good the class looks.
  assert.ok(withClass.kf <= 0.08);
  const stopLoss = (100 - withClass.stop) * withClass.shares;
  assert.ok(stopLoss <= portfolio.totalValue * withClass.kf + 1e-6);
});

test("signals carry the win probability they were sized with", () => {
  at.resetAutoTraderState();
  for (let i = 0; i < 40; i++) at.autoTraderTick();
  const sigs = at.scanForBreakouts({ advance: false });
  assert.ok(sigs.length > 0);
  for (const s of sigs) assert.ok(s.winProb > 0 && s.winProb < 1, `${s.ticker} ${s.winProb}`);
});

// ── 4. Calibration ──────────────────────────────────────────────────────────

test("Brier score and reliability table", () => {
  const perfect = stats.calibrationReport([{ p: 1, won: true }, { p: 0, won: false }]);
  assert.equal(perfect.brier, 0);
  const coin = stats.calibrationReport([{ p: 0.5, won: true }, { p: 0.5, won: false }]);
  assert.equal(coin.brier, 0.25);
  assert.equal(coin.baseRate, 0.5);
  near(coin.skill!, 0); // no better than always saying the base rate
  const r = stats.calibrationReport([
    { p: 0.1, won: false }, { p: 0.15, won: false }, { p: 0.9, won: true }, { p: 1, won: true }, { p: 0.85, won: false },
  ]);
  assert.deepEqual(r.bins.map(b => [b.lo, b.n]), [[0, 2], [0.8, 3]]); // p = 1 lands in the top bin
  near(r.bins[1].hitRate, 2 / 3);
  assert.ok(r.skill! > 0);
  const none = stats.calibrationReport([]);
  assert.equal(none.n, 0);
  assert.equal(none.brier, null);
});

test("closed trades are logged with their win probability and scored per class", () => {
  clearCalibration();
  recordCalibration({ tradeId: 1, ticker: "BTC", marketType: "crypto", p: 0.6, won: true, reason: "full_target" });
  recordCalibration({ tradeId: 2, ticker: "BTC", marketType: "crypto", p: 0.6, won: false, reason: "stopped_out" });
  recordCalibration({ tradeId: 3, ticker: "EUR/USD", marketType: "forex", p: 0.4, won: false, reason: "max_hold" });
  const c = at.liveCalibration();
  assert.equal(c.n, 3);
  near(c.brier!, (0.16 + 0.36 + 0.16) / 3);
  assert.equal(c.byClass.crypto.n, 2);
  assert.equal(c.byClass.forex.n, 1);
  at.resetAutoTraderState();
  assert.equal(at.liveCalibration().n, 0, "a full reset clears the log with the record");
});

test("the engine logs a calibration row for each trade it closes", () => {
  at.resetAutoTraderState();
  for (let i = 0; i < 400 && at.getAutoTraderState().closedTrades < 3; i++) at.autoTraderTick();
  const closed = at.getAutoTraderState().closedTrades;
  assert.ok(closed >= 1, "the engine closed some trades");
  const c = at.liveCalibration();
  assert.equal(c.n, closed);
  assert.ok(c.brier !== null && c.brier >= 0 && c.brier <= 1);
});
