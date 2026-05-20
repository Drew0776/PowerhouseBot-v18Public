import { useQuery } from "@tanstack/react-query";
import type { SignalRow } from "@shared/schema";
import { Link } from "wouter";
import { Zap } from "lucide-react";

export default function SignalBanner() {
  const { data: signals } = useQuery<SignalRow[]>({ queryKey: ["/api/signals"] });

  const hotSignals = (signals || [])
    .filter(s => s.signal === "BUY")
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 5);

  if (hotSignals.length === 0) return null;

  return (
    <div className="rounded-lg border border-border overflow-hidden" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border" style={{ backgroundColor: "rgba(0, 230, 118, 0.06)" }}>
        <Zap className="w-3 h-3 text-[#00e676]" />
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[#00e676]">Top Signals</span>
      </div>
      <div className="flex items-center gap-0 overflow-x-auto">
        {hotSignals.map((s, i) => (
          <Link key={s.ticker} href={`/stock/${s.ticker}`}>
            <div className="flex items-center gap-3 px-4 py-2.5 border-r border-border hover:bg-accent/50 transition-colors cursor-pointer shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-semibold text-[#00bcd4]">{s.ticker}</span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[rgba(0,230,118,0.15)] text-[#00e676]">
                  BUY
                </span>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono tabular-nums text-foreground">${s.price.toFixed(2)}</div>
                <div className={`text-[10px] font-mono tabular-nums ${s.dayChangePercent >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>
                  {s.dayChangePercent >= 0 ? "+" : ""}{s.dayChangePercent}%
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">Score</div>
                <div className="text-xs font-mono tabular-nums font-semibold text-[#00e676]">{s.compositeScore}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
