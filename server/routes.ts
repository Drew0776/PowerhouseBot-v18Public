import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, getStockData, getStockByTicker } from "./storage";
import { requireAuth, passport } from "./auth";
import { scorePennyStock, scoreMomentum, scoreSqueeze, generateOptionsFlow, generateMarketStatus } from "./seed";
import {
  createGridBot,
  getAllGridBots,
  getGridBot,
  getGridOrders,
  getGridBotSummary,
  stopGridBot,
  toggleGridBot,
  simulateGridTick,
  buildGridLevels,
  calcProfitPerGrid,
  suggestGridCount,
  autoRange,
  startGridBotLoop,
  stopGridBotLoop,
  getGridEvents,
} from "./grid-engine";
import {
  autoTraderTick,
  startAutoTrader,
  stopAutoTrader,
  resetAutoTraderState,
  getAutoTraderState,
  isAutoTraderRunning,
  scanForBreakouts,
  runWalkForwardBacktest,
} from "./auto-trader";

// ─── V17: Telegram Alert Helper ─────────────────────────────────────────────
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment to enable alerts
// Get bot token: https://t.me/BotFather | Get chat ID: https://t.me/userinfobot
async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // Silent if not configured
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (_e) { /* non-fatal */ }
}

// Export so auto-trader can call it for circuit breaker + signal alerts
export { sendTelegramAlert };

// Alpaca feed
import { getAlpacaStatus, getAlpacaAccount, getAlpacaPrice, ALPACA_STOCK_TICKERS, refreshAllPrices, startAlpacaFeed, setAlpacaPriceCallback } from "./alpaca";
import { pushMtfBar } from "./auto-trader";
import { z } from "zod";

// Deterministic random for market status & options flow
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── Auth routes (public) ──────────────────────────────────────────────────

  // GET /api/auth/check — returns whether the current session is authenticated
  app.get("/api/auth/check", (req, res) => {
    res.json({ authenticated: req.isAuthenticated() });
  });

  // POST /api/auth/login — { password }
  app.post("/api/auth/login", (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate("local", (err: unknown, user: Express.User | false) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: "Invalid password" });
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.json({ authenticated: true });
      });
    })(req, res, next);
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req: Request, res: Response, next: NextFunction) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ authenticated: false });
    });
  });

  // ── Protected routes ──────────────────────────────────────────────────────

  // GET /api/portfolio — current portfolio value, P&L, positions
  app.get("/api/portfolio", requireAuth, (_req, res) => {
    try {
      const portfolio = storage.getPortfolio();
      res.json(portfolio);
    } catch (err) {
      res.status(500).json({ message: "Failed to get portfolio" });
    }
  });

  // GET /api/signals — all instruments with scores and market metadata
  app.get("/api/signals", (_req, res) => {
    try {
      const stocks = getStockData();
      const signals = stocks.map((s, i) => {
        // Use real Alpaca price for tracked US stocks when feed is live
        const livePrice = ALPACA_STOCK_TICKERS.has(s.ticker) ? (getAlpacaPrice(s.ticker) ?? s.price) : s.price;
        return ({
        rank: i + 1,
        ticker: s.ticker,
        name: s.name,
        price: livePrice,
        dayChangePercent: s.dayChangePercent,
        volumeVsAvg: Math.round((s.volume / s.avgVolume) * 100) / 100,
        momentumScore: s.momentumScore,
        sentimentScore: s.sentimentScore,
        compositeScore: s.compositeScore,
        signal: s.signal,
        sparkline: s.history.slice(-7).map((c) => c.close),
        // Multi-market fields
        category: s.category,
        marketType: s.marketType,
        exchange: s.exchange,
        tradingHours: s.tradingHours,
        sector: s.sector,
        rsi: s.rsi,
        volumeSpikeRatio: s.volumeSpikeRatio,
        shortInterestPct: s.shortInterestPct,
        floatShares: s.floatShares,
        livePrice: ALPACA_STOCK_TICKERS.has(s.ticker) && getAlpacaPrice(s.ticker) != null,
      });
      });
      res.json(signals);
    } catch (err) {
      res.status(500).json({ message: "Failed to get signals" });
    }
  });

  // GET /api/signals/:ticker — individual stock detail with history
  app.get("/api/signals/:ticker", (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const stock = getStockByTicker(ticker);
      if (!stock) {
        return res.status(404).json({ message: "Stock not found" });
      }
      const livePrice = ALPACA_STOCK_TICKERS.has(ticker) ? (getAlpacaPrice(ticker) ?? stock.price) : stock.price;
      res.json({ ...stock, price: livePrice, livePrice: ALPACA_STOCK_TICKERS.has(ticker) && getAlpacaPrice(ticker) != null });
    } catch (err) {
      res.status(500).json({ message: "Failed to get stock detail" });
    }
  });

  // GET /api/scanner/:mode — returns filtered/scored stocks for scanner tabs
  app.get("/api/scanner/:mode", (req, res) => {
    try {
      const mode = req.params.mode;
      const rawStocks = getStockData();
      // Overlay real Alpaca prices for tracked US stocks
      const stocks = rawStocks.map(s => {
        const lp = ALPACA_STOCK_TICKERS.has(s.ticker) ? getAlpacaPrice(s.ticker) : null;
        return lp != null ? { ...s, price: lp } : s;
      });
      const rand = seededRandom(42);

      if (mode === "penny") {
        const pennyStocks = stocks.filter(s => s.price < 15);
        const scored = pennyStocks.map(s => ({
          rank: 0,
          ticker: s.ticker,
          name: s.name,
          price: s.price,
          dayChangePercent: s.dayChangePercent,
          weekChangePercent: s.weekChangePercent,
          monthChangePercent: s.monthChangePercent,
          floatShares: s.floatShares,
          shortInterestPct: s.shortInterestPct,
          volumeSpikeRatio: s.volumeSpikeRatio,
          catalystScore: s.catalystScore,
          compositeScore: scorePennyStock(s),
          signal: "HOLD" as "BUY" | "SELL" | "HOLD",
          livePrice: ALPACA_STOCK_TICKERS.has(s.ticker) && getAlpacaPrice(s.ticker) != null,
        }));
        scored.sort((a, b) => b.compositeScore - a.compositeScore);
        scored.forEach((s, i) => {
          s.rank = i + 1;
          s.signal = s.compositeScore >= 65 ? "BUY" : s.compositeScore <= 35 ? "SELL" : "HOLD";
        });
        return res.json(scored);
      }

      if (mode === "momentum") {
        const scored = stocks.map(s => ({
          rank: 0,
          ticker: s.ticker,
          name: s.name,
          price: s.price,
          dayChangePercent: s.dayChangePercent,
          rsi: s.rsi,
          macdSignal: s.macdSignal,
          bollingerPosition: s.bollingerPosition,
          volumeSpikeRatio: s.volumeSpikeRatio,
          ma20Cross: s.price > s.ma20 ? "Above" : "Below",
          ma50Cross: s.price > s.ma50 ? "Above" : "Below",
          breakoutScore: scoreMomentum(s),
          signal: "HOLD" as "BUY" | "SELL" | "HOLD",
          livePrice: ALPACA_STOCK_TICKERS.has(s.ticker) && getAlpacaPrice(s.ticker) != null,
        }));
        scored.sort((a, b) => b.breakoutScore - a.breakoutScore);
        scored.forEach((s, i) => {
          s.rank = i + 1;
          s.signal = s.breakoutScore >= 65 ? "BUY" : s.breakoutScore <= 35 ? "SELL" : "HOLD";
        });
        return res.json(scored);
      }

      if (mode === "squeeze") {
        const squeezeStocks = stocks.filter(s => s.shortInterestPct > 5);
        const scored = squeezeStocks.map(s => ({
          rank: 0,
          ticker: s.ticker,
          name: s.name,
          price: s.price,
          shortInterestPct: s.shortInterestPct,
          daysToCover: s.daysToCover,
          costToBorrow: Math.round((s.shortInterestPct * 1.5 + rand() * 10) * 10) / 10,
          floatShares: s.floatShares,
          volumeSpikeRatio: s.volumeSpikeRatio,
          squeezeScore: scoreSqueeze(s),
          signal: "HOLD" as "BUY" | "SELL" | "HOLD",
          livePrice: ALPACA_STOCK_TICKERS.has(s.ticker) && getAlpacaPrice(s.ticker) != null,
        }));
        scored.sort((a, b) => b.squeezeScore - a.squeezeScore);
        scored.forEach((s, i) => {
          s.rank = i + 1;
          s.signal = s.squeezeScore >= 65 ? "BUY" : s.squeezeScore <= 35 ? "SELL" : "HOLD";
        });
        return res.json(scored);
      }

      if (mode === "options") {
        const flows = generateOptionsFlow(stocks, rand);
        return res.json(flows);
      }

      res.status(400).json({ message: "Invalid scanner mode" });
    } catch (err) {
      res.status(500).json({ message: "Failed to get scanner data" });
    }
  });

  // GET /api/market-status — simulated market overview
  app.get("/api/market-status", (_req, res) => {
    try {
      const rand = seededRandom(Date.now() % 10000);
      const status = generateMarketStatus(rand);
      res.json(status);
    } catch (err) {
      res.status(500).json({ message: "Failed to get market status" });
    }
  });

  // GET /api/settings
  app.get("/api/settings", requireAuth, (_req, res) => {
    try {
      const s = storage.getSettings();
      res.json(s);
    } catch (err) {
      res.status(500).json({ message: "Failed to get settings" });
    }
  });

  // GET /api/alpaca/status — connection health + cached ticker count
  app.get("/api/alpaca/status", requireAuth, async (_req, res) => {
    try {
      const status = getAlpacaStatus();
      const account = await getAlpacaAccount();
      res.json({ ...status, account });
    } catch {
      res.status(500).json({ connected: false, error: "Failed to get Alpaca status" });
    }
  });

  // POST /api/alpaca/refresh — force immediate price refresh
  app.post("/api/alpaca/refresh", requireAuth, async (_req, res) => {
    try {
      startAlpacaFeed();
      await refreshAllPrices();
      const status = getAlpacaStatus();
      res.json({ success: true, ...status });
    } catch (err: unknown) {
      console.error("[/api/alpaca/refresh] error:", err);
      res.status(500).json({ success: false, error: "Failed to refresh Alpaca feed" });
    }
  });

  // GET /api/telegram/test — test Telegram connection
  app.get("/api/telegram/test", requireAuth, async (_req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return res.json({ connected: false, message: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable alerts" });
    }
    await sendTelegramAlert("🤖 <b>Powerhouse V17 Connected!</b>\nTelegram alerts are active. You'll receive:\n• 🚦 New trade signals\n• 🚨 Circuit breaker triggers\n• 📊 Daily P&L summaries");
    res.json({ connected: true, message: "Test alert sent to your Telegram!" });
  });

  // POST /api/settings
  app.post("/api/settings", requireAuth, (req, res) => {
    try {
      const s = storage.saveSettings(req.body);
      res.json(s);
    } catch (err) {
      res.status(500).json({ message: "Failed to save settings" });
    }
  });

  // GET /api/trades — trade log
  app.get("/api/trades", requireAuth, (_req, res) => {
    try {
      const allTrades = storage.getTrades();
      const closedTrades = allTrades.filter((t) => t.status === "closed");
      const winningTrades = closedTrades.filter((t) => t.pnl !== null && t.pnl > 0);
      const losingTrades = closedTrades.filter((t) => t.pnl !== null && t.pnl < 0);
      const avgReturn = closedTrades.length > 0
        ? Math.round(
            closedTrades.reduce((s, t) => s + (t.pnl || 0), 0) / closedTrades.length * 100
          ) / 100
        : 0;

      res.json({
        trades: allTrades,
        summary: {
          totalTrades: allTrades.length,
          winningTrades: winningTrades.length,
          losingTrades: losingTrades.length,
          averageReturn: avgReturn,
        },
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to get trades" });
    }
  });

  // POST /api/trades — execute a paper trade (buy)
  // SECURITY: the execution price is *always* taken from the server-side
  // market data (getStockByTicker). Any client-supplied price is ignored so
  // callers cannot forge entry prices and mint arbitrary profits on close.
  const MAX_SHARES = 1_000_000;
  // Only "buy" is supported for opening positions; existing positions are
  // closed via POST /api/trades/:id/close. Naked sells would let a caller
  // mint cash on close (no short-sell model exists), so they are rejected.
  const tradeSchema = z.object({
    ticker: z.string().min(1).max(16).regex(/^[A-Za-z0-9.\-]+$/, "invalid ticker"),
    action: z.literal("buy"),
    shares: z.number().positive().max(MAX_SHARES),
    // price is accepted for backward-compat but intentionally ignored
    price: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    takeProfit: z.number().positive().optional(),
  });

  app.post("/api/trades", requireAuth, (req, res) => {
    try {
      // Reject sell explicitly with a clear message before generic validation.
      if (req.body && req.body.action && req.body.action !== "buy") {
        return res.status(400).json({
          message: "Only buy trades may be opened via this endpoint. Close an existing position via POST /api/trades/:id/close.",
        });
      }
      const parsed = tradeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid trade data", errors: parsed.error.errors });
      }

      const { ticker, action, shares, stopLoss, takeProfit } = parsed.data;
      const upperTicker = ticker.toUpperCase();

      // Validate the ticker is one the server actually tracks, and use the
      // server-side market price as the execution price.
      const stock = getStockByTicker(upperTicker);
      if (!stock) {
        return res.status(404).json({ message: "Unknown ticker" });
      }
      const execPrice = stock.price;
      if (!(execPrice > 0)) {
        return res.status(503).json({ message: "Market price unavailable" });
      }

      const total = Math.round(shares * execPrice * 100) / 100;

      // Check if we have enough cash for buy (only buys reach here).
      const portfolio = storage.getPortfolio();
      if (total > portfolio.cash) {
        return res.status(400).json({ message: `Insufficient cash. Available: $${portfolio.cash.toFixed(2)}` });
      }

      const trade = storage.createTrade({
        ticker: upperTicker,
        action,
        shares,
        price: execPrice,
        total,
        stopLoss: stopLoss ?? null,
        takeProfit: takeProfit ?? null,
        openedAt: new Date().toISOString(),
      });

      res.json(trade);
    } catch (err) {
      res.status(500).json({ message: "Failed to create trade" });
    }
  });

  // POST /api/trades/:id/close — close a position
  app.post("/api/trades/:id/close", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid trade ID" });
      }

      const allTrades = storage.getTrades();
      const trade = allTrades.find((t) => t.id === id);
      if (!trade) {
        return res.status(404).json({ message: "Trade not found" });
      }

      const stock = getStockByTicker(trade.ticker);
      if (!stock) {
        return res.status(404).json({ message: "Stock not found" });
      }

      const closedTrade = storage.closeTrade(id, stock.price);
      if (!closedTrade) {
        return res.status(400).json({ message: "Trade already closed" });
      }

      res.json(closedTrade);
    } catch (err) {
      res.status(500).json({ message: "Failed to close trade" });
    }
  });

  // GET /api/equity-curve — portfolio value time series
  app.get("/api/equity-curve", requireAuth, (_req, res) => {
    try {
      const curve = storage.getEquityCurve();
      res.json(curve);
    } catch (err) {
      res.status(500).json({ message: "Failed to get equity curve" });
    }
  });

  // ─── Auto-Trader API ─────────────────────────────────────────────────────

  // GET /api/auto-trader — full state
  app.get("/api/auto-trader", requireAuth, (_req, res) => {
    try {
      res.json(getAutoTraderState());
    } catch (err) {
      res.status(500).json({ message: "Failed to get auto-trader state" });
    }
  });

  // POST /api/auto-trader/start — start the engine
  app.post("/api/auto-trader/start", requireAuth, (_req, res) => {
    try {
      startAutoTrader();
      res.json({ status: "started" });
    } catch (err) {
      res.status(500).json({ message: "Failed to start" });
    }
  });

  // POST /api/auto-trader/stop — stop the engine
  app.post("/api/auto-trader/stop", requireAuth, (_req, res) => {
    try {
      stopAutoTrader();
      res.json({ status: "stopped" });
    } catch (err) {
      res.status(500).json({ message: "Failed to stop" });
    }
  });

  // POST /api/auto-trader/tick — advance one tick
  app.post("/api/auto-trader/tick", requireAuth, (_req, res) => {
    try {
      if (!isAutoTraderRunning()) {
        return res.status(400).json({ message: "Auto-trader is not running. Start it first." });
      }
      const result = autoTraderTick();
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: "Failed to tick" });
    }
  });

  // GET /api/auto-trader/scan — scan without trading (preview)
  app.get("/api/auto-trader/scan", requireAuth, (_req, res) => {
    try {
      const signals = scanForBreakouts();
      res.json(signals);
    } catch (err) {
      res.status(500).json({ message: "Failed to scan" });
    }
  });

  // POST /api/auto-trader/backtest — V6 walk-forward backtest
  app.post("/api/auto-trader/backtest", requireAuth, (req, res) => {
    try {
      const ticks = typeof req.body?.ticks === "number" ? Math.min(req.body.ticks, 5000) : 1000;
      const result = runWalkForwardBacktest(ticks);
      res.json(result);
    } catch (err) {
      console.error("[/api/auto-trader/backtest] error:", err);
      res.status(500).json({ message: "Backtest failed" });
    }
  });

  // POST /api/portfolio/reset — reset trades and equity curve for fresh start
  app.post("/api/portfolio/reset", requireAuth, async (_req, res) => {
    try {
      // Delete all trades and equity curve entries
      const { db } = await import("./storage");
      const { trades, equityCurve } = await import("../shared/schema");
      db.delete(trades).run();
      db.delete(equityCurve).run();
      // Seed fresh equity point
      storage.addEquityCurvePoint({ timestamp: new Date().toISOString(), value: 100 });
      stopAutoTrader();
      resetAutoTraderState();
      res.json({ message: "Portfolio reset to $100. All trades cleared.", cash: 100 });
    } catch (err) {
      console.error("[/api/portfolio/reset] error:", err);
      res.status(500).json({ message: "Reset failed" });
    }
  });

  // ─── Grid Bot API ────────────────────────────────────────────────────────

  // GET /api/grid/bots — list all grid bots
  app.get("/api/grid/bots", requireAuth, (_req, res) => {
    try {
      const bots = getAllGridBots();
      res.json(bots);
    } catch (err) {
      res.status(500).json({ message: "Failed to get grid bots" });
    }
  });

  // GET /api/grid/bots/:id — full summary for one bot
  app.get("/api/grid/bots/:id", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const summary = getGridBotSummary(id);
      if (!summary) return res.status(404).json({ message: "Bot not found" });
      res.json(summary);
    } catch (err) {
      res.status(500).json({ message: "Failed to get bot summary" });
    }
  });

  // POST /api/grid/bots — create a new grid bot
  const createBotSchema = z.object({
    ticker: z.string().min(1).max(10),
    lowerPrice: z.number().positive(),
    upperPrice: z.number().positive(),
    gridCount: z.number().int().min(2).max(50),
    totalInvestment: z.number().positive(),
    stopBufferPct: z.number().min(0).max(0.5).optional(),
    // Task #50 — ATR spacing controls (all optional; defaults preserve
    // legacy fixed-spacing behavior for clients that don't send them).
    spacingMode: z.enum(["fixed", "atr"]).optional(),
    atrWindow: z.number().int().min(2).max(200).optional(),
    atrMultiplier: z.number().positive().max(20).optional(),
    stepMinPct: z.number().min(0.0005).max(0.5).optional(),
    stepMaxPct: z.number().min(0.001).max(1).optional(),
    // Task #56 — opt-in adaptive regrid threshold (e.g. 0.30 = 30% ATR drift).
    // 0 (default) = OFF — bot keeps existing behavior.
    autoRegridDriftPct: z.number().min(0).max(5).optional(),
  });

  app.post("/api/grid/bots", requireAuth, (req, res) => {
    try {
      const parsed = createBotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid bot config", errors: parsed.error.errors });
      }
      const {
        ticker, lowerPrice, upperPrice, gridCount, totalInvestment, stopBufferPct,
        spacingMode, atrWindow, atrMultiplier, stepMinPct, stepMaxPct,
        autoRegridDriftPct,
      } = parsed.data;
      // Auto-regrid only makes sense in ATR mode; reject silently-ignored values
      // so the operator can't think it's on when it isn't.
      if (autoRegridDriftPct && autoRegridDriftPct > 0 && spacingMode !== "atr") {
        return res.status(400).json({ message: "autoRegridDriftPct requires spacingMode='atr'" });
      }
      if (stepMinPct !== undefined && stepMaxPct !== undefined && stepMinPct >= stepMaxPct) {
        return res.status(400).json({ message: "stepMinPct must be < stepMaxPct" });
      }

      if (lowerPrice >= upperPrice) {
        return res.status(400).json({ message: "Lower price must be below upper price" });
      }

      // Check stock exists
      const stock = getStockByTicker(ticker.toUpperCase());
      if (!stock) {
        return res.status(404).json({ message: `Ticker ${ticker.toUpperCase()} not found in universe` });
      }

      // V8: Prevent duplicate active bots on same ticker
      const existingBots = getAllGridBots();
      const activeDuplicate = existingBots.find(
        b => b.ticker.toUpperCase() === ticker.toUpperCase() && b.status === "active"
      );
      if (activeDuplicate) {
        return res.status(400).json({ message: `An active grid bot already exists for ${ticker.toUpperCase()}. Stop it before creating a new one.` });
      }

      // Check portfolio cash
      const portfolio = storage.getPortfolio();
      if (totalInvestment > portfolio.cash) {
        return res.status(400).json({ message: `Insufficient cash. Available: $${portfolio.cash.toFixed(2)}` });
      }

      // Reserve the investment from portfolio (create a holding trade)
      const reserveShares = totalInvestment / stock.price;
      storage.createTrade({
        ticker: ticker.toUpperCase(),
        action: "buy",
        shares: reserveShares,
        price: stock.price,
        total: totalInvestment,
        stopLoss: null,
        takeProfit: null,
        openedAt: new Date().toISOString(),
      });

      const bot = createGridBot({
        ticker, lowerPrice, upperPrice, gridCount, totalInvestment, stopBufferPct,
        spacingMode, atrWindow, atrMultiplier, stepMinPct, stepMaxPct,
        autoRegridDriftPct,
      });
      res.json(bot);
    } catch (err) {
      res.status(500).json({ message: "Failed to create grid bot" });
    }
  });

  // GET /api/grid/bots/:id/events — recent regrid audit log (Task #56)
  app.get("/api/grid/bots/:id/events", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50")) || 50));
      res.json(getGridEvents(id, limit));
    } catch (err) {
      res.status(500).json({ message: "Failed to load bot events" });
    }
  });

  // POST /api/grid/bots/:id/tick — advance the simulation by one tick
  app.post("/api/grid/bots/:id/tick", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const order = simulateGridTick(id);
      const summary = getGridBotSummary(id);
      res.json({ order, summary });
    } catch (err) {
      res.status(500).json({ message: "Failed to tick grid bot" });
    }
  });

  // POST /api/grid/bots/:id/stop — stop a bot
  app.post("/api/grid/bots/:id/stop", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = stopGridBot(id);
      if (!bot) return res.status(404).json({ message: "Bot not found" });
      res.json(bot);
    } catch (err) {
      res.status(500).json({ message: "Failed to stop bot" });
    }
  });

  // POST /api/grid/bots/:id/start — (re)start background ticking for a bot
  app.post("/api/grid/bots/:id/start", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = getGridBot(id);
      if (!bot) return res.status(404).json({ message: "Bot not found" });
      if (bot.status !== "active") {
        return res.status(400).json({ message: `Bot is ${bot.status}. Only active bots can be started.` });
      }
      startGridBotLoop(id);
      res.json({ success: true, id, message: "Background loop started" });
    } catch (err) {
      res.status(500).json({ message: "Failed to start bot loop" });
    }
  });

  // POST /api/grid/bots/:id/toggle — pause/resume a bot
  app.post("/api/grid/bots/:id/toggle", requireAuth, (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const { status } = req.body as { status: "active" | "paused" };
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      const bot = toggleGridBot(id, status);
      if (!bot) return res.status(404).json({ message: "Bot not found" });
      if (status === "paused") {
        stopGridBotLoop(id);
      } else if (status === "active") {
        startGridBotLoop(id);
      }
      res.json(bot);
    } catch (err) {
      res.status(500).json({ message: "Failed to toggle bot" });
    }
  });

  // GET /api/grid/preview — preview grid levels before creating
  // SECURITY: clamp `count` (and bound lower/upper) to the same safe range
  // used by createBotSchema so a malicious caller cannot force the server to
  // allocate a multi-million-element array (memory-exhaustion DoS).
  app.get("/api/grid/preview", requireAuth, (req, res) => {
    try {
      const lower = parseFloat(req.query.lower as string);
      const upper = parseFloat(req.query.upper as string);
      const count = parseInt(req.query.count as string);
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isInteger(count)) {
        return res.status(400).json({ message: "lower, upper, count required" });
      }
      if (lower <= 0 || upper <= 0 || lower >= upper) {
        return res.status(400).json({ message: "lower must be > 0 and < upper" });
      }
      if (upper > 1_000_000) {
        return res.status(400).json({ message: "upper must be <= 1,000,000" });
      }
      if (count < 2 || count > 50) {
        return res.status(400).json({ message: "count must be between 2 and 50" });
      }
      const levels = buildGridLevels(lower, upper, count);
      const profitPerGrid = calcProfitPerGrid(lower, upper, count);
      const gridStep = (upper - lower) / count;
      res.json({ levels, profitPerGrid, gridStep });
    } catch (err) {
      res.status(500).json({ message: "Failed to preview grid" });
    }
  });

  // GET /api/grid/auto-range — auto-calculate optimal range for a ticker
  app.get("/api/grid/auto-range", requireAuth, (req, res) => {
    try {
      const ticker = (req.query.ticker as string)?.toUpperCase();
      if (!ticker) return res.status(400).json({ message: "ticker required" });
      const stock = getStockByTicker(ticker);
      if (!stock) return res.status(404).json({ message: "Ticker not found" });
      const { lower, upper } = autoRange(stock.price);
      const suggestedGrids = suggestGridCount(lower, upper, stock.price);
      const profitPerGrid = calcProfitPerGrid(lower, upper, suggestedGrids);
      res.json({
        ticker, currentPrice: stock.price,
        lower, upper, suggestedGrids, profitPerGrid,
        rangePercent: Math.round(((upper - lower) / stock.price) * 10000) / 100,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to auto-range" });
    }
  });

  // GET /api/universe/count — total number of instruments tracked
  app.get("/api/universe/count", (_req, res) => {
    try {
      res.json({ count: getStockData().length });
    } catch (err) {
      res.status(500).json({ message: "Failed to get universe count" });
    }
  });

  // Bug 7 fix: Push Alpaca prices into MTF history for all tickers, not just traded ones.
  // This ensures momentum scoring works correctly for all 181 tickers from startup.
  setAlpacaPriceCallback(pushMtfBar);

  // Auto-start the Alpaca price feed on server init so prices are live immediately
  startAlpacaFeed();

  // Task #50: Resume tick loops for grid bots that were active at shutdown
  // AND start the global circuit-breaker watcher that auto-resumes bots
  // parked by the auto-trader's hard-drawdown breaker once it recovers.
  const { bootGridEngine } = await import("./grid-engine");
  bootGridEngine();

  return httpServer;
}
