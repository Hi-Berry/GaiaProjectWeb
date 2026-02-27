import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { GaiaGameState as GameState } from '@shared/gameConfig';
import { Clock, User } from 'lucide-react';

interface GameLogProps {
  game: GameState;
}

export function GameLog({ game }: GameLogProps) {
  const logs = game.gameLog || [];



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
          <div className="p-4 space-y-2 flex flex-col">
            {logs.length === 0 ? (
              <div className="text-center text-zinc-500 text-sm py-8">
                No actions yet
              </div>
            ) : (
              [...logs].reverse().map((log, index) => {
                const actionText = log.action || '';
                const isPowerAction = /power|income|energy|bowl/i.test(actionText) || /Accepted|Declined/i.test(actionText);
                const isMainAction = /Built|Upgraded|Advanced|Pass|Pass Round|Gaia Project|Federation|Chosen/i.test(actionText) && !isPowerAction;

                return (
                  <div
                    key={index}
                    className={`flex items-start gap-2 p-2 rounded-lg border transition-colors ${isMainAction
                      ? 'bg-zinc-800/40 border-primary/30 shadow-[0_0_10px_rgba(59,130,246,0.1)]'
                      : isPowerAction
                        ? 'bg-zinc-950/20 border-white/5 opacity-60'
                        : 'bg-zinc-900/30 border-white/5'
                      } hover:bg-zinc-800/60`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <User className={`w-3 h-3 flex-shrink-0 ${isMainAction ? 'text-primary' : 'text-zinc-500'}`} />
                        <span className={`text-[10px] font-bold truncate shrink-0 max-w-[80px] ${isMainAction ? 'text-zinc-100' : 'text-zinc-400'}`}>
                          {log.playerName}
                        </span>
                      </div>
                      <div className="text-[11px] leading-tight">
                        <span className={`font-black uppercase tracking-tight ${isMainAction ? 'text-primary' : isPowerAction ? 'text-zinc-500 text-[10px]' : 'text-zinc-300'
                          }`}>
                          {log.action}
                        </span>
                        {log.details && (
                          <span className={`ml-1.5 ${isMainAction ? 'text-zinc-300 font-medium' : 'text-zinc-500 italic text-[10px]'}`}>
                            {log.details}
                          </span>
                        )}
                      </div>
                      {/* subLogs (파워 교환 승낙 등 연계된 동작) 렌더링 */}
                      {log.subLogs && log.subLogs.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {log.subLogs.map((subLog, i) => (
                            <div key={i} className="text-[8px] leading-[10px] flex items-center gap-1 bg-purple-900/20 border border-purple-500/20 px-1 py-0.5 rounded-sm">
                              <span className="font-bold text-purple-400 shrink-0">{subLog.playerName}</span>
                              <span className="text-purple-300/80">{subLog.text.replace(`↳ ${subLog.playerName} `, '').replace('↳ ', '')}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
