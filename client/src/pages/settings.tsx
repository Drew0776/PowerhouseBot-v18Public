import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { UserSettings } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Shield, Crosshair, Bell, Activity, Wifi, WifiOff } from "lucide-react";

interface AlpacaStatus {
  connected: boolean;
  error: string;
  cachedTickers: number;
  lastFetchMs: number;
  account: {
    status: string;
    portfolioValue: number;
    cash: number;
    buyingPower: number;
  } | null;
}

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<UserSettings>({ queryKey: ["/api/settings"] });
  const { data: alpaca } = useQuery<AlpacaStatus>({
    queryKey: ["/api/alpaca/status"],
    refetchInterval: 30_000,
  });
  const [local, setLocal] = useState<UserSettings | null>(null);

  useEffect(() => {
    if (settings && !local) setLocal(settings);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: async (s: Partial<UserSettings>) => {
      const res = await apiRequest("POST", "/api/settings", s);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      setLocal(data);
      toast({ title: "Settings Saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !local) return <div className="p-6"><Skeleton className="h-96" /></div>;

  const update = (key: keyof UserSettings, value: boolean | number | string) => {
    setLocal(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const save = () => mutation.mutate(local);

  const testTelegram = async () => {
    try {
      const r = await fetch("/api/telegram/test");
      const d = await r.json() as { connected: boolean; message: string };
      if (d.connected) {
        toast({ title: "Telegram Connected", description: d.message });
      } else {
        toast({ title: "Telegram Not Configured", description: d.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Test Failed", description: "Could not reach Telegram API.", variant: "destructive" });
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>

      {/* Risk Management */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Risk Management</h2>
        </div>
        <div className="space-y-5">
          <div>
            <Label className="text-xs text-muted-foreground">Max Position Size</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <Slider
                value={[local.maxPositionPct]}
                onValueChange={([v]) => update("maxPositionPct", v)}
                min={5}
                max={100}
                step={5}
                className="flex-1"
              />
              <span className="text-sm font-mono tabular-nums w-10 text-right">{local.maxPositionPct}%</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Warn if single position exceeds this % of portfolio</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Default Stop-Loss</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <Slider
                value={[local.stopLossPct]}
                onValueChange={([v]) => update("stopLossPct", v)}
                min={1}
                max={50}
                step={1}
                className="flex-1"
              />
              <span className="text-sm font-mono tabular-nums w-10 text-right">{local.stopLossPct}%</span>
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Default Take-Profit</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <Slider
                value={[local.takeProfitPct]}
                onValueChange={([v]) => update("takeProfitPct", v)}
                min={5}
                max={200}
                step={5}
                className="flex-1"
              />
              <span className="text-sm font-mono tabular-nums w-10 text-right">{local.takeProfitPct}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Scanner Preferences */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-4">
          <Crosshair className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Scanner Preferences</h2>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">100x Hunter (Penny Stocks)</Label>
            <Switch checked={local.scannerPennyActive} onCheckedChange={v => update("scannerPennyActive", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Momentum Breakouts</Label>
            <Switch checked={local.scannerMomentumActive} onCheckedChange={v => update("scannerMomentumActive", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Short Squeeze Radar</Label>
            <Switch checked={local.scannerSqueezeActive} onCheckedChange={v => update("scannerSqueezeActive", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Options Flow</Label>
            <Switch checked={local.scannerOptionsActive} onCheckedChange={v => update("scannerOptionsActive", v)} />
          </div>
          <div className="pt-2 border-t border-border">
            <Label className="text-xs text-muted-foreground">Minimum Score Threshold</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <Slider
                value={[local.minScoreThreshold]}
                onValueChange={([v]) => update("minScoreThreshold", v)}
                min={0}
                max={80}
                step={5}
                className="flex-1"
              />
              <span className="text-sm font-mono tabular-nums w-10 text-right">{local.minScoreThreshold}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Alpaca Connection Status */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Brokerage Connection</h2>
        </div>

        <div className="rounded-md border border-border p-4 bg-accent/20">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Alpaca</span>
              {alpaca?.connected ? (
                <span className="flex items-center gap-1 text-[10px] font-mono text-[#00e676] bg-[#00e676]/10 px-1.5 py-0.5 rounded">
                  <Wifi className="w-2.5 h-2.5" /> LIVE
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                  <WifiOff className="w-2.5 h-2.5" /> OFFLINE
                </span>
              )}
            </div>
            {alpaca?.cachedTickers != null && (
              <span className="text-[10px] text-muted-foreground font-mono">{alpaca.cachedTickers} tickers</span>
            )}
          </div>

          {alpaca?.account ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Portfolio</p>
                <p className="text-sm font-mono font-semibold text-foreground">
                  ${alpaca.account.portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Cash</p>
                <p className="text-sm font-mono font-semibold text-foreground">
                  ${alpaca.account.cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Buying Power</p>
                <p className="text-sm font-mono font-semibold text-foreground">
                  ${alpaca.account.buyingPower.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {alpaca?.error ? `Error: ${alpaca.error}` : "Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in environment secrets to connect."}
            </p>
          )}
        </div>
      </div>

      {/* Notifications */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-4">
          <Bell className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Enable Alerts</Label>
            <Switch checked={local.alertsEnabled} onCheckedChange={v => update("alertsEnabled", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Buy Signal Alerts</Label>
            <Switch checked={local.alertBuySignals} onCheckedChange={v => update("alertBuySignals", v)} disabled={!local.alertsEnabled} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Sell Signal Alerts</Label>
            <Switch checked={local.alertSellSignals} onCheckedChange={v => update("alertSellSignals", v)} disabled={!local.alertsEnabled} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Price Alerts</Label>
            <Switch checked={local.alertPriceAlerts} onCheckedChange={v => update("alertPriceAlerts", v)} disabled={!local.alertsEnabled} />
          </div>
        </div>
      </div>

      {/* Telegram Alerts */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-1">
          <Bell className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Telegram Alerts</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-4">Get real-time alerts for signals and circuit breaker events on your phone.</p>
        <div className="space-y-3 text-xs text-zinc-400">
          <div className="bg-zinc-800/60 rounded p-3 space-y-2">
            <p className="font-semibold text-white">3-Step Setup:</p>
            <p>1. Message <span className="text-[#00e676]">@BotFather</span> on Telegram → /newbot → get your token</p>
            <p>2. Message <span className="text-[#00e676]">@userinfobot</span> on Telegram → get your Chat ID</p>
            <p>3. Add these as Replit Secrets:</p>
            <pre className="bg-zinc-900 rounded p-2 text-[#00e676] text-[10px] overflow-x-auto">TELEGRAM_BOT_TOKEN=your_token{"\n"}TELEGRAM_CHAT_ID=your_chat_id</pre>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-[#00bcd4]/40 text-[#00bcd4] hover:bg-[#00bcd4]/10"
            onClick={testTelegram}
          >
            Test Telegram Connection
          </Button>
        </div>
      </div>

      {/* Save */}
      <Button
        onClick={save}
        className="w-full md:w-auto"
        disabled={mutation.isPending}
        data-testid="save-settings"
      >
        {mutation.isPending ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
