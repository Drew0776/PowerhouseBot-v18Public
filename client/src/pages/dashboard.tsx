import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { PortfolioSummary, GridBot } from "@shared/schema";
import KpiCards from "@/components/kpi-cards";
import EquityChart from "@/components/equity-chart";
import SectorDonut from "@/components/sector-donut";
import SignalBanner from "@/components/signal-banner";
import MarketBar from "@/components/market-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Activity, Wallet, TrendingUp, Grid3x3 } from "lucide-react";

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

interface AlpacaStatus {
  connected: boolean;
  reconnecting: boolean;
  stale: boolean;
  consecutiveFailures: number;
  nextRetryInMs: number;
  freshTickers: number;
  trackedTickers: number;
  // Task #69: surfaced so the dashboard can show the real Alpaca paper
  // account balance alongside the simulator's $500-start figure.
  account?: { status: string; portfolioValue: number; cash: number; buyingPower: number } | null;
}

type ScanDebugGate = "mtf" | "rsi" | "bollinger" | "score" | "cooldown" | "open_position" | null;
interface ScanDebugCandidate {
  ticker: string;
  score: number | null;
  gateFailed: ScanDebugGate;
  mtfBars: number;
  price: number;
}
interface ScanDebugSnapshot {
  passed: number;
  rejected: number;
  topReason: ScanDebugGate;
  totalTicks: number;
  candidates: ScanDebugCandidate[];
}

const GATE_LABELS: Record<Exclude<ScanDebugGate, null>, string> = {
  mtf: "trend (MTF)",
  rsi: "RSI out of range",
  bollinger: "Bollinger too low",
  score: "composite score < 20",
  cooldown: "cooldown",
  open_position: "already open",
};

interface GridBotSummary {
  bot: GridBot;
  currentPrice: number;
  gridLevels: { price: number; action: "buy" | "sell" | "idle" }[];
}

/**
 * HeroCard — one of the four primary at-a-glance signals at the top of the
 * dashboard: API feed status, buying power, open PnL, and the next grid
 * level. Anything else lives behind the tabs below.
 */
function HeroCard({
  label,
  value,
  sub,
  color,
  icon: Icon,
  iconColor,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  icon: React.ElementType;
  iconColor: string;
}) {
  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-3 md:p-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">{label}</span>
        <Icon className="w-3.5 h-3.5" style={{ color: iconColor }} />
      </div>
      <p className="text-lg md:text-xl font-mono font-bold leading-none" style={{ color: color || "#fff" }}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-zinc-500 mt-1.5 font-mono">{sub}</p>}
    </div>
  );
}

function FeedStatusHero({ status }: { status: AlpacaStatus | undefined }) {
  if (!status) {
    return <HeroCard label="API Feed" value="…" sub="checking" icon={Activity} iconColor="#9e9e9e" color="#9e9e9e" />;
  }
  const healthy = status.connected && !status.stale && !status.reconnecting;
  const reconnecting = status.reconnecting || (!status.connected && status.consecutiveFailures > 0);
  const color = healthy ? "#00e676" : reconnecting ? "#ffd740" : "#ff1744";
  const value = healthy ? "LIVE" : reconnecting ? "RETRY" : "STALE";
  const sub = healthy
    ? `${status.freshTickers}/${status.trackedTickers} fresh`
    : reconnecting
      ? `attempt ${status.consecutiveFailures}`
      : "prices >30s old";
  return <HeroCard label="API Feed" value={value} sub={sub} color={color} icon={Activity} iconColor={color} />;
}

function BuyingPowerHero({ portfolio }: { portfolio: PortfolioSummary | undefined }) {
  if (!portfolio) {
    return <HeroCard label="Buying Power" value="—" icon={Wallet} iconColor="#00bcd4" />;
  }
  const total = portfolio.totalValue || 1;
  const used = portfolio.investedValue ?? 0;
  const utilization = (used / total) * 100;
  const color = utilization > 90 ? "#ff1744" : utilization > 70 ? "#ffd740" : "#00e676";
  return (
    <HeroCard
      label="Buying Power"
      value={`$${portfolio.cash.toFixed(2)}`}
      sub={`${utilization.toFixed(0)}% used · $${total.toFixed(2)} equity`}
      color={color}
      icon={Wallet}
      iconColor="#00bcd4"
    />
  );
}

function OpenPnlHero({ portfolio, autoState }: { portfolio: PortfolioSummary | undefined; autoState: any }) {
  // Prefer the live auto-trader's open-position PnL; fall back to portfolio positions.
  const openPositions: any[] = autoState?.openPositions ?? [];
  let openPnl = 0;
  let count = 0;
  if (openPositions.length > 0) {
    for (const p of openPositions) openPnl += p.pnl ?? 0;
    count = openPositions.length;
  } else if (portfolio?.positions) {
    for (const p of portfolio.positions) openPnl += p.unrealizedPnl ?? 0;
    count = portfolio.positions.length;
  }
  return (
    <HeroCard
      label="Open P&L"
      value={`${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}`}
      sub={count === 0 ? "no open positions" : `${count} open position${count === 1 ? "" : "s"}`}
      color={count === 0 ? "#9e9e9e" : pnlColor(openPnl)}
      icon={TrendingUp}
      iconColor={count === 0 ? "#9e9e9e" : pnlColor(openPnl)}
    />
  );
}

function NextGridLevelsHero() {
  const { data: bots = [] } = useQuery<GridBot[]>({
    queryKey: ["/api/grid/bots"],
    refetchInterval: 5000,
  });
  const active = bots.filter((b) => b.status === "active" || b.status === "paused");
  const firstActive = active.find((b) => b.status === "active") ?? active[0];

  const { data: summary } = useQuery<GridBotSummary>({
    queryKey: ["/api/grid/bots", firstActive?.id],
    enabled: !!firstActive,
    refetchInterval: 5000,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/grid/bots/${firstActive!.id}`);
      return r.json();
    },
  });

  if (active.length === 0) {
    return (
      <HeroCard
        label="Next Grid"
        value="—"
        sub="no active grid bots"
        color="#9e9e9e"
        icon={Grid3x3}
        iconColor="#9e9e9e"
      />
    );
  }

  if (!summary) {
    return (
      <HeroCard
        label="Next Grid"
        value={`${active.length} active`}
        sub="loading levels…"
        icon={Grid3x3}
        iconColor="#00bcd4"
      />
    );
  }

  const cp = summary.currentPrice;
  const levels = summary.gridLevels ?? [];
  const nextBuy = levels
    .filter((l) => l.price < cp)
    .sort((a, b) => b.price - a.price)[0];
  const nextSell = levels
    .filter((l) => l.price > cp)
    .sort((a, b) => a.price - b.price)[0];

  const value = `${summary.bot.ticker} $${cp.toFixed(2)}`;
  const buyTxt = nextBuy ? `buy $${nextBuy.price.toFixed(2)}` : "—";
  const sellTxt = nextSell ? `sell $${nextSell.price.toFixed(2)}` : "—";
  const sub =
    active.length > 1
      ? `${buyTxt} / ${sellTxt} · +${active.length - 1} more bot${active.length - 1 === 1 ? "" : "s"}`
      : `${buyTxt} / ${sellTxt}`;

  return <HeroCard label="Next Grid" value={value} sub={sub} icon={Grid3x3} iconColor="#00bcd4" />;
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

  const { data: alpacaStatus } = useQuery<AlpacaStatus>({
    queryKey: ["/api/alpaca/status"],
    refetchInterval: 5000,
  });

  // Task #69: pull the scanner's per-ticker rejection reasons so the
  // operator can see WHY the scanner returned [] (warm-up? flat markets?
  // breaker? cooldown?). Polled at the same cadence as /scan so the
  // "X passed / Y rejected" line stays in sync with the firing-signals card.
  const { data: scanDebug } = useQuery<ScanDebugSnapshot>({
    queryKey: ["/api/auto-trader/scan-debug"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/auto-trader/scan-debug"); return r.json(); },
    refetchInterval: 5000,
  });
  const [showRejected, setShowRejected] = useState(false);

  // Task #68: manual daily-loss breaker reset. The mutation is gated on the
  // server (409 when !circuitBreakerActive), so the button is also hidden
  // client-side when circuitBreakerActive is false to avoid the round-trip.
  const breakerActive: boolean = autoState?.circuitBreakerActive ?? false;
  const resetBreaker = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/auto-trader/breaker/reset");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grid/bots"] });
    },
  });
  const onResetBreakerClick = () => {
    if (!breakerActive) return;
    if (!window.confirm("This will clear today's daily-loss breaker and re-anchor today's starting value to the current portfolio. Continue?")) return;
    resetBreaker.mutate();
  };

  const stats = autoState?.stats ?? {};
  const totalPnl = autoState?.totalPnl ?? 0;
  const winRate = autoState?.winRate ?? 0;
  const totalTrades = autoState?.totalTrades ?? 0;
  const profitFactor = stats.profitFactor ?? 0;
  const expectancy = stats.expectancy ?? 0;
  const openPositions = autoState?.openPositions ?? [];
  const isRunning = autoState?.isRunning ?? false;
  const regime = autoState?.regime ?? "unknown";
  const portfolioValue = portfolio?.totalValue ?? 100;
  const totalReturn = ((portfolioValue - 100) / 100) * 100;

  return (
    <div className="flex flex-col">
      <MarketBar />

      <div className="p-4 md:p-6 space-y-4">
        {/* ── Task #69: Dual-balance — make it impossible to confuse the bot's
             $500 simulation with the real Alpaca paper account. The bot trades
             a sandboxed portfolio against real Alpaca prices; it does NOT
             place orders in your Alpaca account. ── */}
        <div
          className="bg-[#141720] border border-zinc-800 rounded-xl p-3 md:p-4"
          data-testid="dual-balance"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">Simulator (paper)</p>
              <p className="text-lg md:text-xl font-mono font-bold text-white" data-testid="balance-sim">
                {portfolio ? `$${portfolio.totalValue.toFixed(2)}` : "—"}
              </p>
              <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">what the bot manages today</p>
            </div>
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">Alpaca paper account</p>
              <p className="text-lg md:text-xl font-mono font-bold text-white" data-testid="balance-alpaca">
                {alpacaStatus?.account
                  ? `$${alpacaStatus.account.portfolioValue.toFixed(2)}`
                  : alpacaStatus?.connected === false
                    ? "offline"
                    : "—"}
              </p>
              <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">read-only, untouched by the bot</p>
            </div>
          </div>
          <p className="text-[10px] text-zinc-500 mt-2 font-mono leading-relaxed">
            The bot trades a $500 simulation against real Alpaca prices. It does not place orders in your Alpaca account.
          </p>
        </div>

        {/* ── At-a-glance hero row: the only four numbers a working trader needs ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="dashboard-hero">
          <FeedStatusHero status={alpacaStatus} />
          <BuyingPowerHero portfolio={portfolio} />
          <OpenPnlHero portfolio={portfolio} autoState={autoState} />
          <NextGridLevelsHero />
        </div>

        {/* Signal banner — important enough to stay above the fold */}
        <SignalBanner />

        {/* ── Tabbed secondary content ── */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="bg-[#141720] border border-zinc-800">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
            <TabsTrigger value="signals" data-testid="tab-signals">Signals</TabsTrigger>
          </TabsList>

          {/* Overview: live bot performance + open positions */}
          <TabsContent value="overview" className="space-y-3 mt-3">
            {autoState ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-[#00e676] animate-pulse" : "bg-zinc-600"}`} />
                    <span className="text-sm font-semibold text-white tracking-wide">BOT PERFORMANCE</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{regime.toUpperCase()}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {breakerActive && (
                      <button
                        type="button"
                        onClick={onResetBreakerClick}
                        disabled={resetBreaker.isPending}
                        data-testid="button-reset-breaker"
                        title="Clear the daily-loss circuit breaker and re-anchor today's start"
                        className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border border-[#ff1744]/40 bg-[#ff1744]/10 text-[#ff8a80] hover:bg-[#ff1744]/20 disabled:opacity-50"
                      >
                        {resetBreaker.isPending ? "resetting…" : "🔁 Reset Breaker"}
                      </button>
                    )}
                    <span className="text-[11px] text-zinc-500 font-mono">{totalTrades} trades · {openPositions.length} open</span>
                  </div>
                </div>

                {breakerActive && (
                  <div className="rounded-lg border border-[#ff1744]/40 bg-[#ff1744]/10 px-3 py-2 text-[11px] text-[#ff8a80] font-mono">
                    Daily-loss circuit breaker is ACTIVE — no new entries until reset or recovery.
                    {resetBreaker.error ? ` · Reset failed: ${(resetBreaker.error as Error).message}` : ""}
                  </div>
                )}
                {!breakerActive && resetBreaker.isSuccess && (
                  <div className="rounded-lg border border-[#00e676]/30 bg-[#00e676]/10 px-3 py-2 text-[11px] text-[#00e676] font-mono">
                    Breaker cleared. Auto-trader will enter on the next qualifying signal.
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                  <StatCard
                    label="Total Return"
                    value={totalTrades === 0 ? "—" : `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`}
                    sub={totalTrades === 0 ? "no trades yet" : `$${(portfolioValue - 100).toFixed(2)} profit`}
                    color={totalTrades === 0 ? "#9e9e9e" : pnlColor(totalReturn)}
                  />
                  <StatCard
                    label="Win Rate"
                    value={totalTrades === 0 ? "0%" : `${winRate}%`}
                    sub={totalTrades > 0 ? `${totalTrades} total trades` : "no trades yet"}
                    color={totalTrades === 0 ? "#9e9e9e" : winRate >= 55 ? "#00e676" : winRate >= 45 ? "#ffd54f" : "#ff1744"}
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
              </>
            ) : (
              <Skeleton className="h-24 rounded-lg" />
            )}
          </TabsContent>

          {/* Details: full KPIs, equity curve, sector allocation */}
          <TabsContent value="details" className="space-y-4 mt-3">
            {loadingPortfolio ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : portfolio ? (
              <KpiCards portfolio={portfolio} />
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3">
                {loadingCurve ? (
                  <Skeleton className="h-72 rounded-lg" />
                ) : (
                  <EquityChart data={equityCurve || []} hasTrades={totalTrades > 0} />
                )}
              </div>
              <div className="lg:col-span-2">
                <SectorDonut />
              </div>
            </div>
          </TabsContent>

          {/* Signals: top firing signals across the universe */}
          <TabsContent value="signals" className="space-y-3 mt-3">
            {/* Task #69: pulse line + collapsible Rejected candidates panel.
                Always show the X passed / Y rejected summary so a glance
                answers "is the bot warm-yet?" without expanding anything. */}
            {scanDebug && (
              <div
                className="bg-[#141720] border border-zinc-800 rounded-xl"
                data-testid="scan-debug"
              >
                <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
                  <div className="text-[11px] font-mono text-zinc-300">
                    <span className="text-[#00e676]" data-testid="scan-passed">{scanDebug.passed} passed</span>
                    <span className="text-zinc-600 mx-1">/</span>
                    <span className="text-[#ff8a80]" data-testid="scan-rejected">{scanDebug.rejected} rejected</span>
                    {scanDebug.topReason && (
                      <span className="ml-2 text-zinc-500">
                        · top reason: <span className="text-zinc-300">{GATE_LABELS[scanDebug.topReason]}</span>
                      </span>
                    )}
                    <span className="ml-2 text-zinc-600">· {scanDebug.totalTicks} ticks</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRejected((v) => !v)}
                    data-testid="button-toggle-rejected"
                    className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  >
                    {showRejected ? "Hide rejected" : "Show rejected"}
                  </button>
                </div>
                {showRejected && (
                  <div className="px-4 py-3 space-y-3" data-testid="rejected-candidates">
                    {(["mtf", "rsi", "bollinger", "score", "cooldown", "open_position"] as const).map((reason) => {
                      const items = scanDebug.candidates.filter((c) => c.gateFailed === reason);
                      if (items.length === 0) return null;
                      return (
                        <div key={reason}>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">
                            {GATE_LABELS[reason]} <span className="text-zinc-600">({items.length})</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {items.slice(0, 20).map((c) => (
                              <span
                                key={c.ticker}
                                title={`score=${c.score ?? "—"} · mtfBars=${c.mtfBars} · price=$${c.price.toFixed(2)}`}
                                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0d0f12] border border-zinc-700 text-zinc-300"
                              >
                                {c.ticker}
                                {c.score !== null && <span className="text-zinc-600 ml-1">{c.score}</span>}
                              </span>
                            ))}
                            {items.length > 20 && (
                              <span className="text-[10px] font-mono text-zinc-600 self-center">
                                +{items.length - 20} more
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}


            {signals.length > 0 ? (
              <div className="bg-[#141720] border border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-800">
                  <span className="text-[11px] font-semibold text-zinc-300 tracking-wider uppercase">🔍 Top Signals Right Now</span>
                  <span className="text-[10px] text-zinc-500 ml-2 font-mono">{signals.length} firing across 125 markets</span>
                </div>
                <div className="flex overflow-x-auto gap-3 p-3 scrollbar-thin">
                  {signals.slice(0, 20).map((s: any) => {
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
            ) : (
              <div className="bg-[#141720] border border-zinc-800 rounded-xl p-6 text-center text-xs text-zinc-500">
                No active signals right now.
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
