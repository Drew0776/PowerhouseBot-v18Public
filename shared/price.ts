/**
 * Round a price to a precision that fits its magnitude: `dp` decimals at $1
 * and above, 6 significant digits below $1. Fixed-decimal rounding erased
 * sub-cent instruments (PEPE ≈ $0.00001 rounded to 0, and dividing by that 0
 * produced NaN prices).
 */
export function roundPrice(p: number, dp = 4): number {
  if (!Number.isFinite(p) || p === 0) return p;
  if (Math.abs(p) >= 1) {
    const f = 10 ** dp;
    return Math.round(p * f) / f;
  }
  return Number(p.toPrecision(6));
}

/** Display a price: `dp` decimals at $1 and above, 4 significant digits below. */
export function formatPrice(p: number | null | undefined, dp = 2): string {
  if (p == null || !Number.isFinite(p)) return "—";
  if (Math.abs(p) >= 1) return p.toFixed(dp);
  if (p === 0) return (0).toFixed(dp);
  return Number(p.toPrecision(4)).toString();
}

/** Signed dollar amount with the sign before the "$": +$1.20, -$1.20, $0.00. */
export function signedUsd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Number(n.toFixed(dp));
  if (v === 0) return `$${(0).toFixed(dp)}`;
  return `${v > 0 ? "+" : "-"}$${Math.abs(v).toFixed(dp)}`;
}
