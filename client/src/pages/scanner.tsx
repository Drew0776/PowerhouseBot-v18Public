import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ScannerTable, SignalBadge, PctCell, ScoreBar } from "@/components/scanner-table";
import { Link } from "wouter";
import type { PennyStockRow, MomentumRow, SqueezeRow, OptionsFlowRow } from "@shared/schema";

// Safe toFixed helper — never crashes on undefined/null
function sf(n: number | undefined | null, d = 2) {
  if (n == null || isNaN(n as number)) return "—";
  return (n as number).toFixed(d);
}

interface AlpacaStatus {
  connected: boolean;
  reconnecting: boolean;
  stale: boolean;
  consecutiveFailures: number;
  nextRetryInMs: number;
  freshTickers: number;
  trackedTickers: number;
}

function useAlpacaStatus() {
  return useQuery<AlpacaStatus>({ queryKey: ["/api/alpaca/status"], refetchInterval: 5000 });
}

function TickerLink({ ticker, live, stale }: { ticker: string; live?: boolean; stale?: boolean }) {
  return (
    <Link href={`/stock/${ticker}`}>
      <span className="inline-flex items-center gap-1 font-mono font-bold text-[#00bcd4] cursor-pointer hover:underline">
        {live && stale && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0"
            title="Price feed is stale — reconnecting"
          />
        )}
        {live && !stale && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0"
            title="Live Alpaca price"
          />
        )}
        {ticker}
      </span>
    </Link>
  );
}

function FeedStatusBanner({ status }: { status: AlpacaStatus | undefined }) {
  if (!status) return null;
  if (status.connected && !status.stale && !status.reconnecting) return null;

  const reconnecting = status.reconnecting || (!status.connected && status.consecutiveFailures > 0);
  const retrySec = status.nextRetryInMs > 0 ? Math.ceil(status.nextRetryInMs / 1000) : null;

  return (
    <div
      data-testid="feed-status-banner"
      className={`mx-4 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${
        reconnecting
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-zinc-700 bg-zinc-800/50 text-zinc-400"
      }`}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          reconnecting ? "bg-amber-400 animate-pulse" : "bg-zinc-500"
        }`}
      />
      <span className="font-semibold tracking-wide uppercase">
        {reconnecting ? "Reconnecting" : "Stale"}
      </span>
      <span className="text-zinc-400">
        {reconnecting
          ? `Alpaca feed retrying (attempt ${status.consecutiveFailures}${retrySec != null ? `, next in ${retrySec}s` : ""})`
          : `Prices last updated >30s ago — displaying simulated values`}
      </span>
    </div>
  );
}

// ── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  { id: "penny",    label: "100x Hunter" },
  { id: "momentum", label: "Momentum" },
  { id: "squeeze",  label: "Short Squeeze" },
  { id: "options",  label: "Options Flow" },
] as const;

type TabId = typeof TABS[number]["id"];

// ── 100x Hunter (penny) ──────────────────────────────────────────────────────
function PennyTab({ stale }: { stale: boolean }) {
  const { data, isLoading } = useQuery<PennyStockRow[]>({ queryKey: ["/api/scanner/penny"], refetchInterval: 3000 });

  const columns = [
    { key: "rank",     label: "#",        render: (r: PennyStockRow) => <span className="text-zinc-500 font-mono text-[11px]">{r.rank}</span>,                                        sortValue: (r: PennyStockRow) => r.rank,                 mobilePriority: 0 },
    { key: "ticker",   label: "Ticker",   render: (r: PennyStockRow) => <TickerLink ticker={r.ticker} live={r.livePrice} stale={stale} />,                                                           sortValue: (r: PennyStockRow) => r.ticker,               mobilePriority: 1 },
    { key: "price",    label: "Price",    render: (r: PennyStockRow) => <span className="font-mono tabular-nums">${sf(r.price)}</span>,                                                sortValue: (r: PennyStockRow) => r.price ?? 0,           mobilePriority: 2 },
    { key: "day",      label: "Day %",    render: (r: PennyStockRow) => <PctCell value={r.dayChangePercent} />,                                                                        sortValue: (r: PennyStockRow) => r.dayChangePercent ?? 0, mobilePriority: 3 },
    { key: "week",     label: "Wk %",     render: (r: PennyStockRow) => <PctCell value={r.weekChangePercent} />,                                                                       sortValue: (r: PennyStockRow) => r.weekChangePercent ?? 0, mobilePriority: 5 },
    { key: "month",    label: "Mo %",     render: (r: PennyStockRow) => <PctCell value={r.monthChangePercent} />,                                                                      sortValue: (r: PennyStockRow) => r.monthChangePercent ?? 0 },
    { key: "float",    label: "Float M",  render: (r: PennyStockRow) => <span className="font-mono tabular-nums text-zinc-400">{sf(r.floatShares, 0)}</span>,                          sortValue: (r: PennyStockRow) => r.floatShares ?? 999 },
    { key: "si",       label: "SI %",     render: (r: PennyStockRow) => <span className="font-mono tabular-nums" style={{ color: (r.shortInterestPct ?? 0) > 15 ? "#ff1744" : "#ffd740" }}>{sf(r.shortInterestPct)}%</span>, sortValue: (r: PennyStockRow) => r.shortInterestPct ?? 0 },
    { key: "vol",      label: "VolSpike", render: (r: PennyStockRow) => <span className="font-mono tabular-nums" style={{ color: (r.volumeSpikeRatio ?? 0) > 2 ? "#00e676" : "inherit" }}>{sf(r.volumeSpikeRatio, 1)}x</span>, sortValue: (r: PennyStockRow) => r.volumeSpikeRatio ?? 0, mobilePriority: 4 },
    { key: "catalyst", label: "Catalyst", render: (r: PennyStockRow) => <ScoreBar value={r.catalystScore} />,                                                                          sortValue: (r: PennyStockRow) => r.catalystScore ?? 0 },
    { key: "score",    label: "Score",    render: (r: PennyStockRow) => <ScoreBar value={r.compositeScore} />,                                                                         sortValue: (r: PennyStockRow) => r.compositeScore ?? 0,  mobilePriority: 5 },
    { key: "signal",   label: "Signal",   render: (r: PennyStockRow) => <SignalBadge signal={r.signal ?? "HOLD"} />,                                                                   sortValue: (r: PennyStockRow) => r.signal === "BUY" ? 3 : r.signal === "HOLD" ? 2 : 1 },
  ];

  return <ScannerTable data={data ?? []} columns={columns} getPrice={r => r.price ?? 0} getTicker={r => r.ticker} isLoading={isLoading} />;
}

// ── Momentum ──────────────────────────────────────────────────────────────────
function MomentumTab({ stale }: { stale: boolean }) {
  const { data, isLoading } = useQuery<MomentumRow[]>({ queryKey: ["/api/scanner/momentum"], refetchInterval: 3000 });

  const columns = [
    { key: "rank",   label: "#",       render: (r: MomentumRow) => <span className="text-zinc-500 font-mono text-[11px]">{r.rank}</span>,                                   sortValue: (r: MomentumRow) => r.rank,                  mobilePriority: 0 },
    { key: "ticker", label: "Ticker",  render: (r: MomentumRow) => <TickerLink ticker={r.ticker} live={r.livePrice} stale={stale} />,                                                      sortValue: (r: MomentumRow) => r.ticker,                mobilePriority: 1 },
    { key: "price",  label: "Price",   render: (r: MomentumRow) => <span className="font-mono tabular-nums">${sf(r.price)}</span>,                                            sortValue: (r: MomentumRow) => r.price ?? 0,            mobilePriority: 2 },
    { key: "day",    label: "Day %",   render: (r: MomentumRow) => <PctCell value={r.dayChangePercent} />,                                                                    sortValue: (r: MomentumRow) => r.dayChangePercent ?? 0, mobilePriority: 3 },
    { key: "rsi",    label: "RSI",     render: (r: MomentumRow) => <span className="font-mono tabular-nums" style={{ color: (r.rsi ?? 50) > 70 ? "#ff1744" : (r.rsi ?? 50) < 30 ? "#00e676" : "#e0e0e0" }}>{sf(r.rsi, 0)}</span>, sortValue: (r: MomentumRow) => r.rsi ?? 50, mobilePriority: 4 },
    { key: "macd",   label: "MACD",    render: (r: MomentumRow) => { const v = r.macdSignal ?? 0; return <span className="font-mono text-[10px]" style={{ color: v > 0 ? "#00e676" : v < 0 ? "#ff1744" : "#ffd740" }}>{v > 0 ? "Bull" : v < 0 ? "Bear" : "Neu"}</span>; }, sortValue: (r: MomentumRow) => r.macdSignal ?? 0 },
    { key: "boll",   label: "BB%",     render: (r: MomentumRow) => <span className="font-mono tabular-nums text-[11px]">{sf(r.bollingerPosition, 0)}%</span>,                 sortValue: (r: MomentumRow) => r.bollingerPosition ?? 0 },
    { key: "vol",    label: "Vol",     render: (r: MomentumRow) => <span className="font-mono tabular-nums" style={{ color: (r.volumeSpikeRatio ?? 0) > 2 ? "#00e676" : "inherit" }}>{sf(r.volumeSpikeRatio, 1)}x</span>, sortValue: (r: MomentumRow) => r.volumeSpikeRatio ?? 0 },
    { key: "ma20",   label: "20MA",    render: (r: MomentumRow) => <span className="text-[9px] font-bold" style={{ color: r.ma20Cross === "Above" ? "#00e676" : "#ff5252" }}>{r.ma20Cross === "Above" ? "↑" : "↓"}</span>, sortValue: (r: MomentumRow) => r.ma20Cross === "Above" ? 1 : 0 },
    { key: "ma50",   label: "50MA",    render: (r: MomentumRow) => <span className="text-[9px] font-bold" style={{ color: r.ma50Cross === "Above" ? "#00e676" : "#ff5252" }}>{r.ma50Cross === "Above" ? "↑" : "↓"}</span>, sortValue: (r: MomentumRow) => r.ma50Cross === "Above" ? 1 : 0 },
    { key: "score",  label: "Breakout",render: (r: MomentumRow) => <ScoreBar value={r.breakoutScore} />,                                                                      sortValue: (r: MomentumRow) => r.breakoutScore ?? 0,    mobilePriority: 5 },
    { key: "signal", label: "Signal",  render: (r: MomentumRow) => <SignalBadge signal={r.signal ?? "HOLD"} />,                                                               sortValue: (r: MomentumRow) => r.signal === "BUY" ? 3 : 2 },
  ];

  return <ScannerTable data={data ?? []} columns={columns} getPrice={r => r.price ?? 0} getTicker={r => r.ticker} isLoading={isLoading} />;
}

// ── Short Squeeze ─────────────────────────────────────────────────────────────
function SqueezeTab({ stale }: { stale: boolean }) {
  const { data, isLoading } = useQuery<SqueezeRow[]>({ queryKey: ["/api/scanner/squeeze"], refetchInterval: 3000 });

  const columns = [
    { key: "rank",   label: "#",        render: (r: SqueezeRow) => <span className="text-zinc-500 font-mono text-[11px]">{r.rank}</span>,                                     sortValue: (r: SqueezeRow) => r.rank,                  mobilePriority: 0 },
    { key: "ticker", label: "Ticker",   render: (r: SqueezeRow) => <TickerLink ticker={r.ticker} live={r.livePrice} stale={stale} />,                                                        sortValue: (r: SqueezeRow) => r.ticker,                mobilePriority: 1 },
    { key: "price",  label: "Price",    render: (r: SqueezeRow) => <span className="font-mono tabular-nums">${sf(r.price)}</span>,                                              sortValue: (r: SqueezeRow) => r.price ?? 0,            mobilePriority: 2 },
    { key: "si",     label: "SI %",     render: (r: SqueezeRow) => <span className="font-mono tabular-nums font-bold" style={{ color: (r.shortInterestPct ?? 0) > 20 ? "#ff1744" : "#ffd740" }}>{sf(r.shortInterestPct)}%</span>, sortValue: (r: SqueezeRow) => r.shortInterestPct ?? 0, mobilePriority: 3 },
    { key: "dtc",    label: "DTC",      render: (r: SqueezeRow) => <span className="font-mono tabular-nums" style={{ color: (r.daysToCover ?? 0) > 5 ? "#ff1744" : "#ffd740" }}>{sf(r.daysToCover, 1)}d</span>, sortValue: (r: SqueezeRow) => r.daysToCover ?? 0, mobilePriority: 4 },
    { key: "ctb",    label: "CTB %",    render: (r: SqueezeRow) => <span className="font-mono tabular-nums text-[#ffd740]">{sf(r.costToBorrow, 1)}%</span>,                    sortValue: (r: SqueezeRow) => r.costToBorrow ?? 0 },
    { key: "float",  label: "Float M",  render: (r: SqueezeRow) => <span className="font-mono tabular-nums text-zinc-400">{sf(r.floatShares, 0)}</span>,                       sortValue: (r: SqueezeRow) => r.floatShares ?? 999 },
    { key: "vol",    label: "VolSpike", render: (r: SqueezeRow) => <span className="font-mono tabular-nums" style={{ color: (r.volumeSpikeRatio ?? 0) > 2 ? "#00e676" : "inherit" }}>{sf(r.volumeSpikeRatio, 1)}x</span>, sortValue: (r: SqueezeRow) => r.volumeSpikeRatio ?? 0 },
    { key: "score",  label: "Squeeze",  render: (r: SqueezeRow) => <ScoreBar value={r.squeezeScore} />,                                                                        sortValue: (r: SqueezeRow) => r.squeezeScore ?? 0,     mobilePriority: 5 },
    { key: "signal", label: "Signal",   render: (r: SqueezeRow) => <SignalBadge signal={r.signal ?? "HOLD"} />,                                                                sortValue: (r: SqueezeRow) => r.signal === "BUY" ? 3 : 2 },
  ];

  return <ScannerTable data={data ?? []} columns={columns} getPrice={r => r.price ?? 0} getTicker={r => r.ticker} isLoading={isLoading} />;
}

// ── Options Flow ──────────────────────────────────────────────────────────────
function OptionsTab() {
  const { data, isLoading } = useQuery<OptionsFlowRow[]>({ queryKey: ["/api/scanner/options"] });

  const columns = [

    { key: "rank",    label: "#",         render: (r: OptionsFlowRow) => <span className="text-zinc-500 font-mono text-[11px]">{r.rank}</span>,                                 sortValue: (r: OptionsFlowRow) => r.rank,                mobilePriority: 0 },
    { key: "ticker",  label: "Ticker",    render: (r: OptionsFlowRow) => <TickerLink ticker={r.ticker} />,                                                                       sortValue: (r: OptionsFlowRow) => r.ticker,              mobilePriority: 1 },
    { key: "price",   label: "Price",     render: (r: OptionsFlowRow) => <span className="font-mono tabular-nums">${sf(r.price)}</span>,                                          sortValue: (r: OptionsFlowRow) => r.price ?? 0,          mobilePriority: 2 },
    { key: "type",    label: "C/P",       render: (r: OptionsFlowRow) => <span className="font-mono font-bold text-[10px]" style={{ color: r.contractType === "Call" ? "#00e676" : "#ff1744" }}>{r.contractType === "Call" ? "CALL" : "PUT"}</span>, sortValue: (r: OptionsFlowRow) => r.contractType, mobilePriority: 3 },
    { key: "strike",  label: "Strike",    render: (r: OptionsFlowRow) => <span className="font-mono tabular-nums">${sf(r.strike)}</span>,                                         sortValue: (r: OptionsFlowRow) => r.strike ?? 0,         mobilePriority: 4 },
    { key: "expiry",  label: "Exp",       render: (r: OptionsFlowRow) => <span className="text-zinc-400 text-[10px] font-mono">{r.expiry ?? "—"}</span>,                          sortValue: (r: OptionsFlowRow) => r.expiry ?? "" },
    { key: "premium", label: "Prem",      render: (r: OptionsFlowRow) => <span className="font-mono tabular-nums text-[#ffd740]">${sf(r.premium)}</span>,                        sortValue: (r: OptionsFlowRow) => r.premium ?? 0 },
    { key: "voloi",   label: "Vol/OI",    render: (r: OptionsFlowRow) => <span className="font-mono tabular-nums" style={{ color: (r.volumeVsOI ?? 0) > 3 ? "#00e676" : "inherit" }}>{sf(r.volumeVsOI, 1)}x</span>, sortValue: (r: OptionsFlowRow) => r.volumeVsOI ?? 0 },
    { key: "sent",    label: "Sent",      render: (r: OptionsFlowRow) => <span className="text-[9px] font-bold" style={{ color: r.sentiment === "Bullish" ? "#00e676" : "#ff1744" }}>{r.sentiment === "Bullish" ? "Bull" : "Bear"}</span>, sortValue: (r: OptionsFlowRow) => r.sentiment === "Bullish" ? 1 : 0 },
    { key: "score",   label: "Flow",      render: (r: OptionsFlowRow) => <ScoreBar value={r.flowScore} />,                                                                       sortValue: (r: OptionsFlowRow) => r.flowScore ?? 0,      mobilePriority: 5 },
    { key: "signal",  label: "Signal",    render: (r: OptionsFlowRow) => <SignalBadge signal={r.signal ?? "HOLD"} />,                                                            sortValue: (r: OptionsFlowRow) => r.signal === "BUY" ? 3 : 2 },
  ];

  return (
    <>
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-0.5">
          ⚠ Simulated data — not live options flow
        </span>
      </div>
      <ScannerTable data={data ?? []} columns={columns} getPrice={r => r.price ?? 0} getTicker={r => r.ticker} isLoading={isLoading} />
    </>
  );
}

// ── Main Scanner page ─────────────────────────────────────────────────────────
export default function Scanner() {
  const [activeTab, setActiveTab] = useState<TabId>("penny");
  const { data: universeData } = useQuery<{ count: number }>({ queryKey: ["/api/universe/count"], staleTime: 60_000 });
  const universeCount = universeData?.count ?? "—";
  const { data: status } = useAlpacaStatus();
  const feedStale = !!(status && (status.stale || status.reconnecting));

  return (
    <div className="flex flex-col bg-[#0d0f12] min-h-screen">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white tracking-tight">Scanner</h1>
        <p className="text-[11px] text-zinc-500 mt-0.5">{universeCount} markets · 4 strategies · real-time signals</p>
      </div>

      {/* Tabs — horizontally scrollable, no clip */}
      <div className="px-4 mb-3">
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none" style={{ WebkitOverflowScrolling: "touch" }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? "bg-[#00bcd4]/15 text-[#00bcd4] border border-[#00bcd4]/30"
                  : "bg-[#141720] text-zinc-400 border border-zinc-800 hover:text-white hover:border-zinc-600"
              }`}
            >
              {tab.id === "penny"    && "🎯 "}
              {tab.id === "momentum" && "⚡ "}
              {tab.id === "squeeze"  && "🔥 "}
              {tab.id === "options"  && "📊 "}
              {tab.label}
              {tab.id === "options" && (
                <span className="ml-1.5 text-[8px] font-mono font-bold px-1 py-0.5 rounded bg-amber-400/15 text-amber-400/80 border border-amber-400/20 tracking-wide">
                  SIM
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Feed health banner — only renders when reconnecting or stale */}
      <FeedStatusBanner status={status} />

      {/* Tab content */}
      <div className="px-4 pb-4">
        {activeTab === "penny"    && <PennyTab stale={feedStale} />}
        {activeTab === "momentum" && <MomentumTab stale={feedStale} />}
        {activeTab === "squeeze"  && <SqueezeTab stale={feedStale} />}
        {activeTab === "options"  && <OptionsTab />}
      </div>
    </div>
  );
}
