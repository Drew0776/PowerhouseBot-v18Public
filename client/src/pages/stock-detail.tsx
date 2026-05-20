import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import type { StockData } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import TradeDialog from "@/components/trade-dialog";
import { ArrowLeft, TrendingUp, TrendingDown } from "lucide-react";
import { Link } from "wouter";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Bar, ComposedChart, RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, BarChart, ReferenceLine,
} from "recharts";

function CategoryBadge({ category }: { category: string }) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    "ai-tech": { label: "AI & Tech", color: "#00bcd4", bg: "rgba(0,188,212,0.15)" },
    "penny": { label: "Penny Stock", color: "#ffd740", bg: "rgba(255,215,64,0.15)" },
    "momentum": { label: "Momentum", color: "#7c4dff", bg: "rgba(124,77,255,0.15)" },
  };
  const m = map[category] || map["ai-tech"];
  return <span className="px-2 py-0.5 rounded text-[10px] font-semibold" style={{ color: m.color, backgroundColor: m.bg }}>{m.label}</span>;
}

function SignalBadge({ signal }: { signal: string }) {
  const color = signal === "BUY" ? "#00e676" : signal === "SELL" ? "#ff1744" : "#ffd740";
  const bg = signal === "BUY" ? "rgba(0,230,118,0.15)" : signal === "SELL" ? "rgba(255,23,68,0.15)" : "rgba(255,215,64,0.15)";
  return <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ color, backgroundColor: bg }}>{signal}</span>;
}

export default function StockDetail() {
  const params = useParams<{ ticker: string }>();
  const ticker = params.ticker?.toUpperCase() || "";
  const [tradeOpen, setTradeOpen] = useState(false);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA50, setShowMA50] = useState(true);
  const [showBB, setShowBB] = useState(false);

  const { data: stock, isLoading } = useQuery<StockData>({
    queryKey: ["/api/signals", ticker],
  });

  if (isLoading) {
    return <div className="p-6"><Skeleton className="h-[600px]" /></div>;
  }

  if (!stock) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Stock not found</p>
        <Link href="/"><Button variant="secondary" className="mt-4">Back to Dashboard</Button></Link>
      </div>
    );
  }

  const chartData = stock.history.map(c => ({
    date: c.date.slice(5),
    price: c.close,
    volume: c.volume,
    ma20: c.ma20,
    ma50: c.ma50,
    bbUpper: c.bollingerUpper,
    bbLower: c.bollingerLower,
  }));

  const radarData = [
    { metric: "Momentum", value: stock.momentumScore },
    { metric: "Volume", value: stock.volumeScore },
    { metric: "Sentiment", value: stock.sentimentScore },
    { metric: "Short Int.", value: Math.min(100, stock.shortInterestPct * 4) },
    { metric: "Technical", value: stock.rsi },
    { metric: "Catalyst", value: stock.catalystScore },
  ];

  const analystData = [
    { label: "Buy", count: stock.analystRatings.buy, color: "#00e676" },
    { label: "Hold", count: stock.analystRatings.hold, color: "#ffd740" },
    { label: "Sell", count: stock.analystRatings.sell, color: "#ff1744" },
  ];

  const pctChange = stock.dayChangePercent;

  const formatMarketCap = (v: number) => {
    if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toFixed(0)}`;
  };

  const metrics = [
    { label: "Market Cap", value: formatMarketCap(stock.marketCap) },
    { label: "Float", value: `${(stock.floatShares ?? 0).toFixed(0)}M` },
    { label: "Short Interest", value: `${stock.shortInterestPct.toFixed(1)}%`, color: stock.shortInterestPct > 15 ? "#ff1744" : undefined },
    { label: "Days to Cover", value: (stock.daysToCover ?? 0).toFixed(1) },
    { label: "RSI (14)", value: `${stock.rsi}`, color: stock.rsi > 70 ? "#ff1744" : stock.rsi < 30 ? "#00e676" : undefined },
    { label: "MACD", value: stock.macdSignal > 0 ? "Bullish" : stock.macdSignal < 0 ? "Bearish" : "Neutral", color: stock.macdSignal > 0 ? "#00e676" : stock.macdSignal < 0 ? "#ff1744" : "#ffd740" },
    { label: "Avg Volume", value: `${((stock.avgVolume ?? 0) / 1e6).toFixed(1)}M` },
    { label: "Volume Ratio", value: `${stock.volumeSpikeRatio.toFixed(1)}x`, color: stock.volumeSpikeRatio > 2 ? "#00e676" : undefined },
    { label: "20d MA", value: `$${(stock.ma20 ?? 0).toFixed(2)}`, color: stock.price > stock.ma20 ? "#00e676" : "#ff1744" },
    { label: "50d MA", value: `$${(stock.ma50 ?? 0).toFixed(2)}`, color: stock.price > stock.ma50 ? "#00e676" : "#ff1744" },
    { label: "Beta", value: (stock.beta ?? 0).toFixed(2) },
    { label: "Inst. Ownership", value: `${stock.institutionalOwnershipPct}%` },
    { label: "Insider Activity", value: Number(stock.insiderActivity) > 0 ? "Net Buying" : Number(stock.insiderActivity) < 0 ? "Net Selling" : "Neutral", color: Number(stock.insiderActivity) > 0 ? "#00e676" : Number(stock.insiderActivity) < 0 ? "#ff1744" : "#ffd740" },
    { label: "Sector", value: stock.sector },
    { label: "Next Earnings", value: stock.nextEarnings },
    { label: "52W Range", value: `$${(stock.fiftyTwoWeekLow ?? 0).toFixed(2)} – $${(stock.fiftyTwoWeekHigh ?? 0).toFixed(2)}` },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm" className="h-7 px-2"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold font-mono text-[#00bcd4]">{stock.ticker}</h1>
          <span className="text-sm text-muted-foreground">{stock.name}</span>
        </div>
        <CategoryBadge category={stock.category} />
        <SignalBadge signal={stock.signal} />
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="text-xl font-mono tabular-nums font-semibold">${(stock.price ?? 0).toFixed(2)}</div>
            <div className={`text-sm font-mono tabular-nums ${pctChange >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>
              {pctChange >= 0 ? "+" : ""}{(stock.dayChange ?? 0).toFixed(2)} ({pctChange >= 0 ? "+" : ""}{(pctChange ?? 0).toFixed(2)}%)
            </div>
          </div>
          <Button onClick={() => setTradeOpen(true)} className="h-9" data-testid="trade-btn">Trade</Button>
        </div>
      </div>

      {/* Row 1: Chart + Radar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Technical Chart */}
        <div className="lg:col-span-2 rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium">30-Day Chart</h3>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Switch checked={showMA20} onCheckedChange={setShowMA20} className="h-4 w-7" />
                <Label className="text-[10px] text-muted-foreground">20d MA</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch checked={showMA50} onCheckedChange={setShowMA50} className="h-4 w-7" />
                <Label className="text-[10px] text-muted-foreground">50d MA</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch checked={showBB} onCheckedChange={setShowBB} className="h-4 w-7" />
                <Label className="text-[10px] text-muted-foreground">BB</Label>
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 13%)" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="price" tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} domain={["dataMin * 0.97", "dataMax * 1.03"]} />
              <YAxis yAxisId="vol" orientation="right" tick={false} axisLine={false} tickLine={false} domain={[0, "dataMax * 4"]} />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(220 18% 9%)", border: "1px solid hsl(220 15% 15%)", borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: "hsl(210 10% 55%)", fontSize: 10 }}
              />
              <Bar yAxisId="vol" dataKey="volume" fill="hsl(220 15% 15%)" radius={[1, 1, 0, 0]} />
              {showBB && (
                <Area yAxisId="price" dataKey="bbUpper" stroke="none" fill="rgba(0,188,212,0.08)" />
              )}
              {showBB && (
                <Area yAxisId="price" dataKey="bbLower" stroke="none" fill="rgba(0,188,212,0.08)" />
              )}
              {showMA20 && <Line yAxisId="price" type="monotone" dataKey="ma20" stroke="#ffd740" strokeWidth={1} dot={false} strokeDasharray="3 3" />}
              {showMA50 && <Line yAxisId="price" type="monotone" dataKey="ma50" stroke="#7c4dff" strokeWidth={1} dot={false} strokeDasharray="5 5" />}
              <Line yAxisId="price" type="monotone" dataKey="price" stroke="#00e676" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Radar Chart */}
        <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Signal Radar</h3>
          <ResponsiveContainer width="100%" height={230}>
            <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
              <PolarGrid stroke="hsl(220 15% 15%)" />
              <PolarAngleAxis dataKey="metric" tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} />
              <PolarRadiusAxis tick={false} domain={[0, 100]} />
              <Radar dataKey="value" stroke="#00bcd4" fill="#00bcd4" fillOpacity={0.2} strokeWidth={2} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row 2: Metrics Grid + Sentiment + Analyst */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Key Metrics */}
        <div className="lg:col-span-2 rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">Key Metrics</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2">
            {metrics.map(m => (
              <div key={m.label} className="flex justify-between py-1.5 border-b border-border/30">
                <span className="text-[10px] text-muted-foreground">{m.label}</span>
                <span className="text-[11px] font-mono tabular-nums" style={{ color: m.color || "inherit" }}>{m.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sentiment + Analyst */}
        <div className="space-y-4">
          {/* Sentiment */}
          <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
            <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Sentiment</h3>
            <div className="space-y-2">
              <div>
                <span className="text-[10px] font-semibold text-[#00e676]">Bull Case</span>
                <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{stock.sentimentSummary.bull}</p>
              </div>
              <div>
                <span className="text-[10px] font-semibold text-[#ff1744]">Bear Case</span>
                <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{stock.sentimentSummary.bear}</p>
              </div>
            </div>
          </div>

          {/* Analyst Consensus */}
          <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
            <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Analyst Consensus</h3>
            <div className="space-y-1.5">
              {analystData.map(a => (
                <div key={a.label} className="flex items-center gap-2">
                  <span className="text-[10px] w-7" style={{ color: a.color }}>{a.label}</span>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${(a.count / 14) * 100}%`, backgroundColor: a.color }} />
                  </div>
                  <span className="text-[10px] font-mono w-4 text-right">{a.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Row 3: Catalyst Timeline + Analyst Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Catalyst Timeline */}
        <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">Recent Catalysts</h3>
          <div className="space-y-0">
            {stock.catalystTimeline.map((ev, i) => {
              const dotColor = ev.impact === "positive" ? "#00e676" : ev.impact === "negative" ? "#ff1744" : "#ffd740";
              return (
                <div key={i} className="flex gap-3 py-2 border-b border-border/30 last:border-0">
                  <div className="flex flex-col items-center pt-0.5">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                    {i < stock.catalystTimeline.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground font-mono">{ev.date}</span>
                      <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-accent text-muted-foreground">{ev.type}</span>
                    </div>
                    <p className="text-[11px] text-foreground mt-0.5">{ev.title}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Analyst Actions */}
        <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">Analyst Actions</h3>
          <div className="space-y-0">
            {stock.analystActions.slice(0, 6).map((a, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0">
                <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-16">{a.date}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-foreground">{a.firm}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">{a.action}</span>
                    <span className="text-[10px] font-semibold" style={{ color: a.rating.includes("Over") || a.rating === "Buy" ? "#00e676" : a.rating.includes("Under") ? "#ff1744" : "#ffd740" }}>
                      {a.rating}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">PT ${a.priceTarget}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <TradeDialog open={tradeOpen} onOpenChange={setTradeOpen} ticker={stock.ticker} price={stock.price} />
    </div>
  );
}
