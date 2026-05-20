import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import type { GridBot, GridBotSummary, GridLevel, GridOrder } from "@shared/schema";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toFixed(decimals);
}

function pnlColor(n: number) {
  if (n > 0) return "text-[#00e676]";
  if (n < 0) return "text-[#ff1744]";
  return "text-zinc-400";
}

function statusBadge(status: string) {
  if (status === "active") return <Badge className="bg-[#00e676]/20 text-[#00e676] border-[#00e676]/30 text-[10px] px-1.5 py-0">LIVE</Badge>;
  if (status === "paused") return <Badge className="bg-yellow-400/20 text-yellow-400 border-yellow-400/30 text-[10px] px-1.5 py-0">PAUSED</Badge>;
  return <Badge className="bg-zinc-700 text-zinc-400 text-[10px] px-1.5 py-0">STOPPED</Badge>;
}

// ─── Grid Visualizer ──────────────────────────────────────────────────────────

interface GridVisualizerProps {
  summary: GridBotSummary;
}

function GridVisualizer({ summary }: GridVisualizerProps) {
  const { levels, currentPrice, bot } = summary;
  const range = bot.upperPrice - bot.lowerPrice;
  const totalFills = summary.orders.length;

  return (
    <div className="relative flex flex-col gap-0 select-none">
      {/* Header row */}
      <div className="grid grid-cols-[36px_1fr_52px_68px] md:grid-cols-[48px_1fr_64px_64px_80px] gap-1 md:gap-2 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        <span>LVL</span>
        <span>PRICE</span>
        <span className="text-right">FILLS</span>
        <span className="text-right md:hidden">ACT</span>
        <span className="hidden md:block text-right">P&amp;L</span>
        <span className="hidden md:block text-right">ACTION</span>
      </div>

      <div className="flex flex-col-reverse">
        {levels.map((lvl) => {
          const isActive = lvl.level === summary.activeLevel;
          const isCurrent = Math.abs(lvl.price - currentPrice) <= (bot.upperPrice - bot.lowerPrice) / bot.gridCount / 2;
          const pct = ((lvl.price - bot.lowerPrice) / range) * 100;

          return (
            <div
              key={lvl.level}
              data-testid={`grid-level-${lvl.level}`}
              className={`
                relative grid grid-cols-[36px_1fr_52px_68px] md:grid-cols-[48px_1fr_64px_64px_80px] gap-1 md:gap-2 items-center
                px-3 py-1.5 border-b border-zinc-800/50 transition-all
                ${isActive ? "bg-[#00bcd4]/5 border-l-2 border-l-[#00bcd4]" : ""}
                ${lvl.filled ? "bg-zinc-900/40" : ""}
                hover:bg-zinc-800/30
              `}
            >
              {/* Price bar fill */}
              <div
                className="absolute left-0 top-0 h-full bg-[#00bcd4]/5"
                style={{ width: `${pct}%`, pointerEvents: "none" }}
              />

              {/* Level number */}
              <span className={`font-mono text-xs relative z-10 ${isActive ? "text-[#00bcd4] font-bold" : "text-zinc-500"}`}>
                {lvl.level}
              </span>

              {/* Price */}
              <div className="flex items-center gap-2 relative z-10">
                <span className={`font-mono text-sm font-semibold ${isActive ? "text-white" : "text-zinc-300"}`}>
                  ${fmt(lvl.price)}
                </span>
                {isCurrent && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-[#00bcd4]/20 text-[#00bcd4] font-bold tracking-wider">
                    CURRENT
                  </span>
                )}
                {isActive && !isCurrent && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-300">
                    NEAR
                  </span>
                )}
              </div>

              {/* Fill count */}
              <span className={`font-mono text-xs text-right relative z-10 ${lvl.fillCount > 0 ? "text-white" : "text-zinc-600"}`}>
                {lvl.fillCount > 0 ? lvl.fillCount : "—"}
              </span>

              {/* P&L - hidden on mobile, shown as combined action column */}
              <span className={`hidden md:block font-mono text-xs text-right relative z-10 ${pnlColor(lvl.pnl)}`}>
                {lvl.pnl !== 0 ? `$${fmt(Math.abs(lvl.pnl))}` : "—"}
              </span>
              {/* Mobile: compact action/pnl combined */}
              <div className="flex md:hidden justify-end relative z-10">
                {lvl.action === "buy" && <span className="text-[9px] px-1 py-0.5 rounded bg-[#00e676]/10 text-[#00e676] font-mono">BUY</span>}
                {lvl.action === "sell" && <span className="text-[9px] px-1 py-0.5 rounded bg-[#ff1744]/10 text-[#ff1744] font-mono">SELL</span>}
                {lvl.action === "idle" && <span className="text-[9px] text-zinc-600 font-mono">—</span>}
              </div>

              {/* Next action — desktop only */}
              <div className="hidden md:flex justify-end relative z-10">
                {lvl.action === "buy" && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[#00e676]/10 text-[#00e676] border border-[#00e676]/20 font-mono">
                    ↓ BUY
                  </span>
                )}
                {lvl.action === "sell" && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[#ff1744]/10 text-[#ff1744] border border-[#ff1744]/20 font-mono">
                    ↑ SELL
                  </span>
                )}
                {lvl.action === "idle" && (
                  <span className="text-[10px] text-zinc-600 font-mono">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Create Bot Form ──────────────────────────────────────────────────────────

interface CreateBotFormProps {
  onCreated: () => void;
  availableCash: number;
}

function CreateBotForm({ onCreated, availableCash }: CreateBotFormProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [ticker, setTicker] = useState("BBAI");
  const [lower, setLower] = useState("");
  const [upper, setUpper] = useState("");
  const [gridCount, setGridCount] = useState(10);
  const [investment, setInvestment] = useState(Math.min(25, availableCash).toString());

  // Auto-range API — smart range + grid count suggestion
  const { data: autoRangeData } = useQuery<any>({
    queryKey: ["/api/grid/auto-range", ticker],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/grid/auto-range?ticker=${ticker.toUpperCase()}`);
      return r.json();
    },
    enabled: ticker.length >= 2,
    retry: false,
  });
  const stockData = autoRangeData; // price compat

  useEffect(() => {
    if (autoRangeData?.currentPrice) {
      setLower(fmt(autoRangeData.lower, 4));
      setUpper(fmt(autoRangeData.upper, 4));
      if (autoRangeData.suggestedGrids) setGridCount(autoRangeData.suggestedGrids);
    }
  }, [autoRangeData]);

  // Preview grid
  const lowerNum = parseFloat(lower);
  const upperNum = parseFloat(upper);
  const investNum = parseFloat(investment);
  const isValid = !isNaN(lowerNum) && !isNaN(upperNum) && lowerNum < upperNum && gridCount >= 2 && investNum > 0 && investNum <= availableCash;

  const gridStep = isValid ? (upperNum - lowerNum) / gridCount : 0;
  const profitPerGrid = isValid && (lowerNum + upperNum) > 0
    ? (gridStep / ((lowerNum + upperNum) / 2)) * 100
    : 0;
  const perLevelInvestment = isValid ? investNum / gridCount : 0;

  const createMutation = useMutation({
    mutationFn: async (data: any) => { const r = await apiRequest("POST", "/api/grid/bots", data); return r.json(); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/grid/bots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      toast({ title: "Grid Bot Launched", description: `Grid on ${ticker.toUpperCase()} is now active.` });
      onCreated();
    },
    onError: (err: any) => {
      toast({ title: "Failed to create bot", description: err.message, variant: "destructive" });
    },
  });

  function handleCreate() {
    if (!isValid) return;
    createMutation.mutate({
      ticker: ticker.toUpperCase(),
      lowerPrice: lowerNum,
      upperPrice: upperNum,
      gridCount,
      totalInvestment: investNum,
    });
  }

  return (
    <div className="bg-[#141720] border border-zinc-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-[#00bcd4]" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 3L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
        </svg>
        <h3 className="text-sm font-semibold text-white tracking-wide">NEW GRID BOT</h3>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-zinc-400 uppercase tracking-wider">Ticker</Label>
          <Input
            data-testid="input-ticker"
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            className="bg-[#0d0f12] border-zinc-700 font-mono text-white h-8 text-sm"
            placeholder="e.g. SOUN"
          />
          {autoRangeData?.currentPrice && (
            <p className="text-[10px] text-zinc-500 font-mono">
              Current: ${fmt(autoRangeData.currentPrice)} · Range: ±{autoRangeData.rangePercent?.toFixed(0)}%
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-zinc-400 uppercase tracking-wider">Investment ($)</Label>
          <Input
            data-testid="input-investment"
            value={investment}
            onChange={e => setInvestment(e.target.value)}
            type="number"
            min={1}
            max={availableCash}
            className="bg-[#0d0f12] border-zinc-700 font-mono text-white h-8 text-sm"
          />
          <p className="text-[10px] text-zinc-500 font-mono">Available: ${fmt(availableCash)}</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-zinc-400 uppercase tracking-wider">Lower Bound ($)</Label>
          <Input
            data-testid="input-lower"
            value={lower}
            onChange={e => setLower(e.target.value)}
            type="number"
            className="bg-[#0d0f12] border-zinc-700 font-mono text-white h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-zinc-400 uppercase tracking-wider">Upper Bound ($)</Label>
          <Input
            data-testid="input-upper"
            value={upper}
            onChange={e => setUpper(e.target.value)}
            type="number"
            className="bg-[#0d0f12] border-zinc-700 font-mono text-white h-8 text-sm"
          />
        </div>
      </div>

      {/* Grid count slider */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <Label className="text-[11px] text-zinc-400 uppercase tracking-wider">Grid Lines</Label>
          <span className="text-sm font-mono text-[#00bcd4] font-bold">{gridCount}</span>
        </div>
        <Slider
          data-testid="slider-grid-count"
          value={[gridCount]}
          onValueChange={([v]) => setGridCount(v)}
          min={3}
          max={30}
          step={1}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
          <span>3 (wider gaps, bigger profit)</span>
          <span>30 (tight, high frequency)</span>
        </div>
      </div>

      {/* Live Preview */}
      {isValid && (
        <div className="bg-[#0d0f12] border border-zinc-800 rounded-lg p-3 grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Grid Step</p>
            <p className="font-mono text-sm text-white font-semibold">${fmt(gridStep)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Profit / Grid</p>
            <p className="font-mono text-sm text-[#00e676] font-semibold">{fmt(profitPerGrid, 2)}%</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Per Level</p>
            <p className="font-mono text-sm text-white font-semibold">${fmt(perLevelInvestment)}</p>
          </div>
        </div>
      )}

      <Button
        data-testid="button-create-bot"
        onClick={handleCreate}
        disabled={!isValid || createMutation.isPending}
        className="w-full bg-[#00bcd4] hover:bg-[#00bcd4]/80 text-black font-bold h-9 text-sm tracking-wide"
      >
        {createMutation.isPending ? "LAUNCHING..." : "⚡ LAUNCH GRID BOT"}
      </Button>
    </div>
  );
}

// ─── Bot Card ─────────────────────────────────────────────────────────────────

interface BotCardProps {
  bot: GridBot;
  selected: boolean;
  onClick: () => void;
}

function BotCard({ bot, selected, onClick }: BotCardProps) {
  const profitPct = bot.totalInvestment > 0
    ? (bot.realizedPnl / bot.totalInvestment) * 100
    : 0;

  return (
    <div
      data-testid={`bot-card-${bot.id}`}
      onClick={onClick}
      className={`
        cursor-pointer p-3 rounded-lg border transition-all
        ${selected
          ? "border-[#00bcd4] bg-[#00bcd4]/5"
          : "border-zinc-800 bg-[#141720] hover:border-zinc-600"
        }
      `}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <span className="font-mono text-base font-bold text-white">{bot.ticker}</span>
          <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
            ${fmt(bot.lowerPrice)} – ${fmt(bot.upperPrice)} · {bot.gridCount} grids
          </p>
        </div>
        {statusBadge(bot.status)}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2">
        <div>
          <p className="text-[10px] text-zinc-500">Invested</p>
          <p className="font-mono text-xs text-white">${fmt(bot.totalInvestment)}</p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500">Realized P&L</p>
          <p className={`font-mono text-xs font-semibold ${pnlColor(bot.realizedPnl)}`}>
            {bot.realizedPnl >= 0 ? "+" : ""}${fmt(bot.realizedPnl)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500">Fills</p>
          <p className="font-mono text-xs text-[#00bcd4]">{bot.totalGridFills}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Order History ────────────────────────────────────────────────────────────

function OrderHistory({ orders }: { orders: GridOrder[] }) {
  if (orders.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-600 text-sm font-mono">
        No fills yet — bot is monitoring price...
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div className="grid grid-cols-[40px_44px_1fr_1fr_56px] md:grid-cols-[60px_60px_80px_80px_80px_80px] gap-1 md:gap-2 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        <span>LVL</span>
        <span>TYPE</span>
        <span className="text-right">PRICE</span>
        <span className="text-right hidden md:block">SHARES</span>
        <span className="text-right hidden md:block">TOTAL</span>
        <span className="text-right">P&amp;L</span>
      </div>
      {orders.slice(0, 20).map((o) => (
        <div
          key={o.id}
          className="grid grid-cols-[32px_52px_1fr_1fr] gap-1 px-3 py-1.5 text-xs font-mono border-b border-zinc-800/50 hover:bg-zinc-800/20"
        >
          <span className="text-zinc-400">{o.level}</span>
          <span className={o.action === "buy" ? "text-[#00e676]" : "text-[#ff1744]"}>
            {o.action.toUpperCase()}
          </span>
          <span className="text-right text-white">${fmt(o.fillPrice)}</span>
          <span className="text-right text-zinc-300">{o.shares.toFixed(4)}</span>
          <span className="text-right text-zinc-300">${fmt(o.total)}</span>
          <span className={`text-right ${pnlColor(o.pnl ?? 0)}`}>
            {o.pnl !== null && o.pnl !== undefined ? `+$${fmt(o.pnl)}` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GridBotPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [activeTab, setActiveTab] = useState<"grid" | "orders">("grid");
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch all bots
  const { data: bots = [] } = useQuery<GridBot[]>({
    queryKey: ["/api/grid/bots"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/grid/bots"); return r.json(); },
    refetchInterval: 3000,
  });

  // Fetch portfolio (for available cash)
  const { data: portfolio } = useQuery<any>({
    queryKey: ["/api/portfolio"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/portfolio"); return r.json(); },
  });

  // Fetch selected bot summary
  const { data: summary, refetch: refetchSummary } = useQuery<GridBotSummary>({
    queryKey: ["/api/grid/bots", selectedBotId],
    queryFn: async () => { const r = await apiRequest("GET", `/api/grid/bots/${selectedBotId}`); return r.json(); },
    enabled: selectedBotId !== null,
    refetchInterval: 2000,
  });

  // Auto-select first bot
  useEffect(() => {
    if (bots.length > 0 && selectedBotId === null) {
      setSelectedBotId(bots[0].id);
    }
  }, [bots]);

  // Tick mutation (advance simulation)
  const tickMutation = useMutation({
    mutationFn: async (id: number) => { const r = await apiRequest("POST", `/api/grid/bots/${id}/tick`); return r.json(); },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/grid/bots"] });
      if (data.order) {
        const o = data.order;
        toast({
          title: `Grid Fill: ${o.action.toUpperCase()} ${o.ticker}`,
          description: `Level ${o.level} · ${o.shares.toFixed(4)} shares @ $${fmt(o.fillPrice)}${o.pnl ? ` · +$${fmt(o.pnl)} profit` : ""}`,
        });
      }
    },
  });

  // Stop mutation
  const stopMutation = useMutation({
    mutationFn: async (id: number) => { const r = await apiRequest("POST", `/api/grid/bots/${id}/stop`); return r.json(); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/grid/bots"] });
      toast({ title: "Grid Bot Stopped", description: "Bot has been deactivated." });
    },
  });

  // Auto-tick when bot is active (every 4s simulate a tick)
  useEffect(() => {
    if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);
    const activeBot = bots.find(b => b.id === selectedBotId && b.status === "active");
    if (activeBot) {
      tickIntervalRef.current = setInterval(() => {
        tickMutation.mutate(activeBot.id);
      }, 4000);
    }
    return () => {
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);
    };
  }, [selectedBotId, bots]);

  const selectedBot = bots.find(b => b.id === selectedBotId);
  const availableCash = portfolio?.cash ?? 100;

  return (
    <div className="flex flex-col bg-[#0d0f12] min-h-screen">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 sticky top-0 z-10 bg-[#0d0f12]">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-[#00bcd4]" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 3L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
          </svg>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight">Grid Trading Bot</h1>
            <p className="text-[11px] text-zinc-500">Buy low · Sell high · Repeat automatically</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Stats summary */}
          {bots.length > 0 && (
            <div className="hidden md:flex gap-4 mr-4">
              <div className="text-center">
                <p className="text-[10px] text-zinc-500 uppercase">Active Bots</p>
                <p className="font-mono text-sm text-[#00bcd4] font-bold">{bots.filter(b => b.status === "active").length}</p>
              </div>
              <div className="text-center">
                <p className="text-[10px] text-zinc-500 uppercase">Total Fills</p>
                <p className="font-mono text-sm text-white font-bold">{bots.reduce((a, b) => a + b.totalGridFills, 0)}</p>
              </div>
              <div className="text-center">
                <p className="text-[10px] text-zinc-500 uppercase">Total P&L</p>
                <p className={`font-mono text-sm font-bold ${pnlColor(bots.reduce((a, b) => a + b.realizedPnl, 0))}`}>
                  ${fmt(bots.reduce((a, b) => a + b.realizedPnl, 0))}
                </p>
              </div>
            </div>
          )}
          <Button
            data-testid="button-new-bot"
            onClick={() => setShowCreate(!showCreate)}
            size="sm"
            className="bg-[#00bcd4] hover:bg-[#00bcd4]/80 text-black font-bold text-xs h-8 px-4 tracking-wide"
          >
            + NEW BOT
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left Sidebar — hidden on mobile when a bot is selected */}
        <div className={`
          border-r border-zinc-800 overflow-y-auto bg-[#0d0f12]
          ${(selectedBotId !== null || showCreate)
            ? "hidden md:flex md:w-72 md:flex-shrink-0 flex-col"
            : "w-full md:w-72 md:flex-shrink-0 flex-col flex"
          }
        `}>
          <div className="p-3 space-y-2">
            {bots.length === 0 && !showCreate && (
              <div className="py-8 text-center">
                <svg viewBox="0 0 24 24" className="w-10 h-10 text-zinc-700 mx-auto mb-3" fill="none" stroke="currentColor" strokeWidth="1">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 3L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
                </svg>
                <p className="text-zinc-500 text-sm">No grid bots yet</p>
                <p className="text-zinc-600 text-xs mt-1">Click "+ New Bot" to get started</p>
              </div>
            )}
            {bots.map(bot => (
              <BotCard
                key={bot.id}
                bot={bot}
                selected={selectedBotId === bot.id}
                onClick={() => { setSelectedBotId(bot.id); setShowCreate(false); }}
              />
            ))}

            {/* Explainer */}
            <div className="mt-4 p-3 bg-[#141720] rounded-lg border border-zinc-800">
              <p className="text-[11px] text-zinc-400 font-semibold mb-2 tracking-wide">HOW IT WORKS</p>
              <div className="space-y-1.5 text-[10px] text-zinc-500">
                <div className="flex gap-2">
                  <span className="text-[#00e676] shrink-0">↓</span>
                  <span>Price hits a grid line → <b className="text-zinc-300">BUY</b></span>
                </div>
                <div className="flex gap-2">
                  <span className="text-[#ff1744] shrink-0">↑</span>
                  <span>Price rises one level → <b className="text-zinc-300">SELL</b> (take profit)</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-[#00bcd4] shrink-0">∞</span>
                  <span>Repeats as price oscillates → compounds gains</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className={`bg-[#0d0f12] overflow-y-auto ${
          (selectedBotId || showCreate) ? "flex-1 w-full" : "hidden md:flex md:flex-1"
        }`}>
          {/* Create Form */}
          {showCreate && (
            <div className="p-6 border-b border-zinc-800">
              <CreateBotForm
                availableCash={availableCash}
                onCreated={() => setShowCreate(false)}
              />
            </div>
          )}

          {/* Bot Detail */}
          {summary && selectedBot && !showCreate && (
            <div className="p-4 md:p-6 space-y-4 md:space-y-5">
              {/* Mobile back button */}
              <button
                onClick={() => setSelectedBotId(null)}
                className="flex md:hidden items-center gap-2 text-[#00bcd4] text-sm font-medium mb-1"
              >
                ← All Bots
              </button>
              {/* Bot Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-xl font-bold font-mono text-white">{summary.bot.ticker}</h2>
                    {statusBadge(summary.bot.status)}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono truncate">
                    ${fmt(summary.bot.lowerPrice)} – ${fmt(summary.bot.upperPrice)} · {summary.bot.gridCount}L · ${fmt((summary.bot.upperPrice - summary.bot.lowerPrice) / summary.bot.gridCount)} step
                  </p>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {summary.bot.status === "active" && (
                    <Button
                      data-testid="button-tick"
                      onClick={() => tickMutation.mutate(summary.bot.id)}
                      disabled={tickMutation.isPending}
                      size="sm"
                      variant="outline"
                      className="text-xs border-zinc-700 text-zinc-300 h-8"
                    >
                      ⚡ Force Tick
                    </Button>
                  )}
                  {summary.bot.status !== "stopped" && (
                    <Button
                      data-testid="button-stop-bot"
                      onClick={() => stopMutation.mutate(summary.bot.id)}
                      disabled={stopMutation.isPending}
                      size="sm"
                      variant="outline"
                      className="text-xs border-red-900/40 text-[#ff1744] hover:bg-red-900/20 h-8"
                    >
                      ■ Stop Bot
                    </Button>
                  )}
                </div>
              </div>

              {/* KPI Row */}
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { label: "Current Price", value: `$${fmt(summary.currentPrice)}`, color: "text-white" },
                  { label: "Realized P&L", value: `${summary.bot.realizedPnl >= 0 ? "+" : ""}$${fmt(summary.bot.realizedPnl)}`, color: pnlColor(summary.bot.realizedPnl) },
                  { label: "Unrealized P&L", value: `${summary.unrealizedPnl >= 0 ? "+" : ""}$${fmt(summary.unrealizedPnl)}`, color: pnlColor(summary.unrealizedPnl) },
                  { label: "Total P&L", value: `${summary.totalPnl >= 0 ? "+" : ""}$${fmt(summary.totalPnl)}`, color: pnlColor(summary.totalPnl) },
                  { label: "Grid Fills", value: `${summary.bot.totalGridFills}`, color: "text-[#00bcd4]" },
                  { label: "Investment", value: `$${fmt(summary.bot.lowerPrice)}`, color: "text-zinc-300" },
                  { label: "Profit/Grid", value: `${fmt(summary.bot.profitPerGrid)}%`, color: "text-[#00e676]" },
                  { label: "Active Level", value: `#${summary.activeLevel}`, color: "text-[#00bcd4]" },
                ].map((kpi) => (
                  <div key={kpi.label} className="bg-[#141720] border border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{kpi.label}</p>
                    <p className={`font-mono text-base font-bold ${kpi.color}`}>{kpi.value}</p>
                  </div>
                ))}
              </div>

              {/* Tabs */}
              <div className="flex gap-1 border-b border-zinc-800 pb-0">
                {(["grid", "orders"] as const).map(tab => (
                  <button
                    key={tab}
                    data-testid={`tab-${tab}`}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors border-b-2 -mb-px ${
                      activeTab === tab
                        ? "border-[#00bcd4] text-[#00bcd4]"
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {tab === "grid" ? "⊞ Grid Levels" : "📋 Order History"}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="bg-[#141720] border border-zinc-800 rounded-xl overflow-hidden">
                {activeTab === "grid" && (
                  <GridVisualizer summary={summary} />
                )}
                {activeTab === "orders" && (
                  <OrderHistory orders={summary.orders} />
                )}
              </div>

              {/* Strategy explanation */}
              <div className="bg-[#141720] border border-zinc-800 rounded-xl p-4">
                <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-3 font-semibold">STRATEGY OVERVIEW</p>
                <div className="flex flex-col gap-3">
                  <div className="bg-[#0d0f12] rounded-lg p-3">
                    <p className="text-[11px] text-zinc-300 font-semibold mb-1">Range Arbitrage</p>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Divides ${fmt(summary.bot.lowerPrice)}–${fmt(summary.bot.upperPrice)} into {summary.bot.gridCount} equal zones.
                      Each oscillation captures {fmt(summary.bot.profitPerGrid)}% profit.
                    </p>
                  </div>
                  <div className="bg-[#0d0f12] rounded-lg p-3">
                    <p className="text-[11px] text-zinc-300 font-semibold mb-1">Auto Execution</p>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Price drops to grid line → BUY. Price rises one level → SELL.
                      No emotion, no guessing — pure systematic execution.
                    </p>
                  </div>
                  <div className="bg-[#0d0f12] rounded-lg p-3">
                    <p className="text-[11px] text-zinc-300 font-semibold mb-1">Compounding</p>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Each round-trip adds {fmt(summary.bot.profitPerGrid)}% realized P&L.
                      High-volatility stocks compound fastest.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Empty state when no bot selected and not creating */}
          {!summary && !showCreate && bots.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full py-32">
              <svg viewBox="0 0 24 24" className="w-16 h-16 text-zinc-700 mb-4" fill="none" stroke="currentColor" strokeWidth="0.75">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 3L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
              </svg>
              <h3 className="text-lg font-bold text-zinc-500 mb-2">No Grid Bots Running</h3>
              <p className="text-zinc-600 text-sm text-center max-w-sm">
                Create a grid bot to start automating buy-low, sell-high across any stock in your universe.
              </p>
              <Button
                onClick={() => setShowCreate(true)}
                className="mt-6 bg-[#00bcd4] hover:bg-[#00bcd4]/80 text-black font-bold text-sm h-10 px-8"
              >
                ⚡ Launch First Grid Bot
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
