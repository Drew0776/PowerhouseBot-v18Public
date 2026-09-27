/**
 * Technical indicators computed from a price series.
 *
 * Every function takes closes oldest → newest, sampled at a fixed interval
 * (the engine samples once per tick), and returns null until it has enough
 * history. Pure functions: no state, no I/O.
 */

/** Simple moving average of the last n values. */
export function sma(xs: number[], n: number): number | null {
  if (n <= 0 || xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

/**
 * Exponential moving average series with smoothing α = 2/(n+1), seeded with
 * the SMA of the first n values (the usual charting convention). Element k of
 * the result corresponds to xs[n - 1 + k].
 */
export function emaSeries(xs: number[], n: number): number[] {
  if (n <= 0 || xs.length < n) return [];
  const a = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += xs[i];
  e /= n;
  const out = [e];
  for (let i = n; i < xs.length; i++) {
    e = a * xs[i] + (1 - a) * e;
    out.push(e);
  }
  return out;
}

export function ema(xs: number[], n: number): number | null {
  const s = emaSeries(xs, n);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Wilder's RSI: average gain and loss seeded with the simple mean of the
 * first n changes, then smoothed as avg = (prev·(n−1) + current) / n.
 * Needs n + 1 closes. A flat series reads 50; one with no losses reads 100.
 */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * MACD(fast, slow, signal): line = EMA(fast) − EMA(slow), signal = EMA of the
 * line, histogram = line − signal. Needs slow + signal − 1 closes.
 */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9):
  { macd: number; signal: number; hist: number } | null {
  if (closes.length < slow + signal - 1) return null;
  const f = emaSeries(closes, fast), s = emaSeries(closes, slow);
  const offset = slow - fast; // f[k + offset] and s[k] refer to the same close
  const line = s.map((v, k) => f[k + offset] - v);
  const sig = emaSeries(line, signal);
  const m = line[line.length - 1], g = sig[sig.length - 1];
  return { macd: m, signal: g, hist: m - g };
}

/**
 * Bollinger %B: where the last close sits in the band SMA(n) ± k·σ, with σ the
 * population standard deviation (Bollinger's definition). 0 = lower band,
 * 1 = upper band; can fall outside [0, 1]. A flat window reads 0.5.
 */
export function bollingerPctB(closes: number[], n = 20, k = 2): number | null {
  const m = sma(closes, n);
  if (m === null) return null;
  let v = 0;
  for (let i = closes.length - n; i < closes.length; i++) v += (closes[i] - m) ** 2;
  const sd = Math.sqrt(v / n);
  if (sd === 0) return 0.5;
  const lower = m - k * sd;
  return (closes[closes.length - 1] - lower) / (2 * k * sd);
}

/**
 * Sample standard deviation of the last n one-step log returns — realized
 * volatility per sampling interval. Needs n + 1 closes, n ≥ 2.
 */
export function realizedVol(closes: number[], n: number): number | null {
  if (n < 2 || closes.length < n + 1) return null;
  const r: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    if (!(closes[i] > 0 && closes[i - 1] > 0)) return null;
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mu = r.reduce((a, b) => a + b, 0) / n;
  const v = r.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1);
  return Math.sqrt(v);
}

/**
 * Momentum over k steps in units of expected noise: the k-step log return
 * divided by σ·√k. Scale-free, so a 1% move in a quiet instrument and a 5% move
 * in a volatile one can score alike. Null when σ is 0 or history is short.
 */
export function momentumZ(closes: number[], k: number, sigma: number | null): number | null {
  if (!sigma || sigma <= 0 || closes.length < k + 1) return null;
  const a = closes[closes.length - 1 - k], b = closes[closes.length - 1];
  if (!(a > 0 && b > 0)) return null;
  return Math.log(b / a) / (sigma * Math.sqrt(k));
}
