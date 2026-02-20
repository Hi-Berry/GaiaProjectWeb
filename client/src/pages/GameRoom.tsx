import { PlayerDashboard } from "@/components/PlayerDashboard";
import { HexMap } from "@/components/HexMap";
import { GameControls } from "@/components/GameControls";
import { Scoreboard } from "@/components/Scoreboard";
import { usePlayer, useInitPlayer } from "@/hooks/use-game";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export default function GameRoom() {
  // For this demo, we assume player ID 1. In a real app, this would come from auth or route params.
  const PLAYER_ID = 1;
  const { data: player, isLoading } = usePlayer(PLAYER_ID);
  const initPlayer = useInitPlayer();

  // Auto-initialize if no player exists
  useEffect(() => {
    if (!isLoading && !player && !initPlayer.isPending && !initPlayer.isSuccess) {
      initPlayer.mutate();
    }
  }, [isLoading, player, initPlayer]);

  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-background flex overflow-hidden">
      {/* Sidebar - Player Dashboard */}
      <div className="w-[380px] h-full shrink-0 z-20 shadow-2xl">
        <PlayerDashboard playerId={PLAYER_ID} />
      </div>

      {/* Main Content - Hex Map */}
      <div className="flex-1 relative h-full bg-black">
        {/* Background Atmosphere */}
        <div className="absolute inset-0 bg-gradient-to-br from-background via-transparent to-background/50 z-0 pointer-events-none" />
        
        {/* Game Area */}
        <div className="relative z-10 w-full h-full p-8 flex items-center justify-center">
          <GameControls />
          <Scoreboard playerId={PLAYER_ID} round={1} />
          <HexMap />
        </div>
      </div>
    </div>
  );
}
