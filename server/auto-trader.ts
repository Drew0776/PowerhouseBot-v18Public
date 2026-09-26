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

import { storage, getStockData, getStockByTicker, STARTING_BALANCE } from "./storage";
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
import { roundPrice } from "@shared/price";
import { hashString } from "@shared/hash";
import { estimateEdge, meanCI95 } from "./stats";

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

// Per-tick volatility of the simulated random walk (no drift — see advancePrice).
const TICK_VOL_BASE    = 0.0012;

// Multipliers by asset class (relative to stock baseline)
const CLASS_VOL:   Record<string, number> = { stock: 1.0, penny: 2.0, crypto: 1.5, forex: 0.4, commodity: 0.7, index: 0.5 };

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

function slippage(shares: number, price: number, mt: string): number {
  const rate = mt === "crypto" ? 0.001 : mt === "forex" ? 0.0002 : mt === "commodity" ? 0.0005 : mt === "index" ? 0.0003 : 0;
  const fixed = mt === "stock" || mt === "penny" ? 0.02 * shares : 0;
  return Math.max(0, Math.round((price * rate * shares + fixed) * 10000) / 10000);
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
// V11: Tracks tickers that just hit FULL_TARGET — gets 1.5× position boost
const _hotTickers = new Map<string, number>(); // ticker → tick when T2 was hit

function getVol(ticker: string, mt: string): number {
  const s = getStockByTicker(ticker);
  const cls = (s && s.price < 5) ? "penny" : mt;
  return TICK_VOL_BASE * (CLASS_VOL[cls] ?? 1.0);
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
  portfolio: { cash: number; totalValue: number }
): { posSize: number; shares: number; kf: number } {
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
  const edge = estimateEdge({ wins, losses, totalWin: totalWinAmt, totalLoss: totalLossAmt });
  const kf = Math.max(PROBE_RISK, Math.min(edge.kelly / 2, KELLY_CAP));

  // V9 AUDIT FIX: 30-40% of cash per position
  // Ensures 5 positions deploy 150-200% → full capital utilization
  let posSize = cash * (POS_MIN_PCT + (compositeScore / 100) * (POS_MAX_PCT - POS_MIN_PCT));
  posSize = Math.min(posSize * mult, cash * 0.95);

  return { posSize: Math.round(posSize * 100) / 100, shares: 0, kf };
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

    // Assign grade by rank
    const grade: BreakoutSignal["grade"] = i === 0 ? "A+" : i < 3 ? "A" : i < 8 ? "B" : "C";

    const price = s.price;
    const atr   = estimateATR(r.ticker, r.mt, price);
    const stop  = Math.max(stopFloor(price), roundPrice(price - STOP_MULT * atr));
    const tp1   = roundPrice(price + TP1_MULT * atr);
    const tp2   = roundPrice(price + TP2_MULT * atr);
    const rr    = (tp1 - price) / Math.max(price - stop, price * 1e-6);

    if (portfolio.cash < 1) continue;
    let { posSize, kf } = sizePosition(r.compositeScore, portfolio);

    // Risk cap: a stop-out may lose at most kf (≤ KELLY_CAP) of the portfolio.
    const stopPct = (price - stop) / price;
    if (stopPct > 0) posSize = Math.min(posSize, (portfolio.totalValue * kf) / stopPct);

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
  if (entryBlockReason(sig.ticker)) return null;

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
        const tradePnl = closePnl + (worst.t1Pnl ?? 0);
        if (tradePnl >= 0) { wins++; totalWinAmt += tradePnl; }
        else { losses++; totalLossAmt += Math.abs(tradePnl); }
        pnlHistory.push(tradePnl);
        state.closedTrades++;
        state.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
        updateStats();
        cooldowns.set(worst.ticker, state.totalTicks);
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
  const entrySlip = slippage(sig.shares, curPrice, mt);
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

  log(`✅ FILL ${sig.grade} | ${sig.ticker}[${mt}] | ${sig.shares.toFixed(4)}sh @ $${curPrice.toFixed(4)} (limit $${pending.limitPrice.toFixed(4)}; $${fillPrice.toFixed(4)} incl. costs) | Stop $${stopLoss.toFixed(4)} | T1 $${takeProfit1.toFixed(4)} | Score ${sig.score}`);
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
    const newPrice = advancePrice(pos.ticker, mt);
    const cur = newPrice > 0 ? newPrice : stock.price;

    pos.currentPrice = roundPrice(cur);
    pos.pnl = Math.round((pos.currentPrice - pos.entryPrice) * pos.sharesRemaining * 100) / 100;
    pos.pnlPct = Math.round(((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100;
    pos.ticksOpen++;

    // Update high water mark + trailing stop (after T1 only)
    if (pos.currentPrice > pos.highWaterMark) {
      pos.highWaterMark = pos.currentPrice;
      if (pos.tier1Hit) {
        const profPct = (pos.highWaterMark - pos.entryPrice) / pos.entryPrice * 100;
        const tm = profPct > 20 ? 0.5 : profPct > 10 ? 0.7 : TRAIL_MULT;
        const newTrail = roundPrice(pos.highWaterMark - tm * pos.atr);
        if (newTrail > pos.trailingStop) pos.trailingStop = newTrail;
      }
    }

    // Tier 1 partial exit (40% shares)
    if (!pos.tier1Hit && pos.currentPrice >= pos.takeProfit1) {
      pos.tier1Hit = true;
      const halfSh = Math.round(pos.sharesRemaining * 0.40 * 10000) / 10000;
      const exitSlip = slippage(halfSh, pos.takeProfit1, mt);
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
      log(`T1 HIT ✓ | ${pos.ticker} | ${t1pnl >= 0 ? "+" : "-"}$${Math.abs(t1pnl).toFixed(2)} locked | ${pos.sharesRemaining.toFixed(4)}sh → T2 $${pos.takeProfit2.toFixed(4)}`);
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
    else if ((featuresFor(pos.ticker)?.rsi ?? 50) < 35 && pos.pnlPct < -5 && !pos.tier1Hit) {
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

      // Win/loss stats use the whole trade: final exit plus any T1 partial.
      const tradePnl = Math.round((closePnl + (pos.t1Pnl ?? 0)) * 100) / 100;
      if (tradePnl >= 0) {
        wins++; totalWinAmt += tradePnl;
        if (!state.bestTrade || tradePnl > state.bestTrade.pnl) {
          state.bestTrade = { ticker: pos.ticker, pnl: tradePnl, pct: pos.pnlPct };
        }
      } else {
        losses++; totalLossAmt += Math.abs(tradePnl);
      }

      cooldowns.set(pos.ticker, state.totalTicks);

      state.closedTrades++;
      state.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
      updateStats();
      pnlHistory.push(tradePnl);

      const icon = closePnl >= 0 ? "✓" : "✗";
      log(`EXIT ${icon} ${exitReason.toUpperCase()} | ${pos.ticker} | ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct}% | Net ${closePnl >= 0 ? "+" : ""}$${closePnl.toFixed(2)} | ${pos.ticksOpen} ticks`);
    }
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
  } else if (dd >= limit && !state.circuitBreakerActive) {
    state.circuitBreakerActive = true;
    log(`⚠️ CIRCUIT BREAKER | Drawdown ${(dd*100).toFixed(1)}% ≥ ${(limit*100).toFixed(0)}% limit | Paused`);
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

export function runWalkForwardBacktest(totalTicks = 1000): BacktestResult {
  const splitAt = Math.floor(totalTicks * 0.8);
  const all = getStockData();

  const lPrices = new Map<string, PriceState>();
  for (const s of all) {
    const h = hashString(s.ticker);
    lPrices.set(s.ticker, { price: s.price, lcg: h + 54321 });
  }

  const lMTF = new Map<string, number[]>();
  const lCooldowns = new Map<string, number>();

  function lAdvance(ticker: string, mt: string): number {
    const seed = _seeds.get(ticker) ?? getStockByTicker(ticker)?.price ?? 1;
    const g = lPrices.get(ticker);
    if (!g) return seed;
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
    g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
    const u2 = g.lcg / 0xffffffff;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const vol = getVol(ticker, mt);
    g.price = Math.max(seed * 0.20, Math.min(seed * 1.80, g.price * (1 + vol * z)));  // V11: ±80%
    g.price = roundPrice(g.price);
    return g.price;
  }

  interface SimPos {
    ticker: string; mt: string; entry: number; stop: number; tp1: number; tp2: number;
    shares: number; sharesRem: number; atr: number; tier1Hit: boolean; ticks: number; enteredAt: number;
    t1pnl: number; // P&L already realized by the T1 partial; counted into the trade at close
  }

  const positions: SimPos[] = [];
  let bal = STARTING_BALANCE, peak = STARTING_BALANCE, maxDD_IS = 0, maxDD_OOS = 0;
  let balAtSplit = STARTING_BALANCE;
  let isW = 0, isL = 0, isWA = 0, isLA = 0, isT = 0, isSl = 0;
  let oosW = 0, oosL = 0, oosWA = 0, oosLA = 0, oosT = 0, oosSl = 0;
  const oosTradePnls: number[] = [];

  for (let tick = 1; tick <= totalTicks; tick++) {
    const inIS = tick <= splitAt;

    for (const s of all) {
      const mt = (s as any).marketType ?? "stock";
      sampleHistory(lMTF, s.ticker, lAdvance(s.ticker, mt));
    }


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
        if (pos.enteredAt <= splitAt) isSl += sl; else oosSl += sl;
        pos.t1pnl += pnl;
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
        // One result per trade: final exit plus any T1 partial.
        const tradePnl = pnl + pos.t1pnl;
        if (pos.enteredAt <= splitAt) {
          isT++; isSl += sl;
          if (tradePnl >= 0) { isW++; isWA += tradePnl; } else { isL++; isLA += Math.abs(tradePnl); }
        } else {
          oosT++; oosSl += sl;
          oosTradePnls.push(tradePnl);
          if (tradePnl >= 0) { oosW++; oosWA += tradePnl; } else { oosL++; oosLA += Math.abs(tradePnl); }
        }
        lCooldowns.set(pos.ticker, tick);
        positions.splice(pi, 1);
      }
    }

    if (bal > peak) peak = bal;
    const dd = (peak - bal) / Math.max(peak, 1);
    if (inIS && dd > maxDD_IS) maxDD_IS = dd;
    if (!inIS && dd > maxDD_OOS) maxDD_OOS = dd;
    if (tick === splitAt) balAtSplit = bal;

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

      // Same features and gates as the live engine, from this run's own paths
      const mh = lMTF.get(s.ticker) ?? [];
      const f = featuresFrom(mh);
      if (!f || !trendGate(mh)) continue;

      const composite = computeCompositeScore(f, mt);
      if (!composite || composite < 20) continue;

      const atr  = atrFrom(g.price, f.sigma, getVol(s.ticker, mt));
      const stop = Math.max(stopFloor(g.price), g.price - STOP_MULT * atr);
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
      positions.push({
        ticker: cand.ticker, mt: cand.mt,
        entry: adjEntry,
        // Exits relative to the cost-adjusted entry, as in the live engine.
        stop: cand.stop + (adjEntry - cand.price),
        tp1: cand.tp1 + (adjEntry - cand.price),
        tp2: cand.tp2 + (adjEntry - cand.price),
        shares, sharesRem: shares, atr: cand.atr,
        tier1Hit: false, ticks: 0, enteredAt: tick, t1pnl: 0,
      });
    }
  }

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
  _hotTickers.clear();
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
  _hotTickers.clear(); cooldowns.clear();
  pendingEntries.length = 0; // Task #49: drop pending limits on full reset

  // Reset daily tracking
  dailyStart.value = STARTING_BALANCE;
  dailyStart.tick  = 0;
  dailyStart.dateKey = '';

  // Remove persisted state so next restart begins clean
  try {
    const { sqlite } = require("./storage") as { sqlite: import("better-sqlite3").Database };
    sqlite.prepare("DELETE FROM engine_state WHERE id = 1").run();
  } catch (_e) { /* non-fatal */ }
}
