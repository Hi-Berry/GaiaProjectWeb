import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GaiaGameState as GameState } from '@shared/gameConfig';
import { FACTIONS, FINAL_MISSION_LABELS, getFinalMissionValue } from '@shared/gameConfig';
import { Calendar, Trophy, Zap } from 'lucide-react';

interface RoundBoardProps {
    game: GameState;
    playerId: string | null;
    onEndGame?: () => void;
    isMini?: boolean;
}

export function RoundBoard({ game, playerId, onEndGame, isMini = false }: RoundBoardProps) {
    const isCurrentTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
    const canPass = isCurrentTurn && !game.hasDoneMainAction;
    const isRound6 = game.roundNumber === 6;

    return (
        <Card className={`w-full text-zinc-100 overflow-hidden font-orbitron ${isMini ? 'border-none shadow-none bg-transparent' : 'bg-zinc-950 border-white/5 shadow-2xl'}`}>
            {!isMini && (
                <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50 flex flex-row items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-primary" />
                        <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400">
                            Round Mission & Final Mission
                        </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-tighter">Current Phase</span>
                            <Badge variant="outline" className="text-[10px] bg-primary/10 border-primary/30 text-primary font-black px-2 uppercase tracking-widest">
                                Round {game.roundNumber || 1}
                            </Badge>
                        </div>
                        {game.roundNumber === 6 && onEndGame && (
                            <>
                                <div className="h-6 w-[1px] bg-white/10" />
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={!canPass}
                                    onClick={onEndGame}
                                    className="text-[10px] font-black uppercase tracking-widest px-3 h-7"
                                >
                                    End Game
                                </Button>
                            </>
                        )}
                    </div>
                </CardHeader>
            )}
            <CardContent className={isMini ? 'p-1' : 'p-4'}>
                <div className={`flex ${isMini ? 'flex-row items-center justify-between gap-1' : 'flex-row gap-4'}`}>
                    {/* Left Side: Round Scoring Tiles */}
                    <div className={isMini ? 'w-[65%] shrink-0' : 'w-[60%] min-w-0'}>
                        <div className={`relative ${isMini ? 'h-[100px]' : 'h-[220px]'} flex justify-center items-end bg-zinc-900/20 rounded-xl border border-white/5 overflow-hidden`}>
                            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-1 bg-primary/10 rounded-full blur-xl" />

                            {game.roundScoringTiles.map((tile, index) => {
                                const isCurrent = (index + 1) === game.roundNumber;
                                const isPast = (index + 1) < game.roundNumber;
                                const isSelected = tile.id !== '' && tile.condition !== '';

                                // Restore original wide fan angle
                                const totalTiles = 6;
                                const startAngle = -75;
                                const endAngle = 75;
                                const angleStep = (endAngle - startAngle) / (totalTiles - 1);
                                const angle = startAngle + (index * angleStep);

                                // Restore comfortable radius
                                const radius = isMini ? 40 : 55;

                                const getTileImage = (id: string) => {
                                    if (!id) return null;
                                    const numStr = id.replace('rs', '');
                                    return `/image/RS_${numStr}.gif`;
                                };

                                const tileImg = getTileImage(tile.id);

                                return (
                                    <div
                                        key={tile.id || `round-${index + 1}`}
                                        style={{
                                            position: 'absolute',
                                            bottom: '-2px',
                                            left: '50%',
                                            transformOrigin: 'bottom center',
                                            transform: `translateX(-50%) rotate(${angle}deg) translateY(${-radius}px)`,
                                            zIndex: isCurrent ? 30 : 10 + index,
                                        }}
                                        className={`group flex flex-col items-center transition-all duration-500 ${isCurrent && isSelected
                                            ? 'scale-110 drop-shadow-[0_0_15px_rgba(255,255,255,0.15)] z-30'
                                            : isPast && isSelected
                                                ? 'opacity-20 grayscale brightness-[0.3] contrast-75'
                                                : 'opacity-90 hover:opacity-100'
                                            }`}
                                    >
                                        <div className={`relative ${isMini ? 'w-12 h-18' : 'w-24 h-36'} flex items-center justify-center transition-all duration-300`}>
                                            {tileImg ? (
                                                <div className="w-full h-full relative group">
                                                    <img
                                                        src={tileImg}
                                                        alt={tile.condition}
                                                        className={`w-full h-full object-contain ${isCurrent ? 'brightness-110 saturate-[1.1]' : isPast ? 'brightness-50' : 'opacity-90'
                                                            }`}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="w-full h-full flex flex-col items-center justify-center p-0.5 text-center bg-zinc-900/60 rounded border border-white/5 border-dashed">
                                                    <div className="text-[8px] font-black text-zinc-600">R{index + 1}</div>
                                                </div>
                                            )}

                                            {isCurrent && (
                                                <div className="absolute inset-0 bg-primary/10 rounded-lg blur-md -z-10 animate-pulse" />
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Right Side: Final Missions */}
                    <div className={isMini ? 'flex-1 min-w-0' : 'w-[40%] flex flex-col justify-center'}>
                        <div className={`grid ${isMini ? 'grid-cols-1 gap-1' : 'grid-cols-1 gap-2'}`}>
                            {(game.finalMissionIds ?? []).map((missionId) => {
                                const label = FINAL_MISSION_LABELS[missionId] ?? missionId;
                                const missionKeys = Object.keys(FINAL_MISSION_LABELS);
                                const missionIndex = missionKeys.indexOf(missionId);
                                const missionImg = missionIndex !== -1 ? `/image/EGS_${missionIndex + 1}.jpg` : null;

                                const playerValues = game.turnOrder
                                    .map((pid) => ({
                                        playerId: pid,
                                        value: getFinalMissionValue(game, pid, missionId),
                                        color: FACTIONS.find((f) => f.id === game.players[pid]?.faction)?.color ?? '#888',
                                        name: game.players[pid]?.name
                                    }))
                                    .filter((p) => p.value > 0)
                                    .sort((a, b) => b.value - a.value);

                                return (
                                    <div key={missionId} className={`group rounded-lg overflow-hidden border border-white/5 bg-zinc-900/40 shadow-sm ${isMini ? 'h-[64px]' : 'h-24'} flex items-stretch`}>
                                        {/* Left: Mission Image */}
                                        <div className={`${isMini ? 'w-16' : 'w-24'} bg-black/40 flex items-center justify-center p-1 border-r border-white/5`}>
                                            {missionImg ? (
                                                <img
                                                    src={missionImg}
                                                    alt={missionId}
                                                    className="w-full h-full object-contain brightness-100 group-hover:brightness-110 transition-all duration-300"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-[8px] text-zinc-800 font-black">
                                                    ?
                                                </div>
                                            )}
                                        </div>

                                        {/* Right: Mission Info */}
                                        <div className={`flex-1 p-2 flex flex-col justify-center bg-zinc-900/20`}>
                                            {!isMini && (
                                                <div className="text-[11px] uppercase font-black text-zinc-300 tracking-wider mb-2 border-b border-white/5 pb-1">
                                                    {label}
                                                </div>
                                            )}
                                            
                                            <div className={isMini ? "grid grid-cols-1 gap-0.5 w-full" : "flex flex-wrap gap-2"}>
                                                {playerValues.length === 0 ? (
                                                    <span className="text-[8px] text-zinc-700 font-bold text-center">—</span>
                                                ) : (
                                                    playerValues.map(({ playerId, value, color, name }) => (
                                                        <div
                                                            key={playerId}
                                                            className={`flex items-center gap-1 ${isMini ? 'justify-start px-1' : 'bg-black/40 px-2 py-1 rounded border border-white/5'}`}
                                                            title={name}
                                                        >
                                                            <div
                                                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                                                style={{ backgroundColor: color }}
                                                            />
                                                            {!isMini && (
                                                                <span className="text-[10px] font-bold text-zinc-400 mr-1">
                                                                    {name}
                                                                </span>
                                                            )}
                                                            <span
                                                                className={`${isMini ? 'text-[9px]' : 'text-[11px]'} font-black tabular-nums leading-none`}
                                                                style={{ color }}
                                                            >
                                                                {value}
                                                            </span>
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
