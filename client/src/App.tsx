import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient, apiRequest } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
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
import Login from "@/pages/login";
import AppLayout from "@/components/app-layout";

function AuthenticatedApp() {
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

function AppRouter() {
  const { data: authData, isLoading } = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/auth/check"],
    retry: false,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  const isAuthenticated = authData?.authenticated === true;

  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route>
        {isAuthenticated ? <AuthenticatedApp /> : <Redirect to="/login" />}
      </Route>
    </Switch>
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
