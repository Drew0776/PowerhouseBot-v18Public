import { useQueryClient, useQuery } from "@tanstack/react-query";
import type { MarketStatus } from "@shared/schema";
import { TrendingUp, TrendingDown, Minus, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * MarketBar — top-of-page status strip.
 *
 * Goal: do NOT re-render React on every market-status tick. The component
 * mounts once, paints a static shell, and then ALL live values
 * (sentiment, SP500 price/change, VIX, BTC, fear-greed gauge, clock) are
 * written directly to their DOM nodes via refs.
 *
 * We achieve this by passing `notifyOnChangeProps: []` to useQuery — that
 * disables React re-renders on query data changes — and instead subscribing
 * to the query cache imperatively in an effect.
 */

const SENTIMENT_COLOR: Record<string, string> = {
  Bullish: "#00e676",
  Bearish: "#ff1744",
  Neutral: "#ffd740",
};

function applyMarket(
  m: MarketStatus,
  refs: {
    sentimentIcon: HTMLSpanElement | null;
    sentimentLabel: HTMLSpanElement | null;
    sp500Price: HTMLSpanElement | null;
    sp500Change: HTMLSpanElement | null;
    vix: HTMLSpanElement | null;
    fgBar: HTMLDivElement | null;
    fgLabel: HTMLSpanElement | null;
    btc: HTMLSpanElement | null;
  },
) {
  // Sentiment icon + label
  const sColor = SENTIMENT_COLOR[m.sentiment] ?? "#ffd740";
  if (refs.sentimentLabel) {
    refs.sentimentLabel.textContent = m.sentiment;
    refs.sentimentLabel.style.color = sColor;
  }
  if (refs.sentimentIcon) {
    refs.sentimentIcon.dataset.kind = m.sentiment;
    refs.sentimentIcon.style.color = sColor;
  }

  // SP500
  if (refs.sp500Price) refs.sp500Price.textContent = m.sp500.price.toLocaleString();
  if (refs.sp500Change) {
    const pct = m.sp500.changePercent;
    refs.sp500Change.textContent = `${pct >= 0 ? "+" : ""}${pct}%`;
    refs.sp500Change.style.color = pct >= 0 ? "#00e676" : "#ff1744";
  }

  // VIX
  if (refs.vix) {
    refs.vix.textContent = String(m.vix);
    refs.vix.style.color = m.vix > 25 ? "#ff1744" : m.vix > 18 ? "#ffd740" : "#00e676";
  }

  // Fear & Greed gauge
  const fgColor = m.fearGreed > 55 ? "#00e676" : m.fearGreed > 45 ? "#ffd740" : "#ff1744";
  const fgLabel =
    m.fearGreed > 70 ? "Extreme Greed" :
    m.fearGreed > 55 ? "Greed" :
    m.fearGreed > 45 ? "Neutral" :
    m.fearGreed > 30 ? "Fear" : "Extreme Fear";
  if (refs.fgBar) {
    refs.fgBar.style.width = `${m.fearGreed}%`;
    refs.fgBar.style.backgroundColor = fgColor;
  }
  if (refs.fgLabel) {
    refs.fgLabel.textContent = fgLabel;
    refs.fgLabel.style.color = fgColor;
  }

  // BTC
  if (refs.btc) refs.btc.textContent = `$${m.bitcoin.toLocaleString()}`;
}

export default function MarketBar() {
  const queryClient = useQueryClient();

  // Register the query so it polls, but disable ALL change-driven re-renders
  // by passing `notifyOnChangeProps: []`. The component will never re-render
  // when market-status data updates — we update the DOM imperatively.
  useQuery<MarketStatus>({
    queryKey: ["/api/market-status"],
    notifyOnChangeProps: [],
  });

  // We need exactly ONE render after the first snapshot arrives so the
  // static shell appears. The cache subscriber below flips `ready` to true
  // when (or if) data is already present at mount.
  const [ready, setReady] = useState(
    () => !!queryClient.getQueryData<MarketStatus>(["/api/market-status"]),
  );

  // Refs to every live text node in the bar.
  const sentimentIconRef = useRef<HTMLSpanElement>(null);
  const sentimentLabelRef = useRef<HTMLSpanElement>(null);
  const sp500PriceRef = useRef<HTMLSpanElement>(null);
  const sp500ChangeRef = useRef<HTMLSpanElement>(null);
  const vixRef = useRef<HTMLSpanElement>(null);
  const fgBarRef = useRef<HTMLDivElement>(null);
  const fgLabelRef = useRef<HTMLSpanElement>(null);
  const btcRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef<HTMLSpanElement>(null);
  const bullIconRef = useRef<SVGSVGElement>(null);
  const bearIconRef = useRef<SVGSVGElement>(null);
  const flatIconRef = useRef<SVGSVGElement>(null);

  // Subscribe to query cache imperatively — no React renders triggered.
  useEffect(() => {
    const refs = {
      sentimentIcon: sentimentIconRef.current,
      sentimentLabel: sentimentLabelRef.current,
      sp500Price: sp500PriceRef.current,
      sp500Change: sp500ChangeRef.current,
      vix: vixRef.current,
      fgBar: fgBarRef.current,
      fgLabel: fgLabelRef.current,
      btc: btcRef.current,
    };

    // Swap the visible sentiment icon by toggling display on the three
    // pre-mounted glyphs — avoids unmounting/remounting svgs every tick.
    const swapIcon = (kind: string) => {
      const map: Record<string, SVGSVGElement | null> = {
        Bullish: bullIconRef.current,
        Bearish: bearIconRef.current,
        Neutral: flatIconRef.current,
      };
      for (const [k, el] of Object.entries(map)) {
        if (el) el.style.display = k === kind ? "" : "none";
      }
    };

    const apply = (m: MarketStatus) => {
      applyMarket(m, refs);
      swapIcon(m.sentiment);
    };

    // Paint from whatever snapshot is already in cache.
    const current = queryClient.getQueryData<MarketStatus>(["/api/market-status"]);
    if (current) apply(current);

    // Subscribe to every subsequent cache update — without forcing a render.
    const unsub = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      if (!Array.isArray(key) || key[0] !== "/api/market-status") return;
      const next = event.query.state.data as MarketStatus | undefined;
      if (!next) return;
      // Flip ready once so the shell mounts (then we never re-render again).
      setReady((r) => (r ? r : true));
      apply(next);
    });

    return unsub;
  }, [queryClient, ready]);

  // Imperative once-per-second clock — also bypasses React renders.
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const close = new Date(now);
      close.setHours(16, 0, 0, 0);
      const diff = close.getTime() - now.getTime();
      const node = closeRef.current;
      if (!node) return;
      if (diff <= 0) {
        node.textContent = "CLOSED";
      } else {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        node.textContent = `${h}h ${m}m ${s}s`;
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!ready) return null;

  // Static shell — rendered ONCE, then never reconciled by data changes.
  // All live numbers/colors are populated by the cache subscriber above.
  return (
    <div
      className="flex items-center gap-4 md:gap-6 px-4 py-2 border-b border-border overflow-x-auto"
      style={{ backgroundColor: "hsl(220 18% 6%)" }}
    >
      {/* Sentiment — three pre-mounted icons, swapped via display toggle */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span ref={sentimentIconRef} className="inline-flex">
          <TrendingUp ref={bullIconRef} className="w-3.5 h-3.5" style={{ display: "none" }} />
          <TrendingDown ref={bearIconRef} className="w-3.5 h-3.5" style={{ display: "none" }} />
          <Minus ref={flatIconRef} className="w-3.5 h-3.5" style={{ display: "none" }} />
        </span>
        <span ref={sentimentLabelRef} className="text-xs font-semibold" />
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* S&P 500 */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">S&P 500</span>
        <span ref={sp500PriceRef} className="text-xs font-mono tabular-nums text-foreground" />
        <span ref={sp500ChangeRef} className="text-[10px] font-mono tabular-nums" />
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* VIX + fear/greed gauge */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">VIX</span>
        <span ref={vixRef} className="text-xs font-mono tabular-nums" />
        <div className="flex items-center gap-1.5">
          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
            <div ref={fgBarRef} className="h-full rounded-full transition-all" style={{ width: "0%" }} />
          </div>
          <span ref={fgLabelRef} className="text-[10px] font-mono" />
        </div>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* Bitcoin */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">BTC</span>
        <span ref={btcRef} className="text-xs font-mono tabular-nums text-foreground" />
      </div>

      {/* Time to close — ticks once a second via direct DOM write */}
      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">Close in</span>
        <span ref={closeRef} className="text-xs font-mono tabular-nums text-[#00bcd4]" />
      </div>
    </div>
  );
}
