import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, ScrollText, Activity, Zap,
  Settings, Crosshair, Grid3X3, Bot, X, TrendingUp,
  ChevronRight
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/",       label: "Dashboard",   shortLabel: "Home",     icon: LayoutDashboard },
  { href: "/auto",   label: "Auto-Trader", shortLabel: "Auto",     icon: Bot,             badge: "LIVE" },
  { href: "/scanner",label: "Scanner",     shortLabel: "Scan",     icon: Crosshair },
  { href: "/grid",   label: "Grid Bot",    shortLabel: "Grid",     icon: Grid3X3 },
  { href: "/trades", label: "Trade Log",   shortLabel: "Trades",   icon: ScrollText },
  { href: "/settings",label: "Settings",   shortLabel: "More",     icon: Settings },
];

function PowerhouseLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="Powerhouse">
      <rect x="2" y="2" width="28" height="28" rx="6" stroke="#00bcd4" strokeWidth="2" />
      <path d="M10 22 L16 8 L18 15 L24 10" stroke="#00e676" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="24" cy="10" r="2" fill="#00e676" />
    </svg>
  );
}

function useUniverseCount() {
  const { data } = useQuery<{ count: number }>({ queryKey: ["/api/universe/count"], staleTime: 60_000 });
  return data?.count ?? "—";
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const universeCount = useUniverseCount();
  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
        <PowerhouseLogo />
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold text-foreground tracking-tight">Powerhouse</span>
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Trading Bot</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? location === "/" || location === "" : location.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                  isActive ? "bg-[hsl(174,100%,37%,0.12)] text-[#00bcd4]" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
                onClick={onNavigate}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {(item as any).badge && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-[#00bcd4]/20 text-[#00bcd4] font-bold tracking-wider">
                    {(item as any).badge}
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Zap className="w-3 h-3 text-[#00e676]" />
          <span>Paper Trading — $100</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <Activity className="w-3 h-3" />
          <span className="font-mono tabular-nums">{universeCount} Markets Tracked</span>
        </div>
      </div>
    </>
  );
}

// ── Mobile drawer (slides in from left) ──────────────────────────────────────
function DrawerNavItems({ onClose }: { onClose: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
      {NAV_ITEMS.map((item) => {
        const isActive = item.href === "/" ? location === "/" || location === "" : location.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={cn(
                "flex items-center gap-3 px-4 py-3.5 rounded-xl text-[15px] font-medium transition-all cursor-pointer",
                isActive
                  ? "bg-[#00bcd4]/15 text-[#00bcd4] border border-[#00bcd4]/25"
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800"
              )}
              onClick={onClose}
              data-testid={`mobile-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <item.icon className={cn("w-5 h-5 shrink-0", isActive ? "text-[#00bcd4]" : "text-zinc-500")} />
              <span className="flex-1">{item.label}</span>
              {(item as any).badge && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#00e676]/20 text-[#00e676] font-bold tracking-wider animate-pulse">
                  {(item as any).badge}
                </span>
              )}
              {isActive && <ChevronRight className="w-4 h-4 text-[#00bcd4]/50" />}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}

function MobileDrawerFooter() {
  const universeCount = useUniverseCount();
  return (
    <div className="px-4 py-4 border-t border-zinc-800">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
        <Zap className="w-3 h-3 text-[#00e676]" />
        <span>Paper Trading — $100 starting capital</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <TrendingUp className="w-3 h-3 text-[#00bcd4]" />
        <span className="font-mono">{universeCount} Markets Monitored</span>
      </div>
    </div>
  );
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 flex flex-col border-r border-zinc-700 transition-transform duration-250 ease-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ backgroundColor: "hsl(220 20% 5%)" }}
      >
        <div className="flex items-center justify-between px-4 h-14 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <PowerhouseLogo />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-semibold text-white tracking-tight">Powerhouse</span>
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Trading Bot</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            data-testid="drawer-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <DrawerNavItems onClose={onClose} />
        <MobileDrawerFooter />
      </aside>
    </>
  );
}

// ── Bottom tab bar (mobile only) ─────────────────────────────────────────────
// Shows 5 most-used tabs as icons at the bottom — standard mobile pattern
const BOTTOM_TABS = [
  { href: "/",        label: "Home",   icon: LayoutDashboard },
  { href: "/auto",    label: "Auto",   icon: Bot,    badge: "LIVE" },
  { href: "/scanner", label: "Scan",   icon: Crosshair },
  { href: "/grid",    label: "Grid",   icon: Grid3X3 },
  { href: "/trades",  label: "Trades", icon: ScrollText },
];

function BottomTabBar() {
  const [location] = useLocation();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-zinc-800"
      style={{ backgroundColor: "hsl(220 20% 5%)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-stretch">
        {BOTTOM_TABS.map((tab) => {
          const isActive = tab.href === "/" ? location === "/" || location === "" : location.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} className="flex-1">
              <div
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 py-2.5 relative transition-colors cursor-pointer",
                  isActive ? "text-[#00bcd4]" : "text-zinc-500"
                )}
                data-testid={`tab-${tab.label.toLowerCase()}`}
              >
                {/* Active indicator */}
                {isActive && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-[#00bcd4]" />
                )}
                {/* Badge dot for Auto-Trader */}
                {(tab as any).badge && !isActive && (
                  <div className="absolute top-2 right-[calc(50%-10px)] w-1.5 h-1.5 rounded-full bg-[#00e676]" />
                )}
                <tab.icon className={cn("w-5 h-5", isActive ? "text-[#00bcd4]" : "text-zinc-500")} />
                <span className={cn("text-[10px] font-medium", isActive ? "text-[#00bcd4]" : "text-zinc-500")}>
                  {tab.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// ── Mobile top header ─────────────────────────────────────────────────────────
function MobileTopBar({ onMenuOpen }: { onMenuOpen: () => void }) {
  const [location] = useLocation();
  const currentPage = NAV_ITEMS.find(n =>
    n.href === "/" ? location === "/" || location === "" : location.startsWith(n.href)
  );
  return (
    <header
      className="flex md:hidden items-center justify-between px-4 h-13 border-b border-zinc-800 shrink-0 sticky top-0 z-30"
      style={{ backgroundColor: "hsl(220 20% 5%)", height: "52px" }}
    >
      {/* Logo + page name */}
      <div className="flex items-center gap-2.5">
        <PowerhouseLogo size={24} />
        <div className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold text-white leading-tight">
            {currentPage?.label ?? "Powerhouse"}
          </span>
          <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">Trading Bot</span>
        </div>
      </div>

      {/* Right side: LIVE badge + menu button */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 bg-[#00e676]/10 border border-[#00e676]/20 rounded-full px-2.5 py-1">
          <div className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse" />
          <span className="text-[10px] font-bold text-[#00e676] tracking-wider">LIVE</span>
        </div>
        <button
          onClick={onMenuOpen}
          className="w-9 h-9 flex items-center justify-center rounded-xl bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-white active:scale-95 transition-all"
          data-testid="mobile-menu-btn"
          aria-label="Open menu"
        >
          {/* Hamburger icon — 3 lines */}
          <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
            <rect y="0" width="16" height="1.8" rx="1" />
            <rect y="5.1" width="12" height="1.8" rx="1" />
            <rect y="10.2" width="16" height="1.8" rx="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}

// ── Root layout ───────────────────────────────────────────────────────────────
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar — hidden on mobile */}
      <aside
        className="hidden md:flex w-56 shrink-0 border-r border-border flex-col"
        style={{ backgroundColor: "hsl(220 20% 6%)" }}
        data-testid="sidebar"
      >
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <MobileTopBar onMenuOpen={() => setDrawerOpen(true)} />

        {/* Page content — extra bottom padding on mobile for the tab bar */}
        <main
          className="flex-1 overflow-y-auto"
          data-testid="main-content"
        >
          {/* Extra bottom padding on mobile to clear the bottom tab bar */}
          <div className="pb-20 md:pb-6">
            {children}
          </div>
        </main>

        {/* Mobile bottom tab bar */}
        <BottomTabBar />
      </div>
    </div>
  );
}
