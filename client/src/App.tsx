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

  // [패닉 키] '0' 누르면 즉시 naver로 이동(보스키). 단 입력창(채팅 등) 포커스 중엔 무시 — 타이핑 방해 안 함.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '0' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable;
      if (typing) return; // 채팅/입력 중이면 무시
      window.location.href = 'https://www.naver.com';
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
