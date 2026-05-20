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
import { gridBots, gridOrders } from "@shared/schema";
import type { GridBot, GridOrder, GridBotSummary, GridLevel } from "@shared/schema";
// V17 BUG FIX #4: Share single DB connection from storage.ts — no more lock contention
import { getStockByTicker, advancePrice, getLivePrice, db as gridDb, sqlite } from "./storage";

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
`);

/** Build equally-spaced grid levels between lower and upper */
export function buildGridLevels(lower: number, upper: number, count: number): number[] {
  const step = (upper - lower) / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round((lower + i * step) * 100) / 100);
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
}): GridBot {
  const { ticker, lowerPrice, upperPrice, gridCount, totalInvestment } = params;
  const profitPerGrid = calcProfitPerGrid(lowerPrice, upperPrice, gridCount);

  const bot = gridDb.insert(gridBots).values({
    ticker: ticker.toUpperCase(),
    lowerPrice,
    upperPrice,
    gridCount,
    totalInvestment,
    profitPerGrid,
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

/** Stop a grid bot */
export function stopGridBot(id: number): GridBot | undefined {
  stopGridBotLoop(id);
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

  // Advance price simulation — GBM + mean-reversion step
  const currentPrice = advancePrice(bot.ticker);
  if (!currentPrice) return null;
  const levels = buildGridLevels(bot.lowerPrice, bot.upperPrice, bot.gridCount);

  // If price is outside the grid range, skip tick
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

  const levels = buildGridLevels(bot.lowerPrice, bot.upperPrice, bot.gridCount);
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
