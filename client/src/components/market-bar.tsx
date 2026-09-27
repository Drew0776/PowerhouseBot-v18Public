import { useQuery } from "@tanstack/react-query";
import type { MarketStatus } from "@shared/schema";
import { Clock } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatPrice } from "@shared/price";

/**
 * MarketBar — top-of-page status strip: whether the US regular session is
 * open, a countdown to the next open or close, and reference prices (SPY,
 * QQQ, BTC). Each price is tagged LIVE (Alpaca quote) or SIM (the simulator's
 * price that the bot is trading). The session times come from the server's
 * exchange calendar, so they're right in any browser time zone and account
 * for weekends, holidays and early closes.
 */

function Countdown({ target }: { target: string }) {
  // Written straight to the DOM once a second so the bar itself doesn't re-render.
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const at = Date.parse(target);
    const tick = () => {
      if (!ref.current) return;
      const diff = Math.max(0, at - Date.now());
      const d = Math.floor(diff / 86_400_000);
      const h = Math.floor((diff % 86_400_000) / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      ref.current.textContent = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  return <span ref={ref} className="text-xs font-mono tabular-nums text-[#00bcd4]" />;
}

export default function MarketBar() {
  const { data: m } = useQuery<MarketStatus>({ queryKey: ["/api/market-status"] });
  if (!m) return null;

  return (
    <div
      className="flex items-center gap-4 md:gap-6 px-4 py-2 border-b border-border overflow-x-auto"
      style={{ backgroundColor: "hsl(220 18% 6%)" }}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`w-2 h-2 rounded-full ${m.sessionOpen ? "bg-[#00e676]" : "bg-zinc-600"}`} />
        <span className="text-xs font-semibold" style={{ color: m.sessionOpen ? "#00e676" : "#9e9e9e" }}>
          {m.sessionOpen ? "US market open" : "US market closed"}
        </span>
      </div>

      {m.quotes.map(q => (
        <div key={q.symbol} className="flex items-center gap-1.5 shrink-0">
          <div className="w-px h-5 bg-border mr-2.5" />
          <span className="text-[10px] text-muted-foreground uppercase">{q.symbol}</span>
          <span className="text-xs font-mono tabular-nums text-foreground">${q.price >= 1000 ? q.price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : formatPrice(q.price, 2)}</span>
          <span
            className={`text-[9px] font-mono px-1 rounded ${q.live ? "bg-[#00e676]/10 text-[#00e676]" : "bg-zinc-800 text-zinc-400"}`}
            title={q.live ? "Live Alpaca quote" : "Simulated price (no live quote)"}
          >
            {q.live ? "LIVE" : "SIM"}
          </span>
        </div>
      ))}

      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">{m.sessionOpen ? "Closes in" : "Opens in"}</span>
        <Countdown target={m.nextSessionChange} />
      </div>
    </div>
  );
}
