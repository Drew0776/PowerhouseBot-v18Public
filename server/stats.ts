/**
 * Small statistics toolkit for sizing, backtest verdicts and calibration.
 * Pure functions.
 */

const T975_SMALL = [12.7062, 4.3027, 3.1824, 2.7764]; // df = 1..4
const Z975 = 1.959964;

/**
 * Two-sided 95% Student-t critical value t(0.975, df). Exact table for df ≤ 4,
 * then the Cornish–Fisher expansion around the normal quantile, which is
 * within 0.005 of the true value for df ≥ 5.
 */
export function tCritical975(df: number): number {
  if (!(df >= 1)) return NaN;
  if (df <= 4) return T975_SMALL[Math.floor(df) - 1];
  const z = Z975, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z
    + (z3 + z) / (4 * df)
    + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

/** Mean with a two-sided 95% confidence interval (Student t). Needs n ≥ 2. */
export function meanCI95(xs: number[]): { n: number; mean: number; lo: number; hi: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = tCritical975(n - 1) * sd / Math.sqrt(n);
  return { n, mean, lo: mean - half, hi: mean + half };
}

/**
 * Kelly fraction for a bet that wins b times the amount at risk with
 * probability p: f* = p − (1 − p) / b. Negative means the bet has no edge.
 */
export function kellyFraction(p: number, b: number): number {
  if (!(b > 0)) return -1;
  return p - (1 - p) / b;
}

export type EdgeRecord = { wins: number; losses: number; totalWin: number; totalLoss: number };
export type Edge = { p: number; b: number; kelly: number; avgWin: number; avgLoss: number };

/**
 * Win probability p and payoff ratio b (average win ÷ average loss) estimated
 * from closed trades, shrunk toward a prior with `prior` pseudo-trades on each
 * side, so a handful of results can't swing sizing. The prior defaults to
 * neutral (p = ½, average win = average loss); pass `toward` to shrink toward
 * another estimate instead, e.g. one market class's record toward the pooled
 * one. With no history and the default prior this returns p = ½, b = 1,
 * Kelly = 0.
 */
export function estimateEdge(
  h: EdgeRecord,
  prior = 5,
  toward?: { p: number; avgWin: number; avgLoss: number },
): Edge {
  const n = h.wins + h.losses;
  const unit = n > 0 ? (h.totalWin + h.totalLoss) / n : 1;
  const t = toward ?? { p: 0.5, avgWin: unit, avgLoss: unit };
  const p = (h.wins + 2 * prior * t.p) / (n + 2 * prior);
  const avgWin = (h.totalWin + prior * t.avgWin) / (h.wins + prior);
  const avgLoss = (h.totalLoss + prior * t.avgLoss) / (h.losses + prior);
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  return { p, b, kelly: kellyFraction(p, b), avgWin, avgLoss };
}

/**
 * Edge for one market class: that class's own record, shrunk toward the
 * pooled record of every class. A class with few trades sizes like the
 * engine overall; one with a long record sizes from its own win rate and
 * payoff ratio.
 */
export function classEdge(cls: EdgeRecord | undefined, pooled: EdgeRecord, prior = 5): Edge {
  const all = estimateEdge(pooled, prior);
  return cls ? estimateEdge(cls, prior, all) : all;
}

/** t-statistic of the mean, mean ÷ (sd / √n). Null below two values or with no spread. */
export function tStat(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
}

/**
 * Annualised Sharpe ratio of an equity curve sampled at equal intervals:
 * mean ÷ sd of the period returns, times √(periods per year). Risk-free rate
 * taken as zero. Null with fewer than two returns or no variation.
 */
export function annualisedSharpe(equity: number[], periodsPerYear: number): number | null {
  const r: number[] = [];
  for (let i = 1; i < equity.length; i++) if (equity[i - 1] > 0) r.push(equity[i] / equity[i - 1] - 1);
  if (r.length < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null;
}

export type CalibrationBin = { lo: number; hi: number; n: number; meanP: number; hitRate: number };
export type CalibrationReport = {
  n: number;
  /** Mean squared error of the predicted win probability, 0 (perfect) to 1. */
  brier: number | null;
  /** Share of predictions that came true. */
  baseRate: number | null;
  /** Brier score of always predicting the base rate, the no-skill reference. */
  referenceBrier: number | null;
  /** 1 − brier ÷ referenceBrier: above 0 beats the base rate, below 0 is worse. */
  skill: number | null;
  bins: CalibrationBin[];
};

/**
 * Brier score and a reliability table for predicted probabilities `p` of an
 * event against what happened (`won`). A calibrated forecaster's bins have
 * hit rates close to their mean predictions.
 */
export function calibrationReport(rows: Array<{ p: number; won: boolean }>, binCount = 5): CalibrationReport {
  const n = rows.length;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount, hi = (i + 1) / binCount;
    const inBin = rows.filter(r => r.p >= lo && (i === binCount - 1 ? r.p <= hi : r.p < hi));
    if (inBin.length === 0) continue;
    bins.push({
      lo, hi, n: inBin.length,
      meanP: inBin.reduce((a, r) => a + r.p, 0) / inBin.length,
      hitRate: inBin.filter(r => r.won).length / inBin.length,
    });
  }
  if (n === 0) return { n, brier: null, baseRate: null, referenceBrier: null, skill: null, bins };
  const brier = rows.reduce((a, r) => a + (r.p - (r.won ? 1 : 0)) ** 2, 0) / n;
  const baseRate = rows.filter(r => r.won).length / n;
  const referenceBrier = baseRate * (1 - baseRate);
  const skill = referenceBrier > 0 ? 1 - brier / referenceBrier : null;
  return { n, brier, baseRate, referenceBrier, skill, bins };
}
