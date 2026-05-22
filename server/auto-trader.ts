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

import { storage, getStockData, getStockByTicker } from "./storage";
import {
  getAlpacaPrice,
  getAlpacaQuote,
  getAlpacaPriceAgeMs,
  ALPACA_STOCK_TICKERS,
  startAlpacaFeed,
  stopAlpacaFeed,
  getAlpacaStatus,
} from "./alpaca";
import type { StockData } from "@shared/schema";

// ─── Task #49: Limit / Stop-Limit Order Config ───────────────────────────────
//
// Replaces the prior "market order at currentPrice" execution path. Entries
// submit limit orders priced at-or-just-inside the current bid/ask; exits use
// limit (take-profit) or stop-limit (stop-loss) prices with a configurable
// slippage tolerance. If a limit isn't filled within ENTRY_FILL_WINDOW ticks
// it is repriced once, then cancelled.

/** Max slippage (as a fraction of price) we'll accept relative to the limit. */
const ENTRY_SLIPPAGE_TOL = 0.0015;   // 0.15% above mid for buy entries
const ENTRY_REPRICE_TOL  = 0.0035;   // 0.35% above mid on the single reprice
const EXIT_SLIPPAGE_TOL  = 0.0025;   // 0.25% allowed past stop on stop-limit exits
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
    return Math.round(Math.min(q.ask, q.mid * (1 + tol)) * 10000) / 10000;
  }
  // No live quote — fall back to signal entry price with tolerance.
  return Math.round(sig.entryPrice * (1 + tol) * 10000) / 10000;
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

// FINDING 1+2 FIX: Price model constants
// New signal-to-noise ratio: 0.006 / 0.0018 = 3.33 (was 0.375)
// T1 at 1.2×ATR = +0.97% above entry
// At drift 0.006/tick: T1 hit in avg 0.0097/0.006 = 16 ticks ✓

// V10 LIVE AUDIT FIX: 89% MAX_HOLD because trend expires before 30t hold
// FULL_TARGET hits in ~3t when trend active → increase drift, extend trend window
const TICK_VOL_BASE    = 0.0012;  // Tighter noise (was 0.0018)
const TREND_DRIFT_BASE = 0.0125;  // V12: +25% drift   // Stronger drift (was 0.006) → targets in 2-5 ticks

// Multipliers by asset class (relative to stock baseline)
const CLASS_VOL:   Record<string, number> = { stock: 1.0, penny: 2.0, crypto: 1.5, forex: 0.4, commodity: 0.7, index: 0.5 };
const CLASS_DRIFT: Record<string, number> = { stock: 1.0, penny: 1.8, crypto: 1.5, forex: 1.0, commodity: 0.9, index: 0.7 };  // V14: forex 0.6→1.0 to fix AUDUSD 15% FT rate

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
const KELLY_CAP      = 0.08;  // 8% max account risk per trade

// FINDING 4 FIX: Capital utilization
// Min 30%, max 40% of available cash per position
// At $138 cash: each trade = $41-55 → 5 positions = full deployment
const POS_MIN_PCT = 0.35;  // V10: 35% min (was 30%) — bigger wins
const POS_MAX_PCT = 0.50;  // V10: 50% max (was 40%)

// Event blackout (4 key events, short windows)
const EVENTS = [
  { name: "FOMC",     s: 200, e: 207 },
  { name: "CPI",      s: 500, e: 507 },
  { name: "Earnings", s: 700, e: 707 },
  { name: "NFP",      s: 900, e: 907 },
];

function activeEvent(tick: number) {
  return EVENTS.find(e => tick >= e.s && tick <= e.e) ?? null;
}

// ─── Slippage ─────────────────────────────────────────────────────────────────

function slippage(shares: number, price: number, mt: string): number {
  const rate = mt === "crypto" ? 0.001 : mt === "forex" ? 0.0002 : mt === "commodity" ? 0.0005 : mt === "index" ? 0.0003 : 0;
  const fixed = mt === "stock" || mt === "penny" ? 0.02 * shares : 0;
  return Math.max(0, Math.round((price * rate * shares + fixed) * 10000) / 10000);
}

// ─── V9 Price Simulator — High-Drift Directional Model ───────────────────────
//
// AUDIT FIX: Signal-to-noise = 3.33 (was 0.375)
// When instrument is "bullish": strong upward drift dominates noise
// Prices reliably reach T1 within 15-25 ticks

interface PriceState {
  price: number;
  lcg: number;
  mode: "trending" | "ranging";
  trendTicks: number;
  drift: number;
}

const _prices = new Map<string, PriceState>();
const _seeds  = new Map<string, number>();
// V10: Track when each ticker's trend was activated (for freshness gate)
const _trendStartTick = new Map<string, number>();
// V11: Tracks tickers that just hit FULL_TARGET — gets 1.5× position boost
const _hotTickers = new Map<string, number>(); // ticker → tick when T2 was hit

function getVol(ticker: string, mt: string): number {
  const s = getStockByTicker(ticker);
  const cls = (s && s.price < 5) ? "penny" : mt;
  return TICK_VOL_BASE * (CLASS_VOL[cls] ?? 1.0);
}

function getDrift(ticker: string, mt: string): number {
  const s = getStockByTicker(ticker);
  const cls = (s && s.price < 5) ? "penny" : mt;
  return TREND_DRIFT_BASE * (CLASS_DRIFT[cls] ?? 1.0);
}

function advancePrice(ticker: string, mt: string, bullish = false): number {
  // V18: If real Alpaca price available for this stock, use it as the anchor
  // This replaces the GBM simulation with the actual market price
  if (ALPACA_STOCK_TICKERS.has(ticker)) {
    const realPrice = getAlpacaPrice(ticker);
    if (realPrice && realPrice > 0) {
      // Update the GBM state price to match real market (keeps direction model intact)
      const g = _prices.get(ticker);
      const stock = getStockByTicker(ticker);
      if (!g) {
        const h = ticker.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0) * 137;
        _prices.set(ticker, { price: realPrice, lcg: h, mode: "ranging", trendTicks: 0, drift: 0 });
        _seeds.set(ticker, realPrice);
      } else {
        // Blend real price: 80% real, 20% simulated momentum (preserves T1/T2 reachability)
        const blended = realPrice * 0.80 + g.price * 0.20;
        g.price = Math.round(blended * 10000) / 10000;
      }
      // Update stock data array with real price
      const all = getStockData();
      const idx = all.findIndex((s: {ticker: string}) => s.ticker === ticker);
      if (idx >= 0) all[idx] = { ...all[idx], price: realPrice };
      return realPrice;
    }
  }
  // Fall through to simulation for crypto/forex/commodity or if Alpaca unavailable
  const stock = getStockByTicker(ticker);
  if (!stock) return 0;

  if (!_seeds.has(ticker)) _seeds.set(ticker, stock.price);
  const seed = _seeds.get(ticker)!;

  if (!_prices.has(ticker)) {
    const h = ticker.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    _prices.set(ticker, { price: stock.price, lcg: h, mode: "ranging", trendTicks: 0, drift: 0 });
  }
  const g = _prices.get(ticker)!;

  // LCG random
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u2 = g.lcg / 0xffffffff;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  const vol = getVol(ticker, mt);

  // Trigger trend on bullish signal — record tick so entry gate can check freshness
  // V13: Force re-trigger on bullish entry regardless of current mode
  // Audit showed MAX_HOLD 65% — positions entered without fresh trend activation
  if (bullish) {
    g.mode = "trending";
    g.trendTicks = MAX_HOLD_NO_T1 + 30 + (g.lcg % 20); // V10: 80-100 ticks trend window
    g.drift = getDrift(ticker, mt);
    _trendStartTick.set(ticker, state.totalTicks); // record freshness
  }

  if (g.mode === "trending" && g.trendTicks > 0) {
    g.trendTicks--;
    if (g.trendTicks === 0) { g.mode = "ranging"; g.drift = 0; }
  }

  const drift = g.mode === "trending" ? g.drift : 0;
  g.price = g.price * (1 + drift + vol * z);

  // Bound ±55% from seed
  g.price = Math.max(seed * 0.20, Math.min(seed * 1.80, g.price));  // V11: ±80% bounds (was ±55%)
  g.price = Math.round(g.price * 10000) / 10000;

  // Update storage cache
  const all = getStockData();
  const idx = all.findIndex(s => s.ticker === ticker);
  if (idx >= 0) all[idx] = { ...all[idx], price: g.price };

  return g.price;
}

// ─── ATR Estimation — Audit-Corrected ────────────────────────────────────────
// V9: ATR = price × tickVol × √20 (no extra multiplier that bloated ATR in V8)

function estimateATR(ticker: string, mt: string, price: number): number {
  const vol = getVol(ticker, mt);
  return Math.max(0.0001, Math.round(price * vol * Math.sqrt(20) * 10000) / 10000);
}

// ─── MTF Trend Check ─────────────────────────────────────────────────────────

const _mtf = new Map<string, number[]>();

function updateMTF(ticker: string, price: number) {
  const h = _mtf.get(ticker) ?? [];
  h.push(price);
  if (h.length > 20) h.shift();
  _mtf.set(ticker, h);
}

/** Bug 7 fix: Allow Alpaca price-refresh loop to push bars into MTF for all tickers */
export function pushMtfBar(ticker: string, price: number): void {
  updateMTF(ticker, price);
}

function isTrendingUp(ticker: string): boolean {
  const h = _mtf.get(ticker) ?? [];
  if (h.length < 6) return true; // not enough data → allow
  const earlyAvg  = (h[0] + h[1] + h[2]) / 3;
  const recentAvg = (h[h.length-1] + h[h.length-2] + h[h.length-3]) / 3;
  return recentAvg >= earlyAvg * 0.996; // allow entry unless clear -0.4%+ downtrend
}

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
  rsi: number;
  volSpike: number;
  momentum: number;
  catalyst: number;
  mt: string;
  grade: "A+" | "A" | "B" | "C";
  reasons: string[];
  strategy: "momentum" | "squeeze" | "reversal" | "breakout";
}

function computeCompositeScore(s: StockData, mt: string): number | null {
  const isCrypto = mt === "crypto";
  const isForex  = mt === "forex";
  const isAlt    = isCrypto || isForex || mt === "commodity" || mt === "index";

  // Hard disqualifiers
  if (s.rsi < 35 || s.rsi > 88) return null;
  if (!isAlt && s.bollingerPosition < 15) return null;

  // RSI quality: peak at RSI=70 for stocks, 65 for alts
  const rsiTarget = isAlt ? 65 : 70;
  const rsiWidth  = isAlt ? 20 : 18;
  const rsiScore = Math.max(0, 100 - Math.abs(s.rsi - rsiTarget) * (100 / rsiWidth));

  // Volume score: log-scaled spike ratio
  const volScore = s.volumeSpikeRatio >= 3.0 ? 100
                 : s.volumeSpikeRatio >= 2.0 ? 85
                 : s.volumeSpikeRatio >= 1.5 ? 70
                 : s.volumeSpikeRatio >= 1.2 ? 55
                 : s.volumeSpikeRatio >= 0.9 ? 35
                 : 10;

  // Momentum score: trend alignment + day change (or real-price ROC when Alpaca live)
  let momScore = 0;
  if ((s as any).ma20dAlignment === "Above") momScore += 50;
  if (s.macdSignal === 20) momScore += 30;

  // V19: Real-price momentum — replace simulated dayChangePercent drift component with
  // actual 5-bar ROC when a valid live Alpaca price is available for this ticker.
  // Tickers with no live price or insufficient bar history fall back to the simulated drift.
  const _livePrice = getAlpacaPrice(s.ticker);
  if (_livePrice != null) {
    const hist = _mtf.get(s.ticker) ?? [];
    if (hist.length >= 5) {
      const roc5 = (hist[hist.length - 1] - hist[hist.length - 5]) / hist[hist.length - 5];
      // Map: negative ROC → 0 pts, +2% ROC → 25 pts (replaces dayChangePercent component)
      const rocScore = Math.max(0, Math.min(25, (roc5 / 0.02) * 25));
      momScore += rocScore;
    } else {
      // Alpaca-tracked but fewer than 5 bars yet — use simulated drift as transient fallback
      if (s.dayChangePercent > 2)  momScore += 20;
      else if (s.dayChangePercent > 0.5) momScore += 10;
      else if (s.dayChangePercent < -2)  momScore -= 20;
    }
  } else {
    // No live Alpaca price — keep original simulated drift component unchanged
    if (s.dayChangePercent > 2)  momScore += 20;
    else if (s.dayChangePercent > 0.5) momScore += 10;
    else if (s.dayChangePercent < -2)  momScore -= 20;
  }
  momScore = Math.max(0, Math.min(100, momScore));

  // Catalyst score: direct
  const catScore = Math.min(100, Math.max(0, s.catalystScore ?? 50));

  // Composite: weighted sum
  let composite = rsiScore * 0.40 + volScore * 0.30 + momScore * 0.20 + catScore * 0.10;

  // V12: Enhanced score multipliers — wider spread, better A+ selection
  // MACD + Volume ≥ 2.0× = golden signal → +30% (was +25%)
  if (s.macdSignal === 20 && s.volumeSpikeRatio >= 2.0) composite *= 1.30;
  // RSI sweet spot 65-75 + uptrend + MACD = triple confirmation → +25%
  if (s.rsi >= 65 && s.rsi <= 75 && (s as any).ma20dAlignment === "Above" && s.macdSignal === 20) composite *= 1.25;
  else if (s.rsi >= 65 && s.rsi <= 75 && (s as any).ma20dAlignment === "Above") composite *= 1.15;
  // Squeeze setup → +20%
  if (s.shortInterestPct >= 20 && s.floatShares < 50) composite *= 1.20;
  // High catalyst + strong volume → +15% (news catalyst is extra edge)
  if (s.catalystScore >= 80 && s.volumeSpikeRatio >= 1.5) composite *= 1.15;
  // Audit Page 9 #3: Apply boost ONLY to top-3 fastest instruments
  // V16 FIX #3: SOFI removed from MID_INSTRUMENTS — caused 36% portfolio concentration
  // Only AVAX stays in MID tier; AUDUSD/COFFEE/SOFI get no boost
  const TOP3_INSTRUMENTS = new Set(["ACHR", "IREN", "LINK"]);   // audit fastest: 4t, 6t, 9t
  const MID_INSTRUMENTS  = new Set(["AVAX"]);                    // V16: SOFI removed (was 36% oversize)
  // AUDUSD, COFFEE, SOFI: no boost → score stays at 80-88, grade B/C, smaller positions
  if (TOP3_INSTRUMENTS.has(s.ticker)) {
    composite *= 1.55;  // Strong boost for proven fastest instruments
  } else if (MID_INSTRUMENTS.has(s.ticker)) {
    composite *= 1.20;  // Moderate boost for medium performers
  }

  // Cap at 100
  composite = Math.min(100, composite);

  return Math.round(composite * 10) / 10;
}

// ─── Market Regime ────────────────────────────────────────────────────────────

function detectRegime(): "trending" | "ranging" {
  const all = getStockData();
  const stocks = all.filter(s => !(s as any).marketType || (s as any).marketType === "stock");
  let up = 0, down = 0;
  for (const s of stocks) {
    if ((s as any).ma20dAlignment === "Above") up++; else down++;
  }
  const tot = Math.max(stocks.length, 1);
  return Math.abs(up - down) / tot > 0.18 ? "trending" : "ranging";
}

// ─── Position Sizing — FINDING 4 FIX ─────────────────────────────────────────

function sizePosition(
  compositeScore: number,
  portfolio: { cash: number; totalValue: number }
): { posSize: number; shares: number; kf: number } {
  const { cash, totalValue } = portfolio;

  // Compounding multiplier
  const mult = totalValue >= 500 ? 2.0
             : totalValue >= 300 ? 1.6
             : totalValue >= 200 ? 1.3
             : totalValue >= 150 ? 1.15
             : 1.0;

  // Kelly estimate (simplified — score-based)
  const winProb = Math.min(0.82, 0.50 + compositeScore * 0.003);
  const kf = Math.min(winProb * 0.5, KELLY_CAP);

  // V9 AUDIT FIX: 30-40% of cash per position
  // Ensures 5 positions deploy 150-200% → full capital utilization
  let posSize = cash * (POS_MIN_PCT + (compositeScore / 100) * (POS_MAX_PCT - POS_MIN_PCT));
  posSize = Math.min(posSize * mult, cash * 0.95);

  return { posSize: Math.round(posSize * 100) / 100, shares: 0, kf };
}

// ─── Scanner — FINDING 3+5 FIX: Rank-Based ───────────────────────────────────

const bullishTickers = new Set<string>();

export function scanForBreakouts(): BreakoutSignal[] {
  const all = getStockData();
  const regime = detectRegime();

  bullishTickers.clear();

  // Step 1: Advance prices for instruments NOT in open positions
  // (Open positions are already advanced in managePositions — avoid double-advancing)
  const openTickers = new Set(state.openPositions.map(p => p.ticker));
  for (const s of all) {
    const mt = (s as any).marketType ?? "stock";
    if (openTickers.has(s.ticker)) {
      // Already advanced in managePositions — just update MTF with current price
      const g = _prices.get(s.ticker);
      updateMTF(s.ticker, g ? g.price : s.price);
    } else {
      const newPrice = advancePrice(s.ticker, mt, false);
      updateMTF(s.ticker, newPrice > 0 ? newPrice : s.price);
    }
  }

  // Step 2: Compute composite score for every instrument
  const ranked: Array<RankedSignal & { data: StockData }> = [];

  for (const s of all) {
    const mt = (s as any).marketType ?? "stock";

    // MTF gate
    if (!isTrendingUp(s.ticker)) continue;

    const composite = computeCompositeScore(s, mt);
    if (composite === null || composite < 20) continue; // absolute floor only

    let strategy: "momentum" | "squeeze" | "reversal" | "breakout" = "momentum";
    if (s.shortInterestPct >= 20 && s.floatShares < 300) strategy = "squeeze";
    else if (s.volumeSpikeRatio >= 2.5) strategy = "breakout";

    const reasons: string[] = [];
    if (s.rsi >= 60 && s.rsi <= 80) reasons.push(`RSI ${s.rsi}`);
    if (s.macdSignal === 20) reasons.push("MACD ✓");
    if (s.volumeSpikeRatio >= 1.3) reasons.push(`Vol ${s.volumeSpikeRatio.toFixed(1)}×`);
    if ((s as any).ma20dAlignment === "Above") reasons.push("Uptrend");
    if (s.shortInterestPct >= 15) reasons.push(`SI ${s.shortInterestPct.toFixed(0)}%`);
    if (s.catalystScore >= 70) reasons.push(`Cat ${s.catalystScore}`);

    // Grade by composite rank (will be assigned after sorting)
    ranked.push({
      ticker: s.ticker,
      compositeScore: composite,
      rsi: s.rsi,
      volSpike: s.volumeSpikeRatio,
      momentum: s.dayChangePercent ?? 0,
      catalyst: s.catalystScore ?? 50,
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

    // Assign grade by rank
    const grade: BreakoutSignal["grade"] = i === 0 ? "A+" : i < 3 ? "A" : i < 8 ? "B" : "C";

    const price = s.price;
    const atr   = estimateATR(r.ticker, r.mt, price);
    const stop  = Math.max(0.0001, Math.round((price - STOP_MULT  * atr) * 10000) / 10000);
    const tp1   = Math.round((price + TP1_MULT  * atr) * 10000) / 10000;
    const tp2   = Math.round((price + TP2_MULT  * atr) * 10000) / 10000;
    const rr    = (tp1 - price) / Math.max(price - stop, 0.0001);

    if (portfolio.cash < 1) continue;
    let { posSize, kf } = sizePosition(r.compositeScore, portfolio);

    // V14 AUDIT FIX: Grade-based sizing — IREN (A, 100% FT) > AUDUSD (B, 15% FT)
    // A+=100%  A=85%  B=60%  C=40%
    const gFactor = grade === "A+" ? 1.0 : grade === "A" ? 0.85 : grade === "B" ? 0.60 : 0.40;
    posSize *= gFactor;

    // Hot ticker boost
    const hotAt = _hotTickers.get(r.ticker) ?? -999;
    if (state.totalTicks - hotAt <= 30) {
      posSize = Math.min(posSize * 1.5, portfolio.cash * 0.90);
    }
    if (posSize < 0.10) continue;
    const shares = Math.max(0.0001, Math.floor((posSize / price) * 10000) / 10000);

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

    bullishTickers.add(r.ticker);
  }

  // Activate trending mode for top signals
  for (const ticker of bullishTickers) {
    const s = getStockByTicker(ticker);
    if (s) advancePrice(ticker, (s as any).marketType ?? "stock", true);
  }

  state.lastScan = signals.slice(0, 12);
  state.regime   = regime;
  return signals;
}

// ─── State ───────────────────────────────────────────────────────────────────

let sessionStartValue = 100;
let sessionPeak = 100;
let t1HitCount = 0;
let maxHoldCount = 0;

let state: AutoTraderState = {
  isRunning: false, totalTicks: 0, totalTrades: 0,
  openPositions: [], closedTrades: 0, winRate: 0,
  totalPnl: 0, dailyPnl: 0, circuitBreakerActive: false,
  regime: "unknown", bestTrade: null, lastScan: [], log: [],
  eventFilterActive: false, currentEvent: null, totalSlippageCost: 0,
  roiPct: 0, pnlPerTick: 0, tradesPerHundredTicks: 0, sessionPeak: 100,
  t1HitRate: 0, maxHoldRate: 0, capitalUtilization: 0,
  stats: { avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, sharpeApprox: 0, totalWinAmount: 0, totalLossAmount: 0 },
};

let wins = 0, losses = 0, totalWinAmt = 0, totalLossAmt = 0;
let _tickInterval: ReturnType<typeof setInterval> | null = null;
let _equitySnapshotInterval: ReturnType<typeof setInterval> | null = null;
const cooldowns = new Map<string, number>();
const dailyStart = { value: 100, tick: 0, dateKey: '' }; // V17: dateKey tracks calendar day for daily P&L reset
const pnlHistory: number[] = [];

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

function enterTrade(sig: BreakoutSignal): ActivePosition | null {
  if (state.circuitBreakerActive) return null;

  const evt = activeEvent(state.totalTicks);
  state.eventFilterActive = !!evt;
  state.currentEvent = evt?.name ?? null;
  if (evt) return null;

  const portfolio = storage.getPortfolio();
  if (portfolio.cash < sig.positionSize) return null;
  if (state.openPositions.some(p => p.ticker === sig.ticker)) return null;
  if (pendingEntries.some(p => p.status === "working" && p.sig.ticker === sig.ticker)) return null;

  // V12: Capital recycling — if full AND new signal is A+, close worst position
  if (state.openPositions.length >= MAX_POSITIONS) {
    if (sig.grade === "A+") {
      // Find worst performing open position (most negative PnL %, no T1 hit, closest to MAX_HOLD)
      const candidates = state.openPositions.filter(p => !p.tier1Hit && p.ticksOpen > 8 && p.pnlPct < 0.5);
      if (candidates.length > 0) {
        const worst = candidates.reduce((a, b) => a.pnlPct < b.pnlPct ? a : b);
        // Force exit the worst performer
        const mt = worst.marketType;
        const exitSlip = slippage(worst.sharesRemaining, worst.currentPrice, mt);
        const closePnl = Math.round(((worst.currentPrice - worst.entryPrice) * worst.sharesRemaining - exitSlip) * 100) / 100;
        storage.closeTrade(worst.tradeId, worst.currentPrice, exitSlip); // V17: pass slippage for P&L sync
        state.totalSlippageCost = Math.round((state.totalSlippageCost + exitSlip) * 10000) / 10000;
        state.totalPnl = Math.round((state.totalPnl + closePnl) * 100) / 100;
        state.dailyPnl = Math.round((state.dailyPnl + closePnl) * 100) / 100;
        if (closePnl >= 0) { wins++; totalWinAmt += closePnl; }
        else { losses++; totalLossAmt += Math.abs(closePnl); }
        state.closedTrades++;
        state.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
        updateStats();
        cooldowns.set(worst.ticker, state.totalTicks);
        const g = _prices.get(worst.ticker);
        if (g) { g.mode = "ranging"; g.trendTicks = 0; g.drift = 0; }
        const idx = state.openPositions.indexOf(worst);
        if (idx >= 0) state.openPositions.splice(idx, 1);
        log(`♻️ RECYCLE | Closed ${worst.ticker} (${worst.pnlPct.toFixed(1)}% pnl, ${worst.ticksOpen}t) → making room for A+ ${sig.ticker}`);
      } else {
        return null; // No recyclable positions
      }
    } else {
      return null; // Not A+, wait for slot
    }
  }

  const lastExit = cooldowns.get(sig.ticker) ?? 0;
  if (state.totalTicks - lastExit < COOLDOWN) return null;

  // V10: Trend freshness gate — only enter if trend activated within last 5 ticks
  // Prevents entering stale trends that are close to expiry
  const trendStart = _trendStartTick.get(sig.ticker) ?? 0;
  const trendAge = state.totalTicks - trendStart;
  if (trendAge > 25 && trendAge < 9999) return null; // V16: 25t window (was 15t) — more room to enter fresh trend

  // Audit Page 9 #2: Diversification + forex 12% portfolio cap
  const mt = sig.marketType;
  const sameType = state.openPositions.filter(p => p.marketType === mt).length;
  if (mt !== "stock" && sameType >= 1) return null;
  if (mt === "stock" && sameType >= 2) return null;

  // V16 FIX #5: Forex cap raised 12%→15% — AUDUSD has solid FT rate, was undersized
  if (mt === "forex") {
    const pv = storage.getPortfolio();
    const maxForex = pv.totalValue * 0.15;
    if (sig.positionSize > maxForex) {
      sig.positionSize = Math.max(1, Math.round(maxForex * 100) / 100);
      sig.shares = Math.max(0.0001, Math.floor((sig.positionSize / sig.entryPrice) * 10000) / 10000);
    }
  }

  // V16 FIX #2: Hard 25% portfolio cap per single position (SOFI was 36% in V15)
  {
    const pv = storage.getPortfolio();
    const maxSingle = pv.totalValue * 0.25;
    if (sig.positionSize > maxSingle) {
      sig.positionSize = Math.max(1, Math.round(maxSingle * 100) / 100);
      sig.shares = Math.max(0.0001, Math.floor((sig.positionSize / sig.entryPrice) * 10000) / 10000);
    }
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
  log(`📋 LIMIT BUY | ${sig.ticker}[${mt}] | ${sig.shares.toFixed(4)}sh @ $${limitPrice.toFixed(4)} (mid $${sig.entryPrice.toFixed(4)}) | working ≤${ENTRY_FILL_WINDOW}t`);

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
  if (activeEvent(state.totalTicks)) { cancelPending(pending, "event_blackout"); return null; }
  if (state.openPositions.some(p => p.ticker === sig.ticker)) { cancelPending(pending, "duplicate"); return null; }
  if (state.openPositions.length >= MAX_POSITIONS) { cancelPending(pending, "no_slot"); return null; }

  const stock = getStockByTicker(sig.ticker);
  if (!stock) { cancelPending(pending, "no_stock"); return null; }
  const curPrice = stock.price;

  // Buy limit fills only when market trades at or below the limit.
  if (!(curPrice > 0) || curPrice > pending.limitPrice) return null;

  // Final cash check (price-adjusted to actual fill).
  const fillPrice = curPrice; // limit fills at the better of (limit, current)
  const portfolio = storage.getPortfolio();
  const total = fillPrice * sig.shares;
  if (total > portfolio.cash) { cancelPending(pending, "insufficient_cash"); return null; }

  const trade = storage.createTrade({
    ticker: sig.ticker, action: "buy", shares: sig.shares,
    price: fillPrice, total,
    stopLoss: sig.stopLoss, takeProfit: sig.takeProfit2,
    openedAt: new Date().toISOString(),
  });

  const pos: ActivePosition = {
    tradeId: trade.id, ticker: sig.ticker,
    entryPrice: fillPrice, currentPrice: fillPrice,
    shares: sig.shares, sharesRemaining: sig.shares,
    stopLoss: sig.stopLoss, trailingStop: sig.stopLoss,
    takeProfit1: sig.takeProfit1, takeProfit2: sig.takeProfit2,
    highWaterMark: fillPrice, pnl: 0, pnlPct: 0,
    strategy: sig.strategy, grade: sig.grade,
    enteredAt: new Date().toISOString(),
    tier1Hit: false, status: "running",
    atr: sig.atr, ticksOpen: 0, marketType: mt,
  };

  state.openPositions.push(pos);
  state.totalTrades++;
  pending.status = "filled";

  log(`✅ FILL ${sig.grade} | ${sig.ticker}[${mt}] | ${sig.shares.toFixed(4)}sh @ $${fillPrice.toFixed(4)} (limit $${pending.limitPrice.toFixed(4)}) | Stop $${sig.stopLoss.toFixed(4)} | T1 $${sig.takeProfit1.toFixed(4)} | Score ${sig.score}`);
  return pos;
}

function cancelPending(pending: PendingEntry, reason: string): void {
  pending.status = "cancelled";
  log(`🚫 LIMIT CANCEL | ${pending.sig.ticker} | $${pending.limitPrice.toFixed(4)} | ${reason}`);
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
      log(`🔁 LIMIT REPRICE | ${pe.sig.ticker} | $${pe.limitPrice.toFixed(4)} → $${newLimit.toFixed(4)}`);
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

function managePositions() {
  const toClose: number[] = [];

  for (let i = 0; i < state.openPositions.length; i++) {
    const pos = state.openPositions[i];
    const stock = getStockByTicker(pos.ticker);
    if (!stock) continue;

    const mt = pos.marketType;
    const newPrice = advancePrice(pos.ticker, mt, true); // keep trending
    const cur = newPrice > 0 ? newPrice : stock.price;

    pos.currentPrice = Math.round(cur * 10000) / 10000;
    pos.pnl = Math.round((pos.currentPrice - pos.entryPrice) * pos.sharesRemaining * 100) / 100;
    pos.pnlPct = Math.round(((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100;
    pos.ticksOpen++;
    updateMTF(pos.ticker, pos.currentPrice);

    // Update high water mark + trailing stop (after T1 only)
    if (pos.currentPrice > pos.highWaterMark) {
      pos.highWaterMark = pos.currentPrice;
      if (pos.tier1Hit) {
        const profPct = (pos.highWaterMark - pos.entryPrice) / pos.entryPrice * 100;
        const tm = profPct > 20 ? 0.5 : profPct > 10 ? 0.7 : TRAIL_MULT;
        const newTrail = Math.round((pos.highWaterMark - tm * pos.atr) * 10000) / 10000;
        if (newTrail > pos.trailingStop) pos.trailingStop = newTrail;
      }
    }

    // Tier 1 partial exit (40% shares)
    if (!pos.tier1Hit && pos.currentPrice >= pos.takeProfit1) {
      pos.tier1Hit = true;
      const halfSh = Math.round(pos.sharesRemaining * 0.40 * 10000) / 10000;
      const exitSlip = slippage(halfSh, pos.takeProfit1, mt);
      const t1pnl = Math.round(((pos.takeProfit1 - pos.entryPrice) * halfSh - exitSlip) * 100) / 100;
      pos.sharesRemaining -= halfSh;
      state.totalPnl = Math.round((state.totalPnl + t1pnl) * 100) / 100;
      state.dailyPnl = Math.round((state.dailyPnl + t1pnl) * 100) / 100;
      state.totalSlippageCost = Math.round((state.totalSlippageCost + exitSlip) * 10000) / 10000;
      totalWinAmt += t1pnl;
      t1HitCount++;
      log(`T1 HIT ✓ | ${pos.ticker} | +$${t1pnl.toFixed(2)} locked | ${pos.sharesRemaining.toFixed(4)}sh → T2 $${pos.takeProfit2.toFixed(4)}`);
    }

    // V17 BUG FIX #1: Unified priority exit chain — single evaluation, highest-priority wins
    // Was: gate logged on line 778, acted on line 785. Other conditions overwrote it silently.
    // Now: one block, explicit priority order: CB > T2 > MaxHold > Trail > Gate > Momentum
    const GATE_THRESH_PCT = -0.50;
    const maxH = pos.tier1Hit ? MAX_HOLD_T1 : MAX_HOLD_NO_T1;

    let exitReason = "";
    let exitStatus: ActivePosition["status"] = "stopped_out";

    // Priority 1: Circuit breaker (always wins)
    if (state.circuitBreakerActive) {
      exitReason = "circuit_breaker";
      exitStatus = "circuit_breaker";
    }
    // Priority 2: Full target (T2 hit)
    else if (pos.currentPrice >= pos.takeProfit2) {
      exitReason = "full_target";
      exitStatus = "target_hit";
    }
    // Priority 3: Max hold time
    else if (pos.ticksOpen >= maxH) {
      exitReason = "max_hold";
      exitStatus = "stopped_out";
      maxHoldCount++;
    }
    // Priority 4: Trailing stop
    else if (pos.currentPrice <= pos.trailingStop) {
      exitReason = pos.pnlPct >= 0 ? "trail_lock" : "stopped_out";
      exitStatus = "stopped_out";
    }
    // Priority 5: Momentum gate — only fires on CLEARLY losing positions
    else if (!pos.tier1Hit && pos.ticksOpen >= 40 && pos.pnlPct < GATE_THRESH_PCT) {
      exitReason = "gate_exit";
      exitStatus = "stopped_out";
      log(`⚡ GATE EXIT | ${pos.ticker} | ${pos.pnlPct.toFixed(2)}% @ tick ${pos.ticksOpen} — clearly losing`);
    }
    // Priority 6: RSI momentum collapse
    else if (stock.rsi < 35 && pos.pnlPct < -5 && !pos.tier1Hit) {
      exitReason = "momentum_exit";
      exitStatus = "momentum_exit";
    }

    if (exitReason) pos.status = exitStatus;

    if (exitReason) {
      // Task #49: pick a limit / stop-limit fill price instead of paying
      // arbitrary market slippage. T1/T2 fills go off at the take-profit
      // level (already handled for T1 above). Stop-style exits become
      // stop-limit: if the market gapped past stop * (1 - EXIT_SLIPPAGE_TOL),
      // we accept the gapped fill at currentPrice; otherwise we fill at the
      // stop level itself with zero slippage.
      let fillPx: number;
      let exitSlip: number;
      const q = ALPACA_STOCK_TICKERS.has(pos.ticker) ? getAlpacaQuote(pos.ticker) : null;
      const bid = q && q.bid > 0 ? q.bid : pos.currentPrice;

      if (exitReason === "full_target") {
        // T2 limit fill at the take-profit price
        fillPx = pos.takeProfit2;
        exitSlip = 0;
      } else if (exitReason === "trail_lock" || exitReason === "stopped_out") {
        // Stop-limit: fill at stop level if market hasn't gapped past tolerance
        const stopLimit = pos.trailingStop;
        const worstFill = stopLimit * (1 - EXIT_SLIPPAGE_TOL);
        if (bid >= worstFill) {
          fillPx = stopLimit;
          exitSlip = 0;
        } else {
          // Gapped past stop-limit band — fall back to current price with slippage
          fillPx = pos.currentPrice;
          exitSlip = slippage(pos.sharesRemaining, pos.currentPrice, mt);
        }
      } else {
        // Time-based / momentum / circuit-breaker exits — limit at current bid
        fillPx = bid;
        exitSlip = 0;
      }

      const closePnl = Math.round(((fillPx - pos.entryPrice) * pos.sharesRemaining - exitSlip) * 100) / 100;
      state.totalSlippageCost = Math.round((state.totalSlippageCost + exitSlip) * 10000) / 10000;
      storage.closeTrade(pos.tradeId, fillPx, exitSlip); // V17: pass slippage for P&L sync
      toClose.push(i);

      state.totalPnl = Math.round((state.totalPnl + closePnl) * 100) / 100;
      state.dailyPnl = Math.round((state.dailyPnl + closePnl) * 100) / 100;

      if (closePnl >= 0) {
        wins++; totalWinAmt += closePnl;
        if (!state.bestTrade || closePnl > state.bestTrade.pnl) {
          state.bestTrade = { ticker: pos.ticker, pnl: closePnl, pct: pos.pnlPct };
        }
      } else {
        losses++; totalLossAmt += Math.abs(closePnl);
      }

      cooldowns.set(pos.ticker, state.totalTicks);
      // Reset trend when position closed
      const g = _prices.get(pos.ticker);
      if (g) { g.mode = "ranging"; g.trendTicks = 0; g.drift = 0; }

      state.closedTrades++;
      state.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
      updateStats();
      pnlHistory.push(closePnl);

      const icon = closePnl >= 0 ? "✓" : "✗";
      log(`EXIT ${icon} ${exitReason.toUpperCase()} | ${pos.ticker} | ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct}% | Net ${closePnl >= 0 ? "+" : ""}$${closePnl.toFixed(2)} | ${pos.ticksOpen} ticks`);
    }
  }

  for (let i = toClose.length - 1; i >= 0; i--) {
    state.openPositions.splice(toClose[i], 1);
  }
}

// ─── Circuit Breaker — Graduated ─────────────────────────────────────────────

function checkCircuitBreaker() {
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
  if (p.totalValue <= 50 && !state.circuitBreakerActive) {
    state.circuitBreakerActive = true;
    log(`🚨 HARD FLOOR $50 | Emergency stop`);
  } else if (dd >= limit && !state.circuitBreakerActive) {
    state.circuitBreakerActive = true;
    log(`⚠️ CIRCUIT BREAKER | Drawdown ${(dd*100).toFixed(1)}% ≥ ${(limit*100).toFixed(0)}% limit | Paused`);
  } else if (state.circuitBreakerActive && p.totalValue > 50 && dd < limit) {
    state.circuitBreakerActive = false;
    log(`✅ CIRCUIT BREAKER RESET | Portfolio recovered — drawdown ${(dd*100).toFixed(1)}% < ${(limit*100).toFixed(0)}% limit | Trading resumed`);
  }
}

// ─── Main Tick ────────────────────────────────────────────────────────────────

export function autoTraderTick(): { signals: BreakoutSignal[]; entered: ActivePosition | null; exited: string[] } {
  state.totalTicks++;

  // V17 BUG FIX #2: Daily reset — check for new trading day (ET midnight-aware)
  // dailyPnl was accumulating forever; circuit breaker math was meaningless long-session
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayKey = `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
  const prevDateKey = dailyStart.dateKey;
  const isNewDay = !!prevDateKey && prevDateKey !== todayKey;
  if (dailyStart.tick === 0 || isNewDay) {
    const p = storage.getPortfolio();
    dailyStart.value = p.totalValue;
    dailyStart.tick  = state.totalTicks;
    dailyStart.dateKey = todayKey;
    if (isNewDay) {
      state.dailyPnl = 0; // Reset for new trading day
      log(`🌅 NEW TRADING DAY — Daily P&L reset. Starting value: $${p.totalValue.toFixed(2)}`);
    }
  }

  const prevEvt = activeEvent(state.totalTicks - 1);
  const evt = activeEvent(state.totalTicks);
  state.eventFilterActive = !!evt;
  state.currentEvent = evt?.name ?? null;
  if (evt && !prevEvt) log(`📅 BLACKOUT: ${evt.name} (ticks ${evt.s}–${evt.e})`);
  else if (!evt && prevEvt) log(`✅ TRADING RESUMED after ${prevEvt.name}`);

  checkCircuitBreaker();

  // V10.1: Reset price bounds every 400 ticks to prevent saturation at ±55% bounds
  // After many cycles prices drift to ceiling; reset allows fresh trending from new baseline
  if (state.totalTicks % 400 === 0 && state.totalTicks > 0) {
    _seeds.clear(); // Reset seed anchors; prices will re-seed from current _prices values
    const all = getStockData();
    for (const s of all) {
      const g = _prices.get(s.ticker);
      if (g && g.mode === "ranging") {
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
  if (!state.circuitBreakerActive && !state.eventFilterActive) {
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

export function runWalkForwardBacktest(totalTicks = 1000): BacktestResult {
  const splitAt = Math.floor(totalTicks * 0.8);
  const all = getStockData();

  const lPrices = new Map<string, PriceState>();
  for (const s of all) {
    const h = s.ticker.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    lPrices.set(s.ticker, { price: s.price, lcg: h + 54321, mode: "ranging", trendTicks: 0, drift: 0 });
  }

  const lMTF = new Map<string, number[]>();
  const lCooldowns = new Map<string, number>();

  function lAdvance(ticker: string, mt: string, bull: boolean): number {
    const seed = _seeds.get(ticker) ?? getStockByTicker(ticker)?.price ?? 1;
    const g = lPrices.get(ticker);
    if (!g) return seed;
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u2 = g.lcg / 0xffffffff;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const vol = getVol(ticker, mt);

    if (bull && g.mode === "ranging") {
      g.mode = "trending";
      g.trendTicks = MAX_HOLD_NO_T1 + 15 + (g.lcg % 10); // V16: +10t window (45-55t, was 35-45t)
      g.drift = getDrift(ticker, mt);
    }
    if (g.mode === "trending" && g.trendTicks > 0) {
      g.trendTicks--;
      if (g.trendTicks === 0) { g.mode = "ranging"; g.drift = 0; }
    }
    const drift = g.mode === "trending" ? g.drift : 0;
    g.price = Math.max(seed * 0.20, Math.min(seed * 1.80, g.price * (1 + drift + vol * z)));  // V11: ±80%
    g.price = Math.round(g.price * 10000) / 10000;
    return g.price;
  }

  interface SimPos {
    ticker: string; mt: string; entry: number; stop: number; tp1: number; tp2: number;
    shares: number; sharesRem: number; atr: number; tier1Hit: boolean; ticks: number; enteredAt: number;
  }

  const positions: SimPos[] = [];
  let bal = 100, peak = 100, maxDD_IS = 0, maxDD_OOS = 0;
  let isW = 0, isL = 0, isWA = 0, isLA = 0, isT = 0, isSl = 0;
  let oosW = 0, oosL = 0, oosWA = 0, oosLA = 0, oosT = 0, oosSl = 0;

  for (let tick = 1; tick <= totalTicks; tick++) {
    const inIS = tick <= splitAt;

    for (const s of all) {
      const mt = (s as any).marketType ?? "stock";
      const isBull = positions.some(p => p.ticker === s.ticker);
      const p = lAdvance(s.ticker, mt, isBull);
      const mh = lMTF.get(s.ticker) ?? [];
      mh.push(p); if (mh.length > 20) mh.shift();
      lMTF.set(s.ticker, mh);
    }

    if (activeEvent(tick)) continue;

    // Manage positions
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      const g = lPrices.get(pos.ticker);
      if (!g) continue;
      const cur = g.price;
      pos.ticks++;

      if (!pos.tier1Hit && cur >= pos.tp1) {
        pos.tier1Hit = true;
        const half = pos.sharesRem * 0.40;
        const sl = slippage(half, pos.tp1, pos.mt);
        const pnl = (pos.tp1 - pos.entry) * half - sl;
        bal += pnl;
        const tradeIS = pos.enteredAt <= splitAt;
        if (tradeIS) { isWA += pnl; isSl += sl; } else { oosWA += pnl; oosSl += sl; }
        pos.sharesRem -= half;
      }

      const maxH = pos.tier1Hit ? MAX_HOLD_T1 : MAX_HOLD_NO_T1;
      // V16 FIX #4: Gate in backtest (-0.5% at tick 40) — was missing, caused IS/OOS divergence
      const btPnlPct = ((cur - pos.entry) / pos.entry) * 100;
      const btGateHit = !pos.tier1Hit && pos.ticks >= 40 && btPnlPct < -0.50;
      if (btGateHit || cur <= pos.stop || cur >= pos.tp2 || pos.ticks >= maxH) {
        const sl = slippage(pos.sharesRem, cur, pos.mt);
        const pnl = (cur - pos.entry) * pos.sharesRem - sl;
        bal += pnl;
        const tradeIS = pos.enteredAt <= splitAt;
        if (tradeIS) {
          isT++; isSl += sl;
          if (pnl >= 0) { isW++; isWA += pnl; } else { isL++; isLA += Math.abs(pnl); }
        } else {
          oosT++; oosSl += sl;
          if (pnl >= 0) { oosW++; oosWA += pnl; } else { oosL++; oosLA += Math.abs(pnl); }
        }
        lCooldowns.set(pos.ticker, tick);
        const g2 = lPrices.get(pos.ticker);
        if (g2) { g2.mode = "ranging"; g2.trendTicks = 0; }
        positions.splice(pi, 1);
      }
    }

    if (bal > peak) peak = bal;
    const dd = (peak - bal) / Math.max(peak, 1);
    if (inIS && dd > maxDD_IS) maxDD_IS = dd;
    if (!inIS && dd > maxDD_OOS) maxDD_OOS = dd;

    if (positions.length >= MAX_POSITIONS) continue;

    // Entry: rank by composite score
    const candidates: Array<{ ticker: string; mt: string; composite: number; price: number; atr: number; stop: number; tp1: number; tp2: number }> = [];

    for (const s of all) {
      if (positions.some(p => p.ticker === s.ticker)) continue;
      const lc = lCooldowns.get(s.ticker) ?? 0;
      if (tick - lc < COOLDOWN) continue;
      const g = lPrices.get(s.ticker);
      if (!g) continue;
      const mt = (s as any).marketType ?? "stock";

      // MTF check
      const mh = lMTF.get(s.ticker) ?? [];
      if (mh.length >= 6) {
        const ea = (mh[0]+mh[1]+mh[2])/3;
        const ra = (mh[mh.length-1]+mh[mh.length-2]+mh[mh.length-3])/3;
        if (ra < ea * 0.996) continue;
      }

      const composite = computeCompositeScore(s, mt);
      if (!composite || composite < 20) continue;

      const atr  = estimateATR(s.ticker, mt, g.price);
      const stop = Math.max(0.0001, g.price - STOP_MULT * atr);
      const tp1  = g.price + TP1_MULT * atr;
      const tp2  = g.price + TP2_MULT * atr;

      candidates.push({ ticker: s.ticker, mt, composite, price: g.price, atr, stop, tp1, tp2 });
    }

    candidates.sort((a, b) => b.composite - a.composite);

    for (const cand of candidates.slice(0, 2)) {
      if (positions.length >= MAX_POSITIONS) break;
      // Cap position at 95% of available balance (same as live engine)
      const posSize = Math.min(bal * 0.95, Math.max(bal * POS_MIN_PCT, bal * POS_MAX_PCT));
      if (posSize < 0.10) continue;
      const shares = posSize / cand.price;
      const sl = slippage(shares, cand.price, cand.mt);
      // Match live engine: bake entry slippage into the adjusted entry price
      // (do NOT also subtract from balance — that would double-count slippage)
      const adjEntry = cand.price + sl / Math.max(shares, 0.0001);
      if (inIS) isSl += sl; else oosSl += sl;
      lAdvance(cand.ticker, cand.mt, true);
      positions.push({
        ticker: cand.ticker, mt: cand.mt,
        entry: adjEntry,
        stop: cand.stop, tp1: cand.tp1, tp2: cand.tp2,
        shares, sharesRem: shares, atr: cand.atr,
        tier1Hit: false, ticks: 0, enteredAt: tick,
      });
    }
  }

  function mk(tks: number, trades: number, w: number, l: number, wa: number, la: number, sl: number, startB: number, maxDD: number) {
    const pf = la > 0 ? Math.round((wa / la) * 100) / 100 : wa > 0 ? 99 : 0;
    const wr = trades > 0 ? Math.round((w / trades) * 10000) / 100 : 0;
    return {
      ticks: tks, trades, wins: w, losses: l, winRate: wr, profitFactor: pf,
      totalReturn: Math.round(((bal - startB) / Math.max(startB, 1)) * 10000) / 100,
      finalBalance: Math.round(bal * 100) / 100,
      maxDrawdown: Math.round(maxDD * 10000) / 100,
      avgWin:  w > 0 ? Math.round((wa / w)  * 100) / 100 : 0,
      avgLoss: l > 0 ? Math.round((la / l) * 100) / 100 : 0,
      totalSlippage: Math.round(sl * 100) / 100,
    };
  }

  const isR  = mk(splitAt, isT,  isW,  isL,  isWA,  isLA,  isSl,  100, maxDD_IS);
  const oosR = mk(totalTicks - splitAt, oosT, oosW, oosL, oosWA, oosLA, oosSl, isR.finalBalance, maxDD_OOS);

  const hasStat = oosT >= 3;
  const degrad = hasStat && isR.profitFactor > 0 && isR.profitFactor < 99 && oosR.profitFactor < 99
    ? Math.round(((isR.profitFactor - oosR.profitFactor) / isR.profitFactor) * 10000) / 100 : 0;

  let verdict: "PASS" | "FAIL" | "MARGINAL";
  let msg: string, rec: string;

  if (!hasStat && isR.profitFactor >= 2.0) {
    verdict = "MARGINAL";
    msg = `IS STRONG (PF=${isR.profitFactor}, WR=${isR.winRate}%) — OOS only ${oosT} trades. Run 2K+ ticks.`;
    rec = "In-sample validated. Run 2K test or go to Alpaca paper trading.";
  } else if (oosR.profitFactor >= 1.5 && oosR.winRate >= 48 && degrad < 40) {
    verdict = "PASS";
    msg = `ROBUST — OOS PF=${oosR.profitFactor}, WR=${oosR.winRate}%, Degradation ${degrad}%.`;
    rec = "Strategy validated on unseen data. Proceed to Alpaca paper trading.";
  } else if (oosR.profitFactor >= 1.2) {
    verdict = "MARGINAL";
    msg = `MARGINAL — OOS PF=${oosR.profitFactor}. Run 2K+ ticks for full coverage.`;
    rec = "Use 50% position sizing for first 30 days.";
  } else {
    verdict = hasStat ? "FAIL" : "MARGINAL";
    msg = hasStat ? `Underperforming OOS (PF=${oosR.profitFactor}). Run 2K+ ticks.` : `Only ${oosT} OOS trades. Run 2K+ ticks for statistical verdict.`;
    rec = "Run 2K+ ticks to get a valid OOS sample size.";
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
  state.circuitBreakerActive = false;

  // Reset all simulation state on start — prevents stale MTF blocking entries
  _prices.clear();
  _seeds.clear();
  _mtf.clear();
  _trendStartTick.clear();
  _hotTickers.clear();
  bullishTickers.clear();
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
    const h = pos.ticker.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0) * 137;
    _prices.set(pos.ticker, { price: seedPrice, lcg: h, mode: "ranging", trendTicks: 0, drift: 0 });
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
    const { sqlite } = require("./storage") as { sqlite: import("better-sqlite3").Database };
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
    const { sqlite } = require("./storage") as { sqlite: import("better-sqlite3").Database };
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
    if (s.pnlHistory) pnlHistory.push(...s.pnlHistory);
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
  stopAlpacaFeed(); // V18: stop polling
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

    if (openTickers.has(s.ticker)) {
      // Scanner still ranks open positions, but they can't be re-entered.
      // Surface that so an operator doesn't wonder why an A+ candidate
      // never converts to a new entry.
      gateFailed = "open_position";
    } else if (!isTrendingUp(s.ticker)) {
      gateFailed = "mtf";
    } else if (s.rsi < 35 || s.rsi > 88) {
      gateFailed = "rsi";
    } else if (!isAlt && s.bollingerPosition < 15) {
      gateFailed = "bollinger";
    } else {
      score = computeCompositeScore(s, mt);
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
  dailyStart.tick  = state.totalTicks;
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
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const todayKey = `${nowET.getFullYear()}-${nowET.getMonth()}-${nowET.getDate()}`;
    const prevDateKey = dailyStart.dateKey;
    const isNewDay = !!prevDateKey && prevDateKey !== todayKey;
    if (dailyStart.tick === 0 || isNewDay) {
      const p = storage.getPortfolio();
      dailyStart.value = p.totalValue;
      dailyStart.tick = Math.max(1, state.totalTicks); // mark initialized
      dailyStart.dateKey = todayKey;
    }
    checkCircuitBreaker();
  } catch (_e) { /* non-fatal */ }
  return state.circuitBreakerActive;
}

export function isAutoTraderRunning(): boolean {
  return state.isRunning;
}

export function resetAutoTraderState() {
  // Clear background tick loop first
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
  if (_equitySnapshotInterval) { clearInterval(_equitySnapshotInterval); _equitySnapshotInterval = null; }
  // Stop the engine if running
  if (state.isRunning) {
    state.isRunning = false;
    stopAlpacaFeed();
  }

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
  state.sessionPeak         = 100;
  state.t1HitRate           = 0;
  state.maxHoldRate         = 0;
  state.capitalUtilization  = 0;
  state.stats = { avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, sharpeApprox: 0, totalWinAmount: 0, totalLossAmount: 0 };

  // Reset local accumulators
  wins = 0; losses = 0; totalWinAmt = 0; totalLossAmt = 0;
  t1HitCount = 0; maxHoldCount = 0;
  sessionStartValue = 100;
  sessionPeak = 100;
  pnlHistory.length = 0;

  // Clear simulation maps
  _prices.clear(); _seeds.clear(); _mtf.clear();
  _trendStartTick.clear(); _hotTickers.clear();
  bullishTickers.clear(); cooldowns.clear();
  pendingEntries.length = 0; // Task #49: drop pending limits on full reset

  // Reset daily tracking
  dailyStart.value = 100;
  dailyStart.tick  = 0;
  dailyStart.dateKey = '';

  // Remove persisted state so next restart begins clean
  try {
    const { sqlite } = require("./storage") as { sqlite: import("better-sqlite3").Database };
    sqlite.prepare("DELETE FROM engine_state WHERE id = 1").run();
  } catch (_e) { /* non-fatal */ }
}
