import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Paper trades
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  action: text("action").notNull(), // "buy" or "sell"
  shares: real("shares").notNull(),
  price: real("price").notNull(),
  total: real("total").notNull(),
  status: text("status").notNull().default("open"), // "open" or "closed"
  pnl: real("pnl"), // realized P&L when closed
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
});

export const insertTradeSchema = createInsertSchema(trades).omit({
  id: true,
  status: true,
  pnl: true,
  closedAt: true,
});

export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;

// Equity curve snapshots
export const equityCurve = sqliteTable("equity_curve", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull(),
  value: real("value").notNull(),
});

export const insertEquityCurveSchema = createInsertSchema(equityCurve).omit({
  id: true,
});

export type InsertEquityCurve = z.infer<typeof insertEquityCurveSchema>;
export type EquityCurvePoint = typeof equityCurve.$inferSelect;

// Settings table
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

// Stock category
export type StockCategory = "ai-tech" | "penny" | "momentum" | "crypto" | "forex" | "commodity" | "index";

// Extended stock data with all 12 metrics
export interface StockData {
  ticker: string;
  name: string;
  price: number;
  previousClose: number;
  dayChange: number;
  dayChangePercent: number;
  weekChangePercent: number;
  monthChangePercent: number;
  volume: number;
  avgVolume: number;
  high: number;
  low: number;
  open: number;
  history: DailyCandle[];
  category: StockCategory;
  // 12 metrics
  rsi: number;
  macdSignal: number; // +20 bullish, 0 neutral, -20 bearish
  maAlignment: number; // +30 aligned up, 0 mixed, -30 aligned down
  volumeSpikeRatio: number;
  bollingerPosition: number; // 0-100, where 0=lower band, 100=upper band
  shortInterestPct: number;
  daysToCover: number;
  floatShares: number; // in millions
  catalystScore: number; // 0-100
  sentimentScore: number; // 0-100
  institutionalOwnershipPct: number;
  insiderActivity: string | number; // "Net Buying" | "Net Selling" | "Neutral" or -100 to +100
  // Derived scores
  momentumScore: number;
  volumeScore: number;
  analystScore: number;
  compositeScore: number;
  signal: "BUY" | "SELL" | "HOLD";
  bullBearRatio: number;
  analystRatings: { buy: number; hold: number; sell: number };
  analystActions: AnalystAction[];
  sentimentSummary: { bull: string; bear: string };
  // Additional data for deep dive
  marketCap: number;
  beta: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  ma20: number;
  ma50: number;
  nextEarnings: string;
  sector: string;
  catalystTimeline: CatalystEvent[];
  // Multi-market fields
  marketType: "stock" | "crypto" | "forex" | "commodity" | "index";
  exchange: string;      // e.g. NYSE, Binance, Forex, COMEX
  tradingHours: "24/7" | "24/5" | "market_hours";
  pipSize: number;       // minimum price increment (0.0001 for forex, 1 for indices)
  ma20dAlignment: string; // "Above" | "Below" | "At"
}

export interface DailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma20?: number;
  ma50?: number;
  bollingerUpper?: number;
  bollingerLower?: number;
}

export interface AnalystAction {
  date: string;
  firm: string;
  action: string;
  rating: string;
  priceTarget: number;
}

export interface CatalystEvent {
  date: string;
  type: string;
  title: string;
  impact: "positive" | "negative" | "neutral";
}

export interface PortfolioSummary {
  totalValue: number;
  cash: number;
  investedValue: number;
  dayPnl: number;
  dayPnlPercent: number;
  totalPnl: number;
  totalPnlPercent: number;
  winRate: number;
  openPositions: number;
  riskScore: number;
  positions: Position[];
}

export interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface SignalRow {
  rank: number;
  ticker: string;
  name: string;
  price: number;
  dayChangePercent: number;
  volumeVsAvg: number;
  momentumScore: number;
  sentimentScore: number;
  compositeScore: number;
  signal: "BUY" | "SELL" | "HOLD";
  sparkline: number[];
}

// Scanner types
export interface PennyStockRow {
  rank: number;
  ticker: string;
  name: string;
  price: number;
  dayChangePercent: number;
  weekChangePercent: number;
  monthChangePercent: number;
  floatShares: number;
  shortInterestPct: number;
  volumeSpikeRatio: number;
  catalystScore: number;
  compositeScore: number;
  signal: "BUY" | "SELL" | "HOLD";
  livePrice?: boolean;
}

export interface MomentumRow {
  rank: number;
  ticker: string;
  name: string;
  price: number;
  dayChangePercent: number;
  rsi: number;
  macdSignal: number;
  bollingerPosition: number;
  volumeSpikeRatio: number;
  ma20Cross: string;
  ma50Cross: string;
  breakoutScore: number;
  signal: "BUY" | "SELL" | "HOLD";
  livePrice?: boolean;
}

export interface SqueezeRow {
  rank: number;
  ticker: string;
  name: string;
  price: number;
  shortInterestPct: number;
  daysToCover: number;
  costToBorrow: number;
  floatShares: number;
  volumeSpikeRatio: number;
  squeezeScore: number;
  signal: "BUY" | "SELL" | "HOLD";
  livePrice?: boolean;
}

export interface OptionsFlowRow {
  rank: number;
  ticker: string;
  price: number;
  contractType: "Call" | "Put";
  strike: number;
  expiry: string;
  premium: number;
  volumeVsOI: number;
  sentiment: "Bullish" | "Bearish";
  flowScore: number;
  signal: "BUY" | "SELL" | "HOLD";
}

export interface MarketStatus {
  sentiment: "Bullish" | "Bearish" | "Uncertain";
  sp500: { price: number; change: number; changePercent: number };
  vix: number;
  fearGreed: number; // 0-100
  bitcoin: number;
  marketCloseTime: string;
}

export interface UserSettings {
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  scannerPennyActive: boolean;
  scannerMomentumActive: boolean;
  scannerSqueezeActive: boolean;
  scannerOptionsActive: boolean;
  minScoreThreshold: number;
  alertsEnabled: boolean;
  alertBuySignals: boolean;
  alertSellSignals: boolean;
  alertPriceAlerts: boolean;
}

// ─── Grid Trading Bot ───────────────────────────────────────────────────────

export const gridBots = sqliteTable("grid_bots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  status: text("status").notNull().default("active"), // "active" | "paused" | "paused_by_breaker" | "stopped" | "stopped_range_exit"
  lowerPrice: real("lower_price").notNull(),
  upperPrice: real("upper_price").notNull(),
  gridCount: integer("grid_count").notNull(),
  totalInvestment: real("total_investment").notNull(),
  profitPerGrid: real("profit_per_grid").notNull(), // theoretical % profit per grid step
  stopBufferPct: real("stop_buffer_pct").notNull().default(0.05), // range-exit stop buffer (e.g. 0.05 = 5%)
  // Task #50 — ATR-based spacing (snapshot at creation; gridCount is derived
  // when spacingMode === "atr" and remains stable for the bot's lifetime so
  // level indices stay aligned with open positions on subsequent ticks).
  spacingMode: text("spacing_mode").notNull().default("fixed"), // "fixed" | "atr"
  atrWindow: integer("atr_window").notNull().default(14),
  atrMultiplier: real("atr_multiplier").notNull().default(1.0),
  stepMinPct: real("step_min_pct").notNull().default(0.005), // clamp: min step as % of price
  stepMaxPct: real("step_max_pct").notNull().default(0.05),  // clamp: max step as % of price
  createdAt: text("created_at").notNull(),
  stoppedAt: text("stopped_at"),
  realizedPnl: real("realized_pnl").notNull().default(0),
  totalGridFills: integer("total_grid_fills").notNull().default(0),
});

export const insertGridBotSchema = createInsertSchema(gridBots).omit({
  id: true,
  status: true,
  createdAt: true,
  stoppedAt: true,
  realizedPnl: true,
  totalGridFills: true,
});
export type InsertGridBot = z.infer<typeof insertGridBotSchema>;
export type GridBot = typeof gridBots.$inferSelect;

export const gridOrders = sqliteTable("grid_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  botId: integer("bot_id").notNull(),
  ticker: text("ticker").notNull(),
  level: integer("level").notNull(),       // grid level index (0 = lowest)
  gridPrice: real("grid_price").notNull(), // the exact price this level sits at
  action: text("action").notNull(),        // "buy" | "sell"
  fillPrice: real("fill_price").notNull(),
  shares: real("shares").notNull(),
  total: real("total").notNull(),
  pnl: real("pnl"),                        // set when a sell matches a prior buy
  filledAt: text("filled_at").notNull(),
});
export type GridOrder = typeof gridOrders.$inferSelect;

// Summary interface for frontend
export interface GridBotSummary {
  bot: GridBot;
  levels: GridLevel[];
  orders: GridOrder[];
  unrealizedPnl: number;
  totalPnl: number;
  currentPrice: number;
  activeLevel: number; // which level is current price at
}

export interface GridLevel {
  level: number;
  price: number;
  action: "buy" | "sell" | "idle"; // what the bot would do AT this level
  filled: boolean;
  fillCount: number;
  pnl: number;
}
