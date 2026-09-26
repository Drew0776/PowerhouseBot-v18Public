/**
 * server/stats.ts against textbook values.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/stats.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tCritical975, meanCI95, kellyFraction, estimateEdge } from "../stats.js";

const near = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("t critical values match standard tables", () => {
  // Two-sided 95% (t 0.975) from standard t tables.
  const table: [number, number][] = [[1, 12.706], [2, 4.303], [4, 2.776], [5, 2.571], [10, 2.228], [20, 2.086], [30, 2.042], [60, 2.000], [120, 1.980]];
  for (const [df, t] of table) near(tCritical975(df), t, df <= 4 ? 0.001 : 0.005);
  near(tCritical975(1e9), 1.96, 0.001);
});

test("95% CI of a mean", () => {
  // n = 5, mean 3, sample sd √2.5 → half-width 2.776 × √2.5 / √5 = 1.963
  const ci = meanCI95([1, 2, 3, 4, 5])!;
  near(ci.mean, 3, 1e-12);
  near(ci.hi - ci.mean, 2.7764 * Math.sqrt(2.5) / Math.sqrt(5), 1e-3);
  assert.equal(meanCI95([1]), null);
});

test("Kelly fraction", () => {
  near(kellyFraction(0.6, 1), 0.2, 1e-12);   // even-money coin at 60% → bet 20%
  near(kellyFraction(0.5, 1), 0, 1e-12);     // fair bet → no edge
  near(kellyFraction(0.4, 2), 0.1, 1e-12);   // 40% to win 2:1 → 10%
  assert.ok(kellyFraction(0.5, 0.4) < 0);    // tight target vs wide stop needs p > 1/(1+b)
});

test("edge estimate shrinks toward neutral with little data", () => {
  const none = estimateEdge({ wins: 0, losses: 0, totalWin: 0, totalLoss: 0 });
  assert.deepEqual([none.p, none.b, none.kelly], [0.5, 1, 0]);
  // 3 lucky wins must not produce a confident bet…
  const lucky = estimateEdge({ wins: 3, losses: 0, totalWin: 3, totalLoss: 0 });
  assert.ok(lucky.p < 0.62 && lucky.kelly < 0.35, JSON.stringify(lucky));
  // …but a long record converges on the observed numbers.
  const long = estimateEdge({ wins: 600, losses: 400, totalWin: 600, totalLoss: 400 });
  near(long.p, 0.6, 0.005); near(long.b, 1, 0.01); near(long.kelly, 0.2, 0.01);
  // The recorded session (20 trades, 50% wins, PF 0.52) has negative edge.
  const rec = estimateEdge({ wins: 10, losses: 10, totalWin: 3.74, totalLoss: 7.2 });
  assert.ok(rec.kelly < 0, JSON.stringify(rec));
});
