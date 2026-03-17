import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Lobby from "@/pages/Lobby";
import Game from "@/pages/Game";
import NotFound from "@/pages/not-found";
import { useEffect } from "react";
import { preloadImages } from "@/lib/imagePreloader";

const PRELOAD_IMAGES = [
  ...Array.from({ length: 10 }, (_, i) => `/image/BoostTile_${i + 1}.jpg`),
  ...Array.from({ length: 12 }, (_, i) => `/image/Federation_${i + 1}.gif`),
  ...Array.from({ length: 6 }, (_, i) => `/image/Art${i + 1}.png`),
];

function Router() {
  return (
    <Switch>
      <Route path="/" component={Lobby} />
      <Route path="/game/:matchID" component={Game} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    preloadImages(PRELOAD_IMAGES);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
