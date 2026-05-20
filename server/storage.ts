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
import { eq, desc } from "drizzle-orm";
import { generateAllStocks } from "./seed";

export const sqlite = new Database("data.db"); // V17: exported for shared use by grid-engine
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

// Ensure stop_loss and take_profit columns exist (migration for existing DBs)
try {
  sqlite.exec(`ALTER TABLE trades ADD COLUMN stop_loss REAL`);
} catch (_) { /* column already exists */ }
try {
  sqlite.exec(`ALTER TABLE trades ADD COLUMN take_profit REAL`);
} catch (_) { /* column already exists */ }

const STARTING_BALANCE = 500; // V17: raised from $100 — realistic position sizing (was too tight)

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
  scannerPennyActive: true,
  scannerMomentumActive: true,
  scannerSqueezeActive: true,
  scannerOptionsActive: true,
  minScoreThreshold: 40,
  alertsEnabled: true,
  alertBuySignals: true,
  alertSellSignals: true,
  alertPriceAlerts: false,
};

export interface IStorage {
  getTrades(): Trade[];
  getOpenTrades(): Trade[];
  createTrade(trade: InsertTrade): Trade;
  closeTrade(id: number, closePrice: number, slippageCost?: number): Trade | undefined; // V17: slippage param added
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

  getEquityCurve(): EquityCurvePoint[] {
    return db.select().from(equityCurve).all();
  }

  addEquityCurvePoint(point: InsertEquityCurve): EquityCurvePoint {
    return db.insert(equityCurve).values(point).returning().get();
  }

  getPortfolio(): PortfolioSummary {
    const allTrades = this.getTrades();
    const openTrades = allTrades.filter((t) => t.status === "open");
    const closedTrades = allTrades.filter((t) => t.status === "closed");

    // Calculate cash remaining
    let cash = STARTING_BALANCE;
    for (const t of allTrades) {
      if (t.action === "buy") {
        cash -= t.total;
      }
      if (t.status === "closed" && t.pnl !== null) {
        cash += t.total + t.pnl;
      }
    }

    // Calculate positions (aggregate by ticker)
    const posMap = new Map<string, { shares: number; totalCost: number }>();
    for (const t of openTrades) {
      const existing = posMap.get(t.ticker) || { shares: 0, totalCost: 0 };
      existing.shares += t.shares;
      existing.totalCost += t.total;
      posMap.set(t.ticker, existing);
    }

    const positions: Position[] = [];
    let investedValue = 0;
    let dayPnl = 0;

    for (const [ticker, pos] of posMap) {
      const stock = getStockByTicker(ticker);
      if (!stock) continue;

      const marketValue = pos.shares * stock.price;
      const avgCost = pos.totalCost / pos.shares;
      const unrealizedPnl = marketValue - pos.totalCost;
      const unrealizedPnlPercent = (unrealizedPnl / pos.totalCost) * 100;
      const dayPnlForPos = pos.shares * stock.dayChange;

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
      dayPnl += dayPnlForPos;
    }

    const totalValue = Math.round((cash + investedValue) * 100) / 100;
    const totalPnl = Math.round((totalValue - STARTING_BALANCE) * 100) / 100;
    const totalPnlPercent = Math.round((totalPnl / STARTING_BALANCE) * 10000) / 100;
    dayPnl = Math.round(dayPnl * 100) / 100;
    const dayPnlPercent = totalValue > 0 ? Math.round((dayPnl / (totalValue - dayPnl)) * 10000) / 100 : 0;

    const winningTrades = closedTrades.filter((t) => t.pnl !== null && t.pnl > 0).length;
    const winRate = closedTrades.length > 0
      ? Math.round((winningTrades / closedTrades.length) * 10000) / 100
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

// ─── Live Price Simulator ────────────────────────────────────────────────────
// Sinusoidal oscillator with superimposed random noise.
// Each ticker gets a unique phase, frequency, and amplitude derived from its
// hash — guaranteeing independent, continuous oscillation around the seed price.
// Price NEVER drifts out of the ±25% band around the seed.

const tickCounts = new Map<string, number>(); // per-ticker tick counter

/** Advance the simulated price for a ticker by one tick */
export function advancePrice(ticker: string): number {
  const stock = stockDataCache.find(s => s.ticker === ticker);
  if (!stock) return 0;

  const mu = _ORIGINAL_PRICES_FROZEN.get(ticker) ?? stock.price;
  const n  = (tickCounts.get(ticker) ?? 0) + 1;
  tickCounts.set(ticker, n);

  // Unique phase offset and frequency per ticker (derived from hash)
  const hash   = ticker.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const phase  = (hash * 2.618) % (2 * Math.PI);          // golden-ratio spread
  const freq   = 0.08 + (hash % 7) * 0.018;               // 0.08–0.19 rad/tick
  const amp    = 0.12 + (hash % 5) * 0.03;                // 12–24% amplitude

  // Primary sine wave
  const primary = Math.sin(freq * n + phase);

  // Secondary higher-frequency component for choppiness
  const secondary = 0.4 * Math.sin(freq * 2.3 * n + phase * 1.7);

  // Deterministic "noise" via LCG (seeded by ticker + tick)
  let lcgSeed = (hash * 1664525 + n * 1013904223) & 0x7fffffff;
  const lcgRand = () => {
    lcgSeed = (lcgSeed * 1664525 + 1013904223) & 0x7fffffff;
    return lcgSeed / 0x7fffffff - 0.5; // [-0.5, 0.5]
  };
  const noise = 0.3 * lcgRand() * amp;

  // Combined wave — always bounded to ±25% around mu
  const raw      = mu * (1 + amp * (primary + secondary) * 0.6 + noise);
  const newPrice = Math.max(mu * 0.75, Math.min(mu * 1.25, raw));
  const rounded  = Math.round(newPrice * 100) / 100;

  // Update cache so /api/signals/:ticker returns live price
  const idx = stockDataCache.findIndex(s => s.ticker === ticker);
  if (idx >= 0) {
    stockDataCache[idx] = { ...stockDataCache[idx], price: rounded };
  }

  return newPrice;
}

/** Get the current live price without advancing */
export function getLivePrice(ticker: string): number {
  const stock = stockDataCache.find(s => s.ticker === ticker);
  return stock?.price ?? 0;
}
