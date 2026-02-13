import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { GaiaGameState as GameState } from '@shared/gameConfig';
import { Clock, User } from 'lucide-react';

interface GameLogProps {
  game: GameState;
}

export function GameLog({ game }: GameLogProps) {
  const logs = game.gameLog || [];

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <Card className="w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron shadow-2xl">
      <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50">
        <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Game Log
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[400px]">
          <div className="p-4 space-y-2">
            {logs.length === 0 ? (
              <div className="text-center text-zinc-500 text-sm py-8">
                No actions yet
              </div>
            ) : (
              logs.map((log, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 p-2 rounded-lg bg-zinc-900/30 border border-white/5 hover:bg-zinc-900/50 transition-colors"
                >
                  <div className="flex-shrink-0 text-[10px] text-zinc-500 font-mono mt-0.5">
                    {formatTime(log.timestamp)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <User className="w-3 h-3 text-primary flex-shrink-0" />
                      <span className="text-xs font-bold text-zinc-200 truncate">
                        {log.playerName}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-300">
                      <span className="font-semibold text-primary">{log.action}</span>
                      {log.details && (
                        <span className="text-zinc-400 ml-2">{log.details}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
