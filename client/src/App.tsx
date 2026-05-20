import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Scanner from "@/pages/scanner";
import TradeLog from "@/pages/trade-log";
import StockDetail from "@/pages/stock-detail";
import Settings from "@/pages/settings";
import GridBotPage from "@/pages/grid-bot";
import AutoTraderPage from "@/pages/auto-trader";
import AppLayout from "@/components/app-layout";

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/scanner" component={Scanner} />
        <Route path="/trades" component={TradeLog} />
        <Route path="/stock/:ticker" component={StockDetail} />
        <Route path="/settings" component={Settings} />
        <Route path="/grid" component={GridBotPage} />
        <Route path="/auto" component={AutoTraderPage} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
