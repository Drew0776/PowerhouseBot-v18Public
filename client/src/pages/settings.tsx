import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { UserSettings } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Shield, Crosshair, Link2, Bell } from "lucide-react";

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<UserSettings>({ queryKey: ["/api/settings"] });
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

  const update = (key: keyof UserSettings, value: any) => {
    setLocal(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const save = () => mutation.mutate(local);

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

      {/* Brokerage Connection */}
      <div className="rounded-lg border border-border p-5" style={{ backgroundColor: "hsl(220 18% 7%)" }}>
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="w-4 h-4 text-[#00bcd4]" />
          <h2 className="text-sm font-semibold text-foreground">Brokerage Connection</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3">Connect a brokerage to execute real trades. Currently paper trading only.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-md border border-border p-3 bg-accent/30">
            <div className="text-xs font-semibold mb-1.5">Public.com</div>
            <Input placeholder="API Key" className="h-7 text-[10px] font-mono mb-1.5" disabled data-testid="public-api-key" />
            <Button variant="secondary" size="sm" className="h-7 text-[10px] w-full" disabled>Connect</Button>
          </div>
          <div className="rounded-md border border-border p-3 bg-accent/30">
            <div className="text-xs font-semibold mb-1.5">Alpaca</div>
            <Input placeholder="API Key" className="h-7 text-[10px] font-mono mb-1.5" disabled data-testid="alpaca-api-key" />
            <Button variant="secondary" size="sm" className="h-7 text-[10px] w-full" disabled>Connect</Button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">Brokerage integration coming soon</p>
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

      {/* V17: Telegram Alerts */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2">
          📱 Telegram Alerts
          <span className="text-[10px] font-mono text-[#00e676] bg-[#00e676]/10 px-2 py-0.5 rounded">V17 NEW</span>
        </h3>
        <p className="text-xs text-zinc-500 mb-4">Get real-time alerts for signals and circuit breaker events on your phone.</p>
        <div className="space-y-3 text-xs text-zinc-400">
          <div className="bg-zinc-800 rounded p-3 space-y-2">
            <p className="font-bold text-white">3-Step Setup:</p>
            <p>1. Message <span className="text-[#00e676]">@BotFather</span> on Telegram → /newbot → get your token</p>
            <p>2. Message <span className="text-[#00e676]">@userinfobot</span> on Telegram → get your Chat ID</p>
            <p>3. Set these when starting the bot locally:</p>
            <pre className="bg-zinc-950 rounded p-2 text-[#00e676] text-[10px] overflow-x-auto">TELEGRAM_BOT_TOKEN=your_token{"\n"}TELEGRAM_CHAT_ID=your_chat_id</pre>
          </div>
          <button
            className="w-full py-2 rounded bg-[#00bcd4]/20 border border-[#00bcd4]/40 text-[#00bcd4] text-xs font-bold hover:bg-[#00bcd4]/30 transition"
            onClick={async () => {
              const r = await fetch("/api/telegram/test");
              const d = await r.json();
              alert(d.message);
            }}
          >
            Test Telegram Connection
          </button>
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
