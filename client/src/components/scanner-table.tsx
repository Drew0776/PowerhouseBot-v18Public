import { useState, useMemo } from "react";
import { Link } from "wouter";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import TradeDialog from "@/components/trade-dialog";

type SortDir = "asc" | "desc";

// ── Safe number formatter ──────────────────────────────────────────────────
function safeFmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || isNaN(n as number)) return "—";
  return (n as number).toFixed(decimals);
}

export function SignalBadge({ signal }: { signal: string }) {
  const color = signal === "BUY" ? "#00e676" : signal === "SELL" ? "#ff1744" : "#ffd740";
  const bg = signal === "BUY" ? "rgba(0,230,118,0.12)" : signal === "SELL" ? "rgba(255,23,68,0.12)" : "rgba(255,215,64,0.12)";
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wide" style={{ color, backgroundColor: bg, border: `1px solid ${color}30` }}>
      {signal}
    </span>
  );
}

export function PctCell({ value }: { value: number | undefined | null }) {
  if (value == null || isNaN(value)) return <span className="font-mono text-zinc-500">—</span>;
  const color = value >= 0 ? "#00e676" : "#ff1744";
  return <span className="font-mono tabular-nums text-[11px]" style={{ color }}>{value >= 0 ? "+" : ""}{value.toFixed(2)}%</span>;
}

export function ScoreBar({ value, max = 100 }: { value: number | undefined | null; max?: number }) {
  const v = value ?? 0;
  const pct = Math.min(100, (v / max) * 100);
  const color = pct >= 65 ? "#00e676" : pct >= 40 ? "#ffd740" : "#ff5252";
  return (
    <div className="flex items-center gap-1.5 min-w-[56px]">
      <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono tabular-nums text-[11px] text-white w-5 text-right">{v}</span>
    </div>
  );
}

interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => number | string;
  className?: string;
  mobileHide?: boolean;
  mobilePriority?: number;
}

interface ScannerTableProps<T> {
  data: T[];
  columns: Column<T>[];
  getPrice: (row: T) => number;
  getTicker: (row: T) => string;
  isLoading?: boolean;
}

function safeRender<T>(col: Column<T>, row: T): React.ReactNode {
  try { return col.render(row); } catch { return <span className="text-zinc-600">—</span>; }
}

export function ScannerTable<T>({ data, columns, getPrice, getTicker, isLoading }: ScannerTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchTerm, setSearchTerm] = useState("");
  const [priceMax, setPriceMax] = useState(1000);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [tradeTicker, setTradeTicker] = useState("");
  const [tradePrice, setTradePrice] = useState(0);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const safeData = useMemo(() => (data || []).filter(d => {
    try { return getPrice(d) != null; } catch { return false; }
  }), [data, getPrice]);

  const filtered = useMemo(() => {
    let result = safeData;
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      result = result.filter(d => getTicker(d).toLowerCase().includes(t));
    }
    result = result.filter(d => (getPrice(d) ?? 0) <= priceMax);
    return result;
  }, [safeData, searchTerm, priceMax, getPrice, getTicker]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find(c => c.key === sortKey);
    if (!col?.sortValue) return filtered;
    return [...filtered].sort((a, b) => {
      const aVal = col.sortValue!(a);
      const bVal = col.sortValue!(b);
      if (typeof aVal === "number" && typeof bVal === "number")
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      return sortDir === "asc"
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [filtered, sortKey, sortDir, columns]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const visibleCols = columns.filter(c => !c.mobileHide);

  // Columns sorted by mobilePriority for card layout
  const mobileCardCols = useMemo(() =>
    [...visibleCols]
      .filter(c => c.mobilePriority !== undefined)
      .sort((a, b) => (a.mobilePriority ?? 99) - (b.mobilePriority ?? 99)),
    [visibleCols]
  );

  const openTrade = (row: T) => {
    setTradeTicker(getTicker(row));
    setTradePrice(getPrice(row));
    setTradeOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 py-6">
        {[1,2,3,4,5].map(i => (
          <div key={i} className="h-10 bg-zinc-800/60 rounded animate-pulse mx-1" />
        ))}
      </div>
    );
  }

  return (
    <>
      {/* ── Filters (mobile-first) ── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mb-3 px-1">
        <div className="relative w-full sm:w-44">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <Input
            placeholder="Search ticker..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-8 h-8 w-full text-xs bg-zinc-900 border-zinc-700"
            data-testid="scanner-search"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-[10px] text-zinc-500 shrink-0">Max $</span>
          <Slider
            value={[priceMax]}
            onValueChange={([v]) => setPriceMax(v)}
            min={0}
            max={1000}
            step={5}
            className="flex-1 sm:w-28"
          />
          <span className="text-[10px] font-mono text-white w-14 shrink-0">${priceMax}</span>
          <span className="text-[10px] text-zinc-500 shrink-0 ml-auto">{sorted.length} results</span>
        </div>
      </div>

      {/* ── Mobile card layout (< md) ── */}
      <div className="block md:hidden space-y-2">
        {sorted.map((row, i) => {
          const tickerCol = mobileCardCols[0];
          const priceCol  = mobileCardCols[1];
          const metric1   = mobileCardCols[2];
          const metric2   = mobileCardCols[3];
          const signalCol = visibleCols.find(c => c.key === "signal");

          return (
            <div
              key={i}
              className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2"
            >
              {/* Left: ticker + price */}
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  {tickerCol && safeRender(tickerCol, row)}
                  {signalCol && safeRender(signalCol, row)}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
                  {priceCol && safeRender(priceCol, row)}
                  {metric1 && <span>{safeRender(metric1, row)}</span>}
                </div>
              </div>

              {/* Right: score metric + trade button */}
              <div className="flex items-center gap-2 shrink-0">
                {metric2 && <span>{safeRender(metric2, row)}</span>}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 text-[9px] px-2 font-bold"
                  onClick={() => openTrade(row)}
                  data-testid={`trade-${getTicker(row)}`}
                >
                  Trade
                </Button>
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-xs">No results matching your filters</div>
        )}
      </div>

      {/* ── Desktop table layout (≥ md) ── */}
      <div className="hidden md:block rounded-xl border border-zinc-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[480px]">
            <thead>
              <tr className="border-b border-zinc-800 bg-[#0d0f12]">
                {visibleCols.map(col => (
                  <th
                    key={col.key}
                    className={`px-2.5 py-2 text-left text-[10px] uppercase tracking-wider font-medium text-zinc-500 cursor-pointer hover:text-white transition-colors whitespace-nowrap ${col.className || ""}`}
                    onClick={() => col.sortValue && toggleSort(col.key)}
                  >
                    <div className="flex items-center gap-1">
                      {col.label}
                      {col.sortValue && (
                        sortKey === col.key
                          ? sortDir === "asc" ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />
                          : <ArrowUpDown className="w-2.5 h-2.5 opacity-25" />
                      )}
                    </div>
                  </th>
                ))}
                <th className="px-2.5 py-2 text-[10px] uppercase tracking-wider font-medium text-zinc-500 text-right">Act</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                  onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                >
                  {visibleCols.map(col => (
                    <td key={col.key} className={`px-2.5 py-2 whitespace-nowrap ${col.className || ""}`}>
                      {safeRender(col, row)}
                    </td>
                  ))}
                  <td className="px-2.5 py-2 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 text-[9px] px-2 font-bold"
                      onClick={e => {
                        e.stopPropagation();
                        openTrade(row);
                      }}
                      data-testid={`trade-${getTicker(row)}`}
                    >
                      Trade
                    </Button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={visibleCols.length + 1} className="px-4 py-10 text-center text-zinc-500 text-xs">
                    No results matching your filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <TradeDialog open={tradeOpen} onOpenChange={setTradeOpen} ticker={tradeTicker} price={tradePrice} />
    </>
  );
}

export { };
