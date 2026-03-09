import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { type GaiaGameState as GameState, FACTIONS } from '@shared/gameConfig';
import { Clock, User } from 'lucide-react';

interface GameLogProps {
  game: GameState;
  onEntryMouseEnter?: (tileId: string) => void;
  onEntryMouseLeave?: () => void;
  hideHeader?: boolean;
  className?: string;
  maxHeight?: string;
}

export function GameLog({
  game,
  onEntryMouseEnter,
  onEntryMouseLeave,
  hideHeader = false,
  className = "",
  maxHeight = "400px"
}: GameLogProps) {
  const logs = game.gameLog || [];


  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  const content = (
    <div className={`space-y-2 flex flex-col ${!hideHeader ? "p-4" : "p-0 pr-3"}`}>
      {logs.length === 0 ? (
        <div className="text-center text-zinc-500 text-sm py-8 uppercase tracking-widest font-black opacity-30">
          No actions yet
        </div>
      ) : (
        [...logs].reverse().map((log, index) => {
          const actionText = log.action || '';
          const isPowerAction = /power|income|energy|bowl/i.test(actionText) || /Accepted|Declined/i.test(actionText);
          const isMainAction = /Built|Upgraded|Advanced|Pass|Pass Round|Gaia Project|Federation|Chosen/i.test(actionText) && !isPowerAction;

          const player = log.playerId ? game.players[log.playerId] : undefined;
          const factionColor = player?.faction ? FACTIONS.find(f => f.id === player.faction)?.color : undefined;
          const factionName = player?.faction ? FACTIONS.find(f => f.id === player.faction)?.name : undefined;

          return (
            <div
              key={index}
              onMouseEnter={() => log.tileId && onEntryMouseEnter?.(log.tileId)}
              onMouseLeave={() => onEntryMouseLeave?.()}
              className={`flex items-start gap-2 p-2 rounded-lg border-l-4 transition-all duration-200 ${isMainAction
                ? 'bg-zinc-800/40 border-y border-r border-y-white/10 border-r-white/10 shadow-[0_0_15px_rgba(0,0,0,0.3)]'
                : isPowerAction
                  ? 'bg-zinc-950/20 border-y border-r border-y-white/5 border-r-white/5 opacity-70'
                  : 'bg-zinc-900/30 border-y border-r border-y-white/5 border-r-white/5'
                } ${log.tileId ? 'cursor-pointer hover:border-primary/50 hover:bg-zinc-800/80' : 'hover:bg-zinc-800/60'}`}
              style={{
                borderLeftColor: factionColor ? factionColor : (isMainAction ? '#3b82f6' : '#52525b')
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <User className={`w-3 h-3 flex-shrink-0 opacity-70`} style={factionColor ? { color: factionColor } : {}} />
                    <span className={`text-[10px] font-black uppercase tracking-tighter truncate shrink-0`} style={factionColor ? { color: factionColor } : (isMainAction ? { color: '#f4f4f5' } : { color: '#a1a1aa' })}>
                      {log.playerName}{factionName ? ` (${factionName})` : ''}
                    </span>
                  </div>
                  <span className="text-[9px] text-muted-foreground/30 font-mono shrink-0">
                    {formatTime(log.timestamp)}
                  </span>
                </div>
                <div className="text-[11px] leading-tight mt-1">
                  <span className={`font-black uppercase tracking-tight`} style={factionColor ? { color: factionColor } : (isMainAction ? { color: factionColor || '#3b82f6' } : isPowerAction ? { color: '#71717a', fontSize: '10px' } : { color: '#d4d4d8' })}>
                    {log.action}
                  </span>
                  {log.details && (
                    <span className={`ml-1.5 ${isMainAction ? 'text-zinc-200 font-bold' : 'text-zinc-500 font-medium text-[10px]'}`}>
                      {log.details}
                    </span>
                  )}
                </div>
                {/* subLogs rendering */}
                {log.subLogs && log.subLogs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1 border-t border-white/5 pt-1.5">
                    {log.subLogs.map((subLog, i) => {
                      if (!subLog) return null;
                      const subPlayer = subLog.playerId ? game.players[subLog.playerId] : undefined;
                      const subColor = subPlayer?.faction ? FACTIONS.find(f => f.id === subPlayer.faction)?.color : undefined;
                      const subFactionName = subPlayer?.faction ? FACTIONS.find(f => f.id === subPlayer.faction)?.name : undefined;
                      const cleanText = subLog.text.replace(`↳ ${subLog.playerName} `, '').replace('↳ ', '');

                      return (
                        <div key={i} className="text-[9px] leading-[10px] flex items-center gap-1.5 bg-black/40 border border-white/5 px-2 py-1 rounded shadow-inner" style={{ borderLeft: subColor ? `2px solid ${subColor}` : '1px solid #3f3f46' }}>
                          <span className="font-black uppercase tracking-tighter shrink-0" style={subColor ? { color: subColor } : { color: '#c084fc' }}>
                            {subLog.playerName}
                          </span>
                          <span className="text-zinc-400 font-medium">{cleanText}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  if (hideHeader) {
    return (
      <ScrollArea className={`flex-1 ${className}`} style={{ height: maxHeight }}>
        {content}
      </ScrollArea>
    );
  }

  return (
    <Card className={`w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron shadow-2xl ${className}`}>
      <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50">
        <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Game Log
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea style={{ height: maxHeight }}>
          {content}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
