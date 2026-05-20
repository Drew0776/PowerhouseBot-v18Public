import { useQuery } from "@tanstack/react-query";
import type { PortfolioSummary } from "@shared/schema";
import KpiCards from "@/components/kpi-cards";
import EquityChart from "@/components/equity-chart";
import SectorDonut from "@/components/sector-donut";
import SignalBanner from "@/components/signal-banner";
import MarketBar from "@/components/market-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";

function pnlColor(n: number) {
  if (n > 0) return "#00e676";
  if (n < 0) return "#ff1744";
  return "#9e9e9e";
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-3 md:p-4">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">{label}</p>
      <p className="text-lg md:text-xl font-mono font-bold" style={{ color: color || "#fff" }}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const { data: portfolio, isLoading: loadingPortfolio } = useQuery<PortfolioSummary>({
    queryKey: ["/api/portfolio"],
  });

  const { data: equityCurve, isLoading: loadingCurve } = useQuery<
    { id: number; timestamp: string; value: number }[]
  >({
    queryKey: ["/api/equity-curve"],
  });

  const { data: autoState } = useQuery<any>({
    queryKey: ["/api/auto-trader"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/auto-trader"); return r.json(); },
    refetchInterval: 3000,
  });

  const { data: signals = [] } = useQuery<any[]>({
    queryKey: ["/api/auto-trader/scan"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/auto-trader/scan"); return r.json(); },
    refetchInterval: 5000,
  });

  const stats = autoState?.stats ?? {};
  const totalPnl = autoState?.totalPnl ?? 0;
  const winRate = autoState?.winRate ?? 0;
  const totalTrades = autoState?.totalTrades ?? 0;
  const profitFactor = stats.profitFactor ?? 0;
  const expectancy = stats.expectancy ?? 0;
  const openPositions = autoState?.openPositions ?? [];
  const isRunning = autoState?.isRunning ?? false;
  const regime = autoState?.regime ?? "unknown";
  const bestTrade = autoState?.bestTrade;
  const portfolioValue = portfolio?.totalValue ?? 100;
  const totalReturn = ((portfolioValue - 100) / 100) * 100;

  return (
    <div className="flex flex-col">
      {/* Market Status Bar */}
      <MarketBar />

      <div className="p-4 md:p-6 space-y-4">
        {/* KPI Cards */}
        {loadingPortfolio ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        ) : portfolio ? (
          <KpiCards portfolio={portfolio} />
        ) : null}

        {/* Middle: Equity + Sector Donut */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3">
            {loadingCurve ? (
              <Skeleton className="h-72 rounded-lg" />
            ) : (
              <EquityChart data={equityCurve || []} />
            )}
          </div>
          <div className="lg:col-span-2">
            <SectorDonut />
          </div>
        </div>

        {/* Signal Banner */}
        <SignalBanner />

        {/* ── Live Bot Performance Panel ── */}
        {autoState && (
          <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-[#00e676] animate-pulse" : "bg-zinc-600"}`} />
                <span className="text-sm font-semibold text-white tracking-wide">BOT PERFORMANCE</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{regime.toUpperCase()}</span>
              </div>
              <span className="text-[11px] text-zinc-500 font-mono">{totalTrades} trades · {openPositions.length} open</span>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
              <StatCard
                label="Total Return"
                value={`${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`}
                sub={`$${(portfolioValue - 100).toFixed(2)} profit`}
                color={pnlColor(totalReturn)}
              />
              <StatCard
                label="Win Rate"
                value={`${winRate}%`}
                sub={totalTrades > 0 ? `${totalTrades} total trades` : "no trades yet"}
                color={winRate >= 55 ? "#00e676" : winRate >= 45 ? "#ffd54f" : "#ff1744"}
              />
              <StatCard
                label="Profit Factor"
                value={profitFactor > 0 ? profitFactor.toFixed(2) : "—"}
                sub={profitFactor >= 1.5 ? "excellent" : profitFactor >= 1.0 ? "good" : "needs improvement"}
                color={profitFactor >= 1.5 ? "#00e676" : profitFactor >= 1.0 ? "#ffd54f" : "#ff1744"}
              />
              <StatCard
                label="Expectancy"
                value={expectancy !== 0 ? `$${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}` : "—"}
                sub="avg profit per trade"
                color={pnlColor(expectancy)}
              />
            </div>

            {/* Open positions mini-list */}
            {openPositions.length > 0 && (
              <div className="bg-[#141720] border border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse" />
                  <span className="text-[11px] font-semibold text-zinc-300 tracking-wider uppercase">Live Positions</span>
                </div>
                <div className="divide-y divide-zinc-800/60">
                  {openPositions.map((pos: any) => {
                    const pct = pos.pnlPct ?? 0;
                    const pnl = pos.pnl ?? 0;
                    const progress = Math.min(100, Math.max(0, ((pos.currentPrice - pos.entryPrice) / ((pos.takeProfit2 ?? pos.entryPrice * 1.2) - pos.entryPrice)) * 100));
                    return (
                      <div key={pos.tradeId} className="flex items-center justify-between px-4 py-2.5 gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono font-bold text-sm text-white">{pos.ticker}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#00bcd4]/15 text-[#00bcd4] border border-[#00bcd4]/20 font-mono uppercase">{pos.strategy}</span>
                          <span className="text-[9px] text-zinc-500 font-mono">{pos.grade}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="hidden md:flex items-center gap-1">
                            <div className="w-16 h-1 bg-zinc-800 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: pnl >= 0 ? "#00e676" : "#ff1744" }} />
                            </div>
                          </div>
                          <span className="font-mono text-xs" style={{ color: pnlColor(pct) }}>
                            {pct >= 0 ? "+" : ""}{(pct ?? 0).toFixed(2)}%
                          </span>
                          <span className="font-mono text-xs font-semibold" style={{ color: pnlColor(pnl) }}>
                            {pnl >= 0 ? "+" : ""}${(pnl ?? 0).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Top signals ticker */}
            {signals.length > 0 && (
              <div className="bg-[#141720] border border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-800">
                  <span className="text-[11px] font-semibold text-zinc-300 tracking-wider uppercase">🔍 Top Signals Right Now</span>
                  <span className="text-[10px] text-zinc-500 ml-2 font-mono">{signals.length} firing across 125 markets</span>
                </div>
                <div className="flex overflow-x-auto gap-3 p-3 scrollbar-thin">
                  {signals.slice(0, 10).map((s: any) => {
                    const marketIcons: Record<string, string> = { crypto: "🔥", forex: "💱", commodity: "🏅", index: "📊", stock: "📈" };
                    const icon = marketIcons[s.marketType ?? "stock"] ?? "📈";
                    const gradeColor = s.grade === "A+" ? "#00e676" : s.grade === "A" ? "#00bcd4" : "#ffd54f";
                    return (
                      <div key={s.ticker} className="shrink-0 bg-[#0d0f12] border border-zinc-700 rounded-lg p-2.5 min-w-[120px]">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-xs text-white">{icon} {s.ticker}</span>
                          <span className="text-[9px] font-bold font-mono" style={{ color: gradeColor }}>{s.grade}</span>
                        </div>
                        <div className="text-[10px] text-zinc-400 font-mono">{(s.score ?? 0)} pts</div>
                        <div className="text-[10px] text-zinc-500 truncate mt-0.5">{(s.reasons ?? [])[0]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
