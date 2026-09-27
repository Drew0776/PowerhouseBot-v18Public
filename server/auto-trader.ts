/**
 * POWERHOUSE AUTO-TRADER V17 — V16 Audit Fix
 *
 * V16 AUDIT FINDINGS (from V15 live 20-tick audit):
 *
 * FINDING 1 (CRITICAL): Gate exits 46% generating $0 P&L → FIXED
 *   Root cause: gate fired at pnlPct < +0.10% (break-even, not losing)
 *   Fix: tighten to pnlPct < -0.50% — only exit CLEARLY negative positions
 *   Expected: gate exits 46% → ~15%, FT rate 19% → 25%+
 *
 * FINDING 2 (HIGH): SOFI oversized at 36% of portfolio → FIXED
 *   Root cause: A+ grade full sizing with no single-position portfolio cap
 *   Fix: hard cap at 25% of totalValue per position
 *
 * FINDING 3 (HIGH): Score saturation all 100/100 → FIXED
 *   Root cause: SOFI getting MID_INSTRUMENTS 1.20× boost AND A+ grade
 *   Fix: SOFI removed from MID_INSTRUMENTS boost
 *
 * FINDING 4 (HIGH): Backtest MARGINAL (OOS WR 47%) → FIXED
 *   Root cause: backtest missing the momentum gate — diverged from live engine
 *   Fix: gate added to backtest evaluation loop (-0.5% at tick 40)
 *
 * FINDING 5 (MODERATE): FT rate dropped 27% → 19% → IMPROVED
 *   Root cause: gate recycling winners + forex undersized
 *   Fix: forex cap 12% → 15%, trend window +10t, gate loosened
 */

// sqlite is imported, not require()d: this package is ESM, where require is
// undefined, so the old require() threw and state was silently never saved in
// development (the production bundle happened to resolve it).
import { storage, sqlite, getStockData, getStockByTicker, STARTING_BALANCE } from "./storage";
import {
  getAlpacaPrice,
  getAlpacaQuote,
  getAlpacaPriceAgeMs,
  ALPACA_STOCK_TICKERS,
  startAlpacaFeed,
  getAlpacaStatus,
  isAlpacaConfigured,
} from "./alpaca";
import type { StockData } from "@shared/schema";
import { isRegularSessionOpen } from "./market-calendar";
import { rsi as rsiOf, ema, macd, bollingerPctB, realizedVol, momentumZ } from "./indicators";
import { roundPrice, formatPrice } from "@shared/price";
import { hashString } from "@shared/hash";
import { estimateEdge, meanCI95 } from "./stats";
import { simTickVol } from "./sim-vol";
import { notify } from "./alerts";

// ─── Task #49: Limit / Stop-Limit Order Config ───────────────────────────────
//
// Entries submit limit orders priced at-or-just-inside the current ask. If a
// limit isn't filled within ENTRY_FILL_WINDOW ticks it is repriced once, then
// cancelled. Exits are described at exitFill().

/** Max slippage (as a fraction of price) we'll accept relative to the limit. */
const ENTRY_SLIPPAGE_TOL = 0.0015;   // 0.15% above mid for buy entries
const ENTRY_REPRICE_TOL  = 0.0035;   // 0.35% above mid on the single reprice
/** How many ticks a pending entry order stays live before being repriced/cancelled. */
const ENTRY_FILL_WINDOW  = 3;
const ENTRY_MAX_ATTEMPTS = 2;        // 1 initial + 1 reprice

interface PendingEntry {
  sig: BreakoutSignal;
  limitPrice: number;
  submittedAtTick: number;
  attempts: number;
  status: "working" | "filled" | "cancelled";
}

const pendingEntries: PendingEntry[] = [];

/** Compute a limit price for a buy entry: at-or-just-inside the current ask. */
function computeEntryLimitPrice(sig: BreakoutSignal, tol: number): number {
  const q = getAlpacaQuote(sig.ticker);
  if (q && q.ask > 0 && q.bid > 0) {
    // Pay at most ask + tol (just-inside-ask, with tolerance for fast tape).
    return roundPrice(Math.min(q.ask, q.mid * (1 + tol)));
  }
  // No live quote — fall back to signal entry price with tolerance.
  return roundPrice(sig.entryPrice * (1 + tol));
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BreakoutSignal {
  ticker: string;
  price: number;
  score: number;
  rank: number;           // V9: composite rank (1 = best)
  grade: "A+" | "A" | "B" | "C";
  strategy: "momentum" | "squeeze" | "reversal" | "breakout";
  regime: "trending" | "ranging";
  reasons: string[];
  redFlags: string[];
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionSize: number;
  shares: number;
  kellyFraction: number;
  riskRewardRatio: number;
  atr: number;
  marketType: string;
}

export interface ActivePosition {
  tradeId: number;
  ticker: string;
  entryPrice: number;
  currentPrice: number;
  shares: number;
  sharesRemaining: number;
  stopLoss: number;
  trailingStop: number;
  takeProfit1: number;
  takeProfit2: number;
  highWaterMark: number;
  pnl: number;
  pnlPct: number;
  strategy: string;
  grade: string;
  enteredAt: string;
  tier1Hit: boolean;
  status: "running" | "stopped_out" | "target_hit" | "momentum_exit" | "circuit_breaker";
  /** P&L already realized by the T1 partial exit; counted into the trade's result at final close. */
  t1Pnl?: number;
  atr: number;
  ticksOpen: number;
  marketType: string;
}

export interface AutoTraderState {
  isRunning: boolean;
  totalTicks: number;
  totalTrades: number;
  openPositions: ActivePosition[];
  closedTrades: number;
  winRate: number;
  totalPnl: number;
  dailyPnl: number;
  circuitBreakerActive: boolean;
  regime: "trending" | "ranging" | "unknown";
  bestTrade: { ticker: string; pnl: number; pct: number } | null;
  lastScan: BreakoutSignal[];
  log: string[];
  eventFilterActive: boolean;
  currentEvent: string | null;
  totalSlippageCost: number;
  roiPct: number;
  pnlPerTick: number;
  tradesPerHundredTicks: number;
  sessionPeak: number;
  // V9 audit metrics
  t1HitRate: number;      // % of closed trades that hit T1
  maxHoldRate: number;    // % of closed trades that were MAX_HOLD
  capitalUtilization: number; // % of portfolio currently deployed
  stats: {
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    expectancy: number;
    sharpeApprox: number;
    totalWinAmount: number;
    totalLossAmount: number;
  };
}

// ─── V9 Constants — Audit-Corrected ──────────────────────────────────────────
// (Simulator volatility lives in sim-vol.ts, shared with the grid simulator.)

// FINDING 2 FIX: Tighter ATR-based targets
// ATR = price × tickVol × √20 × 1.0 (removed 1.5× multiplier that bloated ATR)
// Stock ATR = price × 0.0018 × 4.47 = price × 0.0081 = 0.81%
// T1 = 1.2×ATR = +0.97% (reachable in ~16 ticks at drift 0.006)
// T2 = 4.0×ATR = +3.24% (reachable in ~54 ticks — home run)
// Stop = 1.0×ATR = -0.81% (tight — fast loss-cut)
// R:R = T1/Stop = 1.2/1.0 = 1.2:1 (reliable, high frequency edge)

const STOP_MULT  = 1.5;   // V10: 1.5×ATR stop — survival room
const TP1_MULT   = 0.6;   // V14: T1 at 0.6×ATR — near-instant partial lock
const TP2_MULT   = 6.0;   // V14: wider T2 → avg win $1.48→$2.00 target
const TRAIL_MULT = 0.5;   // V10: ultra-tight trail after T1

// Trade management
const MAX_POSITIONS  = 5;    // 5 concurrent slots
const MAX_HOLD_NO_T1 = 50;   // V10: 50 ticks (was 30) — wider budget
const MAX_HOLD_T1    = 200;  // V10: 200 ticks after T1
const COOLDOWN       = 2;    // V14: 2-tick cooldown — max frequency target 14+/100t

// Risk
const DAILY_DD_LIMIT = 0.08;  // 8% circuit breaker
const KELLY_CAP      = 0.08;   // 8% max account risk per trade
const PROBE_RISK     = 0.0025; // 0.25% risk while there is no measured edge
const BACKTEST_MIN_TRADES = 30; // out-of-sample trades needed for a verdict

// FINDING 4 FIX: Capital utilization
// Min 30%, max 40% of available cash per position
// At $138 cash: each trade = $41-55 → 5 positions = full deployment
const POS_MIN_PCT = 0.35;  // V10: 35% min (was 30%) — bigger wins
const POS_MAX_PCT = 0.50;  // V10: 50% max (was 40%)

// ─── Market hours ────────────────────────────────────────────────────────────
// The old "event blackout" fired at fixed tick counts (FOMC at tick 200 …),
// not on real dates, so it only ever ran in the first ~30 minutes after a
// reset. It's replaced by a real session gate: with a live Alpaca feed, new
// stock entries are only taken during the US regular session (9:30–16:00 ET on
// exchange trading days, 13:00 on early-close days; see market-calendar.ts).
// eventFilterActive /
// currentEvent now report that gate so the dashboard badge stays meaningful.

function etNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function isUsMarketOpen(now: Date = etNow()): boolean {
  return isRegularSessionOpen(now);
}

/** Live mode: stock prices come from Alpaca, never from the simulator. */
function isLiveStock(ticker: string): boolean {
  return isAlpacaConfigured() && ALPACA_STOCK_TICKERS.has(ticker);
}

/** Why a new entry in this ticker is blocked right now, or null if allowed. */
function entryBlockReason(ticker: string): string | null {
  if (!isLiveStock(ticker)) return null;
  if (!isUsMarketOpen()) return "market_closed";
  if (!getAlpacaQuote(ticker)) return "no_live_quote";
  return null;
}

// ─── Slippage ─────────────────────────────────────────────────────────────────

// Execution cost per side as a fraction of notional — roughly half the
// typical quoted spread for the class. Stocks used to pay a flat $0.02/share,
// which is 2.4% of a $0.85 stock but 0.01% of a $177 one; cost that doesn't
// scale with price made cheap stocks look far worse than they trade.
const HALF_SPREAD_BPS: Record<string, number> = { stock: 2, penny: 15, crypto: 10, forex: 1, commodity: 5, index: 3 };

/**
 * Modelled execution cost for `shares` at `price`. Zero when a live Alpaca
 * quote exists for the ticker: those fills already happen at the ask (entry)
 * or bid (exit), so the spread is paid in the price itself.
 */
function slippage(shares: number, price: number, mt: string, ticker?: string): number {
  if (ticker && ALPACA_STOCK_TICKERS.has(ticker) && getAlpacaQuote(ticker)) return 0;
  return modelledCost(shares, price, mt);
}

/** Half-spread cost of trading `shares` at `price` for an instrument class. */
export function modelledCost(shares: number, price: number, mt: string): number {
  const cls = mt === "stock" && price < 5 ? "penny" : mt;
  const bps = HALF_SPREAD_BPS[cls] ?? HALF_SPREAD_BPS.stock;
  return Math.max(0, Math.round(shares * price * bps / 10000 * 10000) / 10000);
}

// ─── Price Simulator — driftless random walk ─────────────────────────────────
//
// Used for instruments without a live Alpaca quote. There is deliberately no
// directional drift: earlier versions switched on a strong upward trend for
// whatever the scanner picked and for every open position, which made the
// bot's own picks rise by construction and fabricated its win rate.

interface PriceState {
  price: number;
  lcg: number;
}

const _prices = new Map<string, PriceState>();
const _seeds  = new Map<string, number>();

function getVol(ticker: string, mt: string): number {
  // Only stocks under $5 count as penny stocks. (Any instrument under $5 used
  // to, so FX pairs near 1.0 moved at 5× their class volatility.)
  return simTickVol(getStockByTicker(ticker)?.price ?? 0, mt);
}

function advancePrice(ticker: string, mt: string): number {
  // V18: If real Alpaca price available for this stock, use it as the anchor
  // This replaces the GBM simulation with the actual market price
  if (ALPACA_STOCK_TICKERS.has(ticker)) {
    const realPrice = getAlpacaPrice(ticker);
    if (realPrice && realPrice > 0) {
      // Update the GBM state price to match real market (keeps direction model intact)
      const g = _prices.get(ticker);
      const stock = getStockByTicker(ticker);
      if (!g) {
        const h = hashString(ticker);
        _prices.set(ticker, { price: realPrice, lcg: h });
        _seeds.set(ticker, realPrice);
      } else {
        g.price = realPrice;
      }
      // Update stock data array with real price
      const all = getStockData();
      const idx = all.findIndex((s: {ticker: string}) => s.ticker === ticker);
      if (idx >= 0) all[idx] = { ...all[idx], price: realPrice };
      return realPrice;
    }
  }
  // Live stock without a fresh quote (feed hiccup, after hours): hold the last
  // known price. Simulating it would mark — and exit — real positions at
  // synthetic prices.
  const stock = getStockByTicker(ticker);
  if (!stock) return 0;
  if (isLiveStock(ticker)) return _prices.get(ticker)?.price ?? stock.price;

  // Simulation for crypto/forex/commodity, or for everything when no Alpaca
  // keys are configured.

  if (!_seeds.has(ticker)) _seeds.set(ticker, stock.price);
  const seed = _seeds.get(ticker)!;

  if (!_prices.has(ticker)) {
    const h = hashString(ticker);
    _prices.set(ticker, { price: stock.price, lcg: h });
  }
  const g = _prices.get(ticker)!;

  // LCG random
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u2 = g.lcg / 0xffffffff;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  const vol = getVol(ticker, mt);

  g.price = g.price * (1 + vol * z);

  // Bound ±55% from seed
  g.price = Math.max(seed * 0.20, Math.min(seed * 1.80, g.price));  // V11: ±80% bounds (was ±55%)
  g.price = roundPrice(g.price);

  // Update storage cache
  const all = getStockData();
  const idx = all.findIndex(s => s.ticker === ticker);
  if (idx >= 0) all[idx] = { ...all[idx], price: g.price };

  return g.price;
}

// ─── Price history ───────────────────────────────────────────────────────────
// One sample per instrument per engine tick, so every indicator sees evenly
// spaced data. (Samples used to arrive per tick, again for open positions, and
// again on every Alpaca quote, which made the spacing irregular.)

const HIST_LEN = 120;           // 4 minutes of 2-second ticks
const MIN_BARS = 21;            // RSI(14), %B(20), EMA(21) and σ(20) all defined
const _mtf = new Map<string, number[]>();

function sampleHistory(hist: Map<string, number[]>, ticker: string, price: number): void {
  if (!(price > 0)) return;
  const h = hist.get(ticker) ?? [];
  h.push(price);
  if (h.length > HIST_LEN) h.shift();
  hist.set(ticker, h);
}

/** Recent 3-sample average not clearly below the one 20 samples back. */
function trendGate(h: number[]): boolean {
  if (h.length < 6) return true; // not enough data → allow (scoring still needs MIN_BARS)
  const w = h.slice(-20);
  const earlyAvg  = (w[0] + w[1] + w[2]) / 3;
  const recentAvg = (w[w.length-1] + w[w.length-2] + w[w.length-3]) / 3;
  return recentAvg >= earlyAvg * 0.996; // allow entry unless clear -0.4%+ downtrend
}

function isTrendingUp(ticker: string): boolean {
  return trendGate(_mtf.get(ticker) ?? []);
}

// ─── Features computed from the price series ─────────────────────────────────
// These replace the seeded RSI / "MACD" / Bollinger / trend fields, which were
// generated once at startup from synthetic daily candles and never changed, so
// the ranking was frozen for the life of the process. Fundamentals the bot has
// no real source for (catalyst, short interest, volume spikes) no longer feed
// the trading decision.

export interface PriceFeatures {
  bars: number;
  rsi: number;              // Wilder RSI(14)
  pctB: number;             // Bollinger %B(20, 2)
  emaFast: number;          // EMA(9)
  emaSlow: number;          // EMA(21)
  macdHist: number | null;  // MACD(12, 26, 9) histogram; null until 34 samples
  sigma: number;            // realized σ of one-tick log returns (up to 60)
  momZ: number | null;      // 5-tick log return in σ·√5 units
}

export function featuresFrom(h: number[]): PriceFeatures | null {
  if (h.length < MIN_BARS) return null;
  const r = rsiOf(h, 14), b = bollingerPctB(h, 20, 2);
  const ef = ema(h, 9), es = ema(h, 21);
  const sigma = realizedVol(h, Math.min(60, h.length - 1));
  if (r === null || b === null || ef === null || es === null || sigma === null) return null;
  return {
    bars: h.length, rsi: r, pctB: b, emaFast: ef, emaSlow: es,
    macdHist: macd(h)?.hist ?? null, sigma, momZ: momentumZ(h, 5, sigma),
  };
}

function featuresFor(ticker: string): PriceFeatures | null {
  return featuresFrom(_mtf.get(ticker) ?? []);
}

// ─── ATR from realized volatility ────────────────────────────────────────────
// ATR ≈ price × σ_tick × √20 — the typical 20-tick move. σ is measured from the
// instrument's own recent prices; the class constant is only a fallback while
// history is short. Floors keep stops from sitting inside the quoted spread or
// collapsing on a flat tape: 5 bps of price, or the live bid-ask spread.

function atrFrom(price: number, sigma: number | null, fallbackVol: number, spread = 0): number {
  const s = sigma && sigma > 0 ? sigma : fallbackVol;
  return roundPrice(Math.max(price * s * Math.sqrt(20), price * 0.0005, spread));
}

function estimateATR(ticker: string, mt: string, price: number): number {
  const f = featuresFor(ticker);
  const q = ALPACA_STOCK_TICKERS.has(ticker) ? getAlpacaQuote(ticker) : null;
  const spread = q && q.ask > q.bid && q.bid > 0 ? q.ask - q.bid : 0;
  return atrFrom(price, f?.sigma ?? null, getVol(ticker, mt), spread);
}

/** Log formatting for prices: 4 decimals at $1+, 4 significant digits below. */
const px = (v: number) => formatPrice(v, 4);

/** Stop never at or below zero: at least 1% of the entry price. */
const stopFloor = (price: number) => price * 0.01;

// ─── FINDING 3 FIX: Rank-Based Selection ─────────────────────────────────────
// Instead of absolute score (everything = 100), compute a COMPOSITE RANK
// that genuinely differentiates instruments.
//
// Composite rank score (0-100):
//   40% RSI quality (how well RSI fits the ideal 65-75 sweet spot)
//   30% Volume spike (higher is better, normalized against universe)
//   20% Momentum (day change %, trend alignment)
//   10% Catalyst (news/event score)
//
// Only top MAX_POSITIONS instruments enter. No score threshold — pure ranking.

interface RankedSignal {
  ticker: string;
  compositeScore: number; // 0-100 composite rank score
  features: PriceFeatures;
  mt: string;
  grade: "A+" | "A" | "B" | "C";
  reasons: string[];
  strategy: "momentum" | "squeeze" | "reversal" | "breakout";
}

/**
 * Composite score (0–100) from price-derived features only:
 *   45%  RSI quality — peaks at 70 for stocks, 65 for other classes
 *   55%  trend — EMA(9) above EMA(21): 50, MACD histogram > 0: 30,
 *        5-tick momentum: up to 20 at +2σ
 * Full weight when RSI is 65–75 with both trend confirmations, ×0.92 with the
 * EMA confirmation only, ×0.8 otherwise.
 * Null (not tradeable) when RSI is outside 35–88 or, for stocks, %B < 0.15.
 */
function computeCompositeScore(f: PriceFeatures, mt: string): number | null {
  const isAlt = mt === "crypto" || mt === "forex" || mt === "commodity" || mt === "index";

  // Hard disqualifiers
  if (f.rsi < 35 || f.rsi > 88) return null;
  if (!isAlt && f.pctB < 0.15) return null;

  const rsiTarget = isAlt ? 65 : 70;
  const rsiWidth  = isAlt ? 20 : 18;
  const rsiScore = Math.max(0, 100 - Math.abs(f.rsi - rsiTarget) * (100 / rsiWidth));

  const up = f.emaFast > f.emaSlow;
  const macdUp = f.macdHist !== null && f.macdHist > 0;
  let trend = 0;
  if (up) trend += 50;
  if (macdUp) trend += 30;
  if (f.momZ !== null) trend += Math.max(0, Math.min(20, f.momZ * 10));

  // Confluence is applied as a discount on setups without it rather than a
  // bonus on those with it: same relative ordering, but scores stay within
  // 0–100 instead of piling up at a 100 cap where the ranking becomes arbitrary.
  const base = rsiScore * 0.45 + trend * 0.55;
  const sweet = f.rsi >= 65 && f.rsi <= 75;
  const factor = sweet && up && macdUp ? 1 : sweet && up ? 0.92 : 0.8;
  return Math.round(base * factor * 10) / 10;
}

/**
 * What the engine currently thinks of every instrument, for the dashboards,
 * computed from its own price history without advancing anything: the
 * composite score (null while warming up or when a gate rejects it), the
 * grade the scanner would assign by rank (top 20 only), RSI, and the price
 * change across the sampled window (up to HIST_LEN ticks, ~4 minutes).
 * The dashboards used to show scores fixed once at startup from random
 * "fundamentals", which had nothing to do with what the bot traded.
 */
export interface LiveSignal { score: number | null; grade: Grade | null; rank: number | null; rsi: number | null; changePct: number | null }
export function liveSignalView(): Map<string, LiveSignal> {
  const out = new Map<string, LiveSignal>();
  const ranked: Array<{ ticker: string; score: number }> = [];
  for (const s of getStockData()) {
    const mt = (s as any).marketType ?? "stock";
    const h = _mtf.get(s.ticker) ?? [];
    const f = featuresFrom(h);
    const c = f && trendGate(h) ? computeCompositeScore(f, mt) : null;
    const score = c !== null && c >= 20 ? c : null;
    out.set(s.ticker, {
      score, grade: null, rank: null, rsi: f ? Math.round(f.rsi * 10) / 10 : null,
      changePct: h.length >= 2 ? Math.round((h[h.length - 1] / h[0] - 1) * 10000) / 100 : null,
    });
    if (score !== null) ranked.push({ ticker: s.ticker, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => {
    const v = out.get(r.ticker)!;
    v.rank = i + 1;
    if (i < 20) v.grade = gradeFor(i);
  });
  return out;
}

/** The engine's sampled prices and indicators for one instrument (read-only). */
export function instrumentDetail(ticker: string): { history: number[]; features: PriceFeatures | null } {
  const history = [...(_mtf.get(ticker) ?? [])];
  return { history, features: featuresFrom(history) };
}

// ─── Market Regime ────────────────────────────────────────────────────────────

function detectRegime(): "trending" | "ranging" {
  let up = 0, down = 0;
  for (const s of getStockData()) {
    if ((s as any).marketType && (s as any).marketType !== "stock") continue;
    const f = featuresFor(s.ticker);
    if (!f) continue;
    if (f.emaFast > f.emaSlow) up++; else down++;
  }
  const tot = up + down;
  if (tot === 0) return "ranging";
  return Math.abs(up - down) / tot > 0.18 ? "trending" : "ranging";
}

// ─── Position Sizing — FINDING 4 FIX ─────────────────────────────────────────

function sizePosition(
  compositeScore: number,
  portfolio: { cash: number; totalValue: number },
  record: { wins: number; losses: number; totalWin: number; totalLoss: number },
): { posSize: number; kf: number } {
  const { cash, totalValue } = portfolio;

  // Compounding multiplier
  const mult = totalValue >= 500 ? 2.0
             : totalValue >= 300 ? 1.6
             : totalValue >= 200 ? 1.3
             : totalValue >= 150 ? 1.15
             : 1.0;

  // Risk per trade from the Kelly criterion, f* = p − (1 − p)/b, with p and b
  // estimated from this engine's own closed trades (shrunk toward p = ½,
  // b = 1 while the record is short). Half-Kelly, capped at KELLY_CAP. With
  // no measured edge (f* ≤ 0) it keeps trading at a small probe risk so it
  // can still gather evidence. (This used to treat the ranking score as a win
  // probability, which it isn't.)
  const edge = estimateEdge(record);
  const kf = Math.max(PROBE_RISK, Math.min(edge.kelly / 2, KELLY_CAP));

  // V9 AUDIT FIX: 30-40% of cash per position
  // Ensures 5 positions deploy 150-200% → full capital utilization
  let posSize = cash * (POS_MIN_PCT + (compositeScore / 100) * (POS_MAX_PCT - POS_MIN_PCT));
  posSize = Math.min(posSize * mult, cash * 0.95);

  return { posSize: Math.round(posSize * 100) / 100, kf };
}

// ─── Shared trade rules ──────────────────────────────────────────────────────
// The live engine and the walk-forward backtest both call these, so the
// backtest verdict is about the strategy that actually trades.

type Grade = "A+" | "A" | "B" | "C";

/** Grade by position in the ranked list: 1st A+, 2nd–3rd A, 4th–8th B, rest C. */
export function gradeFor(rankIdx: number): Grade {
  return rankIdx === 0 ? "A+" : rankIdx < 3 ? "A" : rankIdx < 8 ? "B" : "C";
}

/**
 * Stops, targets and size for a new entry at `price`. Size starts from
 * sizePosition's share of cash, is scaled by grade and the per-position caps
 * (25% of the portfolio, 15% for forex), and is then limited so a stop-out
 * loses at most kf of the portfolio. The risk limit is applied last so no
 * multiplier can push a trade past it.
 */
export function planEntry(
  price: number, atr: number, composite: number, grade: Grade, mt: string,
  portfolio: { cash: number; totalValue: number },
  record: { wins: number; losses: number; totalWin: number; totalLoss: number },
): { stop: number; tp1: number; tp2: number; posSize: number; shares: number; kf: number; rr: number } {
  const stop = Math.max(stopFloor(price), roundPrice(price - STOP_MULT * atr));
  const tp1  = roundPrice(price + TP1_MULT * atr);
  const tp2  = roundPrice(price + TP2_MULT * atr);
  const rr   = (tp1 - price) / Math.max(price - stop, price * 1e-6);

  let { posSize, kf } = sizePosition(composite, portfolio, record);
  // V14 AUDIT FIX: Grade-based sizing — A+=100%  A=85%  B=60%  C=40%
  posSize *= grade === "A+" ? 1.0 : grade === "A" ? 0.85 : grade === "B" ? 0.60 : 0.40;
  posSize = Math.min(posSize, portfolio.totalValue * (mt === "forex" ? 0.15 : 0.25));
  const stopPct = (price - stop) / price;
  if (stopPct > 0) posSize = Math.min(posSize, (portfolio.totalValue * kf) / stopPct);
  posSize = Math.floor(posSize * 100) / 100; // round down: never past the limit
  const shares = Math.max(0.0001, Math.floor((posSize / price) * 10000) / 10000);
  return { stop, tp1, tp2, posSize, shares, kf, rr };
}

/** Diversification: at most two stocks, and one position in each other class. */
export function typeSlotFree(openTypes: string[], mt: string): boolean {
  const same = openTypes.filter(t => t === mt).length;
  return mt === "stock" ? same < 2 : same < 1;
}

/**
 * Capital recycling: with every slot full, an A+ signal may replace the
 * weakest position that hasn't reached T1, has been open more than 8 ticks and
 * is up less than 0.5%.
 */
export function recycleCandidate<T>(open: T[], view: (p: T) => { tier1Hit: boolean; ticks: number; pnlPct: number }): T | null {
  const c = open.filter(p => { const v = view(p); return !v.tier1Hit && v.ticks > 8 && v.pnlPct < 0.5; });
  return c.length ? c.reduce((a, b) => (view(a).pnlPct < view(b).pnlPct ? a : b)) : null;
}

/** New trailing stop after a price high (moves only after T1, never down). */
export function raiseTrail(p: { tier1Hit: boolean; entry: number; highWaterMark: number; atr: number; trailingStop: number }): number {
  if (!p.tier1Hit) return p.trailingStop;
  const profPct = (p.highWaterMark - p.entry) / p.entry * 100;
  const tm = profPct > 20 ? 0.5 : profPct > 10 ? 0.7 : TRAIL_MULT;
  return Math.max(p.trailingStop, roundPrice(p.highWaterMark - tm * p.atr));
}

export type ExitReason = "circuit_breaker" | "full_target" | "max_hold" | "trail_lock" | "stopped_out" | "gate_exit" | "momentum_exit" | "recycled";

/**
 * Exit rule, highest priority first: circuit breaker, T2, max hold, trailing
 * stop, the -0.5% gate at 40 ticks, then an RSI collapse. `price` is the mark
 * (mid); `sellable` is what a sell would get (the bid when quoted). Targets
 * are resting limit sells, so they trigger on the sellable price.
 */
export function exitReasonFor(p: {
  price: number; sellable: number; entry: number; trailingStop: number; tp2: number;
  tier1Hit: boolean; ticks: number; rsi: number | null;
}, breaker: boolean): ExitReason | null {
  const pnlPct = (p.price - p.entry) / p.entry * 100;
  if (breaker) return "circuit_breaker";
  if (p.sellable >= p.tp2) return "full_target";
  if (p.ticks >= (p.tier1Hit ? MAX_HOLD_T1 : MAX_HOLD_NO_T1)) return "max_hold";
  if (p.price <= p.trailingStop) return pnlPct >= 0 ? "trail_lock" : "stopped_out";
  if (!p.tier1Hit && p.ticks >= 40 && pnlPct < -0.50) return "gate_exit";
  if ((p.rsi ?? 50) < 35 && pnlPct < -5 && !p.tier1Hit) return "momentum_exit";
  return null;
}

/**
 * Fill for an exit. T2 is a resting limit sell, so it fills at the target.
 * Every other exit (stop, trailing stop, time, gate, breaker) is a market sell
 * at the sellable price — the bid with a live quote, the simulated price
 * otherwise. Both pay the modelled half-spread when there is no live quote
 * (slippage() is zero with one, because the bid already includes it).
 *
 * Stops used to book at the stop price even when the market was already
 * below it, and target, stop and time exits paid no spread at all, which
 * made every losing trade look better than it could have been.
 */
export function exitFill(reason: ExitReason, p: { tp2: number; sellable: number }, cost: (price: number) => number): { price: number; cost: number } {
  const price = reason === "full_target" ? p.tp2 : p.sellable;
  return { price, cost: cost(price) };
}

// ─── Scanner — FINDING 3+5 FIX: Rank-Based ───────────────────────────────────

/**
 * Rank the universe and build entry signals. The live tick passes
 * `advance: true` to step prices and MTF history first; the preview endpoint
 * passes false so a GET never moves prices or rewrites engine state.
 */
export function scanForBreakouts(opts: { advance?: boolean } = {}): BreakoutSignal[] {
  const advance = opts.advance ?? true;
  const all = getStockData();
  const regime = detectRegime();

  // Step 1: Advance prices for instruments NOT in open positions
  // (Open positions are already advanced in managePositions — avoid double-advancing)
  const openTickers = new Set(state.openPositions.map(p => p.ticker));
  for (const s of advance ? all : []) {
    const mt = (s as any).marketType ?? "stock";
    if (openTickers.has(s.ticker)) {
      // Already advanced in managePositions — sample its current price once
      const g = _prices.get(s.ticker);
      sampleHistory(_mtf, s.ticker, g ? g.price : s.price);
    } else {
      const newPrice = advancePrice(s.ticker, mt);
      sampleHistory(_mtf, s.ticker, newPrice > 0 ? newPrice : s.price);
    }
  }

  // Step 2: Compute composite score for every instrument
  const ranked: Array<RankedSignal & { data: StockData }> = [];

  for (const s of all) {
    const mt = (s as any).marketType ?? "stock";

    // Needs enough evenly spaced history for the indicators
    const f = featuresFor(s.ticker);
    if (!f) continue;

    // MTF gate
    if (!isTrendingUp(s.ticker)) continue;

    const composite = computeCompositeScore(f, mt);
    if (composite === null || composite < 20) continue; // absolute floor only

    const strategy: RankedSignal["strategy"] = f.pctB >= 1 ? "breakout" : "momentum";

    const reasons: string[] = [];
    if (f.rsi >= 60 && f.rsi <= 80) reasons.push(`RSI ${Math.round(f.rsi)}`);
    if (f.macdHist !== null && f.macdHist > 0) reasons.push("MACD ✓");
    if (f.emaFast > f.emaSlow) reasons.push("EMA9 > EMA21");
    reasons.push(`%B ${f.pctB.toFixed(2)}`);
    if (f.momZ !== null && f.momZ >= 1) reasons.push(`Mom +${f.momZ.toFixed(1)}σ`);

    // Grade by composite rank (will be assigned after sorting)
    ranked.push({
      ticker: s.ticker,
      compositeScore: composite,
      features: f,
      mt,
      grade: "B",  // placeholder
      reasons,
      strategy,
      data: s,
    });
  }

  // Step 3: Sort by composite score (highest first)
  ranked.sort((a, b) => b.compositeScore - a.compositeScore);

  // Step 4: Convert top-N to BreakoutSignal (grade by rank position)
  const portfolio = storage.getPortfolio();
  const signals: BreakoutSignal[] = [];

  for (let i = 0; i < Math.min(ranked.length, 20); i++) {
    const r = ranked[i];
    const s = r.data;

    const grade = gradeFor(i);
    const price = s.price;
    const atr   = estimateATR(r.ticker, r.mt, price);
    if (portfolio.cash < 1) continue;
    const { stop, tp1, tp2, posSize, shares, kf, rr } =
      planEntry(price, atr, r.compositeScore, grade, r.mt, portfolio, edgeRecord());
    if (posSize < 0.10) continue;

    signals.push({
      ticker: r.ticker, price,
      score: Math.round(r.compositeScore),
      rank: i + 1,
      grade,
      strategy: r.strategy,
      regime,
      reasons: r.reasons,
      redFlags: [],
      entryPrice: price,
      stopLoss: stop,
      takeProfit1: tp1,
      takeProfit2: tp2,
      positionSize: posSize,
      shares,
      kellyFraction: kf,
      riskRewardRatio: Math.round(rr * 100) / 100,
      atr,
      marketType: r.mt,
    });
  }

  if (advance) {
    state.lastScan = signals.slice(0, 12);
    state.regime   = regime;
  }
  return signals;
}

// ─── State ───────────────────────────────────────────────────────────────────

let sessionStartValue = STARTING_BALANCE;
let sessionPeak = STARTING_BALANCE;
let t1HitCount = 0;
let maxHoldCount = 0;

let state: AutoTraderState = {
  isRunning: false, totalTicks: 0, totalTrades: 0,
  openPositions: [], closedTrades: 0, winRate: 0,
  totalPnl: 0, dailyPnl: 0, circuitBreakerActive: false,
  regime: "unknown", bestTrade: null, lastScan: [], log: [],
  eventFilterActive: false, currentEvent: null, totalSlippageCost: 0,
  roiPct: 0, pnlPerTick: 0, tradesPerHundredTicks: 0, sessionPeak: STARTING_BALANCE,
  t1HitRate: 0, maxHoldRate: 0, capitalUtilization: 0,
  stats: { avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, sharpeApprox: 0, totalWinAmount: 0, totalLossAmount: 0 },
};

let wins = 0, losses = 0, totalWinAmt = 0, totalLossAmt = 0;
let _tickInterval: ReturnType<typeof setInterval> | null = null;
let _equitySnapshotInterval: ReturnType<typeof setInterval> | null = null;
const cooldowns = new Map<string, number>();
const dailyStart = { value: STARTING_BALANCE, tick: 0, dateKey: '' }; // V17: dateKey tracks calendar day for daily P&L reset
const pnlHistory: number[] = [];

/** This engine's closed-trade record, the input to Kelly sizing. */
function edgeRecord() {
  return { wins, losses, totalWin: totalWinAmt, totalLoss: totalLossAmt };
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  state.log.unshift(`[${ts}] ${msg}`);
  if (state.log.length > 200) state.log.length = 200;
}

function updateStats() {
  const avgWin  = wins   > 0 ? totalWinAmt  / wins   : 0;
  const avgLoss = losses > 0 ? totalLossAmt / losses : 0;
  const pf  = totalLossAmt > 0 ? totalWinAmt / totalLossAmt : totalWinAmt > 0 ? 99 : 0;
  const wr  = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const exp = wr * avgWin - (1 - wr) * avgLoss;
  let sharpe = 0;
  if (pnlHistory.length >= 5) {
    const mean = pnlHistory.reduce((a, b) => a + b, 0) / pnlHistory.length;
    const std  = Math.sqrt(pnlHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlHistory.length);
    sharpe = std > 0 ? Math.round((mean / std) * 100) / 100 : 0;
  }
  const closed = wins + losses;
  state.t1HitRate   = closed > 0 ? Math.round((t1HitCount  / closed) * 100) : 0;
  state.maxHoldRate = closed > 0 ? Math.round((maxHoldCount / closed) * 100) : 0;
  state.stats = {
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(pf * 100) / 100,
    expectancy: Math.round(exp * 100) / 100,
    sharpeApprox: sharpe,
    totalWinAmount: Math.round(totalWinAmt * 100) / 100,
    totalLossAmount: Math.round(totalLossAmt * 100) / 100,
  };
}

// ─── Enter Trade — Limit-Order Submission (Task #49) ─────────────────────────
//
// enterTrade no longer fills at market on the spot. It runs the eligibility
// checks and then either:
//   (a) submits a pending limit order priced at-or-just-inside the current
//       ask (see computeEntryLimitPrice), or
//   (b) returns null if any pre-trade gate rejects.
//
// The pending order is filled, repriced, or cancelled by tickPendingEntries()
// in subsequent autoTraderTick() calls. The function returns the ActivePosition
// only when the order fills immediately (a marketable limit against current
// price); otherwise it returns null and the caller treats it as "no entry
// this tick".

/** Price a sell would get now: the bid with a live quote, else the mark. */
function sellablePrice(pos: ActivePosition): number {
  const q = ALPACA_STOCK_TICKERS.has(pos.ticker) ? getAlpacaQuote(pos.ticker) : null;
  return q && q.bid > 0 ? q.bid : pos.currentPrice;
}

/**
 * Sell a position's remaining shares at `fillPx` and book the result: trade
 * row, engine P&L, win/loss record, cooldown and log. The caller removes it
 * from state.openPositions.
 */
function closePosition(pos: ActivePosition, fillPx: number, exitSlip: number, reason: ExitReason): void {
  const closePnl = Math.round(((fillPx - pos.entryPrice) * pos.sharesRemaining - exitSlip) * 100) / 100;
  state.totalSlippageCost = Math.round((state.totalSlippageCost + exitSlip) * 10000) / 10000;
  storage.closeTrade(pos.tradeId, fillPx, exitSlip); // V17: pass slippage for P&L sync
  state.totalPnl = Math.round((state.totalPnl + closePnl) * 100) / 100;
  state.dailyPnl = Math.round((state.dailyPnl + closePnl) * 100) / 100;

  // Win/loss stats use the whole trade: final exit plus any T1 partial. A
  // break-even trade isn't a win, matching the portfolio and trade log.
  const tradePnl = Math.round((closePnl + (pos.t1Pnl ?? 0)) * 100) / 100;
  if (tradePnl > 0) {
    wins++; totalWinAmt += tradePnl;
    if (!state.bestTrade || tradePnl > state.bestTrade.pnl) {
      state.bestTrade = { ticker: pos.ticker, pnl: tradePnl, pct: pos.pnlPct };
    }
  } else {
    losses++; totalLossAmt += Math.abs(tradePnl);
  }
  pnlHistory.push(tradePnl);
  cooldowns.set(pos.ticker, state.totalTicks);
  state.closedTrades++;
  state.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  updateStats();

  const icon = closePnl >= 0 ? "✓" : "✗";
  log(`EXIT ${icon} ${reason.toUpperCase()} | ${pos.ticker} | ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct}% | Net ${closePnl >= 0 ? "+" : "-"}$${Math.abs(closePnl).toFixed(2)} | ${pos.ticksOpen} ticks`);
  const usd = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
  notify("exit", `Sold ${pos.ticker} (${reason.replace(/_/g, " ")})`,
    `${pos.sharesRemaining.toFixed(4)} sh at $${px(fillPx)}. Trade result ${usd(tradePnl)} after ${pos.ticksOpen} ticks.`);
}

function enterTrade(sig: BreakoutSignal): ActivePosition | null {
  if (state.circuitBreakerActive) return null;
  if (entryBlockReason(sig.ticker)) return null;

  const portfolio = storage.getPortfolio();
  if (portfolio.cash < sig.positionSize) return null;
  if (state.openPositions.some(p => p.ticker === sig.ticker)) return null;
  if (pendingEntries.some(p => p.status === "working" && p.sig.ticker === sig.ticker)) return null;

  const lastExit = cooldowns.get(sig.ticker) ?? 0;
  if (state.totalTicks - lastExit < COOLDOWN) return null;

  // Every entry check runs before capital recycling, so a position is only
  // closed to make room for an entry that will actually be placed. (It used to
  // close first, then let the cooldown or type limit reject the new entry.)
  const mt = sig.marketType;
  let recycle: ActivePosition | null = null;
  if (state.openPositions.length >= MAX_POSITIONS) {
    if (sig.grade !== "A+") return null; // not A+, wait for a slot
    recycle = recycleCandidate(state.openPositions, p => ({ tier1Hit: p.tier1Hit, ticks: p.ticksOpen, pnlPct: p.pnlPct }));
    if (!recycle) return null; // no recyclable position
  }
  const remainingTypes = state.openPositions.filter(p => p !== recycle).map(p => p.marketType);
  if (!typeSlotFree(remainingTypes, mt)) return null;

  if (recycle) {
    const fill = exitFill("recycled", { tp2: recycle.takeProfit2, sellable: sellablePrice(recycle) },
      price => slippage(recycle!.sharesRemaining, price, recycle!.marketType, recycle!.ticker));
    log(`♻️ RECYCLE | Closing ${recycle.ticker} (${recycle.pnlPct.toFixed(1)}% pnl, ${recycle.ticksOpen}t) → making room for A+ ${sig.ticker}`);
    closePosition(recycle, fill.price, fill.cost, "recycled");
    state.openPositions.splice(state.openPositions.indexOf(recycle), 1);
  }

  // Task #49: Submit a pending LIMIT order priced at-or-just-inside the ask
  // (or with ENTRY_SLIPPAGE_TOL above the simulated mid when no quote exists).
  // The actual fill / reprice / cancel is handled by tickPendingEntries().
  const limitPrice = computeEntryLimitPrice(sig, ENTRY_SLIPPAGE_TOL);
  const pending: PendingEntry = {
    sig: { ...sig, marketType: mt },
    limitPrice,
    submittedAtTick: state.totalTicks,
    attempts: 1,
    status: "working",
  };
  pendingEntries.push(pending);
  log(`📋 LIMIT BUY | ${sig.ticker}[${mt}] | ${sig.shares.toFixed(4)}sh @ $${px(limitPrice)} (mid $${px(sig.entryPrice)}) | working ≤${ENTRY_FILL_WINDOW}t`);

  // Try an immediate marketable-limit fill (current price already at-or-below limit).
  const filled = fillPendingEntry(pending);
  return filled;
}

/**
 * Attempt to fill a pending limit entry against the current market.
 * A buy limit fills when the current price is ≤ limitPrice. Returns the
 * created ActivePosition on fill, otherwise null (the order stays "working").
 */
function fillPendingEntry(pending: PendingEntry): ActivePosition | null {
  if (pending.status !== "working") return null;
  const sig = pending.sig;
  const mt = sig.marketType;

  // Re-check eligibility — circuit breaker / event blackout may have flipped
  // since submission, and an open position for this ticker may have appeared.
  if (state.circuitBreakerActive) { cancelPending(pending, "circuit_breaker"); return null; }
  const blocked = entryBlockReason(sig.ticker);
  if (blocked) { cancelPending(pending, blocked); return null; }
  if (state.openPositions.some(p => p.ticker === sig.ticker)) { cancelPending(pending, "duplicate"); return null; }
  if (state.openPositions.length >= MAX_POSITIONS) { cancelPending(pending, "no_slot"); return null; }

  const stock = getStockByTicker(sig.ticker);
  if (!stock) { cancelPending(pending, "no_stock"); return null; }
  // A buy fills at the ask when we have a live quote (mid otherwise).
  const q = ALPACA_STOCK_TICKERS.has(sig.ticker) ? getAlpacaQuote(sig.ticker) : null;
  const curPrice = q && q.ask > 0 ? q.ask : stock.price;

  // Buy limit fills only when market trades at or below the limit.
  if (!(curPrice > 0) || curPrice > pending.limitPrice) return null;

  // Entry slippage is folded into the entry price, the same way the backtest
  // does it, so live and backtest results are comparable.
  const entrySlip = slippage(sig.shares, curPrice, mt, sig.ticker);
  const fillPrice = roundPrice(curPrice + entrySlip / sig.shares);
  const portfolio = storage.getPortfolio();
  const total = fillPrice * sig.shares;
  if (total > portfolio.cash) { cancelPending(pending, "insufficient_cash"); return null; }
  state.totalSlippageCost = Math.round((state.totalSlippageCost + entrySlip) * 10000) / 10000;

  // Place exits relative to the actual fill (ask + entry costs), not the
  // signal's mid, keeping their ATR distances. Anchored to the mid, T1 could
  // sit below break-even once costs are charged and "lock in" a loss.
  const shift = fillPrice - sig.entryPrice;
  const at = (px: number) => roundPrice(px + shift);
  const stopLoss = Math.max(stopFloor(fillPrice), at(sig.stopLoss));
  const takeProfit1 = at(sig.takeProfit1);
  const takeProfit2 = at(sig.takeProfit2);

  const trade = storage.createTrade({
    ticker: sig.ticker, action: "buy", shares: sig.shares,
    price: fillPrice, total,
    stopLoss, takeProfit: takeProfit2,
    openedAt: new Date().toISOString(),
  });

  const pos: ActivePosition = {
    tradeId: trade.id, ticker: sig.ticker,
    entryPrice: fillPrice, currentPrice: fillPrice,
    shares: sig.shares, sharesRemaining: sig.shares,
    stopLoss, trailingStop: stopLoss,
    takeProfit1, takeProfit2,
    highWaterMark: fillPrice, pnl: 0, pnlPct: 0,
    strategy: sig.strategy, grade: sig.grade,
    enteredAt: new Date().toISOString(),
    tier1Hit: false, status: "running",
    atr: sig.atr, ticksOpen: 0, marketType: mt,
  };

  state.openPositions.push(pos);
  state.totalTrades++;
  pending.status = "filled";

  log(`✅ FILL ${sig.grade} | ${sig.ticker}[${mt}] | ${sig.shares.toFixed(4)}sh @ $${px(curPrice)} (limit $${px(pending.limitPrice)}; $${px(fillPrice)} incl. costs) | Stop $${px(stopLoss)} | T1 $${px(takeProfit1)} | Score ${sig.score}`);
  notify("entry", `Bought ${sig.ticker} (grade ${sig.grade}, score ${sig.score})`,
    `${sig.shares.toFixed(4)} sh at $${px(fillPrice)} ($${total.toFixed(2)}). Stop $${px(stopLoss)}, first target $${px(takeProfit1)}.`);
  return pos;
}

function cancelPending(pending: PendingEntry, reason: string): void {
  pending.status = "cancelled";
  log(`🚫 LIMIT CANCEL | ${pending.sig.ticker} | $${px(pending.limitPrice)} | ${reason}`);
}

/**
 * Tick the pending-orders queue. For each working order:
 *   1. Try to fill at the current price (marketable limit).
 *   2. If still working past ENTRY_FILL_WINDOW ticks, reprice once at a slightly
 *      more aggressive level (ENTRY_REPRICE_TOL above mid).
 *   3. If still unfilled past the second window, cancel — the bot is never
 *      left holding a phantom working order.
 * Returns the list of newly-filled positions (for logging by the caller).
 */
function tickPendingEntries(): ActivePosition[] {
  const filled: ActivePosition[] = [];
  for (const pe of pendingEntries) {
    if (pe.status !== "working") continue;

    // First attempt
    const pos = fillPendingEntry(pe);
    if (pos) { filled.push(pos); continue; }

    const age = state.totalTicks - pe.submittedAtTick;
    if (pe.attempts < ENTRY_MAX_ATTEMPTS && age >= ENTRY_FILL_WINDOW) {
      // Reprice once — more aggressive limit.
      const newLimit = computeEntryLimitPrice(pe.sig, ENTRY_REPRICE_TOL);
      log(`🔁 LIMIT REPRICE | ${pe.sig.ticker} | $${px(pe.limitPrice)} → $${px(newLimit)}`);
      pe.limitPrice = newLimit;
      pe.attempts++;
      pe.submittedAtTick = state.totalTicks;
      const re = fillPendingEntry(pe);
      if (re) filled.push(re);
    } else if (pe.attempts >= ENTRY_MAX_ATTEMPTS && age >= ENTRY_FILL_WINDOW) {
      cancelPending(pe, "fill_window_expired");
    }
  }

  // Garbage-collect completed pendings so the queue doesn't grow unbounded.
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    if (pendingEntries[i].status !== "working") pendingEntries.splice(i, 1);
  }
  return filled;
}

// ─── Manage Positions ─────────────────────────────────────────────────────────

/**
 * Forget positions whose trade was closed outside the engine (the Trade Log's
 * close button, a portfolio reset, a restored position whose row is gone).
 * The engine used to keep managing them and later booked P&L for a sale that
 * never happened. Their real result is already in the trade row.
 */
function dropExternallyClosed(): void {
  if (state.openPositions.length === 0) return;
  const open = new Set(storage.getOpenTrades().map(t => t.id));
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    if (open.has(pos.tradeId)) continue;
    state.openPositions.splice(i, 1);
    cooldowns.set(pos.ticker, state.totalTicks);
    log(`🧹 ${pos.ticker} was closed outside the engine; no longer tracked (its result is in the trade log)`);
  }
}

function managePositions() {
  dropExternallyClosed();
  const toClose: number[] = [];

  for (let i = 0; i < state.openPositions.length; i++) {
    const pos = state.openPositions[i];
    const stock = getStockByTicker(pos.ticker);
    if (!stock) continue;

    const mt = pos.marketType;
    const newPrice = advancePrice(pos.ticker, mt);
    const cur = newPrice > 0 ? newPrice : stock.price;

    pos.currentPrice = roundPrice(cur);
    pos.pnl = Math.round((pos.currentPrice - pos.entryPrice) * pos.sharesRemaining * 100) / 100;
    pos.pnlPct = Math.round(((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100;
    pos.ticksOpen++;
    const sellable = sellablePrice(pos);
    const cost = (price: number, shares = pos.sharesRemaining) => slippage(shares, price, mt, pos.ticker);

    // Update high water mark + trailing stop (after T1 only)
    if (pos.currentPrice > pos.highWaterMark) {
      pos.highWaterMark = pos.currentPrice;
      pos.trailingStop = raiseTrail({ tier1Hit: pos.tier1Hit, entry: pos.entryPrice, highWaterMark: pos.highWaterMark, atr: pos.atr, trailingStop: pos.trailingStop });
    }

    // Tier 1 partial exit (40% shares): a resting limit sell at T1.
    if (!pos.tier1Hit && sellable >= pos.takeProfit1) {
      pos.tier1Hit = true;
      const halfSh = Math.round(pos.sharesRemaining * 0.40 * 10000) / 10000;
      const exitSlip = cost(pos.takeProfit1, halfSh);
      const t1pnl = Math.round(((pos.takeProfit1 - pos.entryPrice) * halfSh - exitSlip) * 100) / 100;
      // Record the partial sale in the DB so the trade log and portfolio cash
      // match the engine; the open row keeps only the remaining shares.
      storage.partialCloseTrade(pos.tradeId, halfSh, pos.takeProfit1, exitSlip);
      pos.sharesRemaining -= halfSh;
      state.totalPnl = Math.round((state.totalPnl + t1pnl) * 100) / 100;
      state.dailyPnl = Math.round((state.dailyPnl + t1pnl) * 100) / 100;
      state.totalSlippageCost = Math.round((state.totalSlippageCost + exitSlip) * 10000) / 10000;
      pos.t1Pnl = t1pnl;
      t1HitCount++;
      log(`T1 HIT ✓ | ${pos.ticker} | ${t1pnl >= 0 ? "+" : "-"}$${Math.abs(t1pnl).toFixed(2)} locked | ${pos.sharesRemaining.toFixed(4)}sh → T2 $${px(pos.takeProfit2)}`);
    }

    const reason = exitReasonFor({
      price: pos.currentPrice, sellable, entry: pos.entryPrice, trailingStop: pos.trailingStop,
      tp2: pos.takeProfit2, tier1Hit: pos.tier1Hit, ticks: pos.ticksOpen, rsi: featuresFor(pos.ticker)?.rsi ?? null,
    }, state.circuitBreakerActive);
    if (!reason) continue;

    pos.status = reason === "circuit_breaker" ? "circuit_breaker"
      : reason === "full_target" ? "target_hit"
      : reason === "momentum_exit" ? "momentum_exit"
      : "stopped_out";
    if (reason === "max_hold") maxHoldCount++;
    if (reason === "gate_exit") log(`⚡ GATE EXIT | ${pos.ticker} | ${pos.pnlPct.toFixed(2)}% @ tick ${pos.ticksOpen} — clearly losing`);

    const fill = exitFill(reason, { tp2: pos.takeProfit2, sellable }, price => cost(price));
    closePosition(pos, fill.price, fill.cost, reason);
    toClose.push(i);
  }

  for (let i = toClose.length - 1; i >= 0; i--) {
    state.openPositions.splice(toClose[i], 1);
  }
}

// ─── Circuit Breaker — Graduated ─────────────────────────────────────────────

/** Today's drawdown vs dailyStart, and the tier limit it's measured against. */
function drawdownStatus(): { totalValue: number; dd: number; limit: number } {
  const p = storage.getPortfolio();
  const dd = (dailyStart.value - p.totalValue) / Math.max(dailyStart.value, 1);
  // Task #64: anchor the tier selector to the day's STARTING value, not the
  // jittery current portfolio. Otherwise a portfolio bouncing across $500 or
  // $200 silently swaps between the 3/5/8 % limits tick-to-tick, leaving a
  // trader who lost (say) 4 % from a $520 start protected one tick and
  // unprotected the next. The hard-floor branch below still uses p.totalValue
  // because it's a real-dollar liquidation safety net, not a tier label.
  const tierAnchor = dailyStart.value;
  const limit = tierAnchor >= 500 ? 0.03 : tierAnchor >= 200 ? 0.05 : DAILY_DD_LIMIT;
  return { totalValue: p.totalValue, dd, limit };
}

function checkCircuitBreaker() {
  const { totalValue, dd, limit } = drawdownStatus();
  const p = { totalValue };
  if (p.totalValue <= 50 && !state.circuitBreakerActive) {
    state.circuitBreakerActive = true;
    log(`🚨 HARD FLOOR $50 | Emergency stop`);
    notify("breaker", "Circuit breaker: $50 hard floor", `Portfolio at $${p.totalValue.toFixed(2)}. New entries stopped and open positions are being closed.`);
  } else if (dd >= limit && !state.circuitBreakerActive) {
    state.circuitBreakerActive = true;
    log(`⚠️ CIRCUIT BREAKER | Drawdown ${(dd*100).toFixed(1)}% ≥ ${(limit*100).toFixed(0)}% limit | Paused`);
    notify("breaker", "Circuit breaker tripped", `Down ${(dd * 100).toFixed(1)}% today (limit ${(limit * 100).toFixed(0)}%), portfolio $${p.totalValue.toFixed(2)}. New entries stopped and open positions are being closed.`);
  }
  // Once tripped the breaker stays latched for the auto-trader: it clears only
  // on a manual reset (resetCircuitBreaker) or when a new ET trading day
  // re-baselines dailyStart (rollDailyAnchor). Grid bots use the softer
  // isGridBreakerActive() below, which lets them resume once drawdown recovers.
}

/**
 * Initialize dailyStart on first use and roll it at ET midnight. A new day
 * also releases a latched breaker, since the daily-loss limit starts over.
 */
function rollDailyAnchor(markTick: number): void {
  const todayKey = etDateKey();
  const prevDateKey = dailyStart.dateKey;
  const isNewDay = !!prevDateKey && prevDateKey !== todayKey;
  if (dailyStart.tick === 0 || isNewDay) {
    const p = storage.getPortfolio();
    dailyStart.value = p.totalValue;
    dailyStart.tick  = markTick;
    dailyStart.dateKey = todayKey;
    if (isNewDay) {
      notify("daily", "Daily summary", `Previous trading day: auto-trader realized ${state.dailyPnl < 0 ? "-" : "+"}$${Math.abs(state.dailyPnl).toFixed(2)}. Portfolio starts today at $${p.totalValue.toFixed(2)}.`);
      state.dailyPnl = 0; // Reset for new trading day
      if (state.circuitBreakerActive) {
        state.circuitBreakerActive = false;
        log(`✅ CIRCUIT BREAKER RELEASED | New trading day`);
      }
      log(`🌅 NEW TRADING DAY — Daily P&L reset. Starting value: $${p.totalValue.toFixed(2)}`);
    }
  }
}

function etDateKey(): string {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
}

// ─── Main Tick ────────────────────────────────────────────────────────────────

export function autoTraderTick(): { signals: BreakoutSignal[]; entered: ActivePosition | null; exited: string[] } {
  state.totalTicks++;

  // V17 BUG FIX #2: Daily reset — check for new trading day (ET midnight-aware)
  rollDailyAnchor(state.totalTicks);

  // Market-hours gate status for the dashboard (only meaningful with a live feed).
  const wasClosed = state.eventFilterActive;
  const closed = isAlpacaConfigured() && !isUsMarketOpen();
  state.eventFilterActive = closed;
  state.currentEvent = closed ? "US market closed" : null;
  if (closed && !wasClosed) log(`📅 US MARKET CLOSED — no new stock entries until 9:30 ET`);
  else if (!closed && wasClosed) log(`✅ US MARKET OPEN — stock entries resumed`);

  checkCircuitBreaker();

  // V10.1: Reset price bounds every 400 ticks to prevent saturation at ±55% bounds
  // After many cycles prices drift to ceiling; reset allows fresh trending from new baseline
  if (state.totalTicks % 400 === 0 && state.totalTicks > 0) {
    _seeds.clear(); // Reset seed anchors; prices will re-seed from current _prices values
    const all = getStockData();
    for (const s of all) {
      const g = _prices.get(s.ticker);
      if (g) {
        _seeds.set(s.ticker, g.price); // Use current price as new seed
      }
    }
    log(`🔄 Price bounds reset at tick ${state.totalTicks} — fresh trending baseline`);
  }

  const prevOpen = state.openPositions.map(p => p.ticker);
  managePositions();
  const exited = prevOpen.filter(t => !state.openPositions.some(p => p.ticker === t));

  // Task #49: Tick the pending limit-order queue BEFORE scanning for new
  // signals. Working limits get a fresh fill attempt; expired ones reprice
  // once and then cancel cleanly.
  const filledFromPending = tickPendingEntries();
  let entered: ActivePosition | null = filledFromPending[0] ?? null;

  const signals = scanForBreakouts();

  // V9: Enter up to 2 per tick when slots available (fast capital deployment)
  if (!state.circuitBreakerActive) {
    const portfolio = storage.getPortfolio();
    const maxEnter = portfolio.totalValue >= 150 ? 2 : 1;
    // Count both filled positions AND working pending limits against the cap.
    const slotsTaken = state.openPositions.length + pendingEntries.filter(p => p.status === "working").length;
    let entered_count = filledFromPending.length;

    // Take top signals by rank (already sorted)
    for (const sig of signals.slice(0, 6)) {
      if (entered_count >= maxEnter) break;
      if (slotsTaken + (entered_count - filledFromPending.length) >= MAX_POSITIONS) break;
      const pos = enterTrade(sig);
      if (pos) { entered = pos; entered_count++; }
      else if (pendingEntries.some(p => p.status === "working" && p.sig.ticker === sig.ticker)) {
        // Limit submitted but not yet filled — still consumes one of this tick's slots.
        entered_count++;
      }
    }
  }

  // Update live metrics
  const pv = storage.getPortfolio();
  if (pv.totalValue > sessionPeak) sessionPeak = pv.totalValue;
  state.sessionPeak = sessionPeak;
  state.roiPct = Math.round(((pv.totalValue - sessionStartValue) / sessionStartValue) * 10000) / 100;
  state.pnlPerTick = state.totalTicks > 0 ? Math.round((state.totalPnl / state.totalTicks) * 10000) / 10000 : 0;
  state.tradesPerHundredTicks = state.totalTicks > 0 ? Math.round((state.totalTrades / state.totalTicks) * 10000) / 100 : 0;

  // Capital utilization
  const investedVal = state.openPositions.reduce((sum, pos) => sum + pos.currentPrice * pos.sharesRemaining, 0);
  state.capitalUtilization = pv.totalValue > 0 ? Math.round((investedVal / pv.totalValue) * 100) : 0;

  // Task #16: Persist positions on every tick so a restart can resume them immediately
  persistState();

  return { signals, entered, exited };
}

// ─── Walk-Forward Backtest ────────────────────────────────────────────────────

export interface BacktestResult {
  inSample: { ticks: number; trades: number; wins: number; losses: number; winRate: number; profitFactor: number; totalReturn: number; finalBalance: number; maxDrawdown: number; avgWin: number; avgLoss: number; totalSlippage: number; };
  outOfSample: { ticks: number; trades: number; wins: number; losses: number; winRate: number; profitFactor: number; totalReturn: number; finalBalance: number; maxDrawdown: number; avgWin: number; avgLoss: number; totalSlippage: number; };
  verdict: "PASS" | "FAIL" | "MARGINAL";
  verdictMessage: string;
  degradation: number;
  recommendation: string;
}

/**
 * Walk-forward backtest on fresh simulated paths: the first 80% of ticks are
 * in-sample, the rest out-of-sample (a trade counts where it was entered).
 *
 * It trades the live strategy with the shared rules above — ranking, grading,
 * sizing and the risk limit (planEntry), diversification, recycling, the T1
 * partial, the trailing stop and the exit priority (exitReasonFor / exitFill)
 * — and keeps real cash: an entry is paid for out of cash, so open positions
 * can never add up to more than the account. What it leaves out needs calendar
 * time or a live feed: the daily-loss breaker, market hours and limit-order
 * repricing (simulated entries always fill on the tick they are placed).
 */
export async function runWalkForwardBacktest(totalTicks = 1000): Promise<BacktestResult> {
  const splitAt = Math.floor(totalTicks * 0.8);
  const all = getStockData();
  const mtOf = (s: StockData) => (s as any).marketType ?? "stock";

  const lPrices = new Map<string, PriceState>();
  const lSeeds = new Map<string, number>();
  for (const s of all) {
    lPrices.set(s.ticker, { price: s.price, lcg: hashString(s.ticker) + 54321 });
    lSeeds.set(s.ticker, s.price);
  }
  const lMTF = new Map<string, number[]>();
  const lCooldowns = new Map<string, number>();

  // Same random walk as advancePrice, on this run's own paths.
  function lAdvance(ticker: string, mt: string): number {
    const g = lPrices.get(ticker)!;
    const seed = lSeeds.get(ticker)!;
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u2 = g.lcg / 0xffffffff;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    g.price = roundPrice(Math.max(seed * 0.20, Math.min(seed * 1.80, g.price * (1 + getVol(ticker, mt) * z))));
    return g.price;
  }

  interface SimPos {
    ticker: string; mt: string; entry: number; stop: number; trail: number; tp1: number; tp2: number;
    hwm: number; sharesRem: number; atr: number; tier1Hit: boolean; ticks: number; enteredAt: number;
    cur: number; pnlPct: number;
    t1pnl: number; // P&L already realized by the T1 partial; counted into the trade at close
  }

  const positions: SimPos[] = [];
  let cash = STARTING_BALANCE;
  const equity = () => cash + positions.reduce((a, p) => a + p.sharesRem * p.cur, 0);
  let peak = STARTING_BALANCE, maxDD_IS = 0, maxDD_OOS = 0, balAtSplit = STARTING_BALANCE;
  const record = { wins: 0, losses: 0, totalWin: 0, totalLoss: 0 }; // feeds Kelly sizing
  const half = { is: { w: 0, l: 0, wa: 0, la: 0, t: 0, sl: 0 }, oos: { w: 0, l: 0, wa: 0, la: 0, t: 0, sl: 0 } };
  const oosTradePnls: number[] = [];
  const side = (enteredAt: number) => (enteredAt <= splitAt ? half.is : half.oos);
  const cost = (shares: number, price: number, mt: string) => modelledCost(shares, price, mt);

  function close(pi: number, reason: ExitReason, tick: number) {
    const pos = positions[pi];
    const fill = exitFill(reason, { tp2: pos.tp2, sellable: pos.cur }, price => cost(pos.sharesRem, price, pos.mt));
    const pnl = (fill.price - pos.entry) * pos.sharesRem - fill.cost;
    cash += fill.price * pos.sharesRem - fill.cost;
    const tradePnl = pnl + pos.t1pnl;
    const h = side(pos.enteredAt);
    h.t++; h.sl += fill.cost;
    if (tradePnl > 0) { h.w++; h.wa += tradePnl; record.wins++; record.totalWin += tradePnl; }
    else { h.l++; h.la += Math.abs(tradePnl); record.losses++; record.totalLoss += Math.abs(tradePnl); }
    if (pos.enteredAt > splitAt) oosTradePnls.push(tradePnl);
    lCooldowns.set(pos.ticker, tick);
    positions.splice(pi, 1);
  }

  for (let tick = 1; tick <= totalTicks; tick++) {
    // Yield to the event loop every 10 ticks (~10 ms of work): a 5,000-tick
    // run takes several seconds, and it used to freeze every request and bot
    // loop meanwhile.
    if (tick % 10 === 0) await new Promise(resolve => setImmediate(resolve));
    // Same periodic re-anchoring of the price bounds as the live tick.
    if (tick % 400 === 0) for (const [t, g] of lPrices) lSeeds.set(t, g.price);
    for (const s of all) sampleHistory(lMTF, s.ticker, lAdvance(s.ticker, mtOf(s)));

    // Manage positions
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      pos.cur = lPrices.get(pos.ticker)!.price;
      pos.pnlPct = (pos.cur - pos.entry) / pos.entry * 100;
      pos.ticks++;
      if (pos.cur > pos.hwm) {
        pos.hwm = pos.cur;
        pos.trail = raiseTrail({ tier1Hit: pos.tier1Hit, entry: pos.entry, highWaterMark: pos.hwm, atr: pos.atr, trailingStop: pos.trail });
      }
      if (!pos.tier1Hit && pos.cur >= pos.tp1) {
        pos.tier1Hit = true;
        const sh = Math.round(pos.sharesRem * 0.40 * 10000) / 10000;
        const c = cost(sh, pos.tp1, pos.mt);
        const pnl = (pos.tp1 - pos.entry) * sh - c;
        cash += pos.tp1 * sh - c;
        side(pos.enteredAt).sl += c;
        pos.t1pnl += pnl;
        pos.sharesRem -= sh;
      }
      const reason = exitReasonFor({
        price: pos.cur, sellable: pos.cur, entry: pos.entry, trailingStop: pos.trail, tp2: pos.tp2,
        tier1Hit: pos.tier1Hit, ticks: pos.ticks, rsi: featuresFrom(lMTF.get(pos.ticker) ?? [])?.rsi ?? null,
      }, false);
      if (reason) close(pi, reason, tick);
    }

    const eq = equity();
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / Math.max(peak, 1);
    if (tick <= splitAt && dd > maxDD_IS) maxDD_IS = dd;
    if (tick > splitAt && dd > maxDD_OOS) maxDD_OOS = dd;
    if (tick === splitAt) balAtSplit = eq;

    // Rank and plan entries exactly as scanForBreakouts does.
    const ranked: Array<{ ticker: string; mt: string; composite: number; price: number; sigma: number }> = [];
    for (const s of all) {
      const mh = lMTF.get(s.ticker) ?? [];
      const f = featuresFrom(mh);
      if (!f || !trendGate(mh)) continue;
      const mt = mtOf(s);
      const composite = computeCompositeScore(f, mt);
      if (composite === null || composite < 20) continue;
      ranked.push({ ticker: s.ticker, mt, composite, price: lPrices.get(s.ticker)!.price, sigma: f.sigma });
    }
    ranked.sort((a, b) => b.composite - a.composite);

    const portfolio = { cash, totalValue: eq };
    if (cash < 1) continue;
    const signals = ranked.slice(0, 20).map((r, i) => {
      const grade = gradeFor(i);
      const atr = atrFrom(r.price, r.sigma, getVol(r.ticker, r.mt));
      return { ...r, grade, atr, plan: planEntry(r.price, atr, r.composite, grade, r.mt, portfolio, record) };
    }).filter(sg => sg.plan.posSize >= 0.10);

    // Entry loop: same limits and checks as autoTraderTick / enterTrade.
    const maxEnter = eq >= 150 ? 2 : 1;
    let entered = 0;
    for (const sg of signals.slice(0, 6)) {
      if (entered >= maxEnter) break;
      if (cash < sg.plan.posSize) continue;
      if (positions.some(p => p.ticker === sg.ticker)) continue;
      if (tick - (lCooldowns.get(sg.ticker) ?? 0) < COOLDOWN) continue;
      let recycleIdx = -1;
      if (positions.length >= MAX_POSITIONS) {
        if (sg.grade !== "A+") continue;
        const worst = recycleCandidate(positions, p => ({ tier1Hit: p.tier1Hit, ticks: p.ticks, pnlPct: p.pnlPct }));
        if (!worst) continue;
        recycleIdx = positions.indexOf(worst);
      }
      if (!typeSlotFree(positions.filter((_, i) => i !== recycleIdx).map(p => p.mt), sg.mt)) continue;
      if (recycleIdx >= 0) close(recycleIdx, "recycled", tick);

      const { shares } = sg.plan;
      const c = cost(shares, sg.price, sg.mt);
      const fillPrice = roundPrice(sg.price + c / shares);
      if (fillPrice * shares > cash) continue;
      cash -= fillPrice * shares;
      side(tick).sl += c;
      // Exits keep their distances from the cost-adjusted fill, as live.
      const shift = fillPrice - sg.price;
      const stop = Math.max(stopFloor(fillPrice), roundPrice(sg.plan.stop + shift));
      positions.push({
        ticker: sg.ticker, mt: sg.mt, entry: fillPrice, stop, trail: stop,
        tp1: roundPrice(sg.plan.tp1 + shift), tp2: roundPrice(sg.plan.tp2 + shift),
        hwm: fillPrice, sharesRem: shares, atr: sg.atr, tier1Hit: false, ticks: 0, enteredAt: tick,
        cur: sg.price, pnlPct: 0, t1pnl: 0,
      });
      entered++;
    }
  }
  const bal = equity();
  const [isW, isL, isWA, isLA, isT, isSl] = [half.is.w, half.is.l, half.is.wa, half.is.la, half.is.t, half.is.sl];
  const [oosW, oosL, oosWA, oosLA, oosT, oosSl] = [half.oos.w, half.oos.l, half.oos.wa, half.oos.la, half.oos.t, half.oos.sl];

  function mk(tks: number, trades: number, w: number, l: number, wa: number, la: number, sl: number, startB: number, endB: number, maxDD: number) {
    const pf = la > 0 ? Math.round((wa / la) * 100) / 100 : wa > 0 ? 99 : 0;
    const wr = trades > 0 ? Math.round((w / trades) * 10000) / 100 : 0;
    return {
      ticks: tks, trades, wins: w, losses: l, winRate: wr, profitFactor: pf,
      totalReturn: Math.round(((endB - startB) / Math.max(startB, 1)) * 10000) / 100,
      finalBalance: Math.round(endB * 100) / 100,
      maxDrawdown: Math.round(maxDD * 10000) / 100,
      avgWin:  w > 0 ? Math.round((wa / w)  * 100) / 100 : 0,
      avgLoss: l > 0 ? Math.round((la / l) * 100) / 100 : 0,
      totalSlippage: Math.round(sl * 100) / 100,
    };
  }

  const isR  = mk(splitAt, isT,  isW,  isL,  isWA,  isLA,  isSl,  STARTING_BALANCE, balAtSplit, maxDD_IS);
  const oosR = mk(totalTicks - splitAt, oosT, oosW, oosL, oosWA, oosLA, oosSl, balAtSplit, bal, maxDD_OOS);

  // Verdict from a 95% confidence interval on the mean out-of-sample trade
  // P&L, with at least BACKTEST_MIN_TRADES trades. (It used to rule on
  // profit-factor thresholds with as few as 3 trades.)
  const ci = meanCI95(oosTradePnls);
  const hasStat = ci !== null && ci.n >= BACKTEST_MIN_TRADES;
  const degrad = hasStat && isR.profitFactor > 0 && isR.profitFactor < 99 && oosR.profitFactor < 99
    ? Math.round(((isR.profitFactor - oosR.profitFactor) / isR.profitFactor) * 10000) / 100 : 0;
  const usd = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);

  let verdict: "PASS" | "FAIL" | "MARGINAL";
  let msg: string, rec: string;
  if (!hasStat) {
    verdict = "MARGINAL";
    msg = `Only ${oosT} out-of-sample trades; at least ${BACKTEST_MIN_TRADES} are needed before the result means anything.`;
    rec = "Run a longer backtest (2K–5K ticks).";
  } else if (ci!.lo > 0) {
    verdict = "PASS";
    msg = `Mean out-of-sample trade ${usd(ci!.mean)} (95% CI ${usd(ci!.lo)} to ${usd(ci!.hi)}, ${ci!.n} trades) is above zero.`;
    rec = "Edge measured on unseen simulated prices. Confirm it on live paper data before relying on it.";
  } else if (ci!.hi < 0) {
    verdict = "FAIL";
    msg = `Mean out-of-sample trade ${usd(ci!.mean)} (95% CI ${usd(ci!.lo)} to ${usd(ci!.hi)}, ${ci!.n} trades) is below zero: it loses money on unseen data.`;
    rec = "Don't trade this configuration.";
  } else {
    verdict = "MARGINAL";
    msg = `Mean out-of-sample trade ${usd(ci!.mean)}, but the 95% CI (${usd(ci!.lo)} to ${usd(ci!.hi)}, ${ci!.n} trades) includes zero: no evidence of an edge either way.`;
    rec = "Run longer, or change the strategy before trading it.";
  }

  return { inSample: isR, outOfSample: oosR, verdict, verdictMessage: msg, degradation: degrad, recommendation: rec };
}

// ─── Controls ─────────────────────────────────────────────────────────────────

export function startAutoTrader() {
  restoreState(); // V17: restore persisted state on start (including openPositions per Task #16)

  // Snapshot restored positions before clearing simulation maps
  const restoredPositions = [...state.openPositions];

  state.isRunning = true;
  state.dailyPnl = 0;
  // circuitBreakerActive is restored as persisted: stop/start (or a server
  // restart) must not bypass a tripped daily-loss breaker.

  // Reset all simulation state on start — prevents stale MTF blocking entries
  _prices.clear();
  _seeds.clear();
  _mtf.clear();
  cooldowns.clear();
  pendingEntries.length = 0; // Task #49: drop any stale working limits across restarts
  t1HitCount = 0;
  maxHoldCount = 0;

  // Task #16: Re-seed price simulator for any restored open positions so managePositions()
  // can advance prices correctly from the last known price on the very first tick.
  // This ensures stop-loss / take-profit checks fire immediately if levels were breached
  // during the downtime rather than waiting for GBM to drift back to those levels.
  for (const pos of restoredPositions) {
    const seedPrice = pos.currentPrice > 0 ? pos.currentPrice : pos.entryPrice;
    const h = hashString(pos.ticker);
    _prices.set(pos.ticker, { price: seedPrice, lcg: h });
    _seeds.set(pos.ticker, seedPrice);
  }

  const p = storage.getPortfolio();
  // Task #64: preserve the day's anchor across same-day restarts. If
  // restoreState() loaded a dailyStart already taken today (ET), keep it —
  // otherwise the breaker tier would silently re-baseline (e.g. a trader
  // already 4% down would lose their tier-1 protection after a process
  // restart). Re-baseline only on first-ever start or after the ET day
  // rolls over.
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayKey = `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
  const sameDayAnchorRestored = dailyStart.tick > 0 && dailyStart.dateKey === todayKey;
  if (sameDayAnchorRestored) {
    log(`🔒 Daily anchor restored: $${dailyStart.value.toFixed(2)} (same ET day — breaker tier preserved)`);
  } else {
    dailyStart.value = p.totalValue;
    dailyStart.tick  = state.totalTicks;
    dailyStart.dateKey = todayKey;
    state.circuitBreakerActive = false; // new day (or first start): daily limit starts over
    log(`🌅 Daily anchor initialized: $${p.totalValue.toFixed(2)}`);
  }
  sessionStartValue = p.totalValue;
  sessionPeak = p.totalValue;

  startAlpacaFeed(); // V18: kick off real price polling

  // V19: Server-side background tick loop — engine runs every 2s regardless of browser tab
  if (_tickInterval) clearInterval(_tickInterval);
  _tickInterval = setInterval(() => {
    if (state.isRunning) {
      try { autoTraderTick(); } catch (e) { console.error("[AutoTrader] tick error:", e); }
    }
  }, 2000);

  // Task #18: Periodic equity snapshot every 5 minutes so the equity curve shows
  // intra-session movement, not just step-jumps at trade exits.
  if (_equitySnapshotInterval) clearInterval(_equitySnapshotInterval);
  _equitySnapshotInterval = setInterval(() => {
    if (!state.isRunning) return;
    const snap = storage.getPortfolio();
    storage.addEquityCurvePoint({ timestamp: new Date().toISOString(), value: snap.totalValue });
  }, 5 * 60 * 1000);

  persistState(); // persist isRunning=true so server restart can auto-resume

  log(`🚀 V19 LIVE | $${p.totalValue.toFixed(2)} | Alpaca REAL prices | ServerTick | AutoResume | StatePersist`);
}

// V17 ISSUE #1: Persist state to SQLite so restarts don't wipe everything
// Task #16: openPositions now included so positions survive server restarts
// Bug 4 fix: use a safe replacer to strip non-JSON-safe values; never throw to caller
function safeReplacer(_key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "number" && !isFinite(value)) return null;
  return value;
}

function persistState() {
  try {
    const payload = {
      isRunning: state.isRunning,
      totalTicks: state.totalTicks,
      totalTrades: state.totalTrades,
      closedTrades: state.closedTrades,
      winRate: state.winRate,
      totalPnl: state.totalPnl,
      dailyPnl: state.dailyPnl,
      totalSlippageCost: state.totalSlippageCost,
      roiPct: state.roiPct,
      wins, losses, totalWinAmt, totalLossAmt,
      pnlHistory: pnlHistory.slice(-200),
      dailyStartValue: dailyStart.value,
      dailyStartTick: dailyStart.tick,
      dailyStartDateKey: dailyStart.dateKey,
      circuitBreakerActive: state.circuitBreakerActive,
      openPositions: state.openPositions,
    };
    const json = JSON.stringify(payload, safeReplacer);
    sqlite.prepare(`
      INSERT OR REPLACE INTO engine_state (id, state_json, updated_at)
      VALUES (1, ?, ?)
    `).run(json, new Date().toISOString());
  } catch (_e) { /* non-fatal — state still in memory */ }
}

function restoreState() {
  try {
    const row = sqlite.prepare("SELECT state_json FROM engine_state WHERE id = 1").get() as { state_json: string } | undefined;
    if (!row) return;
    const s = JSON.parse(row.state_json);
    state.totalTicks = s.totalTicks ?? 0;
    state.totalTrades = s.totalTrades ?? 0;
    state.closedTrades = s.closedTrades ?? 0;
    state.winRate = s.winRate ?? 0;
    state.totalPnl = s.totalPnl ?? 0;
    state.dailyPnl = s.dailyPnl ?? 0;
    state.totalSlippageCost = s.totalSlippageCost ?? 0;
    state.roiPct = s.roiPct ?? 0;
    wins = s.wins ?? 0; losses = s.losses ?? 0;
    totalWinAmt = s.totalWinAmt ?? 0; totalLossAmt = s.totalLossAmt ?? 0;
    pnlHistory.length = 0; // replace, don't append — restoreState runs on every start
    if (s.pnlHistory) pnlHistory.push(...s.pnlHistory);
    state.circuitBreakerActive = s.circuitBreakerActive === true;
    if (s.dailyStartValue) dailyStart.value = s.dailyStartValue;
    if (s.dailyStartTick) dailyStart.tick = s.dailyStartTick;
    if (s.dailyStartDateKey) dailyStart.dateKey = s.dailyStartDateKey;

    // Task #16: Restore open positions — deduplicate by ticker to prevent double-entry
    if (Array.isArray(s.openPositions) && s.openPositions.length > 0) {
      const seen = new Set<string>();
      state.openPositions = (s.openPositions as ActivePosition[]).filter(p => {
        if (!p || !p.ticker || seen.has(p.ticker)) return false;
        seen.add(p.ticker);
        return true;
      });
      const tickers = state.openPositions.map(p => p.ticker).join(", ");
      log(`♻️ State restored from DB: tick ${state.totalTicks}, P&L $${state.totalPnl.toFixed(2)}, positions: ${tickers}`);
    } else {
      log(`♻️ State restored from DB: tick ${state.totalTicks}, P&L $${state.totalPnl.toFixed(2)}`);
    }
  } catch (_e) { /* fresh start */ }
}

export function stopAutoTrader() {
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
  if (_equitySnapshotInterval) { clearInterval(_equitySnapshotInterval); _equitySnapshotInterval = null; }
  state.isRunning = false;
  persistState(); // save including isRunning: false
  // The Alpaca feed keeps running: grid bots and the dashboard use it too.
  log("⏹ V19 STOPPED");
}

// ─── Task #69: Scanner debug — why is nothing trading? ──────────────────────
//
// Mirrors the gate logic in scanForBreakouts() (mtf → rsi → bollinger →
// score) plus enterTrade()'s cooldown check, but read-only: no price
// advancement, no MTF mutation, no log spam. Used by GET
// /api/auto-trader/scan-debug so the operator can answer "is the bot
// gated by warm-up, by markets being flat, or actually trading?" without
// reading server logs.
export type ScanDebugGate =
  | "warmup"
  | "mtf"
  | "rsi"
  | "bollinger"
  | "score"
  | "cooldown"
  | "open_position"
  | null;

export interface ScanDebugCandidate {
  ticker: string;
  score: number | null;
  gateFailed: ScanDebugGate;
  mtfBars: number;
  price: number;
  priceAge: number; // ms since the last Alpaca quote; -1 if no cached price
}

export interface ScanDebugSnapshot {
  passed: number;
  rejected: number;
  topReason: ScanDebugGate;
  totalTicks: number;
  candidates: ScanDebugCandidate[];
}

export function getScanDebug(): ScanDebugSnapshot {
  const all = getStockData();
  const openTickers = new Set(state.openPositions.map(p => p.ticker));
  const candidates: ScanDebugCandidate[] = [];
  const reasonCount = new Map<Exclude<ScanDebugGate, null>, number>();
  let passed = 0;

  for (const s of all) {
    const mt = (s as any).marketType ?? "stock";
    const isAlt = mt === "crypto" || mt === "forex" || mt === "commodity" || mt === "index";
    const mtfHist = _mtf.get(s.ticker) ?? [];
    const g = _prices.get(s.ticker);
    const price = g ? g.price : s.price;

    let gateFailed: ScanDebugGate = null;
    let score: number | null = null;

    const f = featuresFrom(mtfHist);
    if (openTickers.has(s.ticker)) {
      // Scanner still ranks open positions, but they can't be re-entered.
      // Surface that so an operator doesn't wonder why an A+ candidate
      // never converts to a new entry.
      gateFailed = "open_position";
    } else if (!f) {
      gateFailed = "warmup"; // fewer than MIN_BARS evenly spaced samples yet
    } else if (!isTrendingUp(s.ticker)) {
      gateFailed = "mtf";
    } else if (f.rsi < 35 || f.rsi > 88) {
      gateFailed = "rsi";
    } else if (!isAlt && f.pctB < 0.15) {
      gateFailed = "bollinger";
    } else {
      score = computeCompositeScore(f, mt);
      if (score === null || score < 20) {
        gateFailed = "score";
      } else {
        // Cooldown reporting deviates intentionally from enterTrade()'s
        // `cooldowns.get(t) ?? 0` formula: that formula mislabels every
        // ticker as cooldown-gated for the first COOLDOWN ticks after
        // boot/reset, which is exactly the "why is nothing trading?"
        // confusion this endpoint exists to clear up. We only report
        // cooldown for tickers that have actually exited a prior trade.
        const lastExit = cooldowns.get(s.ticker);
        if (lastExit !== undefined && state.totalTicks - lastExit < COOLDOWN) {
          gateFailed = "cooldown";
        }
      }
    }

    if (gateFailed === null) {
      passed++;
    } else {
      reasonCount.set(gateFailed, (reasonCount.get(gateFailed) ?? 0) + 1);
    }

    candidates.push({
      ticker: s.ticker,
      score: score === null ? null : Math.round(score),
      gateFailed,
      mtfBars: mtfHist.length,
      price,
      priceAge: getAlpacaPriceAgeMs(s.ticker),
    });
  }

  let topReason: ScanDebugGate = null;
  let topN = 0;
  for (const [r, n] of reasonCount) {
    if (n > topN) { topN = n; topReason = r; }
  }

  return {
    passed,
    rejected: candidates.length - passed,
    topReason,
    totalTicks: state.totalTicks,
    candidates,
  };
}

export function resetCircuitBreaker(opts?: { manual?: boolean }) {
  state.circuitBreakerActive = false;
  const p = storage.getPortfolio();
  dailyStart.value = p.totalValue;
  // A manual reset must leave the anchor marked initialized (tick ≥ 1) even if
  // the auto-trader has never ticked (grid-only use); otherwise the next
  // evaluation re-baselines it again at whatever the portfolio is then.
  dailyStart.tick  = opts?.manual ? Math.max(1, state.totalTicks) : state.totalTicks;
  // Task #68: re-anchor the ET dateKey so the very next evaluateCircuitBreaker()
  // call doesn't fall into the "uninitialised" branch and re-baseline yet again.
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  dailyStart.dateKey = `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
  log(opts?.manual
    ? "🔁 Daily-loss breaker manually reset by operator"
    : "🔄 Circuit breaker reset");
}

export function getAutoTraderState(): AutoTraderState {
  return { ...state, openPositions: [...state.openPositions] };
}

// Task #50: expose breaker state so the grid engine can mirror the auto-trader's
// global hard-drawdown kill switch.
export function isCircuitBreakerActive(): boolean {
  return state.circuitBreakerActive;
}

/**
 * Task #50 — Portfolio-driven breaker evaluator. Runs the same trip/reset
 * logic as `checkCircuitBreaker()` but is safe to call when the auto-trader
 * tick loop is NOT running, so grid-only deployments still get a global
 * hard-drawdown kill switch. Initializes dailyStart on first call and rolls
 * the day key over at ET midnight just like the auto-trader does.
 */
export function evaluateCircuitBreaker(): boolean {
  try {
    rollDailyAnchor(Math.max(1, state.totalTicks)); // tick ≥ 1 marks it initialized
    checkCircuitBreaker();
  } catch (_e) { /* non-fatal */ }
  return state.circuitBreakerActive;
}

/**
 * Kill switch as seen by grid bots. They park when the breaker trips, but —
 * unlike the latched auto-trader — resume automatically once the drawdown is
 * back under the tier limit (and above the $50 hard floor). A manual reset or
 * a new trading day also releases them.
 */
export function isGridBreakerActive(): boolean {
  if (!evaluateCircuitBreaker()) return false;
  const { totalValue, dd, limit } = drawdownStatus();
  const recovered = totalValue > 50 && dd < limit;
  return !recovered;
}

export function isAutoTraderRunning(): boolean {
  return state.isRunning;
}

export function resetAutoTraderState() {
  // Clear background tick loop first
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
  if (_equitySnapshotInterval) { clearInterval(_equitySnapshotInterval); _equitySnapshotInterval = null; }
  // Stop the engine if running (the shared Alpaca feed stays up)
  state.isRunning = false;

  // Zero all counters and clear positions/history
  state.totalTicks          = 0;
  state.totalTrades         = 0;
  state.openPositions       = [];
  state.closedTrades        = 0;
  state.winRate             = 0;
  state.totalPnl            = 0;
  state.dailyPnl            = 0;
  state.circuitBreakerActive = false;
  state.regime              = "unknown";
  state.bestTrade           = null;
  state.lastScan            = [];
  state.log                 = [];
  state.eventFilterActive   = false;
  state.currentEvent        = null;
  state.totalSlippageCost   = 0;
  state.roiPct              = 0;
  state.pnlPerTick          = 0;
  state.tradesPerHundredTicks = 0;
  state.sessionPeak         = STARTING_BALANCE;
  state.t1HitRate           = 0;
  state.maxHoldRate         = 0;
  state.capitalUtilization  = 0;
  state.stats = { avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, sharpeApprox: 0, totalWinAmount: 0, totalLossAmount: 0 };

  // Reset local accumulators
  wins = 0; losses = 0; totalWinAmt = 0; totalLossAmt = 0;
  t1HitCount = 0; maxHoldCount = 0;
  sessionStartValue = STARTING_BALANCE;
  sessionPeak = STARTING_BALANCE;
  pnlHistory.length = 0;

  // Clear simulation maps
  _prices.clear(); _seeds.clear(); _mtf.clear();
  cooldowns.clear();
  pendingEntries.length = 0; // Task #49: drop pending limits on full reset

  // Reset daily tracking
  dailyStart.value = STARTING_BALANCE;
  dailyStart.tick  = 0;
  dailyStart.dateKey = '';

  // Remove persisted state so next restart begins clean
  try {
    sqlite.prepare("DELETE FROM engine_state WHERE id = 1").run();
  } catch (_e) { /* non-fatal */ }
}
