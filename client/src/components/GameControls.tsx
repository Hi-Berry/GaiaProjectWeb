import { useResetMap, useInitPlayer } from "@/hooks/use-game";
import { Button } from "@/components/ui/button";
import { RefreshCw, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function GameControls() {
  const resetMap = useResetMap();
  const initPlayer = useInitPlayer();
  const { toast } = useToast();

  const handleReset = async () => {
    try {
      await resetMap.mutateAsync();
      toast({
        title: "System Reset",
        description: "Galaxy map has been re-generated.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to reset galaxy map.",
        variant: "destructive",
      });
    }
  };

  const handleInitPlayer = async () => {
    try {
      await initPlayer.mutateAsync();
      toast({
        title: "Player Initialized",
        description: "New faction joined the galaxy.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to initialize player.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="absolute top-6 left-6 z-10 flex gap-4">
      <Button 
        onClick={handleReset} 
        disabled={resetMap.isPending}
        variant="outline"
        className="bg-black/40 backdrop-blur border-white/10 hover:bg-white/10 hover:border-white/20 text-white gap-2 font-mono"
      >
        <RefreshCw className={`w-4 h-4 ${resetMap.isPending ? 'animate-spin' : ''}`} />
        REGENERATE SECTOR
      </Button>

      <Button 
        onClick={handleInitPlayer}
        disabled={initPlayer.isPending}
        variant="secondary"
        className="bg-primary/80 hover:bg-primary text-white border-none shadow-[0_0_15px_rgba(124,58,237,0.5)] gap-2 font-mono"
      >
        <UserPlus className="w-4 h-4" />
        INIT FACTION
      </Button>
    </div>
  );
}
