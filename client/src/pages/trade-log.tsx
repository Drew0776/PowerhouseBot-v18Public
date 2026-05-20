import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Trade } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Search, Trophy, Skull, TrendingUp, TrendingDown, Download } from "lucide-react";
import { Link } from "wouter";

interface TradesResponse {
  trades: Trade[];
  summary: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    averageReturn: number;
  };
}

function CalendarHeatmap({ trades }: { trades: Trade[] }) {
  const dailyPnl = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trades) {
      if (t.status === "closed" && t.pnl !== null && t.closedAt) {
        const day = t.closedAt.split("T")[0];
        map.set(day, (map.get(day) || 0) + t.pnl);
      }
    }
    return map;
  }, [trades]);

  const days: { date: string; pnl: number; dayOfWeek: number }[] = [];
  for (let i = 34; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    days.push({ date: dateStr, pnl: dailyPnl.get(dateStr) || 0, dayOfWeek: d.getDay() });
  }

  const hasActivity = dailyPnl.size > 0;

  return (
    <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Daily P&L Heatmap</h3>
      {!hasActivity ? (
        <div className="flex items-center justify-center h-8 text-[11px] text-muted-foreground font-mono">
          No trades in the last 35 days
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {days.map(d => {
              const color = d.pnl > 0 ? `rgba(0,230,118,${Math.min(1, d.pnl / 2)})` : d.pnl < 0 ? `rgba(255,23,68,${Math.min(1, Math.abs(d.pnl) / 2)})` : "hsl(220 15% 13%)";
              return (
                <div
                  key={d.date}
                  className="w-5 h-5 rounded-sm"
                  style={{ backgroundColor: color }}
                  title={`${d.date}: ${d.pnl >= 0 ? "+" : ""}$${(d.pnl ?? 0).toFixed(2)}`}
                />
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-[9px] text-muted-foreground">Loss</span>
            <div className="flex gap-0.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgba(255,23,68,0.8)" }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgba(255,23,68,0.3)" }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "hsl(220 15% 13%)" }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgba(0,230,118,0.3)" }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgba(0,230,118,0.8)" }} />
            </div>
            <span className="text-[9px] text-muted-foreground">Gain</span>
          </div>
        </>
      )}
    </div>
  );
}

function CumulativePnlChart({ trades }: { trades: Trade[] }) {
  const chartData = useMemo(() => {
    const closed = trades
      .filter(t => t.status === "closed" && t.pnl !== null && t.closedAt)
      .sort((a, b) => (a.closedAt || "").localeCompare(b.closedAt || ""));

    let cumPnl = 0;
    return closed.map(t => {
      cumPnl += t.pnl || 0;
      return {
        date: (t.closedAt || "").slice(5, 10),
        pnl: Math.round(cumPnl * 100) / 100,
      };
    });
  }, [trades]);

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4 flex items-center justify-center h-48" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <span className="text-xs text-muted-foreground">No closed trades yet</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Cumulative P&L</h3>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 13%)" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
          <Tooltip contentStyle={{ backgroundColor: "hsl(220 18% 9%)", border: "1px solid hsl(220 15% 15%)", borderRadius: 6, fontSize: 11 }} />
          <Line type="monotone" dataKey="pnl" stroke="#00bcd4" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function TradeLog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");

  const { data, isLoading } = useQuery<TradesResponse>({ queryKey: ["/api/trades"] });

  const closeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/trades/${id}/close`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/equity-curve"] });
      toast({ title: "Position Closed" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-96" /></div>;

  const trades = data?.trades || [];
  const summary = data?.summary || { totalTrades: 0, winningTrades: 0, losingTrades: 0, averageReturn: 0 };

  const filtered = trades.filter(t => {
    if (filter && !t.ticker.toLowerCase().includes(filter.toLowerCase())) return false;
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    return true;
  });

  const bestTrade = trades.filter(t => t.pnl !== null).sort((a, b) => (b.pnl || 0) - (a.pnl || 0))[0];
  const worstTrade = trades.filter(t => t.pnl !== null).sort((a, b) => (a.pnl || 0) - (b.pnl || 0))[0];

  const closedTrades = trades.filter(t => t.status === "closed");

  function exportCsv() {
    const headers = ["Ticker", "Strategy", "Entry Price", "Exit Price", "Shares", "P&L", "P&L %", "Opened At", "Closed At", "Status"];
    const rows = closedTrades.map(t => {
      const entryPrice = t.price ?? 0;
      const exitPrice = t.pnl !== null && t.shares ? ((t.pnl + entryPrice * t.shares) / t.shares) : null;
      const pnlPct = t.pnl !== null && entryPrice && t.shares ? (t.pnl / (entryPrice * t.shares)) * 100 : null;
      return [
        t.ticker,
        "N/A",
        entryPrice.toFixed(2),
        exitPrice !== null ? exitPrice.toFixed(2) : "",
        (t.shares ?? 0).toFixed(4),
        t.pnl !== null ? t.pnl.toFixed(2) : "",
        pnlPct !== null ? pnlPct.toFixed(2) + "%" : "",
        t.openedAt ? new Date(t.openedAt).toLocaleString() : "",
        t.closedAt ? new Date(t.closedAt).toLocaleString() : "",
        t.status,
      ];
    });
    const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-history-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Trade Log</h1>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs gap-1.5"
          onClick={exportCsv}
          disabled={closedTrades.length === 0}
          data-testid="export-csv"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <span className="text-[10px] uppercase text-muted-foreground">Total Trades</span>
          <div className="text-lg font-mono font-semibold">{summary.totalTrades}</div>
        </div>
        <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <span className="text-[10px] uppercase text-muted-foreground">Win/Loss</span>
          <div className="text-lg font-mono font-semibold">
            <span className="text-[#00e676]">{summary.winningTrades}</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-[#ff1744]">{summary.losingTrades}</span>
          </div>
        </div>
        {bestTrade && (
          <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
            <div className="flex items-center gap-1">
              <Trophy className="w-3 h-3 text-[#00e676]" />
              <span className="text-[10px] uppercase text-muted-foreground">Best Trade</span>
            </div>
            <div className="text-sm font-mono">
              <span className="text-[#00bcd4]">{bestTrade.ticker}</span>
              <span className="text-[#00e676] ml-1">+${(bestTrade.pnl || 0).toFixed(2)}</span>
            </div>
          </div>
        )}
        {worstTrade && worstTrade.pnl !== null && worstTrade.pnl < 0 && (
          <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
            <div className="flex items-center gap-1">
              <Skull className="w-3 h-3 text-[#ff1744]" />
              <span className="text-[10px] uppercase text-muted-foreground">Worst Trade</span>
            </div>
            <div className="text-sm font-mono">
              <span className="text-[#00bcd4]">{worstTrade.ticker}</span>
              <span className="text-[#ff1744] ml-1">${(worstTrade.pnl || 0).toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CalendarHeatmap trades={trades} />
        <CumulativePnlChart trades={trades} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter ticker..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="pl-8 h-8 w-40 text-xs"
            data-testid="trade-filter"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "open", "closed"] as const).map(s => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "secondary"}
              size="sm"
              className="h-7 text-[10px] px-2.5"
              onClick={() => setStatusFilter(s)}
              data-testid={`filter-${s}`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground ml-auto">{filtered.length} trades</span>
      </div>

      {/* Trades table */}
      <div className="rounded-lg border border-border overflow-hidden" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border" style={{ backgroundColor: "hsl(220 18% 6%)" }}>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Ticker</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Action</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Shares</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Price</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Total</th>
                <th className="px-3 py-2 text-center text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">P&L</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Opened</th>
                <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
                  <td className="px-3 py-2">
                    <Link href={`/stock/${t.ticker}`}>
                      <span className="font-mono font-semibold text-[#00bcd4] cursor-pointer hover:underline">{t.ticker}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase font-semibold ${t.action === "buy" ? "text-[#00e676]" : "text-[#ff1744]"}`}>
                      {t.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{(t.shares ?? 0).toFixed(4)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">${(t.price ?? 0).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">${(t.total ?? 0).toFixed(2)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${t.status === "open" ? "bg-[rgba(0,188,212,0.15)] text-[#00bcd4]" : "bg-muted text-muted-foreground"}`}>
                      {t.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {t.pnl !== null ? (
                      <span style={{ color: t.pnl >= 0 ? "#00e676" : "#ff1744" }}>
                        {t.pnl >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2)}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground font-mono">
                    {new Date(t.openedAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">
                    {t.status === "open" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-6 text-[10px] px-2"
                        disabled={closeMutation.isPending}
                        onClick={() => closeMutation.mutate(t.id)}
                        data-testid={`close-${t.id}`}
                      >
                        Close
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                    {trades.length === 0 ? "No trades yet — execute your first paper trade!" : "No trades match filter"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
