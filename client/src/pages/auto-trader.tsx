import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Play,
  Square,
  Zap,
  TrendingUp,
  TrendingDown,
  Activity,
  Target,
  ShieldAlert,
  BarChart2,
  Cpu,
  RefreshCw,
  Trophy,
  Wallet,
  Hash,
  CheckCircle2,
  XCircle,
  CircleDot,
  CalendarX,
  Layers,
  FlaskConical,
  DollarSign,
} from "lucide-react";
import {
  AreaChart,
  Area,
  Tooltip,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import type { PortfolioSummary } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BreakoutSignal {
  ticker: string;
  price: number;
  score: number;
  strategy: "momentum" | "squeeze" | "reversal";
  reasons: string[];
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  shares: number;
}

interface ActivePosition {
  tradeId: number;
  ticker: string;
  entryPrice: number;
  currentPrice: number;
  shares: number;
  stopLoss: number;
  trailingStop: number;
  takeProfit: number;
  highWaterMark: number;
  pnl: number;
  pnlPct: number;
  strategy: string;
  enteredAt: string;
  status: string;
}

// V17 BUG FIX #3: Full AutoTraderState type — synced with server interface
interface AutoTraderState {
  isRunning: boolean;
  totalTicks: number;
  totalTrades: number;
  openPositions: ActivePosition[];
  closedTrades: number;
  winRate: number;
  totalPnl: number;
  dailyPnl: number;              // V17: was missing
  circuitBreakerActive: boolean; // V17: was missing
  regime: "trending" | "ranging" | "unknown"; // V17: was missing
  bestTrade: { ticker: string; pnl: number; pct: number } | null;
  lastScan: BreakoutSignal[];
  log: string[];
  eventFilterActive: boolean;
  currentEvent: string | null;
  totalSlippageCost: number;
  roiPct: number;
  pnlPerTick: number;
  tradesPerHundredTicks: number;
  sessionPeak: number;
  t1HitRate: number;
  maxHoldRate: number;
  capitalUtilization: number;
  stats: {
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    expectancy: number;
    sharpeApprox: number;
    totalWinAmount: number;
    totalLossAmount: number;
  };
}

interface AlpacaStatus {
  connected: boolean;
  error: string;
  cachedTickers: number;
  lastFetchMs: number;
  account?: {
    status: string;
    portfolioValue: number;
    cash: number;
    buyingPower: number;
  } | null;
}

interface BacktestResult {
  inSample: {
    ticks: number; trades: number; wins: number; losses: number;
    winRate: number; profitFactor: number; totalReturn: number;
    finalBalance: number; maxDrawdown: number; avgWin: number;
    avgLoss: number; totalSlippage: number;
  };
  outOfSample: {
    ticks: number; trades: number; wins: number; losses: number;
    winRate: number; profitFactor: number; totalReturn: number;
    finalBalance: number; maxDrawdown: number; avgWin: number;
    avgLoss: number; totalSlippage: number;
  };
  verdict: "PASS" | "FAIL" | "MARGINAL";
  verdictMessage: string;
  degradation: number;
  recommendation: string;
}

interface EquityCurvePoint {
  t: number;
  value: number;
}

interface SignalItem {
  ticker: string;
  signal: string;
  compositeScore: number;
  momentumScore: number;
  sentimentScore: number;
  marketType: string;
  category: string;
  price: number;
  reasons?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || isNaN(n as number)) return '0.00';
  return (n as number).toFixed(decimals);
}

function pnlColor(n: number): string {
  if (n > 0) return "text-[#00e676]";
  if (n < 0) return "text-[#ff1744]";
  return "text-zinc-400";
}

function pnlBg(n: number): string {
  if (n > 0) return "bg-[#00e676]/10";
  if (n < 0) return "bg-[#ff1744]/10";
  return "";
}

function strategyBadge(strategy: string) {
  if (strategy === "momentum")
    return (
      <Badge className="bg-[#00bcd4]/20 text-[#00bcd4] border-[#00bcd4]/30 text-[10px] px-1.5 py-0 uppercase tracking-wide">
        MOMENTUM
      </Badge>
    );
  if (strategy === "squeeze")
    return (
      <Badge className="bg-yellow-400/20 text-yellow-400 border-yellow-400/30 text-[10px] px-1.5 py-0 uppercase tracking-wide">
        SQUEEZE
      </Badge>
    );
  return (
    <Badge className="bg-purple-400/20 text-purple-400 border-purple-400/30 text-[10px] px-1.5 py-0 uppercase tracking-wide">
      REVERSAL
    </Badge>
  );
}

function scoreColor(score: number): string {
  if (score >= 70) return "#00e676";
  if (score >= 50) return "#fbbf24";
  return "#6b7280";
}

function logLineColor(line: string): string {
  if (line.includes("ENTER")) return "text-[#00bcd4]";
  if (line.includes("EXIT ✓")) return "text-[#00e676]";
  if (line.includes("EXIT ✗")) return "text-[#ff1744]";
  if (line.includes("STARTED")) return "text-[#00e676]";
  if (line.includes("STOPPED")) return "text-zinc-400";
  if (line.includes("EVENT BLACKOUT") || line.includes("CIRCUIT BREAKER")) return "text-yellow-400";
  return "text-zinc-400";
}

// ─── V16 Status Banner ─────────────────────────────────────────────────────────

function AlpacaBadge() {
  const { data: alpaca } = useQuery<AlpacaStatus>({
    queryKey: ["/api/alpaca/status"],
    refetchInterval: 20_000,
  });
  const connected = alpaca?.connected ?? false;
  const count = alpaca?.cachedTickers ?? 0;
  const acct = alpaca?.account;

  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-zinc-800 bg-zinc-900 text-xs">
      {/* Connection dot */}
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-[#00e676] shadow-[0_0_6px_#00e676]" : "bg-red-500"}`} />
        <span className={connected ? "text-[#00e676] font-bold" : "text-red-400"}>
          {connected ? "ALPACA LIVE" : "ALPACA OFFLINE"}
        </span>
      </div>
      {connected && (
        <>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">{count} stocks live</span>
          {acct && (
            <>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-400">Paper acct: <span className="text-white font-mono">${acct.portfolioValue.toLocaleString()}</span></span>
            </>
          )}
        </>
      )}
      {!connected && alpaca?.error && (
        <span className="text-zinc-500 truncate max-w-[200px]">{alpaca.error}</span>
      )}
    </div>
  );
}

function V6StatusBanner({ autoState }: { autoState: AutoTraderState | undefined }) {
  const eventActive = autoState?.eventFilterActive ?? false;
  const eventName = autoState?.currentEvent ?? null;
  const slippageCost = autoState?.totalSlippageCost ?? 0;

  const features = [
    { label: "OHLCV Prices", active: true, icon: <BarChart2 className="w-3 h-3" /> },
    { label: "MTF Confirm", active: true, icon: <Layers className="w-3 h-3" /> },
    { label: "Spread Sim", active: true, icon: <DollarSign className="w-3 h-3" /> },
    { label: eventActive ? `BLACKOUT: ${eventName ?? "Event"}` : "Event Filter", active: !eventActive, icon: <CalendarX className="w-3 h-3" />, warning: eventActive },
  ];

  return (
    <div className="bg-[#0e1420] border border-[#00bcd4]/20 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-[#00bcd4]" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-[#00bcd4] font-bold">Engine Status</span>
        </div>
        <span className="text-[10px] font-mono text-zinc-500">Slip cost: <span className="text-[#ff5555]">-${fmt(slippageCost)}</span></span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {features.map((f) => (
          <div
            key={f.label}
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-[10px] font-mono font-semibold ${
              f.warning
                ? "bg-yellow-400/10 border-yellow-400/30 text-yellow-400"
                : f.active
                ? "bg-[#00e676]/8 border-[#00e676]/20 text-[#00e676]"
                : "bg-zinc-800 border-zinc-700 text-zinc-500"
            }`}
          >
            <span className={f.warning ? "text-yellow-400" : f.active ? "text-[#00e676]" : "text-zinc-600"}>{f.icon}</span>
            <span className="truncate">{f.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── V18 Performance Velocity Panel ──────────────────────────────────────────────────

function VelocityPanel({ autoState, portfolio }: { autoState: AutoTraderState | undefined; portfolio: PortfolioSummary | undefined }) {
  const roi = autoState?.roiPct ?? 0;
  const pnlPerTick = autoState?.pnlPerTick ?? 0;
  const freq = autoState?.tradesPerHundredTicks ?? 0;
  const peak = autoState?.sessionPeak ?? 0;
  const total = portfolio?.totalValue ?? 0;
  const cash = portfolio?.cash ?? 0;
  const drawdownFromPeak = peak > 0 ? Math.max(0, Math.round(((peak - total) / peak) * 10000) / 100) : 0;

  const t1Rate = autoState?.t1HitRate ?? 0;
  const maxHoldRate = autoState?.maxHoldRate ?? 0;
  const capUtil = autoState?.capitalUtilization ?? 0;

  const metrics = [
    { label: "Session ROI", value: (roi >= 0 ? "+" : "") + roi.toFixed(2) + "%", color: roi >= 0 ? "#00e676" : "#ff5555" },
    { label: "P&L / Tick", value: (pnlPerTick >= 0 ? "+" : "") + "$" + Math.abs(pnlPerTick).toFixed(4), color: pnlPerTick >= 0 ? "#00e676" : "#ff5555" },
    { label: "Capital Used", value: capUtil + "%", color: capUtil >= 70 ? "#00e676" : capUtil >= 40 ? "#fbbf24" : "#ff9800" },
    { label: "T1 Hit Rate", value: t1Rate + "%", color: t1Rate >= 60 ? "#00e676" : t1Rate >= 40 ? "#fbbf24" : "#ff5555" },
    { label: "MAX_HOLD %", value: maxHoldRate + "%", color: maxHoldRate <= 20 ? "#00e676" : maxHoldRate <= 40 ? "#fbbf24" : "#ff5555" },
    { label: "Session Peak", value: "$" + fmt(peak), color: "#fbbf24" },
  ];

  return (
    <div className="bg-[#0e1420] border border-[#00bcd4]/20 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2.5">
        <TrendingUp className="w-3.5 h-3.5 text-[#00bcd4]" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-[#00bcd4] font-bold">Performance</span>
        <span className="text-[9px] text-zinc-600 font-mono ml-auto">{autoState?.totalTicks ?? 0} ticks run</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {metrics.map(m => (
          <div key={m.label} className="bg-[#0d0f12] rounded-lg p-2 flex flex-col gap-0.5">
            <span className="text-[9px] text-zinc-600 font-mono uppercase truncate">{m.label}</span>
            <span className="text-[11px] font-mono font-bold" style={{ color: m.color }}>{m.value}</span>
          </div>
        ))}
      </div>
      {autoState?.bestTrade && (
        <div className="mt-2 px-2.5 py-1.5 bg-[#00e676]/8 border border-[#00e676]/15 rounded-lg flex items-center gap-2">
          <Trophy className="w-3 h-3 text-[#00e676] shrink-0" />
          <span className="text-[10px] font-mono text-[#00e676]">
            Best: <strong>{autoState.bestTrade.ticker}</strong> +${fmt(autoState.bestTrade.pnl)} ({autoState.bestTrade.pct?.toFixed(1)}%)
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Backtest Panel ────────────────────────────────────────────────────────

function BacktestPanel() {
  const { toast } = useToast();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [tickCount, setTickCount] = useState(1000);

  const runBacktest = async (ticks: number) => {
    setTickCount(ticks);
    setRunning(true);
    try {
      const r = await apiRequest("POST", "/api/auto-trader/backtest", { ticks });
      const data = await r.json();
      setResult(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Backtest failed", description: msg, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const oosHasTrades = (result?.outOfSample?.trades ?? 0) >= 3;
  const verdictColor = result?.verdict === "PASS" ? "#00e676"
    : result?.verdict === "MARGINAL" ? "#fbbf24"
    : "#ff5555";
  const verdictBg = result?.verdict === "PASS" ? "bg-[#00e676]/10 border-[#00e676]/30"
    : result?.verdict === "MARGINAL" ? "bg-yellow-400/10 border-yellow-400/30"
    : "bg-[#ff5555]/10 border-[#ff5555]/30";

  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-purple-400" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Walk-Forward Backtest</span>
          <span className="text-[9px] font-mono text-zinc-600 border border-zinc-700 rounded px-1.5 py-0.5">80% IS / 20% OOS</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            data-testid="button-run-backtest"
            onClick={() => runBacktest(1000)}
            disabled={running}
            size="sm"
            className="h-7 text-[10px] font-mono font-bold gap-1 px-2.5 bg-purple-600 hover:bg-purple-500 text-white border-0"
          >
            <FlaskConical className={`w-3 h-3 ${running && tickCount === 1000 ? "animate-spin" : ""}`} />
            {running && tickCount === 1000 ? "..." : "1K"}
          </Button>
          <Button
            data-testid="button-run-backtest-2k"
            onClick={() => runBacktest(2000)}
            disabled={running}
            size="sm"
            className="h-7 text-[10px] font-mono font-bold gap-1 px-2.5 bg-purple-800 hover:bg-purple-700 text-white border-0"
          >
            <FlaskConical className={`w-3 h-3 ${running && tickCount === 2000 ? "animate-spin" : ""}`} />
            {running && tickCount === 2000 ? "..." : "2K"}
          </Button>
          <Button
            data-testid="button-run-backtest-5k"
            onClick={() => runBacktest(5000)}
            disabled={running}
            size="sm"
            className="h-7 text-[10px] font-mono font-bold gap-1 px-2.5 bg-purple-900 hover:bg-purple-800 text-white border-0"
          >
            <FlaskConical className={`w-3 h-3 ${running && tickCount === 5000 ? "animate-spin" : ""}`} />
            {running && tickCount === 5000 ? "..." : "5K"}
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {!result && !running && (
        <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
          <FlaskConical className="w-8 h-8 text-zinc-700" />
          <p className="text-[11px] text-zinc-500 font-mono">Simulates trades on a fresh price sequence</p>
          <p className="text-[10px] text-zinc-600">1K = quick test · 2K = standard · 5K = deep validation</p>
        </div>
      )}

      {/* Loading */}
      {running && (
        <div className="flex flex-col items-center justify-center py-6 gap-2">
          <FlaskConical className="w-8 h-8 text-purple-400 animate-pulse" />
          <p className="text-[11px] text-zinc-400 font-mono animate-pulse">Simulating {tickCount.toLocaleString()} ticks...</p>
          <p className="text-[10px] text-zinc-600">{tickCount >= 2000 ? "This may take 10-20 seconds" : "Usually takes a few seconds"}</p>
        </div>
      )}

      {/* Results */}
      {result && !running && (
        <div className="space-y-3">
          {/* Verdict */}
          <div className={`flex items-start gap-2.5 p-3 rounded-lg border ${verdictBg}`}>
            <div className="shrink-0 mt-0.5">
              {result.verdict === "PASS" ? (
                <CheckCircle2 className="w-4 h-4" style={{ color: verdictColor }} />
              ) : result.verdict === "MARGINAL" ? (
                <ShieldAlert className="w-4 h-4" style={{ color: verdictColor }} />
              ) : (
                <XCircle className="w-4 h-4" style={{ color: verdictColor }} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[11px] font-mono font-bold" style={{ color: verdictColor }}>{result.verdict}</p>
                {!oosHasTrades && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 font-mono">
                    OOS: {result.outOfSample.trades} trades — run 2K+ for full validation
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{result.verdictMessage}</p>
              <p className="text-[10px] text-zinc-500 mt-0.5 italic">{result.recommendation}</p>
            </div>
          </div>

          {/* Side-by-side */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[#0d0f12] border border-zinc-800 rounded-lg p-3">
              <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-600 mb-2">In-Sample ({result.inSample.ticks} ticks)</p>
              <div className="space-y-1.5">
                {([
                  ["Trades", result.inSample.trades],
                  ["Win Rate", `${fmt(result.inSample.winRate)}%`],
                  ["Profit Factor", result.inSample.profitFactor >= 99 ? "99+ ✨" : fmt(result.inSample.profitFactor)],
                  ["Return", `${result.inSample.totalReturn >= 0 ? "+" : ""}${fmt(result.inSample.totalReturn)}%`],
                  ["Max DD", `${fmt(result.inSample.maxDrawdown)}%`],
                  ["Slippage", `-$${fmt(result.inSample.totalSlippage)}`],
                ] as [string, string | number][]).map(([label, val]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-[10px] text-zinc-500 font-mono">{label}</span>
                    <span className="text-[10px] text-white font-mono font-semibold">{val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={`bg-[#0d0f12] border rounded-lg p-3 ${
              !oosHasTrades ? "border-zinc-700" :
              result.verdict === "PASS" ? "border-[#00e676]/30" :
              result.verdict === "MARGINAL" ? "border-yellow-400/30" : "border-[#ff5555]/30"
            }`}>
              <p className="text-[9px] font-mono uppercase tracking-widest mb-2" style={{ color: oosHasTrades ? verdictColor : "#52525b" }}>
                Out-of-Sample ({result.outOfSample.ticks} ticks){oosHasTrades ? " ★" : " (need 3+ trades)"}
              </p>
              <div className="space-y-1.5">
                {([
                  ["Trades", result.outOfSample.trades],
                  ["Win Rate", `${fmt(result.outOfSample.winRate)}%`],
                  ["Profit Factor", result.outOfSample.profitFactor >= 99 ? "99+ ✨" : fmt(result.outOfSample.profitFactor)],
                  ["Return", `${result.outOfSample.totalReturn >= 0 ? "+" : ""}${fmt(result.outOfSample.totalReturn)}%`],
                  ["Max DD", `${fmt(result.outOfSample.maxDrawdown)}%`],
                  ["Slippage", `-$${fmt(result.outOfSample.totalSlippage)}`],
                ] as [string, string | number][]).map(([label, val]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-[10px] text-zinc-500 font-mono">{label}</span>
                    <span className="text-[10px] font-mono font-semibold" style={{ color: oosHasTrades ? verdictColor : "#71717a" }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Degradation — only show when OOS has data */}
          {oosHasTrades && (
            <div className="bg-[#0d0f12] border border-zinc-800 rounded-lg p-2.5">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] font-mono text-zinc-500">Strategy Degradation (IS→OOS)</span>
                <span className={`text-[10px] font-mono font-bold ${
                  result.degradation < 20 ? "text-[#00e676]" : result.degradation < 40 ? "text-yellow-400" : "text-[#ff5555]"
                }`}>{fmt(result.degradation)}%</span>
              </div>
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500" style={{
                  width: `${Math.min(100, Math.abs(result.degradation))}%`,
                  backgroundColor: result.degradation < 20 ? "#00e676" : result.degradation < 40 ? "#fbbf24" : "#ff5555",
                }} />
              </div>
              <p className="text-[9px] text-zinc-600 mt-1">&lt;20% = robust · 20-40% = acceptable · &gt;40% = overfit</p>
            </div>
          )}

          {/* Tip when OOS lacks data */}
          {!oosHasTrades && (
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-2.5 flex items-start gap-2">
              <FlaskConical className="w-3 h-3 text-purple-400 mt-0.5 shrink-0" />
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                The OOS window only ran {result.outOfSample.trades} trade{result.outOfSample.trades !== 1 ? "s" : ""} — not enough for a statistically valid verdict.
                The in-sample shows strong results (PF {result.inSample.profitFactor >= 99 ? "99+" : fmt(result.inSample.profitFactor)}, WR {fmt(result.inSample.winRate)}%).
                Run <strong className="text-purple-400">2K or 5K ticks</strong> above for more OOS coverage.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  icon: React.ReactNode;
}

function KpiCard({ label, value, sub, color = "text-white", icon }: KpiCardProps) {
  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4 flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          {label}
        </span>
        <span className="text-zinc-600">{icon}</span>
      </div>
      <div className={`font-mono text-xl font-bold tabular-nums truncate ${color}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-500 truncate">{sub}</div>}
    </div>
  );
}

// ─── Mini Equity Curve ────────────────────────────────────────────────────────

function MiniEquityCurve() {
  const { data: curveData } = useQuery<EquityCurvePoint[]>({
    queryKey: ["/api/equity-curve"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/equity-curve");
      return r.json();
    },
    refetchInterval: 5000,
  });

  const points = Array.isArray(curveData) && curveData.length > 0 ? curveData : [];
  const startVal = 100;
  const currentVal = points.length > 0 ? points[points.length - 1].value : startVal;
  const isAbove = currentVal >= startVal;
  const fillColor = isAbove ? "#00e676" : "#ff1744";
  const strokeColor = isAbove ? "#00e676" : "#ff1744";

  // Ensure at least a flat line if no data
  const chartData =
    points.length > 0
      ? points.map((p) => ({ value: p.value }))
      : [{ value: startVal }, { value: startVal }];

  const CustomTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    if (active && payload && payload.length) {
      const val = payload[0].value as number;
      return (
        <div className="bg-[#1a1e2a] border border-zinc-700 rounded px-2 py-1">
          <span
            className="font-mono text-xs font-bold"
            style={{ color: val >= startVal ? "#00e676" : "#ff1744" }}
          >
            ${fmt(val)}
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          Equity Curve
        </span>
        <span
          className="font-mono text-xs font-bold"
          style={{ color: isAbove ? "#00e676" : "#ff1744" }}
        >
          {currentVal >= startVal ? "+" : ""}${fmt(currentVal - startVal)} (
          {currentVal >= startVal ? "+" : ""}
          {fmt(((currentVal - startVal) / startVal) * 100)}%)
        </span>
      </div>

      <div className="relative">
        {/* Left/Right edge labels */}
        <div className="flex justify-between items-center mb-1">
          <span className="font-mono text-[10px] text-zinc-500">${fmt(startVal)}</span>
          <span
            className="font-mono text-[10px] font-semibold"
            style={{ color: isAbove ? "#00e676" : "#ff1744" }}
          >
            ${fmt(currentVal)}
          </span>
        </div>

        {/* Chart */}
        <div className="h-[80px] md:h-[100px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={fillColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={fillColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={1.5}
                fill="url(#equityGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── Win/Loss Breakdown Row ───────────────────────────────────────────────────

function WinLossBreakdown({ autoState }: { autoState: AutoTraderState | undefined }) {
  const stats = autoState?.stats;
  const winRate = autoState?.winRate ?? 0;
  const closedTrades = autoState?.closedTrades ?? 0;

  // Derive win/loss counts from winRate and closedTrades
  const wins = Math.round((winRate / 100) * closedTrades);
  const losses = closedTrades - wins;

  const totalWinAmount = stats?.totalWinAmount ?? 0;
  const totalLossAmount = stats?.totalLossAmount ?? 0;
  const profitFactor = stats?.profitFactor ?? 0;

  const total = totalWinAmount + totalLossAmount;
  const winPct = total > 0 ? (totalWinAmount / total) * 100 : 50;
  const lossPct = 100 - winPct;

  // Profit factor color
  const pfColor =
    profitFactor >= 1.5 ? "#00e676" : profitFactor >= 1.0 ? "#ffd54f" : "#ff1744";

  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          Win / Loss Breakdown
        </span>
        {/* Profit Factor */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-zinc-500">PF:</span>
          <span
            className="font-mono text-sm font-bold tabular-nums"
            style={{ color: pfColor }}
          >
            {profitFactor > 0 ? fmt(profitFactor) : "—"}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2.5 rounded-full overflow-hidden bg-zinc-800 flex mb-3">
        {closedTrades > 0 ? (
          <>
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${winPct}%`, backgroundColor: "#00e676" }}
            />
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${lossPct}%`, backgroundColor: "#ff1744" }}
            />
          </>
        ) : (
          <div className="h-full w-full bg-zinc-700 rounded-full" />
        )}
      </div>

      {/* Labels */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#00e676] shrink-0" />
          <span className="font-mono text-xs text-white">
            W:{" "}
            <span className="text-[#00e676] font-bold">{wins}</span> trades{" "}
            <span className="text-zinc-400">${fmt(totalWinAmount)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#ff1744] shrink-0" />
          <span className="font-mono text-xs text-white">
            L:{" "}
            <span className="text-[#ff1744] font-bold">{losses}</span> trades{" "}
            <span className="text-zinc-400">${fmt(totalLossAmount)}</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 sm:ml-auto">
          <span className="text-[10px] font-mono text-zinc-500">PROFIT FACTOR</span>
          <span
            className="font-mono text-sm font-black tabular-nums"
            style={{ color: pfColor }}
          >
            {profitFactor > 0 ? fmt(profitFactor) : "—"}
          </span>
        </div>
      </div>

      {closedTrades === 0 && (
        <p className="text-[10px] text-zinc-600 font-mono mt-2 text-center">
          No closed trades yet — data will appear after first exit
        </p>
      )}
    </div>
  );
}

// ─── Market Heatmap Strip ─────────────────────────────────────────────────────

const SIGNAL_COLORS: Record<string, string> = {
  "A+": "#00e676",
  A: "#00bcd4",
  B: "#ffd54f",
};

const MARKET_TYPE_ORDER = ["STOCK", "CRYPTO", "FOREX", "COMMODITY", "INDEX"];
const MARKET_TYPE_LABELS: Record<string, string> = {
  STOCK: "STOCKS",
  CRYPTO: "CRYPTO",
  FOREX: "FOREX",
  COMMODITY: "COMMODITIES",
  INDEX: "INDICES",
};

function getTileColor(signal: string): string {
  return SIGNAL_COLORS[signal] ?? "#1a1e2a";
}

function getTileTextColor(signal: string): string {
  if (signal === "A+" || signal === "A" || signal === "B") return "#0d0f12";
  return "#6b7280";
}

interface HeatmapTileProps {
  item: SignalItem;
}

function HeatmapTile({ item }: HeatmapTileProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  const bgColor = getTileColor(item.signal);
  const textColor = getTileTextColor(item.signal);
  const hasSignal = Boolean(SIGNAL_COLORS[item.signal]);

  return (
    <div
      ref={tileRef}
      className="relative flex flex-col items-center justify-center w-[52px] h-[48px] rounded-lg cursor-pointer shrink-0 transition-all duration-150 hover:scale-105 hover:z-10 select-none"
      style={{ backgroundColor: bgColor }}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      onTouchStart={() => setTooltipVisible(true)}
      onTouchEnd={() => setTimeout(() => setTooltipVisible(false), 2000)}
    >
      {/* Colored dot */}
      <span
        className="w-1.5 h-1.5 rounded-full mb-0.5"
        style={{
          backgroundColor: hasSignal ? textColor : "#374151",
        }}
      />
      {/* Ticker */}
      <span
        className="font-mono font-bold leading-none"
        style={{ fontSize: "8px", color: hasSignal ? textColor : "#4b5563" }}
      >
        {item.ticker.length > 5 ? item.ticker.slice(0, 5) : item.ticker}
      </span>

      {/* Tooltip */}
      {tooltipVisible && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 pointer-events-none"
          style={{ minWidth: "120px" }}
        >
          <div className="bg-[#1a1e2a] border border-zinc-700 rounded-lg px-2.5 py-2 shadow-xl">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-mono font-bold text-[11px] text-white">
                {item.ticker}
              </span>
              {item.signal && SIGNAL_COLORS[item.signal] && (
                <span
                  className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: bgColor + "33",
                    color: bgColor,
                    border: `1px solid ${bgColor}55`,
                  }}
                >
                  {item.signal}
                </span>
              )}
            </div>
            <div className="text-[10px] font-mono text-zinc-400">
              Score:{" "}
              <span className="text-white font-semibold">
                {fmt(item.compositeScore, 0)}
              </span>
            </div>
            <div className="text-[10px] font-mono text-zinc-400">
              ${fmt(item.price)}
            </div>
            {item.signal && SIGNAL_COLORS[item.signal] && (
              <div className="text-[9px] font-mono text-zinc-500 mt-1">
                {item.signal === "A+" && "Top breakout — strong momentum"}
                {item.signal === "A" && "High score — watch for entry"}
                {item.signal === "B" && "Moderate signal — developing"}
              </div>
            )}
          </div>
          {/* Arrow */}
          <div
            className="w-2 h-2 bg-[#1a1e2a] border-r border-b border-zinc-700 rotate-45 mx-auto -mt-1"
          />
        </div>
      )}
    </div>
  );
}

function MarketHeatmapStrip() {
  const { data: signalsData } = useQuery<SignalItem[]>({
    queryKey: ["/api/signals"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/signals");
      return r.json();
    },
    refetchInterval: 8000,
  });

  const signals = Array.isArray(signalsData) ? signalsData : [];

  // Group by marketType
  const grouped: Record<string, SignalItem[]> = {};
  for (const s of signals) {
    const mt = (s.marketType ?? "STOCK").toUpperCase();
    if (!grouped[mt]) grouped[mt] = [];
    grouped[mt].push(s);
  }

  // Sort each group: A+ first, then A, B, no signal
  const signalOrder: Record<string, number> = { "A+": 0, A: 1, B: 2 };
  for (const mt of Object.keys(grouped)) {
    grouped[mt].sort(
      (a, b) =>
        (signalOrder[a.signal] ?? 99) - (signalOrder[b.signal] ?? 99) ||
        (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
    );
  }

  const orderedTypes = MARKET_TYPE_ORDER.filter((mt) => grouped[mt]?.length > 0);
  // Also include any unrecognized market types
  const extraTypes = Object.keys(grouped).filter((mt) => !MARKET_TYPE_ORDER.includes(mt));
  const allTypes = [...orderedTypes, ...extraTypes];

  const totalSignals = signals.filter((s) => SIGNAL_COLORS[s.signal]).length;

  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          Market Heatmap
        </span>
        <div className="flex items-center gap-2">
          {totalSignals > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#00e676]/15 text-[#00e676] font-mono font-bold border border-[#00e676]/30">
              {totalSignals} SIGNALS
            </span>
          )}
          {/* Legend */}
          <div className="hidden sm:flex items-center gap-2">
            {(["A+", "A", "B"] as const).map((s) => (
              <div key={s} className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-sm"
                  style={{ backgroundColor: SIGNAL_COLORS[s] }}
                />
                <span className="text-[9px] font-mono text-zinc-500">{s}</span>
              </div>
            ))}
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-[#1a1e2a] border border-zinc-700" />
              <span className="text-[9px] font-mono text-zinc-500">—</span>
            </div>
          </div>
        </div>
      </div>

      {signals.length === 0 ? (
        <div className="flex items-center justify-center h-16 text-zinc-600 text-xs font-mono">
          Loading market data...
        </div>
      ) : (
        <div className="overflow-x-auto pb-1 -mx-1 px-1">
          <div className="flex flex-col gap-3 min-w-max">
            {allTypes.map((mt) => (
              <div key={mt} className="flex items-center gap-2">
                {/* Market label */}
                <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest w-[72px] shrink-0 text-right">
                  {MARKET_TYPE_LABELS[mt] ?? mt}
                </span>
                {/* Tiles */}
                <div className="flex flex-wrap gap-1.5">
                  {grouped[mt].map((item) => (
                    <HeatmapTile key={item.ticker} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Active Positions Table ────────────────────────────────────────────────────

function PositionsTable({ positions }: { positions: ActivePosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <CircleDot className="w-10 h-10 text-zinc-700 mb-3" />
        <p className="text-zinc-500 text-sm">No open positions</p>
        <p className="text-zinc-600 text-xs mt-1">Engine will enter trades when signals fire</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      {/* Header */}
      <div className="grid grid-cols-[80px_110px_80px_80px_64px_90px_70px_90px_80px_80px] gap-2 px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500 border-b border-zinc-800 min-w-[900px]">
        <span>Ticker</span>
        <span>Strategy</span>
        <span className="text-right">Entry</span>
        <span className="text-right">Current</span>
        <span className="text-right">Shares</span>
        <span className="text-right">P&amp;L ($)</span>
        <span className="text-right">P&amp;L (%)</span>
        <span className="text-right">Trail Stop</span>
        <span className="text-right">Target</span>
        <span className="text-right">Status</span>
      </div>

      {positions.map((pos) => {
        const progress = Math.min(
          100,
          Math.max(
            0,
            ((pos.currentPrice - pos.entryPrice) /
              ((pos.takeProfit2 ?? pos.takeProfit ?? pos.entryPrice * 1.25) - pos.entryPrice)) *
              100
          )
        );

        return (
          <div
            key={pos.tradeId}
            data-testid={`position-row-${pos.ticker}`}
            className="grid grid-cols-[80px_110px_80px_80px_64px_90px_70px_90px_80px_80px] gap-2 px-4 py-3 border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors min-w-[900px]"
          >
            <span className="font-mono font-bold text-sm text-white self-center">
              {pos.ticker}
            </span>

            <span className="self-center">{strategyBadge(pos.strategy)}</span>

            <span className="font-mono text-xs text-zinc-300 text-right self-center">
              ${fmt(pos.entryPrice)}
            </span>

            <span className="font-mono text-xs text-white text-right self-center">
              ${fmt(pos.currentPrice)}
            </span>

            <span className="font-mono text-xs text-zinc-400 text-right self-center">
              {pos.shares?.toFixed(4) ?? '—'}
            </span>

            <div className="flex flex-col items-end self-center gap-0.5">
              <span className={`font-mono text-xs font-semibold ${pnlColor(pos.pnl)}`}>
                {pos.pnl >= 0 ? "+" : ""}${fmt(pos.pnl)}
              </span>
              {/* Progress bar entry → target */}
              <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.max(0, progress)}%`,
                    backgroundColor: pos.pnl >= 0 ? "#00e676" : "#ff1744",
                  }}
                />
              </div>
            </div>

            <span
              className={`font-mono text-xs font-semibold text-right self-center ${pnlColor(pos.pnlPct)}`}
            >
              {pos.pnlPct >= 0 ? "+" : ""}
              {fmt(pos.pnlPct)}%
            </span>

            <span className="font-mono text-xs text-yellow-400/90 text-right self-center">
              ${fmt(pos.trailingStop)}
            </span>

            <span className="font-mono text-xs text-[#00bcd4]/90 text-right self-center">
              ${fmt(pos.takeProfit2 ?? pos.takeProfit)}
            </span>

            <div className="flex justify-end self-center">
              {pos.status === "running" ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00e676]/10 text-[#00e676] border border-[#00e676]/20 font-mono">
                  LIVE
                </span>
              ) : pos.status === "target_hit" ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00bcd4]/10 text-[#00bcd4] border border-[#00bcd4]/20 font-mono">
                  TARGET
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#ff1744]/10 text-[#ff1744] border border-[#ff1744]/20 font-mono">
                  EXIT
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Signal Scanner Table ──────────────────────────────────────────────────────

function SignalScanner({ signals }: { signals: BreakoutSignal[] }) {
  if (signals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <BarChart2 className="w-10 h-10 text-zinc-700 mb-3" />
        <p className="text-zinc-500 text-sm">No signals scanned yet</p>
        <p className="text-zinc-600 text-xs mt-1">Start the engine or run a manual scan</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      {/* Header */}
      <div className="grid grid-cols-[36px_80px_140px_110px_80px_80px_80px_80px_1fr] gap-2 px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500 border-b border-zinc-800 min-w-[900px]">
        <span>#</span>
        <span>Ticker</span>
        <span>Score</span>
        <span>Strategy</span>
        <span className="text-right">Price</span>
        <span className="text-right">Entry</span>
        <span className="text-right">Stop</span>
        <span className="text-right">Target</span>
        <span>Reasons</span>
      </div>

      {signals.map((sig, idx) => (
        <div
          key={sig.ticker}
          data-testid={`signal-row-${sig.ticker}`}
          className="grid grid-cols-[36px_80px_140px_110px_80px_80px_80px_80px_1fr] gap-2 px-4 py-3 border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors items-center min-w-[900px]"
        >
          <span className="font-mono text-xs text-zinc-600">{idx + 1}</span>

          <span className="font-mono font-bold text-sm text-white">{sig.ticker}</span>

          {/* Score bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${sig.score}%`,
                  backgroundColor: scoreColor(sig.score),
                }}
              />
            </div>
            <span
              className="font-mono text-xs font-bold w-8 text-right tabular-nums"
              style={{ color: scoreColor(sig.score) }}
            >
              {sig.score}
            </span>
          </div>

          <span>{strategyBadge(sig.strategy)}</span>

          <span className="font-mono text-xs text-white text-right">
            ${fmt(sig.price)}
          </span>
          <span className="font-mono text-xs text-zinc-300 text-right">
            ${fmt(sig.entryPrice)}
          </span>
          <span className="font-mono text-xs text-[#ff1744]/80 text-right">
            ${fmt(sig.stopLoss)}
          </span>
          <span className="font-mono text-xs text-[#00e676]/80 text-right">
            ${fmt(sig.takeProfit1 ?? sig.takeProfit)}
          </span>

          <div className="flex flex-wrap gap-1">
            {sig.reasons.map((r) => (
              <span
                key={r}
                className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono border border-zinc-700/50 whitespace-nowrap"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

function ActivityLog({ entries }: { entries: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll is NOT needed here because entries are newest-first (unshift)
  // The list grows from top downward which is fine for a top-scroll terminal

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Activity className="w-8 h-8 text-zinc-700 mb-2" />
        <p className="text-zinc-600 text-xs font-mono">Awaiting engine activity...</p>
      </div>
    );
  }

  return (
    <div className="font-mono text-xs space-y-0.5 px-1">
      {entries.map((line, i) => (
        <div
          key={i}
          className={`px-3 py-1.5 rounded hover:bg-zinc-800/40 transition-colors leading-relaxed ${logLineColor(line)}`}
        >
          {line}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── Section Shell ────────────────────────────────────────────────────────────

function Section({
  title,
  icon,
  badge,
  children,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">{icon}</span>
          <span className="text-xs font-mono uppercase tracking-widest text-zinc-300 font-semibold">
            {title}
          </span>
          {badge}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AutoTraderPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── State fetch ──
  const {
    data: state,
    isLoading,
    refetch: refetchState,
  } = useQuery<AutoTraderState>({
    queryKey: ["/api/auto-trader"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/auto-trader");
      return r.json();
    },
    refetchInterval: false,
  });

  // ── Portfolio fetch ──
  const { data: portfolio } = useQuery<PortfolioSummary>({
    queryKey: ["/api/portfolio"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/portfolio");
      return r.json();
    },
  });

  // ── Start mutation ──
  const startMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auto-trader/start");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      refetchState();
      toast({
        title: "Engine Started",
        description: "Auto-Trader is now scanning for momentum breakouts.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    },
  });

  // ── Stop mutation ──
  const stopMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auto-trader/stop");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      refetchState();
      toast({
        title: "Engine Stopped",
        description: "Auto-Trader has been halted.",
        variant: "destructive",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to stop", description: err.message, variant: "destructive" });
    },
  });

  // ── Tick mutation ──
  const tickMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/auto-trader/tick");
      return r.json();
    },
    onSuccess: (result: { entered?: ActivePosition | null; exited?: string[]; signals?: BreakoutSignal[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      refetchState();
      if (result?.entered) {
        toast({
          title: `Entered ${result.entered.ticker}`,
          description: `${result.entered.strategy} · ${(result.entered.shares ?? 0).toFixed(4)} shares @ $${fmt(result.entered.entryPrice)}`,
        });
      }
    },
  });

  // ── Scan mutation ──
  const scanMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("GET", "/api/auto-trader/scan");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      refetchState();
      toast({ title: "Scan Complete", description: "Signal table updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Reset portfolio mutation ──
  const resetMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/portfolio/reset");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-trader"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/equity-curve"] });
      refetchState();
      toast({ title: "Portfolio Reset", description: "All trades cleared. Starting fresh from $100." });
    },
    onError: (err: Error) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Auto-tick interval ──
  const isRunning = state?.isRunning ?? false;

  const runAutoTick = useCallback(() => {
    tickMutation.mutate();
  }, []);

  useEffect(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    if (isRunning) {
      tickIntervalRef.current = setInterval(runAutoTick, 2000);
    }
    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
    };
  }, [isRunning]);

  // ── Derived ──
  const openCount = state?.openPositions?.length ?? 0;
  const cash = portfolio?.cash ?? 0;

  const pnlValue = state?.totalPnl ?? 0;
  const winRateValue = state?.winRate ?? 0;
  const bestTrade = state?.bestTrade;

  // ── Loading skeleton ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d0f12]">
        <div className="flex flex-col items-center gap-3">
          <Cpu className="w-10 h-10 text-[#00bcd4] animate-pulse" />
          <p className="text-zinc-400 font-mono text-sm">Loading Auto-Trader...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-[#0d0f12] min-h-screen">
      {/* ── Top Bar ── */}
      <div
        className="border-b border-zinc-800 sticky top-0 z-10"
        style={{ backgroundColor: "#0d0f12" }}
      >
        {/* Row 1: title + status + engine toggle */}
        <div className="flex items-center justify-between px-4 md:px-6 pt-4 pb-2 gap-3">
          {/* Title + status */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0">
              <Cpu className="w-5 h-5 text-[#00bcd4]" />
              {isRunning && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#00e676] animate-pulse" />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white tracking-tight leading-none truncate">Auto-Trader</h1>
              <p className="text-[10px] text-zinc-500 mt-0.5 leading-none truncate">OHLCV · MTF · Spread Sim · Event Filter · Walk-Forward</p>
            </div>
            {/* Status pill */}
            <div
              className={`hidden sm:flex shrink-0 items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border ${
                isRunning ? "bg-[#00e676]/10 text-[#00e676] border-[#00e676]/30" : "bg-zinc-800 text-zinc-500 border-zinc-700"
              }`}
              data-testid="status-indicator"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-[#00e676] animate-pulse" : "bg-zinc-600"}`} />
              {isRunning ? "RUNNING" : "STOPPED"}
            </div>
          </div>

          {/* Engine toggle — always visible, right side */}
          {isRunning ? (
            <Button
              data-testid="button-stop-engine"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              size="sm"
              className="shrink-0 h-9 px-4 font-bold text-xs tracking-wide gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-[#ff5555] border border-zinc-700"
            >
              <Square className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">STOP</span> ENGINE
            </Button>
          ) : (
            <Button
              data-testid="button-start-engine"
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              size="sm"
              className="shrink-0 h-9 px-4 font-bold text-xs tracking-wide gap-1.5 bg-[#00bcd4] hover:bg-[#00bcd4]/80 text-black border-0"
            >
              <Play className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">START</span> ENGINE
            </Button>
          )}
        </div>

        {/* Row 2: utility buttons + mobile status */}
        <div className="flex items-center justify-between px-4 md:px-6 pb-3 gap-2">
          {/* Mobile status */}
          <div
            className={`flex sm:hidden items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border ${
              isRunning ? "bg-[#00e676]/10 text-[#00e676] border-[#00e676]/30" : "bg-zinc-800 text-zinc-500 border-zinc-700"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-[#00e676] animate-pulse" : "bg-zinc-600"}`} />
            {isRunning ? "RUNNING" : "STOPPED"}
          </div>
          <div className="hidden sm:block" />

          {/* Scan + Tick + Reset buttons */}
          <div className="flex items-center gap-2">
            <Button
              data-testid="button-scan"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              size="sm"
              variant="outline"
              className="h-7 text-[11px] border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 font-mono gap-1.5 px-3"
            >
              <RefreshCw className={`w-3 h-3 ${scanMutation.isPending ? "animate-spin" : ""}`} />
              SCAN
            </Button>
            <Button
              data-testid="button-tick"
              onClick={() => tickMutation.mutate()}
              disabled={tickMutation.isPending}
              size="sm"
              variant="outline"
              className="h-7 text-[11px] border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 font-mono gap-1.5 px-3"
            >
              <Zap className="w-3 h-3" />
              TICK
            </Button>
            <Button
              data-testid="button-reset"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending || isRunning}
              size="sm"
              variant="outline"
              className="h-7 text-[11px] border-red-900/40 text-zinc-500 hover:text-[#ff5555] hover:border-red-700/50 font-mono gap-1.5 px-3"
              title="Reset portfolio to $100 (stop engine first)"
            >
              RESET
            </Button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 p-3 md:p-6 space-y-4 md:space-y-5">
        {/* ── KPI Row 1 ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Total Ticks"
            value={state?.totalTicks ?? 0}
            icon={<Hash className="w-4 h-4" />}
            color="text-[#00bcd4]"
          />
          <KpiCard
            label="Open Positions"
            value={openCount}
            sub={openCount > 0 ? `${openCount} active trade${openCount > 1 ? "s" : ""}` : "No open trades"}
            icon={<Activity className="w-4 h-4" />}
            color={openCount > 0 ? "text-[#00e676]" : "text-zinc-400"}
          />
          <KpiCard
            label="Win Rate"
            value={`${winRateValue}%`}
            sub={
              (state?.closedTrades ?? 0) > 0
                ? `from ${state!.closedTrades} closed trades`
                : "No closed trades yet"
            }
            icon={<CheckCircle2 className="w-4 h-4" />}
            color={
              winRateValue >= 60
                ? "text-[#00e676]"
                : winRateValue >= 40
                ? "text-yellow-400"
                : "text-zinc-400"
            }
          />
          <KpiCard
            label="Total P&L"
            value={`${pnlValue >= 0 ? "+" : ""}$${fmt(pnlValue)}`}
            icon={pnlValue >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            color={pnlColor(pnlValue)}
          />
        </div>

        {/* ── KPI Row 2 ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Total Trades"
            value={state?.totalTrades ?? 0}
            icon={<BarChart2 className="w-4 h-4" />}
            color="text-white"
          />
          <KpiCard
            label="Closed Trades"
            value={state?.closedTrades ?? 0}
            icon={<XCircle className="w-4 h-4" />}
            color="text-zinc-300"
          />
          <KpiCard
            label="Best Trade"
            value={bestTrade ? `+$${fmt(bestTrade.pnl ?? 0)}` : "—"}
            sub={bestTrade ? bestTrade.ticker : "No winners yet"}
            icon={<Trophy className="w-4 h-4" />}
            color={bestTrade ? "text-[#00e676]" : "text-zinc-500"}
          />
          <KpiCard
            label="Portfolio Cash"
            value={`$${fmt(cash)}`}
            icon={<Wallet className="w-4 h-4" />}
            color="text-white"
          />
        </div>

        {/* ── V18 Performance Velocity Panel ── */}
        <AlpacaBadge />
        <VelocityPanel autoState={state} portfolio={portfolio} />

        {/* ── V13 Engine Status Banner ── */}
        <V6StatusBanner autoState={state} />

        {/* ── NEW SECTION 1: Mini Equity Curve ── */}
        <MiniEquityCurve />

        {/* ── NEW SECTION 2: Win/Loss Breakdown ── */}
        <WinLossBreakdown autoState={state} />

        {/* ── V16 Walk-Forward Backtest Panel ── */}
        <BacktestPanel />

        {/* ── NEW SECTION 3: Market Heatmap Strip ── */}
        <MarketHeatmapStrip />

        {/* ── Active Positions ── */}
        <Section
          title="Active Positions"
          icon={<Activity className="w-4 h-4" />}
          badge={
            openCount > 0 ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#00e676]/15 text-[#00e676] font-mono font-bold border border-[#00e676]/30">
                {openCount} OPEN
              </span>
            ) : null
          }
        >
          <PositionsTable positions={state?.openPositions ?? []} />
        </Section>

        {/* ── Signal Scanner ── */}
        <Section
          title="Signal Scanner"
          icon={<Target className="w-4 h-4" />}
          badge={
            (state?.lastScan?.length ?? 0) > 0 ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#00bcd4]/15 text-[#00bcd4] font-mono font-bold border border-[#00bcd4]/30">
                {state!.lastScan.length} SIGNALS
              </span>
            ) : null
          }
          action={
            <button
              data-testid="button-rescan"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              className="flex items-center gap-1 text-[10px] font-mono text-zinc-500 hover:text-[#00bcd4] transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3 h-3 ${scanMutation.isPending ? "animate-spin" : ""}`}
              />
              RESCAN
            </button>
          }
        >
          <SignalScanner signals={state?.lastScan ?? []} />
        </Section>

        {/* ── Activity Log ── */}
        <Section
          title="Live Activity Log"
          icon={<ShieldAlert className="w-4 h-4" />}
          badge={
            (state?.log?.length ?? 0) > 0 ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-mono border border-zinc-700">
                {state!.log.length} entries
              </span>
            ) : null
          }
        >
          <ScrollArea
            className="h-64"
            data-testid="activity-log"
          >
            <div className="py-2">
              <ActivityLog entries={state?.log ?? []} />
            </div>
          </ScrollArea>
        </Section>
      </div>
    </div>
  );
}
