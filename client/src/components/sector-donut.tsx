import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useQuery } from "@tanstack/react-query";
import type { SignalRow } from "@shared/schema";

const CATEGORY_COLORS: Record<string, string> = {
  "AI & Tech": "#00bcd4",
  "Penny Stocks": "#ffd740",
  "Momentum": "#7c4dff",
};

// Map tickers to categories
const PENNY_TICKERS = new Set(["SOUN", "BBAI", "GFAI", "DNA", "NKLA", "MARA", "RIOT", "WULF", "IREN", "BTBT", "KULR", "SNDL", "APRE", "RAIL", "CLOV"]);
const MOMENTUM_TICKERS = new Set(["SMCI", "IWM", "RIVN", "LCID", "SOFI", "RKLB", "IONQ", "RGTI", "QUBT", "AFRM", "UPST", "JOBY", "LUNR", "ACHR", "DJT"]);

function getCategory(ticker: string): string {
  if (PENNY_TICKERS.has(ticker)) return "Penny Stocks";
  if (MOMENTUM_TICKERS.has(ticker)) return "Momentum";
  return "AI & Tech";
}

export default function SectorDonut() {
  const { data: signals } = useQuery<SignalRow[]>({ queryKey: ["/api/signals"] });

  const categoryMap = new Map<string, number>();
  if (signals) {
    for (const s of signals) {
      const cat = getCategory(s.ticker);
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
    }
  }

  const pieData = Array.from(categoryMap.entries()).map(([name, value]) => ({ name, value }));

  if (pieData.length === 0) {
    pieData.push({ name: "AI & Tech", value: 15 }, { name: "Penny Stocks", value: 15 }, { name: "Momentum", value: 15 });
  }

  return (
    <div className="rounded-lg border border-border p-4" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Stock Universe</h3>
      <div className="flex items-center gap-4">
        <div style={{ width: 140, height: 140, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={62}
              paddingAngle={3}
              dataKey="value"
              strokeWidth={0}
            >
              {pieData.map((entry) => (
                <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || "#666"} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(220 18% 9%)",
                border: "1px solid hsl(220 15% 15%)",
                borderRadius: 6,
                fontSize: 11,
              }}
              formatter={(value: number) => [`${value} stocks`]}
            />
          </PieChart>
        </ResponsiveContainer>
        </div>
        <div className="space-y-2">
          {pieData.map((entry) => (
            <div key={entry.name} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CATEGORY_COLORS[entry.name] || "#666" }} />
              <span className="text-xs text-muted-foreground">{entry.name}</span>
              <span className="text-xs font-mono tabular-nums text-foreground">{entry.value}</span>
            </div>
          ))}
          <div className="pt-1 border-t border-border">
            <span className="text-xs text-muted-foreground">Total: </span>
            <span className="text-xs font-mono tabular-nums text-foreground">{pieData.reduce((s, p) => s + p.value, 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
