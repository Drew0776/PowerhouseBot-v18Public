/**
 * Per-tick volatility of the simulated price walks (auto-trader and grid bot),
 * by asset class. Stocks under $5 use the "penny" class.
 */
export const TICK_VOL_BASE = 0.0012;
export const CLASS_VOL: Record<string, number> = { stock: 1.0, penny: 2.0, crypto: 1.5, forex: 0.4, commodity: 0.7, index: 0.5 };

export function simTickVol(price: number, mt: string): number {
  const cls = mt === "stock" && price < 5 ? "penny" : mt;
  return TICK_VOL_BASE * (CLASS_VOL[cls] ?? 1.0);
}
