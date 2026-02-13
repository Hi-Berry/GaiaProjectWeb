import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GaiaGameState as GameState } from '@shared/gameConfig';
import { FACTIONS, FINAL_MISSION_LABELS, getFinalMissionValue } from '@shared/gameConfig';
import { Calendar, Trophy, Zap } from 'lucide-react';

interface RoundBoardProps {
    game: GameState;
    playerId: string | null;
    onPass?: () => void;
    onEndGame?: () => void;
}

export function RoundBoard({ game, playerId, onPass, onEndGame }: RoundBoardProps) {
    const isCurrentTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
    const canPass = isCurrentTurn && !game.hasDoneMainAction;
    const isRound6 = game.roundNumber === 6;

    return (
        <Card className="w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron shadow-2xl">
            <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50 flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" />
                    <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400">
                        Sector Scoring & Timeline
                    </CardTitle>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-tighter">Current Phase</span>
                        <Badge variant="outline" className="text-[10px] bg-primary/10 border-primary/30 text-primary font-black px-2 uppercase tracking-widest">
                            Round {game.roundNumber || 1}
                        </Badge>
                    </div>
                    {onPass && (
                        <>
                            <div className="h-6 w-[1px] bg-white/10" />
                            {isRound6 ? (
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={!canPass}
                                    onClick={onEndGame}
                                    className="text-[10px] font-black uppercase tracking-widest px-3 h-7"
                                >
                                    End Game
                                </Button>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!canPass}
                                    onClick={onPass}
                                    className="text-[10px] font-black uppercase tracking-widest px-3 h-7 border-red-500/30 text-red-400 hover:bg-red-500/10"
                                >
                                    Pass
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </CardHeader>
            <CardContent className="p-4 space-y-6">
                {/* Round Scoring Tiles */}
                <div className="grid grid-cols-6 gap-3">
                    {game.roundScoringTiles.map((tile, index) => {
                        const isCurrent = (index + 1) === game.roundNumber;
                        const isPast = (index + 1) < game.roundNumber;
                        const isSelected = tile.id !== '' && tile.condition !== '';

                        return (
                            <div
                                key={tile.id || `round-${index + 1}`}
                                className={`relative group flex flex-col items-center p-3 rounded-xl border transition-all duration-500 ${isCurrent && isSelected
                                        ? 'bg-primary/10 border-primary border-2 shadow-[0_0_20px_rgba(var(--primary),0.1)] scale-105 z-10'
                                        : isPast && isSelected
                                            ? 'bg-zinc-900/50 border-white/5 opacity-30 grayscale'
                                            : isSelected
                                                ? 'bg-zinc-900/30 border-white/5 hover:border-white/20'
                                                : 'bg-zinc-900/20 border-white/5 opacity-50'
                                    }`}
                            >
                                <div className="absolute -top-2 -left-2">
                                    <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black ${isCurrent && isSelected ? 'bg-primary text-black' : 'bg-zinc-800 text-zinc-400'
                                        }`}>
                                        {index + 1}
                                    </div>
                                </div>

                                <div className="mt-2 text-center space-y-1 w-full">
                                    {isSelected ? (
                                        <>
                                            <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400 truncate">
                                                {tile.condition}
                                            </div>
                                            <div className="text-2xl font-black text-white flex items-center justify-center gap-1">
                                                <span className="text-primary">+</span>
                                                {tile.vp}
                                                <Zap className="w-3 h-3 text-yellow-500 fill-yellow-500" />
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="text-[10px] font-black uppercase tracking-widest text-zinc-500 truncate">
                                                미정
                                            </div>
                                            <div className="text-lg font-black text-zinc-600 flex items-center justify-center gap-1">
                                                ?
                                            </div>
                                        </>
                                    )}
                                </div>

                                {isCurrent && isSelected && (
                                    <div className="absolute inset-x-0 -bottom-1 flex justify-center">
                                        <div className="h-1 w-2/3 bg-primary rounded-full animate-pulse shadow-[0_0_10px_rgba(var(--primary),0.5)]" />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Final Missions (6라운드 종료 시 1/2/3등 18/12/6점, 동점 시 합산 후 나눔) */}
                <div className="pt-4 border-t border-white/5">
                    <div className="flex items-center gap-2 mb-3">
                        <Trophy className="w-3.5 h-3.5 text-yellow-500" />
                        <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Final Missions (1st 18 / 2nd 12 / 3rd 6 VP)</h4>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        {(game.finalMissionIds ?? []).map((missionId) => {
                            const label = FINAL_MISSION_LABELS[missionId] ?? missionId;
                            const playerValues = game.turnOrder
                                .map((pid) => ({
                                    playerId: pid,
                                    value: getFinalMissionValue(game, pid, missionId),
                                    color: FACTIONS.find((f) => f.id === game.players[pid]?.faction)?.color ?? '#888',
                                }))
                                .filter((p) => p.value > 0)
                                .sort((a, b) => b.value - a.value);
                            return (
                                <div key={missionId} className="bg-zinc-900/40 p-3 rounded-xl border border-white/5 hover:bg-zinc-900/60 transition-colors">
                                    <div className="text-[9px] uppercase font-bold text-zinc-500 tracking-widest mb-1.5">{label}</div>
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        {playerValues.length === 0 ? (
                                            <span className="text-[10px] text-zinc-600">—</span>
                                        ) : (
                                            playerValues.map(({ playerId, value, color }) => (
                                                <span
                                                    key={playerId}
                                                    className="text-sm font-bold tabular-nums"
                                                    style={{ color }}
                                                    title={game.players[playerId]?.name}
                                                >
                                                    {value}
                                                </span>
                                            ))
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

            </CardContent>
        </Card>
    );
}
