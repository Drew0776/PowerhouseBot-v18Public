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

const ALPACA_KEY    = process.env.ALPACA_KEY_ID     ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";
const DATA_BASE     = "https://data.alpaca.markets/v2";
const PAPER_BASE    = "https://paper-api.alpaca.markets/v2";

// All US stock tickers we track — Alpaca covers these
// Crypto (BTC, ETH, SOL…) and forex (AUDUSD…) are NOT in this list — stay simulated
export const ALPACA_STOCK_TICKERS = new Set([
  "NVDA","MSFT","GOOGL","AMZN","META","AAPL","AVGO","AMD","PLTR","CRWD",
  "SNOW","TSM","TSLA","NOW","ARM","SOUN","BBAI","GFAI","DNA","NKLA",
  "MARA","RIOT","WULF","IREN","BTBT","KULR","SNDL","APRE","RAIL","CLOV",
  "SMCI","IWM","RIVN","LCID","SOFI","RKLB","IONQ","RGTI","QUBT","AFRM",
  "UPST","JOBY","LUNR","ACHR","DJT","VRT","NBIS","CLS","OKLO","SERV",
  "MTSI","GME","AMC","KOSS","PLUG","SPCE","QBTS","ARQQ","BITF","HUT",
  "MSTR","COIN","ASTS","MSAI","AIXI","SAVA","NKTR","PRAX","FFIE","SOLO",
  "VFS","MNTS","ASTR","OPEN","HOOD","COUR","MAPS",
  // Sector ETFs
  "QQQ","SPY","XLK","XLF","XLE","XLV","XLI","SOXL","TQQQ","ARKK","GLD","USO","IVV","VTI",
  // Consumer & Media
  "NFLX","UBER","ABNB","DIS","SPOT",
  // Healthcare & Pharma
  "LLY","UNH","PFE","ABBV","MRK","MRNA","JNJ","AMGN","GILD",
  // Energy
  "XOM","CVX","OXY","SLB","COP","EOG",
  // Financials & Payments
  "JPM","BAC","GS","MS","V","MA","PYPL","WFC","C","AXP",
  // Retail & Consumer Staples
  "COST","WMT","TGT","HD",
  // Enterprise SaaS
  "CRM","ADBE",
]);

// ── In-memory price cache ─────────────────────────────────────────────────────
interface PriceEntry {
  price: number;
  bid: number;
  ask: number;
  fetchedAt: number; // ms timestamp
}

const priceCache = new Map<string, PriceEntry>();
let lastFullFetch = 0;
let alpacaConnected = false;
let alpacaError = "";

export function getAlpacaStatus() {
  return {
    connected: alpacaConnected,
    error: alpacaError,
    cachedTickers: priceCache.size,
    lastFetchMs: Date.now() - lastFullFetch,
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

async function fetchChunk(tickers: string[]): Promise<void> {
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
      alpacaConnected = false;
      return;
    }
    const data = await res.json() as { quotes?: Record<string, { bp: number; ap: number }> };
    const quotes = data.quotes ?? {};
    const now = Date.now();
    for (const [ticker, q] of Object.entries(quotes)) {
      const bid = q.bp ?? 0;
      const ask = q.ap ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
      if (mid > 0) {
        priceCache.set(ticker, { price: mid, bid, ask, fetchedAt: now });
      }
    }
    alpacaConnected = true;
    alpacaError = "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    alpacaError = msg;
    alpacaConnected = false;
  }
}

export async function refreshAllPrices(): Promise<void> {
  // Stagger chunk fetches to avoid hitting rate limits
  for (const chunk of TICKER_CHUNKS) {
    await fetchChunk(chunk);
    await new Promise(r => setTimeout(r, 150)); // 150ms between chunks
  }
  lastFullFetch = Date.now();
}

// ── Public price getter — returns real price or null if unavailable ───────────
export function getAlpacaPrice(ticker: string): number | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  // Stale after 60 seconds — fall back to simulated
  if (Date.now() - entry.fetchedAt > 60_000) return null;
  return entry.price;
}

export function getAlpacaMid(ticker: string): { price: number; bid: number; ask: number } | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > 60_000) return null;
  return { price: entry.price, bid: entry.bid, ask: entry.ask };
}

// ── Background refresh loop — runs every 15 seconds while market is open ─────
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startAlpacaFeed(): void {
  if (refreshTimer) return; // Already running
  console.log("📡 Alpaca feed starting — fetching real prices...");
  refreshAllPrices().catch((err: unknown) => {
    alpacaError = err instanceof Error ? err.message : String(err);
    alpacaConnected = false;
    console.error("📡 Alpaca initial fetch failed:", alpacaError);
  });
  refreshTimer = setInterval(() => {
    refreshAllPrices().catch((err: unknown) => {
      alpacaError = err instanceof Error ? err.message : String(err);
      alpacaConnected = false;
    });
  }, 15_000); // Refresh every 15 seconds
}

export function stopAlpacaFeed(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
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
