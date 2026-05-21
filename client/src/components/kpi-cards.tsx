import type { PortfolioSummary } from "@shared/schema";
import { DollarSign, TrendingUp, TrendingDown, Target, Briefcase, Shield } from "lucide-react";

function KpiCard({ label, value, subValue, icon: Icon, color }: {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
        <Icon className="w-3.5 h-3.5" style={{ color }} />
      </div>
      <div className="font-mono tabular-nums text-lg font-semibold text-foreground leading-none">{value}</div>
      {subValue && (
        <div className="font-mono tabular-nums text-[11px] mt-1" style={{ color }}>{subValue}</div>
      )}
    </div>
  );
}

export default function KpiCards({ portfolio }: { portfolio: PortfolioSummary }) {
  const dayColor = portfolio.dayPnl >= 0 ? "#00e676" : "#ff1744";
  const totalColor = portfolio.totalPnl >= 0 ? "#00e676" : "#ff1744";
  const riskColor = portfolio.riskScore > 70 ? "#ff1744" : portfolio.riskScore > 40 ? "#ffd740" : "#00e676";

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="kpi-cards">
      <KpiCard
        label="Portfolio Value"
        value={`$${portfolio.totalValue.toFixed(2)}`}
        subValue={`$${portfolio.cash.toFixed(2)} cash`}
        icon={DollarSign}
        color="#00bcd4"
      />
      <KpiCard
        label="Day P&L"
        value={`${portfolio.dayPnl >= 0 ? "+" : ""}$${portfolio.dayPnl.toFixed(2)}`}
        subValue={`${portfolio.dayPnlPercent >= 0 ? "+" : ""}${portfolio.dayPnlPercent.toFixed(2)}%`}
        icon={portfolio.dayPnl >= 0 ? TrendingUp : TrendingDown}
        color={dayColor}
      />
      <KpiCard
        label="Total P&L"
        value={`${portfolio.totalPnl >= 0 ? "+" : ""}$${portfolio.totalPnl.toFixed(2)}`}
        subValue={`${portfolio.totalPnlPercent >= 0 ? "+" : ""}${portfolio.totalPnlPercent.toFixed(2)}%`}
        icon={portfolio.totalPnl >= 0 ? TrendingUp : TrendingDown}
        color={totalColor}
      />
      <KpiCard
        label="Win Rate"
        value={`${portfolio.winRate.toFixed(1)}%`}
        icon={Target}
        color="#00bcd4"
      />
      <KpiCard
        label="Open Positions"
        value={`${portfolio.openPositions}`}
        icon={Briefcase}
        color="#00bcd4"
      />
      <KpiCard
        label="Risk Score"
        value={`${portfolio.riskScore}`}
        subValue={portfolio.riskScore > 70 ? "High Risk" : portfolio.riskScore > 40 ? "Moderate" : "Low Risk"}
        icon={Shield}
        color={riskColor}
      />
    </div>
  );
}
