import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { GaiaGameState as GameState, ResearchTrack, TechTile } from '@shared/gameConfig';
import { FACTIONS, RESEARCH_TRACKS, SHIP_TECH_BY_SHIP, SHIP_TECH_TILES, ALL_TECH_TILES, ALL_ADVANCED_TECH_TILES, FEDERATION_REWARDS, ARTIFACTS, getFirstTrackTile, countGreenFederations, isTechTileCovered, SPACESHIP_FEDERATION_REWARDS, getFederationEntries } from '@shared/gameConfig';

interface ResearchBoardProps {
    game: GameState;
    playerId: string | null;
    onUsePowerAction: (actionId: string) => void;
    onUseHadschHallasPIAction?: (actionId: string) => void;
    onUseBalTakGaiaformerToQic?: () => void;
    onGainTechTile: (tileId: string) => void;
    onUseTechAction: (tileId: string) => void;
    onAdvanceTech: (trackId: ResearchTrack) => void;
    onUseShipAction?: (shipTileId: string, actionIndex: number, targetTileId?: string) => void;
    onSelectTechTile?: (techTileId: string, trackId?: string) => void;
    onSelectAdvancedTechTile?: (advancedTileId: string, trackId?: ResearchTrack) => void;
    onConfirmAdvancedTechCover?: (coverTileId: string) => void;
    onTakeTwilightArtifact?: (artifactId: string) => void;
    onUseAcademyQic?: () => void;
    /** 메인 액션 완료 후 턴 종료 (아카데미 QIC 등 사용 후 R 패널에서 바로 턴 종료 가능) */
    onEndTurn?: () => void;
}

const SHIP_NAMES: Record<string, string> = {
    ship_twilight: 'Twilight',
    ship_rebellion: 'Rebellion',
    ship_tf_mars: 'TF Mars',
    ship_eclipse: 'Eclipse',
};

/** 우주선별 액션 라벨 (잠긴 우주선에서도 표시용) */
const SHIP_ACTION_LABELS: Record<string, [string, string, string]> = {
    ship_twilight: ['3Q → Fed', '2O+3P → TS→Lab', '1K → +3 Range'],
    ship_rebellion: ['3Q → Tech', '1O+3P → M→TS', '2K → 1Q 2C'],
    ship_tf_mars: ['2Q → (2 + Tech Tiles)VP', '2P → Gaia', '3C → 1 TF'],
    ship_eclipse: ['2Q → (2 + Planet Types)VP', '2K+3P → Research', '6C → Ast'],
};

export function ResearchBoard({ game, playerId, onUsePowerAction, onUseHadschHallasPIAction, onUseBalTakGaiaformerToQic, onGainTechTile, onUseTechAction, onAdvanceTech, onUseShipAction, onSelectTechTile, onSelectAdvancedTechTile, onConfirmAdvancedTechCover, onTakeTwilightArtifact, onUseAcademyQic, onEndTurn }: ResearchBoardProps) {
    const players = Object.entries(game.players).map(([id, p]) => ({ ...p, id }));
    const [selectedTileIdNeedingTrack, setSelectedTileIdNeedingTrack] = useState<string | null>(null);

    const currentPlayer = playerId ? game.players[playerId] : null;
    const pendingTech = game.pendingTechTileSelection?.playerId === playerId ? game.pendingTechTileSelection : null;
    const hasShipTechOptions = Boolean(game.availableShipTechTileIds?.length);
    const pendingShipTrack = game.pendingShipTechTrackAdvance?.playerId === playerId;
    const pendingAdvTechTrack = game.pendingAdvancedTechTrackAdvance?.playerId === playerId;
    const pendingAdvancedCover = game.pendingAdvancedTechCover?.playerId === playerId ? game.pendingAdvancedTechCover : null;

    const balTakCanAdvanceNav = !currentPlayer || currentPlayer.faction !== 'bal_tak' || game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
    const effectiveGaiaformers = currentPlayer?.faction === 'bal_tak'
        ? Math.max(0, (currentPlayer.gaiaformers ?? 0) - (currentPlayer.balTakGaiaformersUsedForQic ?? 0))
        : (currentPlayer?.gaiaformers ?? 0);
    const isRebellionGain = pendingTech?.structureType === 'rebellion_gain';

    const handleTrackClick = (trackId: ResearchTrack) => {
        if (selectedTileIdNeedingTrack && onSelectTechTile) {
            onSelectTechTile(selectedTileIdNeedingTrack, trackId);
            setSelectedTileIdNeedingTrack(null);
            return;
        }

        // Bal'Tak Navigation track restriction
        if (trackId === 'navigation' && !balTakCanAdvanceNav) {
            return;
        }

        onAdvanceTech(trackId);
    };

    const getTechImg = (tileId: string) => {
        const tile = ALL_TECH_TILES.find(t => t.id === tileId) ||
            ALL_ADVANCED_TECH_TILES.find(t => t.id === tileId) ||
            SHIP_TECH_TILES.find(t => t.id === tileId);
        return tile?.image;
    };

    return (
        <Card className="w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron">
            <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50">
                <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400">
                    Galactic Research & Power Systems
                </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-8">
                {/* Status & Selection Area */}
                {(pendingTech || pendingAdvancedCover || pendingShipTrack || pendingAdvTechTrack) && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                        {/* Tech Selection (Standard/Ship) */}
                        {pendingTech && onSelectTechTile && (
                            <div className="space-y-3 p-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/5 backdrop-blur-sm shadow-2xl">
                                <h4 className="text-xs font-black uppercase tracking-wider text-yellow-400 flex items-center gap-2">
                                    <Badge variant="outline" className="bg-yellow-500/10 border-yellow-500/30 text-yellow-500">ACTION REQUIRED</Badge>
                                    {selectedTileIdNeedingTrack ? 'Select Track to Advance' : 'Choose Tech Tile'}
                                </h4>

                                {selectedTileIdNeedingTrack ? (
                                    <div className="grid grid-cols-6 gap-2 pt-2">
                                        {RESEARCH_TRACKS.map((track) => {
                                            const lvl = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                            return (
                                                <button
                                                    key={track.id}
                                                    onClick={() => {
                                                        onSelectTechTile(selectedTileIdNeedingTrack, track.id as ResearchTrack);
                                                        setSelectedTileIdNeedingTrack(null);
                                                    }}
                                                    className="p-2 rounded-xl border border-white/10 bg-zinc-900/80 hover:border-yellow-500 hover:bg-zinc-800 transition-all group"
                                                >
                                                    <div className="text-[10px] font-bold text-zinc-100">{track.name}</div>
                                                    <div className="text-[8px] text-zinc-500">Lv.{lvl} → {lvl + 1}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="flex flex-wrap gap-4">
                                        {/* Standard Pool Tiles */}
                                        <div className="flex flex-wrap gap-3">
                                            {(() => {
                                                const pool = game.techTilesPool || [];
                                                // Group by ID to show only unique slots in the selection pool
                                                const uniquePool = pool.filter((t, i, self) => t && self.findIndex(s => s?.id === t.id) === i);
                                                return uniquePool.map((tile) => (
                                                    <button
                                                        key={tile?.id}
                                                        onClick={() => setSelectedTileIdNeedingTrack(tile!.id)}
                                                        className="group relative w-24 h-24 rounded-lg overflow-hidden border border-white/10 hover:border-yellow-500 transition-all hover:scale-105 shadow-xl"
                                                    >
                                                        <img src={tile?.image} alt={tile?.label} className="w-full h-full object-cover" />
                                                        <div className="absolute inset-x-0 bottom-0 bg-black/80 p-1 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
                                                            {tile?.label}
                                                        </div>
                                                    </button>
                                                ));
                                            })()}
                                        </div>
                                        {/* Ship Tech Options */}
                                        {(hasShipTechOptions || isRebellionGain) && (
                                            <div className="flex flex-wrap gap-3 border-l border-white/10 pl-4">
                                                {game.availableShipTechTileIds?.map(id => {
                                                    const tile = SHIP_TECH_TILES.find(t => t.id === id);
                                                    return (
                                                        <button
                                                            key={id}
                                                            onClick={() => onSelectTechTile && onSelectTechTile(id)}
                                                            className="group relative w-24 h-24 rounded-lg overflow-hidden border border-cyan-500/30 hover:border-cyan-400 transition-all hover:scale-105 shadow-xl shadow-cyan-500/10"
                                                        >
                                                            <img src={tile?.image} alt={tile?.label} className="w-full h-full object-cover" />
                                                            <div className="absolute inset-x-0 bottom-0 bg-cyan-950/90 p-1 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
                                                                {tile?.label}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Advanced Tech Cover Selection */}
                        {pendingAdvancedCover && onConfirmAdvancedTechCover && currentPlayer && (
                            <div className="space-y-3 p-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 backdrop-blur-sm shadow-2xl">
                                <h4 className="text-xs font-black uppercase tracking-wider text-cyan-400">Select Tech Tile to Cover</h4>
                                <div className="flex flex-wrap gap-3">
                                    {(currentPlayer.techTiles || [])
                                        .filter((id: string) => !(currentPlayer.coveredTechTiles || []).includes(id) && !id.startsWith('adv-'))
                                        .map((id: string) => (
                                            <button
                                                key={id}
                                                onClick={() => onConfirmAdvancedTechCover(id)}
                                                className="group relative w-20 h-20 rounded-lg overflow-hidden border border-white/10 hover:border-cyan-400 transition-all hover:scale-105"
                                            >
                                                <img src={getTechImg(id)} alt={id} className="w-full h-full object-cover" />
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Main Board Image and Overlays */}
                <div className="relative w-full max-w-4xl mx-auto rounded-xl overflow-hidden shadow-2xl border border-white/10">
                    <img
                        src="/image/ResearchBoard_Full.png"
                        alt="Research Board"
                        className="w-full h-auto block"
                    />

                    {/* INTERACTIVE OVERLAYS - Positioning cubes and hitboxes */}
                    <div className="absolute inset-0">
                        {/* Research Tracks Hitboxes & Cubes */}
                        <div className="absolute top-[3.5%] left-[1.5%] w-[97%] h-[56%] flex">
                            {RESEARCH_TRACKS.map((track) => {
                                return (
                                    <div
                                        key={track.id}
                                        className="relative h-full transition-colors hover:bg-white/10 cursor-pointer"
                                        style={{ width: `${100 / 6}%` }}
                                        onClick={() => handleTrackClick(track.id as ResearchTrack)}
                                    >
                                        {/* Player Meeples for this track */}
                                        {players.map((p, pIdx) => {
                                            const level = p.research?.[track.id as ResearchTrack] ?? 0;
                                            const faction = FACTIONS.find(f => f.id === p.faction);

                                            // Precise vertical alignment for the 6 levels (0-5)
                                            // Adjusting to land exactly in the slots
                                            const levelOffsets = [2, 20.5, 39, 57.5, 75.5, 93.5];
                                            const bottomOffset = levelOffsets[level];

                                            // Improved stacking logic for visibility
                                            const xOffset = ((players.indexOf(p) - (players.length / 2)) * 6);

                                            return (
                                                <div
                                                    key={p.id}
                                                    className="absolute w-5 h-8 rounded-t-full rounded-b-sm border border-black/60 shadow-[0_4px_6px_-1px_rgba(0,0,0,0.6),0_2px_4px_-1px_rgba(0,0,0,0.4)] transition-all duration-700 hover:scale-110"
                                                    style={{
                                                        background: `linear-gradient(135deg, ${faction?.color}EE 0%, ${faction?.color} 50%, rgba(0,0,0,0.4) 100%)`,
                                                        bottom: `${bottomOffset}%`,
                                                        left: `calc(50% + ${xOffset}px)`,
                                                        transform: 'translateX(-50%)',
                                                        zIndex: 20 + level,
                                                        boxShadow: `inset 1px 1px 2px rgba(255,255,255,0.4), inset -1px -1px 2px rgba(0,0,0,0.3), 0 0 10px ${faction?.color}33`,
                                                    }}
                                                >
                                                    {/* Meeple Head Detail */}
                                                    <div className="absolute top-[10%] left-1/2 -translate-x-1/2 w-[70%] h-[30%] rounded-full bg-white/20 blur-[1px]" />
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Advanced Tech Tiles - Level 5 of Tracks */}
                        <div className="absolute top-[7.8%] left-[1.5%] w-[97%] h-[9%] flex pointer-events-none">
                            {RESEARCH_TRACKS.map((track) => {
                                const advTile = game.advancedTechTilesByTrack?.[track.id as ResearchTrack];
                                const isTaken = !advTile;
                                return (
                                    <div
                                        key={`adv-${track.id}`}
                                        className={`relative h-full flex items-center justify-center transition-all pointer-events-auto ${!isTaken ? 'cursor-pointer group/adv' : ''}`}
                                        style={{ width: `${100 / 6}%` }}
                                        onClick={() => advTile && onSelectAdvancedTechTile && onSelectAdvancedTechTile(advTile.id, track.id as ResearchTrack)}
                                    >
                                        {!isTaken && advTile?.image && (
                                            <div className="relative w-[95%] h-[95%] transition-transform group-hover/adv:scale-110">
                                                <img
                                                    src={advTile.image}
                                                    alt={advTile.label}
                                                    className="w-full h-full object-fill rounded-sm shadow-[0_4px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(255,255,255,0.1)] border border-white/5"
                                                    style={{ clipPath: 'inset(2px round 4px)' }}
                                                />
                                                <div className="absolute inset-0 border border-white/20 rounded-sm group-hover/adv:border-cyan-400 group-hover/adv:shadow-[0_0_15px_rgba(34,211,238,0.4)] transition-all" />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Standard Tech Tiles Acquisitions - Row 1 (Bottom of Tracks) */}
                        <div className="absolute top-[61%] left-[1.5%] w-[97%] h-[9%] flex">
                            {RESEARCH_TRACKS.map((track) => {
                                const trackTile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack);
                                const isTaken = !trackTile;
                                return (
                                    <div
                                        key={`tech-${track.id}`}
                                        className={`relative h-full flex items-center justify-center transition-all ${!isTaken ? 'cursor-pointer group/tech' : ''}`}
                                        style={{ width: `${100 / 6}%` }}
                                        onClick={() => trackTile && onGainTechTile(trackTile.id)}
                                    >
                                        {!isTaken && trackTile?.image && (
                                            <div className="relative w-[95%] h-[95%] transition-transform group-hover/tech:scale-110">
                                                <img
                                                    src={trackTile.image}
                                                    alt={trackTile.label}
                                                    className="w-full h-full object-fill rounded-sm shadow-[0_4px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(255,255,255,0.1)] border border-white/5"
                                                    style={{ clipPath: 'inset(2px round 4px)' }}
                                                />
                                                <div className="absolute inset-0 border border-white/20 rounded-sm group-hover/tech:border-yellow-400 group-hover/tech:shadow-[0_0_15px_rgba(250,204,21,0.4)] transition-all" />
                                            </div>
                                        )}
                                        {isTaken && (
                                            <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] m-1 rounded shadow-inner" />
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Extra Tech Tiles Acquisitions - Row 2 */}
                        <div className="absolute top-[72.8%] left-[1.5%] w-[97%] h-[9%] flex">
                            {/* Extra Standard Tech Tiles (3 slots) */}
                            <div className="w-[50%] flex">
                                {(() => {
                                    // Handle the 12-item pool (3 types x 4) by showing only the first unique copies
                                    const pool = game.techTilesPool || [];
                                    const groupedTiles: (TechTile | null)[] = [];
                                    const seenIds = new Set<string>();
                                    pool.forEach(t => {
                                        if (t && !seenIds.has(t.id)) {
                                            groupedTiles.push(t);
                                            seenIds.add(t.id);
                                        }
                                    });
                                    // Ensure we have 3 slots visually
                                    while (groupedTiles.length < 3) groupedTiles.push(null);

                                    return groupedTiles.slice(0, 3).map((tile, idx) => {
                                        const isTaken = !tile;
                                        return (
                                            <div
                                                key={`pool-${idx}`}
                                                className={`relative h-full flex items-center justify-center transition-all ${!isTaken ? 'cursor-pointer group/pool' : ''}`}
                                                style={{ width: `${100 / 3}%` }}
                                                onClick={() => tile && onGainTechTile(tile.id)}
                                            >
                                                {!isTaken && tile?.image && (
                                                    <div className="relative w-[95%] h-[95%] transition-transform group-hover/pool:scale-110">
                                                        <img
                                                            src={tile.image}
                                                            alt={tile.label}
                                                            className="w-full h-full object-fill rounded-sm shadow-[0_4px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(255,255,255,0.1)] border border-white/5"
                                                            style={{ clipPath: 'inset(2px round 4px)' }}
                                                        />
                                                        <div className="absolute inset-0 border border-white/20 rounded-sm group-hover/pool:border-yellow-400 group-hover/pool:shadow-[0_0_15px_rgba(250,204,21,0.4)] transition-all" />
                                                    </div>
                                                )}
                                                {isTaken && (
                                                    <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] m-1 rounded shadow-inner" />
                                                )}
                                            </div>
                                        );
                                    });
                                })()}
                            </div>

                            {/* Extra Advanced Tech Tile (1 slot aligned with Track 4) */}
                            <div className="w-[16.66%] flex items-center justify-center">
                                {game.extraAdvancedTechTile && (
                                    <div
                                        className="relative w-[95%] h-[95%] transition-all cursor-pointer group/extra-adv hover:scale-110"
                                        onClick={() => game.extraAdvancedTechTile && onSelectAdvancedTechTile && onSelectAdvancedTechTile(game.extraAdvancedTechTile.id)}
                                    >
                                        <img
                                            src={game.extraAdvancedTechTile.image}
                                            alt={game.extraAdvancedTechTile.label}
                                            className="w-full h-full object-fill rounded-sm shadow-[0_4px_8px_rgba(0,0,0,0.8),inset_0_0_10px_rgba(255,255,255,0.1)] border border-white/5"
                                            style={{ clipPath: 'inset(2px round 4px)' }}
                                        />
                                        <div className="absolute inset-0 border border-white/20 rounded-sm group-hover/extra-adv:border-cyan-400 group-hover/extra-adv:shadow-[0_0_15px_rgba(34,211,238,0.4)] transition-all" />
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* Power Actions Hitboxes */}
                        <div className="absolute top-[88%] left-[4.5%] w-[82%] h-[9%] flex gap-1">
                            {game.powerActions.map((action) => (
                                <div
                                    key={action.id}
                                    className={`relative flex-1 rounded hover:bg-white/10 transition-colors cursor-pointer ${action.isUsed ? 'bg-black/40 grayscale' : ''}`}
                                    onClick={() => onUsePowerAction(action.id)}
                                    title={action.label}
                                >
                                    {action.isUsed && (
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <Badge variant="outline" className="text-[7px] border-red-500/50 text-red-500 bg-red-500/10 uppercase">USED</Badge>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Footer Sections */}
                <div className="space-y-6">
                    {/* Faction Special & Ship Actions */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5 bg-zinc-900/20 p-4 rounded-xl">
                        <div className="space-y-4">
                            <h4 className="text-[10px] uppercase font-black tracking-widest text-zinc-500">Faction Specialization</h4>
                            <div className="flex flex-wrap gap-2">
                                {playerId && currentPlayer?.faction === 'bal_tak' && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={effectiveGaiaformers < 1}
                                        className="border-amber-500/30 bg-amber-950/30 hover:bg-amber-900/40 text-[10px] font-bold h-9"
                                        onClick={() => onUseBalTakGaiaformerToQic && onUseBalTakGaiaformerToQic()}
                                    >
                                        BAL T&apos;AK: 1 FORM → 1 QIC (Remains: {effectiveGaiaformers})
                                    </Button>
                                )}
                                {playerId && game.players[playerId]?.faction === 'hadsch_hallas' && game.players[playerId]?.hadschHallasPIActions?.map(action => (
                                    <Button
                                        key={action.id}
                                        variant="outline"
                                        size="sm"
                                        disabled={(game.players[playerId]?.credits ?? 0) < action.costCredits || action.isUsed}
                                        className="border-amber-500/30 bg-amber-950/30 hover:bg-amber-900/40 text-[10px] font-bold h-9"
                                        onClick={() => onUseHadschHallasPIAction && onUseHadschHallasPIAction(action.id)}
                                    >
                                        {action.label} ({action.costCredits}C)
                                    </Button>
                                ))}
                            </div>
                        </div>

                        {/* Turn Controls */}
                        <div className="flex justify-end items-center">
                            {playerId && game.turnOrder?.[game.currentPlayerIndex] === playerId && game.hasDoneMainAction && game.currentPhase === 'main' && !pendingTech && !pendingAdvancedCover && !pendingShipTrack && !pendingAdvTechTrack && onEndTurn && (
                                <Button
                                    className="bg-green-600 hover:bg-green-500 text-white font-black uppercase tracking-widest text-xs px-8 h-10 shadow-[0_0_20px_rgba(34,197,94,0.3)] animate-pulse"
                                    onClick={onEndTurn}
                                >
                                    End Tactical Phase
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Spaceships */}
                    {game.spaceships && Object.keys(game.spaceships).length > 0 && (
                        <div className="space-y-3 pt-4 border-t border-white/5">
                            <h4 className="text-[10px] uppercase font-black tracking-widest text-zinc-500">Fleet Operations</h4>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                {['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].map((shipType) => {
                                    const tile = game.map.find((t) => t.type === shipType);
                                    if (!tile || !game.spaceships?.[tile.id]) return null;
                                    const ship = game.spaceships![tile.id];
                                    const isLocked = !ship.unlocked;
                                    const isInShip = playerId && ship.occupants.includes(playerId);

                                    return (
                                        <div key={tile.id} className={`p-3 rounded-lg border bg-zinc-900/40 space-y-2 transition-all ${isLocked ? 'opacity-40 grayscale' : 'border-white/10 hover:border-cyan-500/30'}`}>
                                            <div className="flex items-center justify-between">
                                                <span className="text-[10px] font-bold text-zinc-300 uppercase">{shipType.split('_')[1]}</span>
                                                {isLocked && <Badge variant="outline" className="text-[7px] border-amber-500 text-amber-500">LOCKED</Badge>}
                                            </div>
                                            <div className="flex gap-1">
                                                {[0, 1, 2].map((idx) => {
                                                    const alreadyUsed = ship.usedActionIndices?.includes(idx + 1);
                                                    return (
                                                        <Button
                                                            key={idx}
                                                            size="sm"
                                                            disabled={isLocked || !isInShip || alreadyUsed}
                                                            variant="outline"
                                                            className={`h-8 flex-1 text-[8px] font-bold ${alreadyUsed ? 'opacity-30' : 'border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/10'}`}
                                                            onClick={() => onUseShipAction && onUseShipAction(tile.id, idx + 1)}
                                                        >
                                                            ACT {idx + 1}
                                                        </Button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
