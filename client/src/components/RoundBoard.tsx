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
            <CardContent className="p-4">
                <div className="flex flex-row gap-4">
                    {/* Left Side: Round Scoring Tiles - Fan Shape Layout (Refined) */}
                    <div className="w-[60%] min-w-0">
                        <div className="relative h-[220px] flex justify-center items-end bg-zinc-900/20 rounded-2xl border border-white/5 overflow-hidden">
                            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-32 h-1 bg-primary/20 rounded-full blur-2xl" />

                            {game.roundScoringTiles.map((tile, index) => {
                                const isCurrent = (index + 1) === game.roundNumber;
                                const isPast = (index + 1) < game.roundNumber;
                                const isSelected = tile.id !== '' && tile.condition !== '';

                                // Tighter fan shape for perfect 180 degree contact
                                const totalTiles = 6;
                                const startAngle = -75;
                                const endAngle = 75;
                                const angleStep = (endAngle - startAngle) / (totalTiles - 1);
                                const angle = startAngle + (index * angleStep);

                                // Smaller radius to bring tiles together to center
                                const radius = 55;

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
                                            bottom: '0px',
                                            left: '50%',
                                            transformOrigin: 'bottom center',
                                            transform: `translateX(-50%) rotate(${angle}deg) translateY(${-radius}px)`,
                                            zIndex: isCurrent ? 30 : 10 + index,
                                        }}
                                        className={`group flex flex-col items-center transition-all duration-500 ${isCurrent && isSelected
                                            ? 'scale-110 drop-shadow-[0_0_20px_rgba(255,255,255,0.15)] z-30'
                                            : isPast && isSelected
                                                ? 'opacity-20 grayscale brightness-[0.4] contrast-75'
                                                : 'opacity-90 hover:opacity-100 hover:scale-105'
                                            }`}
                                    >
                                        {/* Tile Wrapper with specific Gaia Project shape aspect ratio */}
                                        <div className={`relative w-24 h-36 flex items-center justify-center transition-all duration-300`}>
                                            {tileImg ? (
                                                <div className="w-full h-full relative group">
                                                    <img
                                                        src={tileImg}
                                                        alt={tile.condition}
                                                        className={`w-full h-full object-contain drop-shadow-md ${isCurrent ? 'brightness-110 saturate-[1.1]' : isPast ? 'brightness-50' : 'opacity-90'
                                                            }`}
                                                        onError={(e) => {
                                                            (e.target as HTMLImageElement).style.display = 'none';
                                                            (e.target as HTMLImageElement).parentElement!.classList.add('flex', 'items-center', 'justify-center', 'fixed-aspect-fallback');
                                                        }}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center bg-zinc-900/60 rounded-lg border border-white/5 border-dashed">
                                                    <div className="text-[10px] font-black text-zinc-600">RD {index + 1}</div>
                                                    <div className="text-xl font-black text-zinc-700">?</div>
                                                </div>
                                            )}

                                            {/* Selection Glow (Current Round) */}
                                            {isCurrent && (
                                                <div className="absolute inset-0 bg-primary/10 rounded-xl blur-xl -z-10 animate-pulse" />
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Right Side: Final Missions */}
                    <div className="w-[40%] flex flex-col justify-center">

                        <div className="grid grid-cols-1 gap-2">
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
                                    <div key={missionId} className="group rounded-xl overflow-hidden border border-white/10 bg-zinc-900/60 shadow-lg h-24 flex items-stretch">
                                        {/* Left: Mission Image */}
                                        <div className="w-1/3 bg-black/40 flex items-center justify-center p-1 border-r border-white/5">
                                            {missionImg ? (
                                                <img
                                                    src={missionImg}
                                                    alt={label}
                                                    className="w-full h-full object-contain brightness-100 group-hover:brightness-110 transition-all duration-300"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-800 font-black">
                                                    {missionId}
                                                </div>
                                            )}
                                        </div>

                                        {/* Right: Mission Info */}
                                        <div className="w-2/3 p-2 flex flex-col justify-between bg-zinc-900/40">
                                            <div className="text-[10px] uppercase font-black text-zinc-300 tracking-wider line-clamp-2 leading-tight">
                                                {label}
                                            </div>

                                            <div className="flex flex-wrap items-center gap-1.5 mt-auto">
                                                {playerValues.length === 0 ? (
                                                    <span className="text-[9px] text-zinc-600 font-bold tracking-tighter uppercase">— No Data —</span>
                                                ) : (
                                                    playerValues.map(({ playerId, value, color, name }) => (
                                                        <div
                                                            key={playerId}
                                                            className="flex items-center gap-1 bg-black/40 px-1 py-0.5 rounded border border-white/5"
                                                            title={name}
                                                        >
                                                            <div
                                                                className="w-1.5 h-1.5 rounded-full"
                                                                style={{ backgroundColor: color }}
                                                            />
                                                            <span
                                                                className="text-[10px] font-black tabular-nums"
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
