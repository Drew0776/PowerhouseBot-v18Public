import { useQuery } from "@tanstack/react-query";
import type { MarketStatus } from "@shared/schema";
import { TrendingUp, TrendingDown, Minus, Clock, Activity } from "lucide-react";
import { useEffect, useState } from "react";

function FearGreedGauge({ value }: { value: number }) {
  const label = value > 70 ? "Extreme Greed" : value > 55 ? "Greed" : value > 45 ? "Neutral" : value > 30 ? "Fear" : "Extreme Fear";
  const color = value > 55 ? "#00e676" : value > 45 ? "#ffd740" : "#ff1744";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>{label}</span>
    </div>
  );
}

export default function MarketBar() {
  const { data: market } = useQuery<MarketStatus>({ queryKey: ["/api/market-status"] });
  const [timeToClose, setTimeToClose] = useState("");

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const close = new Date(now);
      close.setHours(16, 0, 0, 0);
      const diff = close.getTime() - now.getTime();
      if (diff <= 0) {
        setTimeToClose("CLOSED");
      } else {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        setTimeToClose(`${h}h ${m}m ${s}s`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!market) return null;

  const sentimentColor = market.sentiment === "Bullish" ? "#00e676" : market.sentiment === "Bearish" ? "#ff1744" : "#ffd740";
  const SentimentIcon = market.sentiment === "Bullish" ? TrendingUp : market.sentiment === "Bearish" ? TrendingDown : Minus;

  return (
    <div className="flex items-center gap-4 md:gap-6 px-4 py-2 border-b border-border overflow-x-auto" style={{ backgroundColor: "hsl(220 18% 6%)" }}>
      {/* Sentiment */}
      <div className="flex items-center gap-1.5 shrink-0">
        <SentimentIcon className="w-3.5 h-3.5" style={{ color: sentimentColor }} />
        <span className="text-xs font-semibold" style={{ color: sentimentColor }}>{market.sentiment}</span>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* S&P 500 */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">S&P 500</span>
        <span className="text-xs font-mono tabular-nums text-foreground">{market.sp500.price.toLocaleString()}</span>
        <span className={`text-[10px] font-mono tabular-nums ${market.sp500.changePercent >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>
          {market.sp500.changePercent >= 0 ? "+" : ""}{market.sp500.changePercent}%
        </span>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* VIX */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">VIX</span>
        <span className={`text-xs font-mono tabular-nums ${market.vix > 25 ? "text-[#ff1744]" : market.vix > 18 ? "text-[#ffd740]" : "text-[#00e676]"}`}>
          {market.vix}
        </span>
        <FearGreedGauge value={market.fearGreed} />
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* Bitcoin */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase">BTC</span>
        <span className="text-xs font-mono tabular-nums text-foreground">${market.bitcoin.toLocaleString()}</span>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* Time to close */}
      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">Close in</span>
        <span className="text-xs font-mono tabular-nums text-[#00bcd4]">{timeToClose}</span>
      </div>
    </div>
  );
}
