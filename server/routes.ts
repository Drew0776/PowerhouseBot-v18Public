import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, sqlite, getStockData, getStockByTicker, getGridPrice, STARTING_BALANCE } from "./storage";
import { requireAuth, passport } from "./auth";
import { scorePennyStock, scoreMomentum, scoreSqueeze, generateOptionsFlow, STOCK_INFO } from "./seed";
import { nextSessionChange } from "./market-calendar";
import type { MarketStatus, InstrumentDetail } from "@shared/schema";
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
  watchBreakerResume,
  isGridReserveTrade,
  stopAllGridBotsForReset,
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
  resetCircuitBreaker,
  isCircuitBreakerActive,
  getScanDebug,
  liveSignalView,
  instrumentDetail,
  liveCalibration,
  manualFill,
  buyQuote,
} from "./auto-trader";

import { sendTelegramAlert } from "./alerts";



// Alpaca feed
import { getAlpacaStatus, getAlpacaAccount, getAlpacaPrice, ALPACA_STOCK_TICKERS, refreshAllPrices, startAlpacaFeed } from "./alpaca";
import { z } from "zod";
import { roundPrice } from "@shared/price";

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

  // GET /api/auth/check — reports whether this session is logged in.
  app.get("/api/auth/check", (req, res) => {
    res.json({ authenticated: req.isAuthenticated() });
  });

  // GET /api/health — unauthenticated liveness probe for container healthchecks.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // POST /api/auth/login — { password }
  // Throttled per client IP: 10 failed attempts per 15 minutes.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 10;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/auth/login", (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    // Drop expired windows so the table can't grow without bound.
    for (const [k, v] of loginFailures) if (v.resetAt <= now) loginFailures.delete(k);
    const current = loginFailures.get(ip);
    if (current && current.count >= LOGIN_MAX_FAILURES) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ message: "Too many failed attempts. Try again later." });
    }
    passport.authenticate("local", (err: unknown, user: Express.User | false) => {
      if (err) return next(err);
      if (!user) {
        const f = loginFailures.get(ip) ?? { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        f.count++;
        loginFailures.set(ip, f);
        return res.status(401).json({ message: "Invalid password" });
      }
      loginFailures.delete(ip);
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
  // Everything else under /api requires an operator session. Registered here,
  // after the public routes above, so it can't be forgotten on a new route.
  app.use("/api", requireAuth);

  // GET /api/portfolio — current portfolio value, P&L, positions
  app.get("/api/portfolio", requireAuth, (_req, res) => {
    try {
      const portfolio = storage.getPortfolio();
      res.json(portfolio);
    } catch (err) {
      res.status(500).json({ message: "Failed to get portfolio" });
    }
  });

  // GET /api/signals — every instrument with the engine's live view of it.
  // Scores, grades and RSI come from the auto-trader's own price history
  // (liveSignalView), so they match what it trades; they're empty until it
  // has run long enough to warm up. "BUY" marks the top five by rank, the
  // same pool the engine enters from. (These used to be random scores fixed
  // at startup.)
  app.get("/api/signals", (_req, res) => {
    try {
      const view = liveSignalView();
      const rows = getStockData().map(s => {
        const live = ALPACA_STOCK_TICKERS.has(s.ticker) ? getAlpacaPrice(s.ticker) : null;
        const v = view.get(s.ticker);
        return {
          rank: v?.rank ?? null,
          ticker: s.ticker,
          name: s.name,
          price: live ?? s.price,
          livePrice: live != null,
          changePct: v?.changePct ?? null,
          compositeScore: v?.score ?? null,
          grade: v?.grade ?? null,
          rsi: v?.rsi ?? null,
          signal: v?.rank != null && v.rank <= 5 ? "BUY" as const : "HOLD" as const,
          category: s.category,
          marketType: s.marketType,
          exchange: s.exchange,
          tradingHours: s.tradingHours,
          sector: s.sector,
        };
      });
      rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ message: "Failed to get signals" });
    }
  });

  // GET /api/signals/:ticker — what the bot actually knows about one
  // instrument: its sampled prices, the indicators it trades on, and its
  // score and rank. (This used to return a fabricated 30-day chart, analyst
  // ratings credited to real banks, invented news, short interest and an
  // earnings date.)
  app.get("/api/signals/:ticker", (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const stock = getStockByTicker(ticker);
      if (!stock) return res.status(404).json({ message: "Stock not found" });
      const live = ALPACA_STOCK_TICKERS.has(ticker) ? getAlpacaPrice(ticker) : null;
      const { history, features } = instrumentDetail(ticker);
      const v = liveSignalView().get(ticker);
      const info = STOCK_INFO[ticker];
      const detail: InstrumentDetail = {
        ticker, name: stock.name, sector: stock.sector, category: stock.category,
        marketType: stock.marketType ?? "stock", exchange: stock.exchange ?? null,
        price: live ?? stock.price, livePrice: live != null,
        history,
        indicators: features && {
          rsi: features.rsi, pctB: features.pctB, emaFast: features.emaFast, emaSlow: features.emaSlow,
          macdHist: features.macdHist, sigma: features.sigma, momZ: features.momZ,
        },
        score: v?.score ?? null, grade: v?.grade ?? null, rank: v?.rank ?? null, changePct: v?.changePct ?? null,
        reference: {
          marketCapBillions: info?.marketCapBillions ? info.marketCapBillions : null,
          beta: info && Number.isFinite(info.beta) ? info.beta : null,
        },
      };
      res.json(detail);
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

  // GET /api/market-status — US session state and a few reference prices.
  // Prices are live Alpaca quotes where available, otherwise the simulator's
  // own prices (the ones the bot is trading), flagged as such. There is no
  // source for index levels, VIX or sentiment, so none are shown; these used
  // to be random numbers regenerated on every request.
  app.get("/api/market-status", (_req, res) => {
    try {
      const session = nextSessionChange();
      const quotes = ["SPY", "QQQ", "BTC"].flatMap(symbol => {
        const live = ALPACA_STOCK_TICKERS.has(symbol) ? getAlpacaPrice(symbol) : null;
        const price = live ?? getStockByTicker(symbol)?.price;
        return price ? [{ symbol, price, live: live != null }] : [];
      });
      const status: MarketStatus = { sessionOpen: session.open, nextSessionChange: session.at.toISOString(), quotes };
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

  // POST /api/telegram/test — send a test Telegram alert. POST (not GET) so a
  // cross-site <img> or link can't trigger a send.
  app.post("/api/telegram/test", requireAuth, async (_req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return res.json({ connected: false, message: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable alerts" });
    }
    const ok = await sendTelegramAlert("🤖 <b>PowerhouseBot connected</b>\nYou'll get alerts when the auto-trader opens or closes a position, when the circuit breaker trips, and a daily P&amp;L summary. Turn them off in Settings → Notifications.");
    res.json(ok
      ? { connected: true, message: "Test alert sent to your Telegram!" }
      : { connected: false, message: "Telegram rejected the message. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." });
  });

  // POST /api/settings — only known keys, with the right types and ranges.
  const pct = z.number().finite().min(0).max(100);
  const settingsSchema = z.object({
    maxPositionPct: pct,
    stopLossPct: pct,
    takeProfitPct: z.number().finite().min(0).max(1000),
    alertsEnabled: z.boolean(),
    alertBuySignals: z.boolean(),
    alertSellSignals: z.boolean(),
  }).partial().strip(); // unknown keys (including the removed settings) are dropped

  app.post("/api/settings", requireAuth, (req, res) => {
    try {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid settings", errors: parsed.error.errors });
      }
      const s = storage.saveSettings(parsed.data);
      res.json(s);
    } catch (err) {
      res.status(500).json({ message: "Failed to save settings" });
    }
  });

  // GET /api/trades — trade log
  app.get("/api/trades", requireAuth, (_req, res) => {
    try {
      const allTrades = storage.getTrades();
      // Counted per position, so a T1 partial exit and its remainder are one
      // trade (they used to count as two, the partial as an extra win).
      const results = storage.closedPositionPnls();
      const avgReturn = results.length > 0
        ? Math.round(results.reduce((s, v) => s + v, 0) / results.length * 100) / 100
        : 0;

      res.json({
        trades: allTrades,
        summary: {
          totalTrades: allTrades.length,
          winningTrades: results.filter(v => v > 0).length,
          losingTrades: results.filter(v => v < 0).length,
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

  // GET /api/trades/quote?ticker=X — per-share buy price for a manual trade,
  // spread included, or why it can't trade now (409: market closed / stale).
  app.get("/api/trades/quote", requireAuth, (req, res) => {
    const ticker = String(req.query.ticker ?? "").toUpperCase();
    if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker)) return res.status(400).json({ message: "invalid ticker" });
    const q = buyQuote(ticker);
    if ("error" in q) return res.status(q.status).json({ message: q.error });
    res.json({ ticker, price: q.price });
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

      // The server sets the price: the live ask, or the simulated mark plus
      // the modelled half-spread, on the same terms the engine trades.
      const fill = manualFill(upperTicker, "buy", shares);
      if ("error" in fill) return res.status(fill.status).json({ message: fill.error });
      const execPrice = roundPrice(fill.price + fill.cost / shares);

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
      if (isGridReserveTrade(id)) {
        return res.status(409).json({ message: "This trade holds a grid bot's capital. Stop the grid bot instead." });
      }

      if (trade.status === "closed") {
        return res.status(400).json({ message: "Trade already closed" });
      }
      // Sells at the live bid, or the simulated mark less the modelled
      // half-spread; refused while a live stock has no fresh quote.
      const fill = manualFill(trade.ticker, "sell", trade.shares);
      if ("error" in fill) return res.status(fill.status).json({ message: fill.error });

      const closedTrade = storage.closeTrade(id, fill.price, fill.cost);
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

  // POST /api/auto-trader/breaker/reset — Task #68: operator-driven manual
  // release of the daily-loss circuit breaker. 409 if the breaker isn't
  // active so a fat-fingered double-click can't silently re-baseline
  // dailyStart and mask a real drawdown. After clearing, we kick
  // watchBreakerResume() synchronously so any grid bots parked in
  // paused_by_breaker flip back to active in this request instead of
  // waiting up to 5s for the next watcher tick.
  app.post("/api/auto-trader/breaker/reset", requireAuth, (_req, res) => {
    try {
      if (!isCircuitBreakerActive()) {
        return res.status(409).json({ message: "Circuit breaker is not active" });
      }
      resetCircuitBreaker({ manual: true });
      try { watchBreakerResume(); } catch (_e) { /* non-fatal */ }
      res.json(getAutoTraderState());
    } catch (err) {
      res.status(500).json({ message: "Failed to reset breaker" });
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
      const signals = scanForBreakouts({ advance: false }); // preview: no price moves
      res.json(signals);
    } catch (err) {
      res.status(500).json({ message: "Failed to scan" });
    }
  });

  // GET /api/auto-trader/scan-debug — Task #69: per-ticker rejection reasons
  // so the operator can see WHY the scanner returned []. Read-only — does
  // not advance prices, mutate MTF, or write to the event log.
  app.get("/api/auto-trader/scan-debug", requireAuth, (_req, res) => {
    try {
      res.json(getScanDebug());
    } catch (err) {
      res.status(500).json({ message: "Failed to scan-debug" });
    }
  });

  // GET /api/auto-trader/calibration — Brier score and reliability table of
  // the win probabilities the engine sized its closed trades with.
  app.get("/api/auto-trader/calibration", requireAuth, (_req, res) => {
    try {
      res.json(liveCalibration());
    } catch (err) {
      res.status(500).json({ message: "Failed to read calibration" });
    }
  });

  // POST /api/auto-trader/backtest — V6 walk-forward backtest
  // One backtest at a time: each is CPU-heavy, and the server stays
  // responsive only because a single run yields between chunks.
  let backtestRunning = false;
  app.post("/api/auto-trader/backtest", requireAuth, async (req, res) => {
    if (backtestRunning) return res.status(409).json({ message: "A backtest is already running" });
    backtestRunning = true;
    try {
      const raw = req.body?.ticks;
      const ticks = typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(10, Math.min(5000, Math.floor(raw)))
        : 1000;
      const result = await runWalkForwardBacktest(ticks);
      res.json(result);
    } catch (err) {
      console.error("[/api/auto-trader/backtest] error:", err);
      res.status(500).json({ message: "Backtest failed" });
    } finally {
      backtestRunning = false;
    }
  });

  // POST /api/portfolio/reset — reset trades and equity curve for fresh start
  app.post("/api/portfolio/reset", requireAuth, async (_req, res) => {
    try {
      // Delete all trades and equity curve entries
      const { db } = await import("./storage");
      const { trades, equityCurve } = await import("../shared/schema");
      stopAllGridBotsForReset();
      db.delete(trades).run();
      db.delete(equityCurve).run();
      // Seed fresh equity point
      storage.addEquityCurvePoint({ timestamp: new Date().toISOString(), value: STARTING_BALANCE });
      stopAutoTrader();
      resetAutoTraderState();
      res.json({ message: `Portfolio reset to $${STARTING_BALANCE}. All trades cleared.`, cash: STARTING_BALANCE });
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

      // One live bot per ticker. Paused bots count: they resume later, and
      // two bots on one ticker would both step its simulated price each tick.
      const duplicate = getAllGridBots().find(
        b => b.ticker.toUpperCase() === ticker.toUpperCase() && b.status !== "stopped" && b.status !== "stopped_range_exit"
      );
      if (duplicate) {
        return res.status(400).json({ message: `A grid bot for ${ticker.toUpperCase()} already exists (${duplicate.status}). Stop it before creating a new one.` });
      }

      // Check portfolio cash
      const portfolio = storage.getPortfolio();
      if (totalInvestment > portfolio.cash) {
        return res.status(400).json({ message: `Insufficient cash. Available: $${portfolio.cash.toFixed(2)}` });
      }

      // Reserve the investment from portfolio cash with a holding trade that
      // is linked to the bot (valued from grid P&L, settled when it stops).
      // Both writes go in one transaction so a failed create can't strand cash.
      const gridPrice = getGridPrice(ticker.toUpperCase()) || stock.price;
      const bot = sqlite.transaction(() => {
        const reserve = storage.createTrade({
          ticker: ticker.toUpperCase(),
          action: "buy",
          shares: totalInvestment / gridPrice,
          price: gridPrice,
          total: totalInvestment,
          stopLoss: null,
          takeProfit: null,
          openedAt: new Date().toISOString(),
        });
        return createGridBot({
          ticker, lowerPrice, upperPrice, gridCount, totalInvestment, stopBufferPct,
          spacingMode, atrWindow, atrMultiplier, stepMinPct, stepMaxPct,
          autoRegridDriftPct,
          reserveTradeId: reserve.id,
        });
      })();
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
      const { status } = (req.body ?? {}) as { status?: unknown };
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
      if (status !== "active" && status !== "paused") {
        return res.status(400).json({ message: "status must be 'active' or 'paused'" });
      }
      const current = getGridBot(id);
      if (!current) return res.status(404).json({ message: "Bot not found" });
      // Only active ↔ paused. Stopped bots have already returned their capital,
      // and paused_by_breaker bots resume only when the breaker clears.
      if (current.status !== "active" && current.status !== "paused") {
        return res.status(409).json({ message: `Bot is ${current.status} and can't be toggled.` });
      }
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

  // Price history for the indicators is sampled once per engine tick inside the
  // auto-trader (evenly spaced); quotes are no longer pushed into it on arrival.

  // Auto-start the Alpaca price feed on server init so prices are live immediately
  startAlpacaFeed();

  // Task #50: Resume tick loops for grid bots that were active at shutdown
  // AND start the global circuit-breaker watcher that auto-resumes bots
  // parked by the auto-trader's hard-drawdown breaker once it recovers.
  const { bootGridEngine } = await import("./grid-engine");
  bootGridEngine();

  return httpServer;
}
