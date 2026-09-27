/**
 * server/indicators.ts against an independent Python implementation (values
 * below were computed separately with the textbook formulas) and against
 * properties any correct implementation must satisfy.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/indicators.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, emaSeries, rsi, macd, bollingerPctB, realizedVol, momentumZ } from "../indicators.js";

// 120-step geometric random walk (LCG-driven), shared with the Python reference.
const SERIES = [99.005092,99.841764,99.421791,98.847903,99.302401,99.367394,99.028757,99.529227,100.038273,100.124043,100.494212,100.767756,101.408161,100.886253,100.632805,101.05211,101.453163,100.551998,100.922528,100.857748,101.713407,102.340686,101.571607,101.598132,102.461643,102.848655,103.144779,103.304639,104.159376,105.013496,104.74552,104.401236,105.107636,104.755594,104.03022,103.610038,103.46192,103.038333,103.943379,104.062714,104.540983,105.333996,104.408248,103.936329,104.062439,104.080758,103.917361,103.28116,104.129402,103.206514,102.929186,102.608798,102.946775,103.824198,103.855048,103.162681,102.968138,102.523443,102.245892,102.090495,101.749209,101.813658,102.046147,101.503141,102.331715,102.245458,102.990485,103.269204,103.547061,103.580706,103.590961,103.983265,104.901459,104.685003,105.121887,104.599934,104.781802,104.469156,104.115813,103.889985,104.504165,105.296279,104.480406,105.149516,104.265225,104.071064,103.352493,102.483631,103.505752,102.927751,103.200591,102.468931,102.381064,102.571497,101.831144,102.693971,103.486867,104.29842,105.105082,105.965744,106.520604,106.043232,105.010106,104.482801,103.600615,102.573021,102.812994,102.262115,102.756514,102.734651,103.120682,102.581842,103.368749,102.822678,102.563778,103.375746,102.58973,102.567697,101.553163,102.395447];
const REF = { rsi14: 45.38349968464603, ema12: 102.7081892954465, macd: -0.38869334999647265, signal: -0.2831566820504482, hist: -0.10553666794602445, pctB: 0.3210233214704729, vol60: 0.0059847986340449445 };
const close = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} vs ${b}`);

test("matches the independent reference implementation", () => {
  close(rsi(SERIES, 14), REF.rsi14);
  close(ema(SERIES, 12), REF.ema12);
  const m = macd(SERIES)!;
  close(m.macd, REF.macd); close(m.signal, REF.signal); close(m.hist, REF.hist);
  close(bollingerPctB(SERIES, 20, 2), REF.pctB);
  close(realizedVol(SERIES, 60), REF.vol60);
});

test("RSI boundary behaviour", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const flat = Array(30).fill(100);
  assert.equal(rsi(up), 100);
  assert.equal(rsi(down), 0);
  assert.equal(rsi(flat), 50);
  // Equal-sized alternating moves: gains and losses balance → 50.
  const zig = Array.from({ length: 31 }, (_, i) => (i % 2 ? 101 : 100));
  close(rsi(zig.slice(0, 15)), 50, 1e-12);
  assert.equal(rsi(up.slice(0, 14)), null, "needs n + 1 closes");
});

test("moving averages", () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  const c = Array(40).fill(7);
  assert.ok(emaSeries(c, 10).every(v => Math.abs(v - 7) < 1e-12), "EMA of a constant is the constant");
  assert.equal(emaSeries([1, 2, 3], 3).length, 1);
  assert.equal(emaSeries([1, 2, 3], 3)[0], 2, "seeded with the SMA");
});

test("MACD of a linear ramp", () => {
  // For x_t = t the EMA lags by (n−1)/2, so MACD → (26−1)/2 − (12−1)/2 = 7 and
  // the histogram → 0 as the signal line converges.
  const ramp = Array.from({ length: 400 }, (_, i) => i);
  const m = macd(ramp)!;
  close(m.macd, 7, 1e-6);
  close(m.hist, 0, 1e-6);
  assert.equal(macd(ramp.slice(0, 33)), null, "needs slow + signal − 1 closes");
});

test("Bollinger %B edges", () => {
  assert.equal(bollingerPctB(Array(20).fill(5)), 0.5, "flat window");
  const w = [...Array(19).fill(10), 10];
  assert.equal(bollingerPctB(w), 0.5);
  const spike = [...Array(19).fill(10), 20];
  const pb = bollingerPctB(spike)!;
  assert.ok(pb > 1, `a jump above the band reads > 1 (got ${pb})`);
});

test("realized volatility and momentum z", () => {
  const g = Array.from({ length: 50 }, (_, i) => 100 * Math.exp(0.001 * i));
  close(realizedVol(g, 40), 0, 1e-12); // constant log return → zero dispersion
  assert.equal(momentumZ(g, 5, 0), null, "zero sigma → undefined");
  close(momentumZ(g, 5, 0.001), 0.005 / (0.001 * Math.sqrt(5)), 1e-9);
  assert.equal(realizedVol([1, 0, 1], 2), null, "non-positive prices are rejected");
});
