/**
 * ALPACA REAL DATA FEED — V18
 *
 * Fetches live quotes from Alpaca's paper trading data API.
 * Replaces simulated GBM prices for all US stocks/ETFs.
 * Crypto, forex, and commodities stay on the simulated engine.
 *
 * Credentials are loaded from environment variables:
 *   ALPACA_KEY_ID, ALPACA_SECRET_KEY
 *   Base: https://data.alpaca.markets/v2
 */

import { STOCK_INFO } from "./seed";

const ALPACA_KEY    = process.env.ALPACA_KEY_ID     ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";
const DATA_BASE     = "https://data.alpaca.markets/v2";
const PAPER_BASE    = "https://paper-api.alpaca.markets/v2";

// Track ALL instruments from the seed universe (181 total).
// Alpaca will return live prices for US stocks/ETFs (~127); crypto/forex/commodity
// symbols return null from getAlpacaPrice() and automatically fall back to simulation.
// Keeping the full set here means the "tracked" count always matches the universe size.
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
}

const priceCache = new Map<string, PriceEntry>();
let lastFullFetch = 0;
let lastSuccessfulFetch = 0;
let alpacaConnected = false;
let alpacaError = "";

// ── Reconnect / backoff state ─────────────────────────────────────────────────
const HEALTHY_POLL_MS  = 15_000;   // normal cadence when connected
const STALE_THRESHOLD  = 30_000;   // prices older than this are considered stale
const BACKOFF_BASE_MS  = 1_000;    // initial retry delay (1s)
const BACKOFF_MAX_MS   = 60_000;   // cap retry delay (60s)
let consecutiveFailures = 0;       // # of refresh attempts that returned no quotes
let nextRetryAt = 0;               // ms timestamp of the next scheduled refresh

function computeBackoffMs(failures: number): number {
  // 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
  const delay = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(BACKOFF_MAX_MS, delay);
}

/** Whether the feed is currently in a reconnecting state (any consecutive failures). */
function isReconnecting(): boolean {
  return consecutiveFailures > 0;
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
  const reconnecting = isReconnecting();
  return {
    connected: alpacaConnected,
    reconnecting,
    stale: isFeedStale(),
    error: alpacaError,
    trackedTickers: ALPACA_STOCK_TICKERS.size,
    cachedTickers: priceCache.size,
    freshTickers: priceCache.size - staleCount,
    staleTickers: staleCount,
    lastFetchMs: lastFullFetch === 0 ? -1 : now - lastFullFetch,
    lastSuccessMs: lastSuccessfulFetch === 0 ? -1 : now - lastSuccessfulFetch,
    consecutiveFailures,
    nextRetryInMs: nextRetryAt === 0 ? -1 : Math.max(0, nextRetryAt - now),
    backoffMs: consecutiveFailures > 0 ? computeBackoffMs(consecutiveFailures) : HEALTHY_POLL_MS,
  };
}

// ── Fetch all quotes in one bulk request ──────────────────────────────────────
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
        priceCache.set(ticker, { price: mid, bid, ask, fetchedAt: now });
        if (_onPriceUpdate) _onPriceUpdate(ticker, mid);
        cached++;
      }
    }
    return cached;
  } catch (err: unknown) {
    alpacaError = err instanceof Error ? err.message : String(err);
    return 0;
  }
}

// Serialize refreshes — manual /api/alpaca/refresh and the scheduled cycle
// must not overlap or they'll race on consecutiveFailures and price cache.
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
      console.log(`📡 Alpaca reconnected after ${consecutiveFailures} failed attempt(s)`);
      consecutiveFailures = 0;
    }
  } else {
    // No quotes at all — count as a failure for backoff purposes
    consecutiveFailures++;
    alpacaConnected = false;
    if (!alpacaError) alpacaError = "no quotes returned";
    console.warn(`📡 Alpaca refresh failed (attempt ${consecutiveFailures}) — ${alpacaError}`);
  }
  return { totalCached };
}

// ── Public price getter — returns real price or null if stale/unavailable ────
// Stale window: 30 seconds (task spec). Older entries fall back to simulation.
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

// ── Adaptive background refresh loop — 15s when healthy, exponential backoff on failure ──
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let feedRunning = false;

function scheduleNextRefresh(): void {
  if (!feedRunning) return;
  const delay = consecutiveFailures > 0
    ? computeBackoffMs(consecutiveFailures)
    : HEALTHY_POLL_MS;
  nextRetryAt = Date.now() + delay;
  refreshTimer = setTimeout(runRefreshCycle, delay);
}

async function runRefreshCycle(): Promise<void> {
  refreshTimer = null;
  try {
    await refreshAllPrices();
  } catch (err: unknown) {
    // refreshAllPrices catches per-chunk errors, but guard the whole call anyway
    alpacaError = err instanceof Error ? err.message : String(err);
    alpacaConnected = false;
    consecutiveFailures++;
  } finally {
    scheduleNextRefresh();
  }
}

export function startAlpacaFeed(): void {
  if (feedRunning) return; // Already running
  feedRunning = true;
  console.log("📡 Alpaca feed starting — fetching real prices...");
  // Kick off immediately, then schedule the next cycle from runRefreshCycle's finally
  void runRefreshCycle();
}

export function stopAlpacaFeed(): void {
  feedRunning = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  nextRetryAt = 0;
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
