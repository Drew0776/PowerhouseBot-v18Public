/**
 * ALPACA REAL DATA FEED — V20 (Task #49: WebSocket + REST fallback)
 *
 * Live quotes flow primarily over a persistent WebSocket connection to
 * Alpaca's IEX market-data stream. REST polling stays as a cold-start /
 * fallback path: it runs fast when the socket is down and slows to a
 * heartbeat cadence when the socket is healthy.
 *
 * Credentials are loaded from environment variables:
 *   ALPACA_KEY_ID, ALPACA_SECRET_KEY
 *   REST base:  https://data.alpaca.markets/v2
 *   WS stream:  wss://stream.data.alpaca.markets/v2/iex
 */

import WebSocket from "ws";
import { STOCK_INFO } from "./seed";

const ALPACA_KEY    = process.env.ALPACA_KEY_ID     ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";
const DATA_BASE     = "https://data.alpaca.markets/v2";
const PAPER_BASE    = "https://paper-api.alpaca.markets/v2";
const WS_URL        = "wss://stream.data.alpaca.markets/v2/iex";

// Track ALL instruments from the seed universe (181 total).
// Alpaca will return live prices for US stocks/ETFs (~127); crypto/forex/commodity
// symbols return null from getAlpacaPrice() and automatically fall back to simulation.
export const ALPACA_STOCK_TICKERS: Set<string> = new Set(Object.keys(STOCK_INFO));

// ── Price-update callback (registered externally to avoid circular imports) ───
let _onPriceUpdate: ((ticker: string, price: number) => void) | null = null;
export function setAlpacaPriceCallback(cb: (ticker: string, price: number) => void): void {
  _onPriceUpdate = cb;
}

// ── In-memory price cache ─────────────────────────────────────────────────────
interface PriceEntry {
  price: number;
  bid: number;
  ask: number;
  fetchedAt: number; // ms timestamp
  source: "ws" | "rest";
}

const priceCache = new Map<string, PriceEntry>();
let lastFullFetch = 0;
let lastSuccessfulFetch = 0;
let alpacaConnected = false;
let alpacaError = "";

// ── Reconnect / backoff state (shared shape for REST + WS) ────────────────────
const HEALTHY_POLL_MS    = 15_000;   // REST cadence when no WS
const HEARTBEAT_POLL_MS  = 60_000;   // REST cadence when WS is healthy (just a sanity check)
const STALE_THRESHOLD    = 30_000;   // prices older than this are considered stale
const BACKOFF_BASE_MS    = 1_000;    // initial retry delay (1s)
const BACKOFF_MAX_MS     = 60_000;   // cap retry delay (60s)
let consecutiveFailures = 0;         // # of refresh attempts that returned no quotes
let nextRetryAt = 0;                 // ms timestamp of the next scheduled refresh

function computeBackoffMs(failures: number): number {
  // 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
  const delay = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(BACKOFF_MAX_MS, delay);
}

// ── WebSocket state ───────────────────────────────────────────────────────────
type WsState = "disconnected" | "connecting" | "authenticating" | "subscribed";
let ws: WebSocket | null = null;
let wsState: WsState = "disconnected";
let wsConnectedAt = 0;
let wsLastMessageAt = 0;
let wsConsecutiveFailures = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsRunning = false;
let wsError = "";

/** Symbols currently subscribed on the WS feed. */
const wsSubscribed = new Set<string>();

/** WS is "fresh" if we got a message in the last STALE_THRESHOLD ms. */
function isWsHealthy(): boolean {
  if (wsState !== "subscribed") return false;
  if (wsLastMessageAt === 0) return false;
  return (Date.now() - wsLastMessageAt) <= STALE_THRESHOLD;
}

/** Public feed status — coarse health surface for the rest of the server. */
function computeFeedStatus(): "healthy" | "degraded" | "down" {
  const wsOk = isWsHealthy();
  const restFresh = lastSuccessfulFetch > 0 && (Date.now() - lastSuccessfulFetch) <= STALE_THRESHOLD;
  if (wsOk) return "healthy";
  if (restFresh) return "degraded"; // WS down, REST keeping us afloat
  return "down";
}

function feedTransport(): "websocket" | "rest" | "none" {
  if (isWsHealthy()) return "websocket";
  if (lastSuccessfulFetch > 0 && (Date.now() - lastSuccessfulFetch) <= STALE_THRESHOLD) return "rest";
  return "none";
}

/** Whether the feed is currently in a reconnecting state. */
function isReconnecting(): boolean {
  return consecutiveFailures > 0 || (wsRunning && wsState !== "subscribed");
}

/** Whether any cached prices are still considered fresh. */
function isFeedStale(): boolean {
  return lastSuccessfulFetch === 0 || (Date.now() - lastSuccessfulFetch) > STALE_THRESHOLD;
}

/** Per-ticker stale check used by getAlpacaPrice/getAlpacaMid. */
export function isPriceStale(ticker: string): boolean {
  const entry = priceCache.get(ticker);
  if (!entry) return true;
  return (Date.now() - entry.fetchedAt) > STALE_THRESHOLD;
}

export function getAlpacaStatus() {
  const now = Date.now();
  let staleCount = 0;
  for (const e of priceCache.values()) {
    if ((now - e.fetchedAt) > STALE_THRESHOLD) staleCount++;
  }
  return {
    connected: alpacaConnected || isWsHealthy(),
    reconnecting: isReconnecting(),
    stale: isFeedStale(),
    error: alpacaError || wsError,
    trackedTickers: ALPACA_STOCK_TICKERS.size,
    cachedTickers: priceCache.size,
    freshTickers: priceCache.size - staleCount,
    staleTickers: staleCount,
    lastFetchMs: lastFullFetch === 0 ? -1 : now - lastFullFetch,
    lastSuccessMs: lastSuccessfulFetch === 0 ? -1 : now - lastSuccessfulFetch,
    consecutiveFailures,
    nextRetryInMs: nextRetryAt === 0 ? -1 : Math.max(0, nextRetryAt - now),
    backoffMs: consecutiveFailures > 0 ? computeBackoffMs(consecutiveFailures) : HEALTHY_POLL_MS,
    feedStatus: computeFeedStatus(),
    feedTransport: feedTransport(),
    ws: {
      state: wsState,
      running: wsRunning,
      connectedMs: wsConnectedAt === 0 ? -1 : now - wsConnectedAt,
      lastMessageMs: wsLastMessageAt === 0 ? -1 : now - wsLastMessageAt,
      subscribed: wsSubscribed.size,
      consecutiveFailures: wsConsecutiveFailures,
      error: wsError,
    },
  };
}

// ── Fetch all quotes in one bulk request (REST fallback path) ─────────────────
const TICKER_CHUNKS: string[][] = [];
(function buildChunks() {
  const all = [...ALPACA_STOCK_TICKERS];
  for (let i = 0; i < all.length; i += 50) {
    TICKER_CHUNKS.push(all.slice(i, i + 50));
  }
})();

/** Fetch a single chunk. Returns the number of quotes successfully cached. */
async function fetchChunk(tickers: string[]): Promise<number> {
  const symbols = tickers.join(",");
  const url = `${DATA_BASE}/stocks/quotes/latest?symbols=${symbols}&feed=iex`;
  try {
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });
    if (!res.ok) {
      alpacaError = `HTTP ${res.status}`;
      return 0;
    }
    const data = await res.json() as { quotes?: Record<string, { bp: number; ap: number }> };
    const quotes = data.quotes ?? {};
    const now = Date.now();
    let cached = 0;
    for (const [ticker, q] of Object.entries(quotes)) {
      const bid = q.bp ?? 0;
      const ask = q.ap ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
      if (mid > 0) {
        // Don't clobber a fresher WS price with a stale REST quote.
        const existing = priceCache.get(ticker);
        if (existing && existing.source === "ws" && (now - existing.fetchedAt) < STALE_THRESHOLD) {
          // keep WS price
        } else {
          priceCache.set(ticker, { price: mid, bid, ask, fetchedAt: now, source: "rest" });
          if (_onPriceUpdate) _onPriceUpdate(ticker, mid);
        }
        cached++;
      }
    }
    return cached;
  } catch (err: unknown) {
    alpacaError = err instanceof Error ? err.message : String(err);
    return 0;
  }
}

// Serialize refreshes so manual /api/alpaca/refresh and the scheduled cycle
// never race on consecutiveFailures and price cache.
let refreshInFlight: Promise<{ totalCached: number }> | null = null;

export function refreshAllPrices(): Promise<{ totalCached: number }> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      return await doRefreshAllPrices();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function doRefreshAllPrices(): Promise<{ totalCached: number }> {
  let totalCached = 0;
  for (const chunk of TICKER_CHUNKS) {
    totalCached += await fetchChunk(chunk);
    await new Promise(r => setTimeout(r, 150)); // 150ms between chunks
  }
  lastFullFetch = Date.now();
  if (totalCached > 0) {
    // At least one chunk returned quotes — consider this a successful refresh
    lastSuccessfulFetch = Date.now();
    alpacaConnected = true;
    alpacaError = "";
    if (consecutiveFailures > 0) {
      console.log(`📡 Alpaca REST reconnected after ${consecutiveFailures} failed attempt(s)`);
      consecutiveFailures = 0;
    }
  } else {
    // No quotes at all — count as a failure for backoff purposes
    consecutiveFailures++;
    alpacaConnected = false;
    if (!alpacaError) alpacaError = "no quotes returned";
    console.warn(`📡 Alpaca REST refresh failed (attempt ${consecutiveFailures}) — ${alpacaError}`);
  }
  return { totalCached };
}

// ── Public price getter — returns real price or null if stale/unavailable ────
// Stale window: 30 seconds. Older entries fall back to simulation.
export function getAlpacaPrice(ticker: string): number | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_THRESHOLD) return null;
  return entry.price;
}

export function getAlpacaMid(ticker: string): { price: number; bid: number; ask: number } | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_THRESHOLD) return null;
  return { price: entry.price, bid: entry.bid, ask: entry.ask };
}

/** Bid/ask snapshot used by the order layer for limit-pricing decisions. */
export function getAlpacaQuote(ticker: string): { bid: number; ask: number; mid: number; freshMs: number } | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  if (age > STALE_THRESHOLD) return null;
  return { bid: entry.bid, ask: entry.ask, mid: entry.price, freshMs: age };
}

// ── Adaptive background REST refresh loop ────────────────────────────────────
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let feedRunning = false;

function scheduleNextRefresh(): void {
  if (!feedRunning) return;
  let delay: number;
  if (consecutiveFailures > 0) {
    delay = computeBackoffMs(consecutiveFailures);
  } else if (isWsHealthy()) {
    // WS is the primary feed — REST just needs to heartbeat the account/quote endpoint
    delay = HEARTBEAT_POLL_MS;
  } else {
    delay = HEALTHY_POLL_MS;
  }
  nextRetryAt = Date.now() + delay;
  refreshTimer = setTimeout(runRefreshCycle, delay);
}

async function runRefreshCycle(): Promise<void> {
  refreshTimer = null;
  try {
    await refreshAllPrices();
  } catch (err: unknown) {
    alpacaError = err instanceof Error ? err.message : String(err);
    alpacaConnected = false;
    consecutiveFailures++;
  } finally {
    scheduleNextRefresh();
  }
}

let _missingKeysWarned = false;
export function startAlpacaFeed(): void {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    if (!_missingKeysWarned) {
      console.warn("⚠️  Alpaca feed disabled — ALPACA_KEY_ID and/or ALPACA_SECRET_KEY are not set. Falling back to simulated prices.");
      alpacaError = "missing ALPACA_KEY_ID / ALPACA_SECRET_KEY";
      alpacaConnected = false;
      _missingKeysWarned = true;
    }
    return;
  }

  // Kick off the WebSocket (primary) and REST poller (fallback) in parallel.
  startWebSocketFeed();

  if (!feedRunning) {
    feedRunning = true;
    console.log("📡 Alpaca REST poller starting (cold-start + fallback)...");
    void runRefreshCycle();
  }
}

export function stopAlpacaFeed(): void {
  feedRunning = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  nextRetryAt = 0;
  stopWebSocketFeed();
}

// ─── WebSocket lifecycle ─────────────────────────────────────────────────────

function startWebSocketFeed(): void {
  if (wsRunning) return;
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  wsRunning = true;
  console.log("📡 Alpaca WebSocket starting...");
  connectWebSocket();
}

function stopWebSocketFeed(): void {
  wsRunning = false;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  wsState = "disconnected";
}

function scheduleWsReconnect(reason: string): void {
  if (!wsRunning) return;
  wsConsecutiveFailures++;
  const delay = computeBackoffMs(wsConsecutiveFailures);
  wsError = reason;
  console.warn(`📡 Alpaca WS reconnect in ${delay}ms (attempt ${wsConsecutiveFailures}) — ${reason}`);
  // While WS is down, make sure the REST poller is in fast mode (its own cadence
  // already speeds up because isWsHealthy() returns false).
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, delay);
}

function connectWebSocket(): void {
  if (!wsRunning) return;
  wsReconnectTimer = null;
  wsState = "connecting";

  let socket: WebSocket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    scheduleWsReconnect(err instanceof Error ? err.message : String(err));
    return;
  }
  ws = socket;

  socket.on("open", () => {
    if (ws !== socket) return; // superseded
    wsState = "authenticating";
    try {
      socket.send(JSON.stringify({ action: "auth", key: ALPACA_KEY, secret: ALPACA_SECRET }));
    } catch (err) {
      scheduleWsReconnect(err instanceof Error ? err.message : String(err));
    }
  });

  socket.on("message", (raw: WebSocket.RawData) => {
    if (ws !== socket) return;
    wsLastMessageAt = Date.now();
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const item of items) {
      handleWsItem(item);
    }
  });

  socket.on("error", (err: Error) => {
    if (ws !== socket) return;
    wsError = err.message;
    // 'error' is typically followed by 'close' — let close handle reconnect.
  });

  socket.on("close", (code: number, reasonBuf: Buffer) => {
    if (ws !== socket) return;
    ws = null;
    wsState = "disconnected";
    wsConnectedAt = 0;
    const reason = `closed (${code}) ${reasonBuf?.toString?.() ?? ""}`.trim();
    scheduleWsReconnect(reason);
  });
}

interface WsControlMsg { T: string; msg?: string; code?: number }
interface WsQuoteMsg { T: "q"; S: string; bp?: number; ap?: number; t?: string }
interface WsTradeMsg { T: "t"; S: string; p?: number; t?: string }

function handleWsItem(item: unknown): void {
  if (!item || typeof item !== "object") return;
  const T = (item as { T?: string }).T;
  if (!T) return;

  // Control messages
  if (T === "success") {
    const ctrl = item as WsControlMsg;
    if (ctrl.msg === "authenticated") {
      wsState = "subscribed";
      wsConnectedAt = Date.now();
      wsConsecutiveFailures = 0;
      wsError = "";
      console.log("📡 Alpaca WS authenticated — subscribing to quotes");
      subscribeAllTickers();
    } else if (ctrl.msg === "connected") {
      // wait for auth response
    }
    return;
  }
  if (T === "subscription") {
    const sub = item as { quotes?: string[]; trades?: string[] };
    const n = (sub.quotes?.length ?? 0) + (sub.trades?.length ?? 0);
    if (n > 0) console.log(`📡 Alpaca WS subscription confirmed — ${sub.quotes?.length ?? 0} quotes, ${sub.trades?.length ?? 0} trades`);
    for (const s of sub.quotes ?? []) wsSubscribed.add(s);
    for (const s of sub.trades ?? []) wsSubscribed.add(s);
    return;
  }
  if (T === "error") {
    const e = item as WsControlMsg;
    wsError = `${e.code ?? "?"} ${e.msg ?? ""}`;
    console.warn(`📡 Alpaca WS error: ${wsError}`);
    // Auth failures / connection-limit errors — close and back off.
    if (e.code === 401 || e.code === 402 || e.code === 406 || e.code === 409) {
      try { ws?.close(); } catch { /* ignore */ }
    }
    return;
  }

  // Quote
  if (T === "q") {
    const q = item as WsQuoteMsg;
    if (!q.S) return;
    const bid = q.bp ?? 0;
    const ask = q.ap ?? 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
    if (mid > 0) {
      const now = Date.now();
      priceCache.set(q.S, { price: mid, bid, ask, fetchedAt: now, source: "ws" });
      lastSuccessfulFetch = now;
      alpacaConnected = true;
      if (_onPriceUpdate) _onPriceUpdate(q.S, mid);
    }
    return;
  }

  // Trade — use as a price update with same bid/ask kept from prior quote
  if (T === "t") {
    const t = item as WsTradeMsg;
    if (!t.S || !t.p || t.p <= 0) return;
    const prev = priceCache.get(t.S);
    const now = Date.now();
    priceCache.set(t.S, {
      price: t.p,
      bid: prev?.bid ?? t.p,
      ask: prev?.ask ?? t.p,
      fetchedAt: now,
      source: "ws",
    });
    lastSuccessfulFetch = now;
    alpacaConnected = true;
    if (_onPriceUpdate) _onPriceUpdate(t.S, t.p);
    return;
  }
}

/**
 * Alpaca's free IEX market-data feed caps simultaneous WS subscriptions at 30
 * symbols. We subscribe to the first WS_SUB_LIMIT tickers from the universe;
 * the remainder stay on the REST poller (which keeps running as a fallback).
 */
const WS_SUB_LIMIT = 30;

function subscribeAllTickers(): void {
  if (!ws) return;
  const tickers = [...ALPACA_STOCK_TICKERS].slice(0, WS_SUB_LIMIT);
  if (tickers.length === 0) return;
  try {
    // Free IEX tier caps the *total* subscriptions across channels at 30.
    // Subscribing to quotes covers our bid/ask needs; the REST poller keeps
    // the last-trade price fresh, so we skip the trades channel here.
    ws.send(JSON.stringify({ action: "subscribe", quotes: tickers }));
  } catch (err) {
    scheduleWsReconnect(err instanceof Error ? err.message : String(err));
  }
}

// ── Account info (for dashboard display) ─────────────────────────────────────
export async function getAlpacaAccount(): Promise<{
  status: string;
  portfolioValue: number;
  cash: number;
  buyingPower: number;
} | null> {
  try {
    const res = await fetch(`${PAPER_BASE}/account`, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });
    if (!res.ok) return null;
    const d = await res.json() as {
      status: string;
      portfolio_value: string;
      cash: string;
      buying_power: string;
    };
    return {
      status: d.status,
      portfolioValue: parseFloat(d.portfolio_value),
      cash: parseFloat(d.cash),
      buyingPower: parseFloat(d.buying_power),
    };
  } catch {
    return null;
  }
}
