import { usePlayer } from "@/hooks/use-game";
import { Trophy, Clock } from "lucide-react";

interface ScoreboardProps {
  playerId: number;
  round?: number;
}

export function Scoreboard({ playerId, round = 1 }: ScoreboardProps) {
  const { data: player } = usePlayer(playerId);

  return (
    <div className="absolute top-6 right-6 z-20 flex gap-4">
      <div className="bg-card/80 backdrop-blur border border-white/10 px-4 py-3 rounded-xl flex items-center gap-3" data-testid="scoreboard-round">
        <Clock className="w-4 h-4 text-muted-foreground" />
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Round</p>
          <p className="text-xl font-mono font-bold text-white" data-testid="text-round">{round}/6</p>
        </div>
      </div>

      <div className="bg-card/80 backdrop-blur border border-white/10 px-4 py-3 rounded-xl flex items-center gap-3" data-testid="scoreboard-score">
        <Trophy className="w-4 h-4 text-yellow-400" />
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Score</p>
          <p className="text-xl font-mono font-bold text-white" data-testid="scoreboard-score-value">{player?.score || 0}</p>
        </div>
      </div>
    </div>
  );
}
