import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import type { InstrumentDetail } from "@shared/schema";
import { formatPrice } from "@shared/price";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import TradeDialog from "@/components/trade-dialog";
import { ArrowLeft } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

/**
 * One instrument, as the bot sees it: the prices it has sampled, the
 * indicators it trades on, and where it ranks. It shows nothing the app has
 * no source for. (This page used to show a made-up 30-day chart, analyst
 * ratings and actions credited to real banks, invented news, short interest,
 * insider activity and an earnings date.)
 */

const panel = { backgroundColor: "hsl(220 18% 7%)" };

function Row({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-border/30" title={hint}>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono tabular-nums" style={{ color: color || "inherit" }}>{value}</span>
    </div>
  );
}

export default function StockDetail() {
  const params = useParams<{ ticker: string }>();
  const ticker = params.ticker?.toUpperCase() || "";
  const [tradeOpen, setTradeOpen] = useState(false);

  const { data: d, isLoading } = useQuery<InstrumentDetail>({
    queryKey: [`/api/signals/${ticker}`],
    enabled: !!ticker,
    refetchInterval: 4000,
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-[480px]" /></div>;
  if (!d) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Stock not found</p>
        <Link href="/"><Button variant="secondary" className="mt-4">Back to Dashboard</Button></Link>
      </div>
    );
  }

  const chart = d.history.map((price, i) => ({ i: i - d.history.length + 1, price }));
  const ind = d.indicators;
  const up = (d.changePct ?? 0) >= 0;

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm" className="h-7 px-2"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold font-mono text-[#00bcd4]">{d.ticker}</h1>
          <span className="text-sm text-muted-foreground">{d.name}</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 uppercase">{d.marketType}</span>
        {d.grade && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#00e676]/15 text-[#00e676]" title="Grade by the engine's rank">
            {d.grade} · #{d.rank}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="text-xl font-mono tabular-nums font-semibold">
              ${formatPrice(d.price)}
              <span className={`ml-2 align-middle text-[9px] font-mono px-1 rounded ${d.livePrice ? "bg-[#00e676]/10 text-[#00e676]" : "bg-zinc-800 text-zinc-400"}`}>
                {d.livePrice ? "LIVE" : "SIM"}
              </span>
            </div>
            {d.changePct != null && (
              <div className={`text-sm font-mono tabular-nums ${up ? "text-[#00e676]" : "text-[#ff1744]"}`}>
                {up ? "+" : ""}{d.changePct.toFixed(2)}% <span className="text-muted-foreground text-xs">over the sampled window</span>
              </div>
            )}
          </div>
          <Button onClick={() => setTradeOpen(true)} className="h-9" data-testid="trade-btn">Trade</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Price history the engine has sampled */}
        <div className="lg:col-span-2 rounded-lg border border-border p-4" style={panel}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">
            Sampled prices · one per engine tick (2 s)
          </h3>
          {chart.length < 2 ? (
            <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground text-center px-6">
              No price history yet. The auto-trader samples every instrument once per tick while it runs.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chart} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 13%)" />
                <XAxis dataKey="i" tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false}
                  tickFormatter={v => (v === 0 ? "now" : `${v * 2}s`)} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false}
                  tickFormatter={v => `$${formatPrice(v)}`} domain={["dataMin", "dataMax"]} width={70} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(220 18% 9%)", border: "1px solid hsl(220 15% 15%)", borderRadius: 6, fontSize: 11 }}
                  formatter={(v: number) => [`$${formatPrice(v, 4)}`, "price"]}
                  labelFormatter={v => (v === 0 ? "latest" : `${Number(v) * -2}s ago`)}
                />
                <Line type="monotone" dataKey="price" stroke="#00e676" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* What the engine scores it on */}
        <div className="rounded-lg border border-border p-4" style={panel}>
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Engine view</h3>
          {ind ? (
            <>
              <Row label="Composite score" value={d.score != null ? d.score.toFixed(1) : "rejected by a gate"} color={d.score != null ? "#00e676" : "#9e9e9e"} />
              <Row label="Rank" value={d.rank != null ? `#${d.rank}` : "—"} />
              <Row label="RSI (14)" value={ind.rsi.toFixed(1)} color={ind.rsi > 70 ? "#ff9800" : ind.rsi < 30 ? "#00bcd4" : undefined} />
              <Row label="Bollinger %B (20, 2)" value={ind.pctB.toFixed(2)} />
              <Row label="EMA 9 vs 21" value={ind.emaFast > ind.emaSlow ? "above" : "below"} color={ind.emaFast > ind.emaSlow ? "#00e676" : "#ff1744"} />
              <Row label="MACD histogram" value={ind.macdHist == null ? "needs 34 samples" : ind.macdHist > 0 ? "positive" : "negative"}
                color={ind.macdHist == null ? "#9e9e9e" : ind.macdHist > 0 ? "#00e676" : "#ff1744"} />
              <Row label="5-tick momentum" value={ind.momZ == null ? "—" : `${ind.momZ >= 0 ? "+" : ""}${ind.momZ.toFixed(2)}σ`} />
              <Row label="Volatility per tick" value={`${(ind.sigma * 100).toFixed(3)}%`} />
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Not scored yet: the indicators need 21 evenly spaced samples (about 40 seconds of the auto-trader running).
            </p>
          )}
          <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">
            These are the only inputs the auto-trader uses. It has no news, analyst or fundamentals feed.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 max-w-xl" style={panel}>
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Reference</h3>
        <Row label="Sector" value={d.sector} />
        {d.exchange && <Row label="Exchange" value={d.exchange} />}
        {d.reference.marketCapBillions != null && (
          <Row label="Market cap" value={`~$${d.reference.marketCapBillions.toLocaleString("en-US")}B`} hint="Static reference value bundled with the app, not live" />
        )}
        {d.reference.beta != null && (
          <Row label="Beta" value={d.reference.beta.toFixed(2)} hint="Static reference value bundled with the app, not live" />
        )}
        <p className="text-[10px] text-muted-foreground mt-2">Static values bundled with the app, not live data.</p>
      </div>

      <TradeDialog open={tradeOpen} onOpenChange={setTradeOpen} ticker={d.ticker} price={d.price} />
    </div>
  );
}
