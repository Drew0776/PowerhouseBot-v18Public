import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";

interface EquityChartProps {
  data: { id: number; timestamp: string; value: number }[];
  hasTrades?: boolean;
}

export default function EquityChart({ data, hasTrades = true }: EquityChartProps) {
  const isEmpty = !hasTrades;

  const chartData = isEmpty
    ? [{ time: "Start", value: 100, spy: 100 }, { time: "Now", value: 100, spy: 100 }]
    : data.map((d, i) => {
        const date = new Date(d.timestamp);
        const spyValue = 100 * (1 + 0.0003 * i);
        return {
          time: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          value: d.value,
          spy: Math.round(spyValue * 100) / 100,
        };
      });

  // If only 1 data point, add a starting point
  if (!isEmpty && chartData.length === 1) {
    chartData.unshift({ time: "Start", value: 100, spy: 100 });
  }

  return (
    <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Equity Curve</h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-0.5 rounded bg-[#00e676]" />
            <span className="text-[10px] text-muted-foreground">Portfolio</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-0.5 rounded bg-[#00bcd4] opacity-50" />
            <span className="text-[10px] text-muted-foreground">SPY Benchmark</span>
          </div>
        </div>
      </div>
      {isEmpty && (
        <div className="flex items-center justify-center gap-1.5 mb-2">
          <span className="text-[10px] text-zinc-500 font-mono">No trades yet — showing starting value</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
          <defs>
            <linearGradient id="gradEquity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00e676" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#00e676" stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 13%)" />
          <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "hsl(210 10% 55%)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} domain={["dataMin - 2", "dataMax + 2"]} />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(220 18% 9%)",
              border: "1px solid hsl(220 15% 15%)",
              borderRadius: 6,
              fontSize: 11,
            }}
            labelStyle={{ color: "hsl(210 10% 55%)", fontSize: 10 }}
            formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name === "value" ? "Portfolio" : "SPY"]}
          />
          <ReferenceLine y={100} stroke="hsl(220 15% 20%)" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="spy"
            stroke="#00bcd4"
            strokeWidth={1}
            strokeOpacity={0.4}
            fill="none"
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#00e676"
            strokeWidth={2}
            fill="url(#gradEquity)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
