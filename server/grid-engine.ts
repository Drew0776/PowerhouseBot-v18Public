/**
 * Grid Trading Engine
 *
 * Strategy: divide a price range [lower, upper] into N equal "grid lines".
 * The bot BUYS when price drops to a grid line and SELLS the same amount
 * when price rises back up one level — capturing the spread as profit.
 *
 * Each grid step earns: (gridStep / entryPrice) * 100%  profit.
 *
 * This is pure mean-reversion / range arbitrage — no direction bias.
 */

import { eq, desc } from "drizzle-orm";
import { gridBots, gridOrders, gridEvents } from "@shared/schema";
import type { GridBot, GridOrder, GridBotSummary, GridLevel, GridEvent } from "@shared/schema";
// V17 BUG FIX #4: Share single DB connection from storage.ts — no more lock contention
import { getStockByTicker, advancePrice, getLivePrice, db as gridDb, sqlite } from "./storage";
import { evaluateCircuitBreaker } from "./auto-trader";

// Create tables if they don't exist (uses shared connection)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS grid_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    lower_price REAL NOT NULL,
    upper_price REAL NOT NULL,
    grid_count INTEGER NOT NULL,
    total_investment REAL NOT NULL,
    profit_per_grid REAL NOT NULL,
    stop_buffer_pct REAL NOT NULL DEFAULT 0.05,
    created_at TEXT NOT NULL,
    stopped_at TEXT,
    realized_pnl REAL NOT NULL DEFAULT 0,
    total_grid_fills INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS grid_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    level INTEGER NOT NULL,
    grid_price REAL NOT NULL,
    action TEXT NOT NULL,
    fill_price REAL NOT NULL,
    shares REAL NOT NULL,
    total REAL NOT NULL,
    pnl REAL,
    filled_at TEXT NOT NULL
  );

  -- Task #56: audit log for adaptive regrid events
  CREATE TABLE IF NOT EXISTS grid_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    old_step REAL NOT NULL,
    new_step REAL NOT NULL,
    old_atr REAL NOT NULL,
    new_atr REAL NOT NULL,
    old_grid_count INTEGER NOT NULL,
    new_grid_count INTEGER NOT NULL,
    flattened_positions INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL
  );
`);

// Migration: add stop_buffer_pct + Task #50 ATR-spacing columns to pre-existing
// grid_bots tables. Each ALTER is conditional so this is idempotent.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(grid_bots)`).all() as Array<{ name: string }>;
  const has = (n: string) => cols.some(c => c.name === n);
  if (!has("stop_buffer_pct")) sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN stop_buffer_pct REAL NOT NULL DEFAULT 0.05`);
  if (!has("spacing_mode"))    sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN spacing_mode TEXT NOT NULL DEFAULT 'fixed'`);
  if (!has("atr_window"))      sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN atr_window INTEGER NOT NULL DEFAULT 14`);
  if (!has("atr_multiplier"))  sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN atr_multiplier REAL NOT NULL DEFAULT 1.0`);
  if (!has("step_min_pct"))    sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN step_min_pct REAL NOT NULL DEFAULT 0.005`);
  if (!has("step_max_pct"))    sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN step_max_pct REAL NOT NULL DEFAULT 0.05`);
  // Task #56 — auto-regrid drift settings + ATR baseline snapshot
  if (!has("auto_regrid_drift_pct")) sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN auto_regrid_drift_pct REAL NOT NULL DEFAULT 0`);
  if (!has("atr_snapshot"))          sqlite.exec(`ALTER TABLE grid_bots ADD COLUMN atr_snapshot REAL NOT NULL DEFAULT 0`);
} catch (_e) { /* non-fatal */ }

/** Build equally-spaced grid levels between lower and upper */
export function buildGridLevels(lower: number, upper: number, count: number): number[] {
  const step = (upper - lower) / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round((lower + i * step) * 100) / 100);
}

// ── Task #50/#56: ATR-based spacing ──────────────────────────────────────────
// computeBotLevels() re-derives the ATR step from live history every call and
// clamps it to [stepMinPct, stepMaxPct]. To preserve sell↔buy matching
// (`level - 1`), gridCount is only resized when the bot has no open buys.
// Task #56 adds an opt-in `autoRegridDriftPct` that flattens open positions
// and rebuilds the grid whenever live ATR has drifted past the threshold
// relative to `atrSnapshot` (the ATR captured at the last regrid).

/** Compute ATR (in dollars) from a ticker's daily candle history. */
export function computeAtrFromHistory(ticker: string, window: number): number {
  const stock = getStockByTicker(ticker);
  if (!stock || !stock.history || stock.history.length < 2) return 0;
  const candles = stock.history.slice(-Math.max(2, window + 1));
  let sumTR = 0;
  let n = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    if (Number.isFinite(tr) && tr > 0) { sumTR += tr; n++; }
  }
  return n > 0 ? sumTR / n : 0;
}

/**
 * Derive a stable step size for an ATR-spaced grid, clamped to the user's
 * min/max step (expressed as % of reference price).
 */
function deriveAtrStep(params: {
  ticker: string;
  referencePrice: number;
  atrWindow: number;
  atrMultiplier: number;
  stepMinPct: number;
  stepMaxPct: number;
}): { step: number; atr: number } {
  const { ticker, referencePrice, atrWindow, atrMultiplier, stepMinPct, stepMaxPct } = params;
  const atr = computeAtrFromHistory(ticker, atrWindow);
  const minStep = referencePrice * stepMinPct;
  const maxStep = referencePrice * stepMaxPct;
  let raw = atr * atrMultiplier;
  if (!Number.isFinite(raw) || raw <= 0) raw = minStep; // no history yet → take floor
  const step = Math.min(maxStep, Math.max(minStep, raw));
  return { step, atr };
}

/**
 * Returns true while a bot has any open (unmatched) buy orders. Used to freeze
 * dynamic ATR re-spacing until the current cycle of buys has been paired off,
 * so level indices stay stable and sell matching (`o.level - 1`) never breaks.
 */
function botHasOpenBuys(botId: number): boolean {
  const orders = gridDb.select().from(gridOrders).where(eq(gridOrders.botId, botId)).all();
  const openBuys = new Map<number, GridOrder>();
  for (const o of orders) {
    if (o.action === "buy") openBuys.set(o.level, o);
    else if (o.action === "sell") openBuys.delete(o.level - 1);
  }
  return openBuys.size > 0;
}

/**
 * Build the level array a bot should use (honors its persisted spacingMode).
 *
 * For `fixed` mode the grid is purely equal-spaced from the persisted
 * gridCount. For `atr` mode the step is re-derived from the live rolling ATR
 * every call and clamped to the user's [stepMinPct, stepMaxPct] band, so the
 * grid breathes with realized volatility. We only resize the grid (and persist
 * the new gridCount) when the bot has NO open buys — that preserves the
 * trade-matching invariant that a sell at level N pairs with the open buy at
 * level N-1. While there are open buys we keep the current gridCount so level
 * indices remain stable across ticks.
 */
export function computeBotLevels(bot: GridBot): number[] {
  if (bot.spacingMode !== "atr") {
    return buildGridLevels(bot.lowerPrice, bot.upperPrice, bot.gridCount);
  }
  const stock = getStockByTicker(bot.ticker);
  const referencePrice = stock?.price && stock.price > 0
    ? stock.price
    : (bot.lowerPrice + bot.upperPrice) / 2;
  const { step } = deriveAtrStep({
    ticker: bot.ticker,
    referencePrice,
    atrWindow: bot.atrWindow,
    atrMultiplier: bot.atrMultiplier,
    stepMinPct: bot.stepMinPct,
    stepMaxPct: bot.stepMaxPct,
  });
  const derived = Math.max(2, Math.min(100, Math.floor((bot.upperPrice - bot.lowerPrice) / step)));
  // Freeze re-spacing while the current grid cycle has open buys so existing
  // (level → price) bindings don't shift under fills that are mid-flight.
  const effectiveCount = botHasOpenBuys(bot.id) ? bot.gridCount : derived;
  if (effectiveCount !== bot.gridCount) {
    // Persist so summary, profit-per-grid, and future ticks all agree.
    const newProfitPerGrid = calcProfitPerGrid(bot.lowerPrice, bot.upperPrice, effectiveCount);
    try {
      gridDb.update(gridBots)
        .set({ gridCount: effectiveCount, profitPerGrid: newProfitPerGrid })
        .where(eq(gridBots.id, bot.id))
        .run();
      bot.gridCount = effectiveCount;
      bot.profitPerGrid = newProfitPerGrid;
    } catch (_e) { /* non-fatal — fall through with derived count */ }
  }
  return buildGridLevels(bot.lowerPrice, bot.upperPrice, effectiveCount);
}

/** Calculate profit per grid step as percentage */
export function calcProfitPerGrid(lower: number, upper: number, count: number): number {
  const step = (upper - lower) / count;
  const midPrice = (lower + upper) / 2;
  const rawPct = (step / midPrice) * 100;
  return Math.round(rawPct * 100) / 100; // as %
}

/** Suggest optimal grid count based on range size and price */
export function suggestGridCount(lower: number, upper: number, price: number): number {
  const rangePct = (upper - lower) / price;
  // More grids for wider ranges, fewer for tight ranges
  // Target ~2-4% profit per grid as sweet spot
  if (rangePct > 0.40) return 20;
  if (rangePct > 0.25) return 14;
  if (rangePct > 0.15) return 10;
  if (rangePct > 0.08) return 6;
  return 4;
}

/** Auto-calculate optimal range centered on current price */
export function autoRange(currentPrice: number, volatilityPct = 0.20): { lower: number; upper: number } {
  const lower = Math.round(currentPrice * (1 - volatilityPct) * 100) / 100;
  const upper = Math.round(currentPrice * (1 + volatilityPct) * 100) / 100;
  return { lower, upper };
}

/** Shares per grid level = totalInvestment / gridCount / midPrice */
export function sharesPerLevel(totalInvestment: number, count: number, entryPrice: number): number {
  return Math.round((totalInvestment / count / entryPrice) * 10000) / 10000;
}

// ── Per-bot background tick intervals ──────────────────────────────────────────
const _botIntervals = new Map<number, ReturnType<typeof setInterval>>();

/** Start automatic background ticking for a bot (every 3 s) */
export function startGridBotLoop(id: number): void {
  if (_botIntervals.has(id)) return;
  const interval = setInterval(() => {
    try { simulateGridTick(id); } catch (_e) { /* non-fatal */ }
  }, 3000);
  _botIntervals.set(id, interval);
}

/** Stop the background tick loop for a bot */
export function stopGridBotLoop(id: number): void {
  const interval = _botIntervals.get(id);
  if (interval) { clearInterval(interval); _botIntervals.delete(id); }
}

/** Create a new grid bot */
export function createGridBot(params: {
  ticker: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  totalInvestment: number;
  stopBufferPct?: number;
  spacingMode?: "fixed" | "atr";
  atrWindow?: number;
  atrMultiplier?: number;
  stepMinPct?: number;
  stepMaxPct?: number;
  autoRegridDriftPct?: number;
}): GridBot {
  const {
    ticker, lowerPrice, upperPrice, totalInvestment, stopBufferPct,
    spacingMode = "fixed",
    atrWindow = 14,
    atrMultiplier = 1.0,
    stepMinPct = 0.005,
    stepMaxPct = 0.05,
    autoRegridDriftPct = 0,
  } = params;

  // Determine an initial gridCount. computeBotLevels() will re-derive the step
  // from live ATR on every tick (clamped to [stepMinPct, stepMaxPct]); the
  // value we persist here is just the starting count for the first cycle.
  let gridCount = params.gridCount;
  let atrSnapshot = 0;
  if (spacingMode === "atr") {
    const stock = getStockByTicker(ticker.toUpperCase());
    const referencePrice = stock?.price && stock.price > 0
      ? stock.price
      : (lowerPrice + upperPrice) / 2;
    const { step, atr } = deriveAtrStep({
      ticker: ticker.toUpperCase(),
      referencePrice,
      atrWindow,
      atrMultiplier,
      stepMinPct,
      stepMaxPct,
    });
    const derived = Math.floor((upperPrice - lowerPrice) / step);
    // Cap to the user's requested gridCount (treat it as a max) and a hard
    // upper bound to keep the grid renderable.
    gridCount = Math.max(2, Math.min(params.gridCount, derived, 100));
    // Capture the ATR baseline for #56 drift detection (0 if no history yet —
    // maybeRegridFromDrift() will seed on first live evaluation).
    atrSnapshot = Number.isFinite(atr) ? atr : 0;
  }

  const profitPerGrid = calcProfitPerGrid(lowerPrice, upperPrice, gridCount);

  const bot = gridDb.insert(gridBots).values({
    ticker: ticker.toUpperCase(),
    lowerPrice,
    upperPrice,
    gridCount,
    totalInvestment,
    profitPerGrid,
    stopBufferPct: stopBufferPct ?? 0.05,
    spacingMode,
    atrWindow,
    atrMultiplier,
    stepMinPct,
    stepMaxPct,
    autoRegridDriftPct,
    atrSnapshot,
    createdAt: new Date().toISOString(),
  }).returning().get();

  startGridBotLoop(bot.id);
  return bot;
}

/** Get all grid bots */
export function getAllGridBots(): GridBot[] {
  return gridDb.select().from(gridBots).orderBy(desc(gridBots.id)).all();
}

/** Get a single bot by ID */
export function getGridBot(id: number): GridBot | undefined {
  return gridDb.select().from(gridBots).where(eq(gridBots.id, id)).get();
}

/** Get all orders for a bot */
export function getGridOrders(botId: number): GridOrder[] {
  return gridDb.select().from(gridOrders)
    .where(eq(gridOrders.botId, botId))
    .orderBy(desc(gridOrders.id))
    .all();
}

/**
 * Task #56 — Adaptive regrid hook. When the bot has opted into auto-regrid
 * (autoRegridDriftPct > 0) and is in ATR mode, this checks whether live ATR
 * has drifted more than the configured fraction from `atrSnapshot`. If it has,
 * the bot:
 *   1) flattens every open buy at the supplied marketPrice (preserves P&L),
 *   2) recomputes step / gridCount / profitPerGrid for the NEW volatility,
 *   3) persists the new gridCount + profitPerGrid + atrSnapshot,
 *   4) writes a `grid_events` audit row capturing old↔new step/ATR/count.
 *
 * The freeze guard in computeBotLevels() (no-resize while open buys exist) is
 * deliberately bypassed here because we flatten first, so the level-matching
 * invariant is trivially preserved on the next tick.
 *
 * Returns true if a regrid was applied.
 */
function maybeRegridFromDrift(bot: GridBot, marketPrice: number): boolean {
  if (bot.spacingMode !== "atr") return false;
  if (!bot.autoRegridDriftPct || bot.autoRegridDriftPct <= 0) return false;

  const referencePrice = marketPrice > 0
    ? marketPrice
    : (bot.lowerPrice + bot.upperPrice) / 2;
  const { step: newStep, atr: newAtr } = deriveAtrStep({
    ticker: bot.ticker,
    referencePrice,
    atrWindow: bot.atrWindow,
    atrMultiplier: bot.atrMultiplier,
    stepMinPct: bot.stepMinPct,
    stepMaxPct: bot.stepMaxPct,
  });
  if (!Number.isFinite(newAtr) || newAtr <= 0) return false; // no history yet

  const baseline = bot.atrSnapshot;
  if (!baseline || baseline <= 0) {
    // Seed the baseline on first live observation so future ticks can measure
    // drift against a real value; no flatten/regrid this tick.
    gridDb.update(gridBots).set({ atrSnapshot: newAtr }).where(eq(gridBots.id, bot.id)).run();
    bot.atrSnapshot = newAtr;
    return false;
  }
  const drift = Math.abs(newAtr - baseline) / baseline;
  if (drift < bot.autoRegridDriftPct) return false;

  // Snapshot pre-regrid values for the audit row.
  const oldGridCount = bot.gridCount;
  const oldStep = (bot.upperPrice - bot.lowerPrice) / Math.max(1, oldGridCount);
  const oldAtr = baseline;

  // Count open buys we're about to flatten (for the audit row).
  const flattenedPositions = (() => {
    const orders = getGridOrders(bot.id);
    const openBuys = new Map<number, GridOrder>();
    for (const o of orders) {
      if (o.action === "buy") openBuys.set(o.level, o);
      else if (o.action === "sell") openBuys.delete(o.level - 1);
    }
    return openBuys.size;
  })();
  closeAllOpenPositions(bot, marketPrice);

  const newGridCount = Math.max(
    2,
    Math.min(100, Math.floor((bot.upperPrice - bot.lowerPrice) / newStep)),
  );
  const newProfitPerGrid = calcProfitPerGrid(bot.lowerPrice, bot.upperPrice, newGridCount);

  gridDb.update(gridBots).set({
    gridCount: newGridCount,
    profitPerGrid: newProfitPerGrid,
    atrSnapshot: newAtr,
  }).where(eq(gridBots.id, bot.id)).run();
  bot.gridCount = newGridCount;
  bot.profitPerGrid = newProfitPerGrid;
  bot.atrSnapshot = newAtr;

  gridDb.insert(gridEvents).values({
    botId: bot.id,
    kind: "regrid",
    oldStep: Math.round(oldStep * 10000) / 10000,
    newStep: Math.round(newStep * 10000) / 10000,
    oldAtr: Math.round(oldAtr * 10000) / 10000,
    newAtr: Math.round(newAtr * 10000) / 10000,
    oldGridCount,
    newGridCount,
    flattenedPositions,
    timestamp: new Date().toISOString(),
  }).run();

  return true;
}

/** Get recent regrid audit events for a bot (newest first). */
export function getGridEvents(botId: number, limit = 50): GridEvent[] {
  return gridDb.select().from(gridEvents)
    .where(eq(gridEvents.botId, botId))
    .orderBy(desc(gridEvents.id))
    .limit(limit)
    .all();
}

/**
 * Cancel any outstanding grid-engine work for a bot.
 *
 * The simulator records fills synchronously inside tickGridBot(), so there
 * are no async "working" orders to cancel; stopping the background tick
 * loop is sufficient. This function exists as a single named hook so the
 * future real-broker integration (e.g. resting Alpaca limit orders) can
 * cancel its working orders here without having to find every kill path.
 */
export function cancelOpenGridOrders(botId: number): void {
  stopGridBotLoop(botId);
}

/** Stop a grid bot */
export function stopGridBot(id: number): GridBot | undefined {
  cancelOpenGridOrders(id);
  return gridDb.update(gridBots)
    .set({ status: "stopped", stoppedAt: new Date().toISOString() })
    .where(eq(gridBots.id, id))
    .returning().get();
}

/** Pause/resume a grid bot */
export function toggleGridBot(id: number, status: "active" | "paused"): GridBot | undefined {
  return gridDb.update(gridBots)
    .set({ status })
    .where(eq(gridBots.id, id))
    .returning().get();
}

/**
 * Close all currently open (unmatched) buy positions at market for a bot.
 * Used by the range-exit stop-loss to flatten exposure.
 * Records a SELL grid_order per open buy at the supplied market price,
 * with realized P&L = (marketPrice - buyPrice) * shares, and rolls the
 * total into bot.realizedPnl.
 */
function closeAllOpenPositions(bot: GridBot, marketPrice: number): void {
  const allOrders = getGridOrders(bot.id);
  const openBuys = new Map<number, GridOrder>();
  for (const o of [...allOrders].reverse()) {
    if (o.action === "buy") {
      if (!openBuys.has(o.level)) openBuys.set(o.level, o);
    } else if (o.action === "sell") {
      openBuys.delete(o.level - 1);
    }
  }
  if (openBuys.size === 0) return;

  let pnlDelta = 0;
  let fillsDelta = 0;
  const nowIso = new Date().toISOString();
  for (const buy of Array.from(openBuys.values())) {
    const pnl = Math.round((marketPrice - buy.fillPrice) * buy.shares * 100) / 100;
    const total = Math.round(buy.shares * marketPrice * 100) / 100;
    gridDb.insert(gridOrders).values({
      botId: bot.id,
      ticker: bot.ticker,
      level: buy.level + 1, // synthetic "exit" sell tagged one level up
      gridPrice: marketPrice,
      action: "sell",
      fillPrice: marketPrice,
      shares: buy.shares,
      total,
      pnl,
      filledAt: nowIso,
    }).run();
    pnlDelta += pnl;
    fillsDelta += 1;
  }

  const newPnl = Math.round((bot.realizedPnl + pnlDelta) * 100) / 100;
  const newFills = bot.totalGridFills + fillsDelta;
  gridDb.update(gridBots).set({
    realizedPnl: newPnl,
    totalGridFills: newFills,
  }).where(eq(gridBots.id, bot.id)).run();
  // Keep the in-memory bot reference in sync so any subsequent writes inside
  // the same tick don't overwrite the just-persisted flatten deltas with
  // stale pre-flatten values.
  bot.realizedPnl = newPnl;
  bot.totalGridFills = newFills;
}

/**
 * Run one "tick" of the grid engine for a given bot.
 * 
 * Logic:
 *  - Get current price for the bot's ticker
 *  - Build the grid levels
 *  - Find which grid level the price is currently AT (nearest)
 *  - Look at the last order for this bot:
 *    - If last action was BUY at level N and price has risen to level N+1 → SELL (take profit)
 *    - If last action was SELL at level N and price has dropped to level N-1 → BUY (re-enter)
 *    - If no prior orders, place initial BUY at the nearest level at or below current price
 *  - Record the simulated fill
 */
export function tickGridBot(botId: number): GridOrder | null {
  const bot = getGridBot(botId);
  if (!bot || bot.status !== "active") return null;

  // Task #50 — Global drawdown circuit breaker. We call the portfolio-driven
  // evaluator so the kill switch is truly global: it trips even when the
  // auto-trader tick loop is stopped (grid-only deployments still get the
  // hard-drawdown protection). On trip, every grid bot is flattened at
  // market and parked in `paused_by_breaker`; the boot-time watcher (see
  // bootGridEngine) auto-resumes these bots once drawdown recovers.
  if (evaluateCircuitBreaker()) {
    const livePrice = getLivePrice(bot.ticker);
    const marketPrice = livePrice > 0 ? livePrice : (bot.lowerPrice + bot.upperPrice) / 2;
    closeAllOpenPositions(bot, marketPrice);
    cancelOpenGridOrders(botId);
    gridDb.update(gridBots)
      .set({ status: "paused_by_breaker" })
      .where(eq(gridBots.id, botId))
      .run();
    return null;
  }

  // Advance price simulation — GBM + mean-reversion step
  const currentPrice = advancePrice(bot.ticker);
  if (!currentPrice) return null;

  // Task #56 — Auto-regrid on volatility drift (no-op unless opted in).
  // If a regrid is applied this tick we end early: positions were just
  // flattened at market and the grid was rebuilt, so any further fill in the
  // same tick would race the freshly-persisted bot state. The next 3 s tick
  // will trade against the new grid.
  if (maybeRegridFromDrift(bot, currentPrice)) return null;

  const levels = computeBotLevels(bot);

  // Range-exit stop-loss: if price has strayed beyond [lower*(1-buf), upper*(1+buf)],
  // close all open positions at market and stop the bot.
  const buf = bot.stopBufferPct ?? 0.05;
  const stopLower = bot.lowerPrice * (1 - buf);
  const stopUpper = bot.upperPrice * (1 + buf);
  if (currentPrice < stopLower || currentPrice > stopUpper) {
    closeAllOpenPositions(bot, currentPrice);
    stopGridBotLoop(botId);
    gridDb.update(gridBots)
      .set({ status: "stopped_range_exit", stoppedAt: new Date().toISOString() })
      .where(eq(gridBots.id, botId))
      .run();
    return null;
  }

  // If price is outside the grid range (but within stop buffer), skip tick
  if (currentPrice < bot.lowerPrice || currentPrice > bot.upperPrice) {
    return null;
  }

  // Find the grid level index the price is currently AT or just below
  let nearestLevelIdx = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] <= currentPrice) nearestLevelIdx = i;
    else break;
  }

  const allOrders = getGridOrders(botId);

  // Build a map of which levels have open (unmatched) BUY positions
  // A buy is "open" if its level has no subsequent SELL at level+1
  const openBuys = new Map<number, GridOrder>(); // level → most recent open buy
  for (const o of [...allOrders].reverse()) {
    if (o.action === "buy") {
      // Mark as open unless already closed by a sell
      if (!openBuys.has(o.level)) {
        openBuys.set(o.level, o);
      }
    } else if (o.action === "sell") {
      // A sell at level L closes the open buy at level L-1
      openBuys.delete(o.level - 1);
    }
  }

  const shareQty = sharesPerLevel(bot.totalInvestment, bot.gridCount, levels[nearestLevelIdx] || currentPrice);

  let action: "buy" | "sell";
  let targetLevel: number;
  let pnl: number | null = null;
  let matchedBuy: GridOrder | null = null;

  // ── SELL check: price has risen above a level where we have an open buy ──
  // Look for any open buy at nearestLevelIdx-1 (price just moved above it)
  const sellLevel = nearestLevelIdx; // current level = potential sell target
  const buyLevelForSell = sellLevel - 1;
  if (buyLevelForSell >= 0 && openBuys.has(buyLevelForSell)) {
    matchedBuy = openBuys.get(buyLevelForSell)!;
    // Only sell if current price is genuinely above the buy level
    if (currentPrice >= levels[sellLevel]) {
      action = "sell";
      targetLevel = sellLevel;
      pnl = Math.round((levels[sellLevel] - matchedBuy.gridPrice) * matchedBuy.shares * 100) / 100;
    } else {
      return null;
    }
  } else {
    // ── BUY check: price has fallen to a level we haven't bought yet ──
    const alreadyBoughtHere = openBuys.has(nearestLevelIdx);
    if (!alreadyBoughtHere) {
      action = "buy";
      targetLevel = nearestLevelIdx;
    } else {
      // Already have an open buy at this level — no action
      return null;
    }
  }

  const fillPrice = levels[targetLevel];
  const total = Math.round(shareQty * fillPrice * 100) / 100;

  // Record the grid order
  const order = gridDb.insert(gridOrders).values({
    botId,
    ticker: bot.ticker,
    level: targetLevel,
    gridPrice: fillPrice,
    action,
    fillPrice,
    shares: shareQty,
    total,
    pnl,
    filledAt: new Date().toISOString(),
  }).returning().get();

  // Update bot stats
  const newPnl = pnl !== null
    ? Math.round((bot.realizedPnl + pnl) * 100) / 100
    : bot.realizedPnl;

  gridDb.update(gridBots).set({
    realizedPnl: newPnl,
    totalGridFills: bot.totalGridFills + 1,
  }).where(eq(gridBots.id, botId)).run();

  return order;
}

/**
 * Build the full summary for a grid bot (for the UI)
 */
export function getGridBotSummary(botId: number): GridBotSummary | null {
  const bot = getGridBot(botId);
  if (!bot) return null;

  // Read-only: do NOT advance prices here (prevents double-tick on summary polling)
  const livePrice = getLivePrice(bot.ticker);
  const currentPrice = livePrice > 0 ? livePrice : (bot.lowerPrice + bot.upperPrice) / 2;

  const levels = computeBotLevels(bot);
  const allOrders = getGridOrders(botId);

  // Compute per-level fill info
  const gridLevels: GridLevel[] = levels.map((price, level) => {
    const levelOrders = allOrders.filter(o => o.level === level);
    const buyOrders = levelOrders.filter(o => o.action === "buy");
    const sellOrders = levelOrders.filter(o => o.action === "sell");
    const levelPnl = levelOrders.reduce((acc, o) => acc + (o.pnl ?? 0), 0);

    // Determine what the bot is "waiting to do" at this level
    let action: "buy" | "sell" | "idle" = "idle";
    if (price < currentPrice) action = "buy";   // below current price → waiting to buy on dip
    else if (price > currentPrice) action = "sell"; // above current price → waiting to sell on rise

    return {
      level,
      price,
      action,
      filled: levelOrders.length > 0,
      fillCount: levelOrders.length,
      pnl: Math.round(levelPnl * 100) / 100,
    };
  });

  // Unrealized P&L: sum up open buy positions that haven't been sold yet
  // Simple: count unmatched buys
  let openBuyTotal = 0;
  let openBuyValue = 0;
  for (const o of allOrders) {
    if (o.action === "buy") {
      openBuyTotal += o.total;
      openBuyValue += o.shares * currentPrice;
    } else if (o.action === "sell") {
      // Offset the most recent matched buy
      const matchedBuy = allOrders.find(b => b.action === "buy" && b.level === o.level - 1);
      if (matchedBuy) {
        openBuyTotal -= matchedBuy.total;
        openBuyValue -= matchedBuy.shares * currentPrice;
      }
    }
  }
  const unrealizedPnl = Math.round((openBuyValue - openBuyTotal) * 100) / 100;

  // Active level (which level is current price at)
  const activeLevel = levels.reduce((best, p, i) => {
    return Math.abs(p - currentPrice) < Math.abs(levels[best] - currentPrice) ? i : best;
  }, 0);

  return {
    bot,
    levels: gridLevels,
    orders: allOrders,
    unrealizedPnl,
    totalPnl: Math.round((bot.realizedPnl + unrealizedPnl) * 100) / 100,
    currentPrice,
    activeLevel,
  };
}

/**
 * Simulate a price path and auto-run the grid for demo/paper trading.
 * Called on-demand from the API to advance the simulation.
 */
export function simulateGridTick(botId: number, priceOverride?: number): GridOrder | null {
  // For paper trading we just run the real tick (prices come from seed data)
  return tickGridBot(botId);
}

// ── Task #50: Boot + circuit-breaker watcher ────────────────────────────────
let _breakerWatcher: ReturnType<typeof setInterval> | null = null;

/**
 * Resume any bots that were parked by the circuit breaker now that drawdown
 * has recovered. Runs every 5s as a side-channel because tickGridBot() is
 * what trips the breaker-pause, and once it does its own loop is stopped —
 * so nothing in-bot can observe the breaker resetting.
 */
export function watchBreakerResume(): void {
  // Re-evaluate from the live portfolio before deciding to resume so the
  // breaker's reset condition (portfolio recovered above drawdown limit)
  // is observed independent of the auto-trader loop.
  if (evaluateCircuitBreaker()) return;
  const parked = gridDb.select().from(gridBots)
    .where(eq(gridBots.status, "paused_by_breaker")).all();
  for (const bot of parked) {
    gridDb.update(gridBots).set({ status: "active" }).where(eq(gridBots.id, bot.id)).run();
    startGridBotLoop(bot.id);
  }
}

/**
 * One-shot startup wiring for the grid engine.
 *  - Resumes background tick loops for any bot that was active at shutdown
 *    (verifies the task-50 "restart-survival" criterion — all bot/order
 *     state lives in SQLite and is replayed on demand by tickGridBot()).
 *  - Starts the global breaker-resume watcher.
 */
export function bootGridEngine(): void {
  for (const bot of getAllGridBots()) {
    if (bot.status === "active") startGridBotLoop(bot.id);
  }
  if (!_breakerWatcher) {
    _breakerWatcher = setInterval(() => {
      try { watchBreakerResume(); } catch (_e) { /* non-fatal */ }
    }, 5000);
  }
}
