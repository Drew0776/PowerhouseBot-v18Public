/**
 * Small statistics toolkit for sizing and backtest verdicts. Pure functions.
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

/**
 * Win probability p and payoff ratio b (average win ÷ average loss) estimated
 * from closed trades, shrunk toward neutral priors (p = ½, b = 1) with
 * `prior` pseudo-trades on each side, so a handful of results can't swing
 * sizing. With no history this returns p = ½, b = 1, Kelly = 0.
 */
export function estimateEdge(
  h: { wins: number; losses: number; totalWin: number; totalLoss: number },
  prior = 5,
): { p: number; b: number; kelly: number } {
  const n = h.wins + h.losses;
  const p = (h.wins + prior) / (n + 2 * prior);
  const unit = n > 0 ? (h.totalWin + h.totalLoss) / n : 1;
  const avgWin = (h.totalWin + prior * unit) / (h.wins + prior);
  const avgLoss = (h.totalLoss + prior * unit) / (h.losses + prior);
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  return { p, b, kelly: kellyFraction(p, b) };
}
