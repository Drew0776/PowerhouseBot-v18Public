import { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle } from "lucide-react";
import type { PortfolioSummary, UserSettings } from "@shared/schema";

interface TradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticker: string;
  price: number;
}

export default function TradeDialog({ open, onOpenChange, ticker, price }: TradeDialogProps) {
  const [mode, setMode] = useState<"dollars" | "shares">("dollars");
  const [amount, setAmount] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: portfolio } = useQuery<PortfolioSummary>({
    queryKey: ["/api/portfolio"],
  });

  const { data: settings } = useQuery<UserSettings>({
    queryKey: ["/api/settings"],
  });

  const cash = portfolio?.cash ?? 100;
  const totalValue = portfolio?.totalValue ?? 100;

  const shares = mode === "dollars"
    ? (parseFloat(amount) || 0) / price
    : parseFloat(amount) || 0;

  const total = shares * price;
  const positionPct = totalValue > 0 ? (total / totalValue) * 100 : 0;
  const maxPosPct = settings?.maxPositionPct ?? 20;
  const oversized = positionPct > maxPosPct;

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        ticker,
        action: "buy",
        shares: Math.round(shares * 10000) / 10000,
        price,
      };
      if (stopLoss) body.stopLoss = parseFloat(stopLoss);
      if (takeProfit) body.takeProfit = parseFloat(takeProfit);

      const res = await apiRequest("POST", "/api/trades", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/equity-curve"] });
      toast({
        title: "Trade Executed",
        description: `Bought ${shares.toFixed(4)} shares of ${ticker} at $${price.toFixed(2)}`,
      });
      setAmount("");
      setStopLoss("");
      setTakeProfit("");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({
        title: "Trade Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Pre-fill stop-loss and take-profit from settings
  const handleOpen = () => {
    if (settings && !stopLoss && !takeProfit) {
      setStopLoss((price * (1 - (settings.stopLossPct / 100))).toFixed(2));
      setTakeProfit((price * (1 + (settings.takeProfitPct / 100))).toFixed(2));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) handleOpen(); onOpenChange(o); }}>
      <DialogContent
        className="sm:max-w-md border-border"
        style={{ backgroundColor: "hsl(220 18% 8%)" }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Paper Trade</span>
            <span className="text-[#00bcd4] font-mono">{ticker}</span>
          </DialogTitle>
          <DialogDescription>
            Current price: <span className="font-mono tabular-nums text-foreground">${price.toFixed(2)}</span>
            {" · "}
            Available: <span className="font-mono tabular-nums text-foreground">${cash.toFixed(2)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <Button
              variant={mode === "dollars" ? "default" : "secondary"}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => { setMode("dollars"); setAmount(""); }}
              data-testid="mode-dollars"
            >
              Dollar Amount
            </Button>
            <Button
              variant={mode === "shares" ? "default" : "secondary"}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => { setMode("shares"); setAmount(""); }}
              data-testid="mode-shares"
            >
              Shares
            </Button>
          </div>

          {/* Input */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              {mode === "dollars" ? "Amount ($)" : "Number of Shares"}
            </Label>
            <Input
              type="number"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={mode === "dollars" ? `Max $${cash.toFixed(2)}` : "0.0000"}
              className="font-mono tabular-nums"
              data-testid="trade-amount-input"
            />
          </div>

          {/* Quick amounts for dollars */}
          {mode === "dollars" && (
            <div className="flex gap-2">
              {[10, 25, 50].map((pct) => (
                <Button
                  key={pct}
                  variant="secondary"
                  size="sm"
                  className="flex-1 text-xs"
                  onClick={() => setAmount((cash * pct / 100).toFixed(2))}
                  data-testid={`quick-${pct}`}
                >
                  {pct}%
                </Button>
              ))}
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 text-xs"
                onClick={() => setAmount(cash.toFixed(2))}
                data-testid="quick-max"
              >
                Max
              </Button>
            </div>
          )}

          {/* Position size warning */}
          {oversized && total > 0 && (
            <div className="flex items-start gap-2 rounded-md p-2.5" style={{ backgroundColor: "rgba(255,215,64,0.1)", border: "1px solid rgba(255,215,64,0.3)" }}>
              <AlertTriangle className="w-4 h-4 text-[#ffd740] shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] text-[#ffd740] font-semibold">Large Position Warning</p>
                <p className="text-[10px] text-muted-foreground">
                  This trade is {positionPct.toFixed(0)}% of your portfolio (limit: {maxPosPct}%)
                </p>
              </div>
            </div>
          )}

          {/* Stop-Loss & Take-Profit */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground">Stop-Loss ($)</Label>
              <Input
                type="number"
                step="any"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                placeholder="Optional"
                className="font-mono tabular-nums h-8 text-xs"
                data-testid="stop-loss-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground">Take-Profit ($)</Label>
              <Input
                type="number"
                step="any"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
                placeholder="Optional"
                className="font-mono tabular-nums h-8 text-xs"
                data-testid="take-profit-input"
              />
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-md bg-accent/50 p-3 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Shares</span>
              <span className="font-mono tabular-nums text-foreground">{shares.toFixed(4)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Total Cost</span>
              <span className="font-mono tabular-nums text-foreground">${total.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Position %</span>
              <span className="font-mono tabular-nums" style={{ color: oversized ? "#ffd740" : "inherit" }}>{positionPct.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Remaining Cash</span>
              <span className="font-mono tabular-nums text-foreground">
                ${(cash - total).toFixed(2)}
              </span>
            </div>
          </div>

          {/* Execute */}
          <Button
            className="w-full"
            disabled={shares <= 0 || total > cash || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="execute-trade-btn"
          >
            {mutation.isPending ? "Executing..." : `Buy ${ticker}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
