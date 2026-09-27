import {
  type Trade,
  type InsertTrade,
  type EquityCurvePoint,
  type InsertEquityCurve,
  type PortfolioSummary,
  type Position,
  type UserSettings,
  trades,
  equityCurve,
  settings,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { generateAllStocks } from "./seed";
import { getAlpacaPrice, ALPACA_STOCK_TICKERS } from "./alpaca";

const DB_PATH = process.env.DATA_DB_PATH ?? "data.db";
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true }); // e.g. a fresh /data volume
export const sqlite = new Database(DB_PATH); // V17: exported for shared use by grid-engine
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Create tables manually since we're not using migrations
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    pnl REAL,
    stop_loss REAL,
    take_profit REAL,
    opened_at TEXT NOT NULL,
    closed_at TEXT
  );
  
  CREATE TABLE IF NOT EXISTS engine_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS equity_curve (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    value REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL
  );
`);

// getPortfolio() looks up open trades on every call.
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_equity_curve_ts ON equity_curve(timestamp)`);
// closedPositionPnls() matches a position's rows on these columns.
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(ticker, opened_at, price, status)`);

// Ensure stop_loss and take_profit columns exist (migration for existing DBs)
try {
  sqlite.exec(`ALTER TABLE trades ADD COLUMN stop_loss REAL`);
} catch (_) { /* column already exists */ }
try {
  sqlite.exec(`ALTER TABLE trades ADD COLUMN take_profit REAL`);
} catch (_) { /* column already exists */ }

import { STARTING_BALANCE } from "@shared/constants";
import { hashString } from "@shared/hash";
import { roundPrice } from "@shared/price";
import { simTickVol } from "./sim-vol";
export { STARTING_BALANCE };
const EQUITY_CURVE_MAX_POINTS = 5000; // V17: raised from $100 — realistic position sizing (was too tight)

// Cache stock data (generated once at startup)
let stockDataCache = generateAllStocks();

// Freeze original prices immediately — used as mean-reversion attractors
const _ORIGINAL_PRICES_FROZEN = new Map<string, number>();
for (const s of stockDataCache) {
  _ORIGINAL_PRICES_FROZEN.set(s.ticker, s.price);
}

export function getStockData() {
  return stockDataCache;
}

export function getStockByTicker(ticker: string) {
  return stockDataCache.find((s) => s.ticker === ticker);
}

const DEFAULT_SETTINGS: UserSettings = {
  maxPositionPct: 20,
  stopLossPct: 10,
  takeProfitPct: 25,
  alertsEnabled: true,
  alertBuySignals: true,
  alertSellSignals: true,
};

// Grid bots reserve capital through an open "buy" trade. That trade must be
// valued from the grid's own P&L, not marked to market as if it were a stock
// holding. grid-engine registers this valuer (it imports storage, so storage
// can't import it back); it returns tradeId → current value of each running
// bot's reserve.
let gridReserveValuer: (() => Map<number, number>) | null = null;
export function setGridReserveValuer(fn: () => Map<number, number>): void {
  gridReserveValuer = fn;
}

export interface IStorage {
  getTrades(): Trade[];
  getOpenTrades(): Trade[];
  createTrade(trade: InsertTrade): Trade;
  closeTrade(id: number, closePrice: number, slippageCost?: number): Trade | undefined; // V17: slippage param added
  partialCloseTrade(id: number, shares: number, closePrice: number, slippageCost?: number): Trade | undefined;
  settleTrade(id: number, pnl: number): Trade | undefined;
  getEquityCurve(): EquityCurvePoint[];
  addEquityCurvePoint(point: InsertEquityCurve): EquityCurvePoint;
  getPortfolio(): PortfolioSummary;
  getSettings(): UserSettings;
  saveSettings(s: Partial<UserSettings>): UserSettings;
}

export class DatabaseStorage implements IStorage {
  getTrades(): Trade[] {
    return db.select().from(trades).orderBy(desc(trades.id)).all();
  }

  getOpenTrades(): Trade[] {
    return db.select().from(trades).where(eq(trades.status, "open")).all();
  }

  createTrade(trade: InsertTrade): Trade {
    const result = db.insert(trades).values(trade).returning().get();
    this.snapshotEquity();
    return result;
  }

  closeTrade(id: number, closePrice: number, slippageCost: number = 0): Trade | undefined {
    const trade = db.select().from(trades).where(eq(trades.id, id)).get();
    if (!trade || trade.status === "closed") return undefined;

    // V17 BUG FIX #5: Include slippage so trade log P&L matches engine dashboard
    // Previously: pnl = (close - entry) * shares — ignored slippage entirely
    // Engine computed pnl separately with slippage → trade log showed wrong numbers
    const pnl = (closePrice - trade.price) * trade.shares - slippageCost;

    db.update(trades)
      .set({
        status: "closed",
        pnl: Math.round(pnl * 100) / 100,
        closedAt: new Date().toISOString(),
      })
      .where(eq(trades.id, id))
      .run();

    this.snapshotEquity();
    return db.select().from(trades).where(eq(trades.id, id)).get();
  }

  /**
   * Sell part of an open trade. The open row keeps the unsold shares (and a
   * proportional share of its cost); a new closed row records the sold slice
   * with its realized P&L. Cash in getPortfolio() stays consistent because the
   * two rows' totals add up to the original total.
   */
  partialCloseTrade(id: number, shares: number, closePrice: number, slippageCost: number = 0): Trade | undefined {
    const trade = db.select().from(trades).where(eq(trades.id, id)).get();
    if (!trade || trade.status === "closed") return undefined;
    if (!(shares > 0) || shares >= trade.shares) return undefined;

    const soldTotal = Math.round(trade.total * (shares / trade.shares) * 100) / 100;
    const pnl = (closePrice - trade.price) * shares - slippageCost;

    const closed = sqlite.transaction(() => {
      db.update(trades)
        .set({ shares: trade.shares - shares, total: Math.round((trade.total - soldTotal) * 100) / 100 })
        .where(eq(trades.id, id))
        .run();
      return db.insert(trades).values({
        ticker: trade.ticker,
        action: trade.action,
        shares,
        price: trade.price,
        total: soldTotal,
        status: "closed",
        pnl: Math.round(pnl * 100) / 100,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        openedAt: trade.openedAt,
        closedAt: new Date().toISOString(),
      }).returning().get();
    })();

    this.snapshotEquity();
    return closed;
  }

  /** Close an open trade with an externally computed P&L (grid bot reserves). */
  settleTrade(id: number, pnl: number): Trade | undefined {
    const trade = db.select().from(trades).where(eq(trades.id, id)).get();
    if (!trade || trade.status === "closed") return undefined;
    db.update(trades)
      .set({ status: "closed", pnl: Math.round(pnl * 100) / 100, closedAt: new Date().toISOString() })
      .where(eq(trades.id, id))
      .run();
    this.snapshotEquity();
    return db.select().from(trades).where(eq(trades.id, id)).get();
  }

  getEquityCurve(): EquityCurvePoint[] {
    return db.select().from(equityCurve).all();
  }

  addEquityCurvePoint(point: InsertEquityCurve): EquityCurvePoint {
    const row = db.insert(equityCurve).values(point).returning().get();
    // Keep the curve bounded: it gets a point per trade event plus every 5
    // minutes, forever, and /api/equity-curve returns all of it.
    if (row.id % 500 === 0) {
      sqlite.prepare("DELETE FROM equity_curve WHERE id <= ?").run(row.id - EQUITY_CURVE_MAX_POINTS);
    }
    return row;
  }

  /**
   * Cash totals and the win record over the whole trade history. getPortfolio
   * runs several times per engine tick and per grid tick, and both of these
   * scan every trade, so they're cached until the trade table changes. The
   * key comes from index lookups only: every write that changes a total adds
   * a row, closes one or deletes some, which moves one of the three numbers.
   * (Without the cache a portfolio read took ~1 s at 10,000 trades.)
   */
  private historyCache: { key: string; spent: number; returned: number; closedCount: number; winCount: number } | null = null;
  private tradeHistory() {
    const k = sqlite.prepare(`
      SELECT (SELECT COUNT(*) FROM trades WHERE status = 'closed') AS c,
             (SELECT COUNT(*) FROM trades WHERE status = 'open')   AS o,
             (SELECT MAX(id) FROM trades)                           AS m
    `).get() as { c: number; o: number; m: number | null };
    const key = `${k.c}|${k.o}|${k.m}`;
    if (this.historyCache?.key === key) return this.historyCache;
    // Every buy spends its total; every closed trade with a P&L returns total + pnl.
    const agg = sqlite.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN action = 'buy' THEN total ELSE 0 END), 0)                          AS spent,
        COALESCE(SUM(CASE WHEN status = 'closed' AND pnl IS NOT NULL THEN total + pnl ELSE 0 END), 0) AS returned
      FROM trades
    `).get() as { spent: number; returned: number };
    const pnls = this.closedPositionPnls();
    this.historyCache = { key, ...agg, closedCount: pnls.length, winCount: pnls.filter(v => v > 0).length };
    return this.historyCache;
  }

  getPortfolio(): PortfolioSummary {
    // Only open trades come back as rows; the closed history is summarized
    // (and cached) by tradeHistory().
    const agg = this.tradeHistory();
    const wr = agg;
    const openTrades = db.select().from(trades).where(eq(trades.status, "open")).orderBy(desc(trades.id)).all();

    const cash = STARTING_BALANCE - agg.spent + agg.returned;

    const reserveValues = gridReserveValuer?.() ?? new Map<number, number>();
    const gridReserves = openTrades.filter((t) => reserveValues.has(t.id));

    // Calculate positions (aggregate by ticker)
    const posMap = new Map<string, { shares: number; totalCost: number }>();
    for (const t of openTrades) {
      if (reserveValues.has(t.id)) continue;
      const existing = posMap.get(t.ticker) || { shares: 0, totalCost: 0 };
      existing.shares += t.shares;
      existing.totalCost += t.total;
      posMap.set(t.ticker, existing);
    }

    const positions: Position[] = [];
    let investedValue = 0;


    for (const [ticker, pos] of posMap) {
      const stock = getStockByTicker(ticker);
      if (!stock) continue;

      const marketValue = pos.shares * stock.price;
      const avgCost = pos.totalCost / pos.shares;
      const unrealizedPnl = marketValue - pos.totalCost;
      const unrealizedPnlPercent = (unrealizedPnl / pos.totalCost) * 100;

      positions.push({
        ticker,
        shares: Math.round(pos.shares * 10000) / 10000,
        avgCost: Math.round(avgCost * 100) / 100,
        currentPrice: stock.price,
        marketValue: Math.round(marketValue * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 100) / 100,
      });

      investedValue += marketValue;
    }

    for (const t of gridReserves) {
      const value = reserveValues.get(t.id)!;
      const pnl = value - t.total;
      positions.push({
        ticker: t.ticker,
        shares: Math.round(t.shares * 10000) / 10000,
        avgCost: Math.round(t.price * 100) / 100,
        currentPrice: t.shares > 0 ? Math.round((value / t.shares) * 100) / 100 : 0,
        marketValue: Math.round(value * 100) / 100,
        unrealizedPnl: Math.round(pnl * 100) / 100,
        unrealizedPnlPercent: t.total > 0 ? Math.round((pnl / t.total) * 10000) / 100 : 0,
      });
      investedValue += value;
    }

    const totalValue = Math.round((cash + investedValue) * 100) / 100;
    const totalPnl = Math.round((totalValue - STARTING_BALANCE) * 100) / 100;
    const totalPnlPercent = Math.round((totalPnl / STARTING_BALANCE) * 10000) / 100;
    // Today's P&L against the portfolio value at the start of the ET trading
    // day. (It used to multiply shares by each stock's seeded `dayChange`, a
    // constant from the synthetic startup data.)
    const dayStart = this.dayStartValue();
    const dayPnl = Math.round((totalValue - dayStart) * 100) / 100;
    const dayPnlPercent = dayStart > 0 ? Math.round((dayPnl / dayStart) * 10000) / 100 : 0;

    const winRate = wr.closedCount > 0
      ? Math.round((wr.winCount / wr.closedCount) * 10000) / 100
      : 0;

    // Risk score: based on concentration and position count
    let riskScore = 0;
    if (positions.length > 0 && investedValue > 0) {
      const maxWeight = Math.max(...positions.map(p => p.marketValue / totalValue));
      riskScore = Math.round(
        Math.min(100, maxWeight * 100 * 0.6 + (investedValue / totalValue) * 100 * 0.4)
      );
    }

    return {
      totalValue,
      cash: Math.round(cash * 100) / 100,
      investedValue: Math.round(investedValue * 100) / 100,
      dayPnl,
      dayPnlPercent,
      totalPnl,
      totalPnlPercent,
      winRate,
      openPositions: positions.length,
      riskScore,
      positions,
    };
  }

  /**
   * Realized P&L of each fully closed position, oldest first. A T1 partial
   * exit is stored as its own closed row carrying the parent's ticker, entry
   * price and open time, so rows are grouped on those and their P&L summed;
   * a position still partly open isn't included until it is fully closed.
   * Win rates count these, not rows (a partial used to count as its own win).
   */
  closedPositionPnls(): number[] {
    const rows = sqlite.prepare(`
      SELECT SUM(COALESCE(pnl, 0)) AS pnl
      FROM trades g WHERE status = 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM trades o
          WHERE o.status = 'open' AND o.ticker = g.ticker AND o.opened_at = g.opened_at AND o.price = g.price
        )
      GROUP BY ticker, opened_at, price
      ORDER BY MIN(id)
    `).all() as { pnl: number }[];
    return rows.map(r => r.pnl);
  }

  /**
   * Portfolio value at the start of today (ET): the last equity-curve point
   * before ET midnight, else the first point today, else the starting balance.
   */
  dayStartValue(now: Date = new Date()): number {
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const offsetMs = now.getTime() - et.getTime();          // ET → UTC
    const etMidnight = new Date(et); etMidnight.setHours(0, 0, 0, 0);
    const cutoff = new Date(etMidnight.getTime() + offsetMs).toISOString();
    const before = sqlite.prepare(
      "SELECT value FROM equity_curve WHERE timestamp < ? ORDER BY timestamp DESC, id DESC LIMIT 1",
    ).get(cutoff) as { value: number } | undefined;
    if (before) return before.value;
    const first = sqlite.prepare(
      "SELECT value FROM equity_curve WHERE timestamp >= ? ORDER BY timestamp ASC, id ASC LIMIT 1",
    ).get(cutoff) as { value: number } | undefined;
    return first?.value ?? STARTING_BALANCE;
  }

  getSettings(): UserSettings {
    const rows = db.select().from(settings).all();
    const result = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      const key = row.key as keyof UserSettings;
      if (key in result) {
        const val = row.value;
        if (typeof DEFAULT_SETTINGS[key] === "boolean") {
          (result as any)[key] = val === "true";
        } else if (typeof DEFAULT_SETTINGS[key] === "number") {
          (result as any)[key] = parseFloat(val);
        } else {
          (result as any)[key] = val;
        }
      }
    }
    return result;
  }

  saveSettings(s: Partial<UserSettings>): UserSettings {
    for (const [key, value] of Object.entries(s)) {
      const strVal = String(value);
      const existing = db.select().from(settings).where(eq(settings.key, key)).get();
      if (existing) {
        db.update(settings).set({ value: strVal }).where(eq(settings.key, key)).run();
      } else {
        db.insert(settings).values({ key, value: strVal }).run();
      }
    }
    return this.getSettings();
  }

  snapshotEquity() {
    const portfolio = this.getPortfolio();
    this.addEquityCurvePoint({
      timestamp: new Date().toISOString(),
      value: portfolio.totalValue,
    });
  }
}

export const storage = new DatabaseStorage();

/** Bug 8 fix: Safe helper — no unsafe cast needed in index.ts */
export function getEngineStateJson(): string | null {
  try {
    const row = sqlite.prepare("SELECT state_json FROM engine_state WHERE id = 1").get() as { state_json: string } | undefined;
    return row?.state_json ?? null;
  } catch { return null; }
}

// Seed initial equity curve point if empty
if (storage.getEquityCurve().length === 0) {
  storage.addEquityCurvePoint({
    timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    value: STARTING_BALANCE,
  });
}

// ─── Grid Bot Price Source ───────────────────────────────────────────────────
// Grid bots read the live Alpaca quote when one is fresh. Otherwise they
// follow a driftless random walk with the same per-tick volatility as the
// auto-trader's simulator, bounded to ±25% of the seed price.
//
// This used to be a sine wave swinging 12–24% every minute or two, which
// hands any grid a profit by construction; a random walk has no oscillation
// for a grid to harvest, so simulated grid results no longer look like an edge.
//
// Simulated grid prices live in their own map and are NOT written into
// stockDataCache, which belongs to the auto-trader's price model. Sharing it
// made the two simulators overwrite each other's prices.

const gridSim = new Map<string, { price: number; lcg: number }>();

function liveGridPrice(ticker: string): number | null {
  if (!ALPACA_STOCK_TICKERS.has(ticker)) return null;
  const p = getAlpacaPrice(ticker);
  return p != null && p > 0 ? p : null;
}

/** True when the grid price for a ticker is a live Alpaca quote. */
export function isLiveGridPrice(ticker: string): boolean {
  return liveGridPrice(ticker) != null;
}

/** Advance the grid price for a ticker by one tick and return it. */
export function advanceGridPrice(ticker: string): number {
  const live = liveGridPrice(ticker);
  if (live != null) return live;

  const stock = stockDataCache.find(s => s.ticker === ticker);
  if (!stock) return 0;
  const mu = _ORIGINAL_PRICES_FROZEN.get(ticker) ?? stock.price;

  let g = gridSim.get(ticker);
  if (!g) { g = { price: mu, lcg: (hashString(ticker) ^ 0x5bd1e995) >>> 0 }; gridSim.set(ticker, g); }
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u1 = Math.max(1e-10, g.lcg / 0xffffffff);
  g.lcg = (g.lcg * 1664525 + 1013904223) >>> 0;
  const u2 = g.lcg / 0xffffffff;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const vol = simTickVol(mu, (stock as { marketType?: string }).marketType ?? "stock");
  g.price = roundPrice(Math.max(mu * 0.75, Math.min(mu * 1.25, g.price * (1 + vol * z))));
  return g.price;
}

/** Current grid price without advancing (live quote, else last simulated, else seed). */
export function getGridPrice(ticker: string): number {
  return liveGridPrice(ticker)
    ?? gridSim.get(ticker)?.price
    ?? _ORIGINAL_PRICES_FROZEN.get(ticker)
    ?? 0;
}
