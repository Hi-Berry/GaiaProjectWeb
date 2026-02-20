import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GaiaGameState as GameState, ResearchTrack } from '@shared/gameConfig';
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
    const balTakCanAdvanceNav = !currentPlayer || currentPlayer.faction !== 'bal_tak' || game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
    const effectiveGaiaformers = currentPlayer?.faction === 'bal_tak'
        ? Math.max(0, (currentPlayer.gaiaformers ?? 0) - (currentPlayer.balTakGaiaformersUsedForQic ?? 0))
        : (currentPlayer?.gaiaformers ?? 0);

    const pendingTech = game.pendingTechTileSelection?.playerId === playerId ? game.pendingTechTileSelection : null;
    /** 우주선 기술 타일도 선택지에 포함 (리벨리온 3Q, 연구소 건설 시 트랙+풀+우주선 모두 선택 가능) */
    const hasShipTechOptions = Boolean(game.availableShipTechTileIds?.length);
    const isRebellionGain = pendingTech?.structureType === 'rebellion_gain';
    const pendingShipTrack = game.pendingShipTechTrackAdvance?.playerId === playerId;
    const pendingAdvTechTrack = game.pendingAdvancedTechTrackAdvance?.playerId === playerId;
    const pendingAdvancedCover = game.pendingAdvancedTechCover?.playerId === playerId ? game.pendingAdvancedTechCover : null;

    const handleTrackClick = (trackId: ResearchTrack) => {
        if (selectedTileIdNeedingTrack && onSelectTechTile) {
            onSelectTechTile(selectedTileIdNeedingTrack, trackId);
            setSelectedTileIdNeedingTrack(null);
        } else {
            onAdvanceTech(trackId);
        }
    };

    return (
        <Card className="w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron">
            <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50">
                <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400">
                    Galactic Research & Power Systems
                </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-8">
                {/* 메인 액션 완료 후, 기술/트랙 등 선택할 게 없을 때만 턴 종료 버튼 표시 */}
                {playerId && game.turnOrder?.[game.currentPlayerIndex] === playerId && game.hasDoneMainAction && game.currentPhase === 'main' && game.pendingTFMarsGaiaProject?.playerId !== playerId && !pendingTech && !pendingAdvancedCover && !pendingShipTrack && !pendingAdvTechTrack && onEndTurn && (
                    <div className="p-3 rounded-xl border border-green-500/40 bg-green-500/10">
                        <p className="text-[10px] text-zinc-400 mb-2">메인 액션을 완료했습니다. 턴을 종료하려면 아래 버튼을 누르세요.</p>
                        <Button size="sm" className="w-full bg-green-600 hover:bg-green-500 text-white text-xs font-bold" onClick={onEndTurn}>
                            턴 종료 (End Turn)
                        </Button>
                    </div>
                )}
                {/* 기술 타일 선택 (R창 내, 팝업 없음) */}
                {pendingTech && onSelectTechTile && (
                    <div className="space-y-3 p-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5">
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-yellow-400">
                            {selectedTileIdNeedingTrack ? '올릴 기술 라인을 클릭해주세요' : '기술 타일을 선택하세요'}
                        </h4>
                        {selectedTileIdNeedingTrack ? (
                            <>
                                <p className="text-[9px] text-zinc-400">올릴 트랙을 아래 6개 중에서 클릭하세요.</p>
                                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 pt-1">
                                    {RESEARCH_TRACKS.map((track) => {
                                        const lvl = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                        const navBlocked = track.id === 'navigation' && !balTakCanAdvanceNav;
                                        const disabled = lvl >= 5 || navBlocked;
                                        return (
                                            <button
                                                key={track.id}
                                                type="button"
                                                disabled={disabled}
                                                title={navBlocked ? "발타크: 의회 건설 후 Nav 트랙 진행 가능" : undefined}
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (!onSelectTechTile || !selectedTileIdNeedingTrack) return;
                                                    const tid = track.id as ResearchTrack;
                                                    onSelectTechTile(selectedTileIdNeedingTrack, tid);
                                                    setSelectedTileIdNeedingTrack(null);
                                                }}
                                                className="p-2 rounded-lg border-2 border-yellow-500/40 bg-zinc-900/80 hover:border-yellow-500 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed text-center"
                                                style={{ borderColor: disabled ? undefined : track.color ? `${track.color}99` : undefined }}
                                            >
                                                <div className="text-[9px] font-bold text-zinc-100">{track.name}</div>
                                                <div className="text-[8px] text-zinc-500">Lv.{lvl}/5</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="text-[9px] text-zinc-400 mb-1">6트랙 + 풀 (이미 가진 타일 제외)</div>
                                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                                    {RESEARCH_TRACKS.map((track) => {
                                        const tile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack);
                                        if (!tile) return null;
                                        return (
                                            <button
                                                key={tile.id}
                                                type="button"
                                                onClick={() => onSelectTechTile(tile.id, track.id)}
                                                className="p-2 rounded-lg border border-white/20 bg-zinc-900/80 hover:border-yellow-500/50"
                                            >
                                                <div className="text-[9px] font-bold text-zinc-100 truncate">{tile.label}</div>
                                                <div className="text-[8px] text-zinc-500 truncate" title={tile.description}>{tile.description}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="text-[9px] text-zinc-500 mt-1">하단 풀 3개 (선택 후 트랙 클릭):</div>
                                <div className="grid grid-cols-3 gap-2">
                                    {(game.techTilesPool || []).map((tile, idx) => !tile ? (
                                        <div key={`pool-empty-${idx}`} className="p-2 rounded-lg border border-dashed border-white/10 bg-zinc-900/40 min-h-[3rem] flex items-center justify-center text-[9px] text-zinc-500">빈 칸</div>
                                    ) : (
                                        <button
                                            key={tile.id}
                                            type="button"
                                            onClick={() => setSelectedTileIdNeedingTrack(tile.id)}
                                            className="p-2 rounded-lg border border-yellow-500/30 bg-zinc-900/80 hover:border-yellow-500"
                                        >
                                            <div className="text-[9px] font-bold text-zinc-100 truncate">{tile.label}</div>
                                            <div className="text-[8px] text-zinc-500 truncate">{tile.description}</div>
                                        </button>
                                    ))}
                                </div>
                                {hasShipTechOptions && (
                                    <>
                                        <div className="text-[9px] text-zinc-500 mt-3">우주선 기술 타일:</div>
                                        <div className="grid grid-cols-3 gap-2">
                                            {(game.availableShipTechTileIds || []).map((id) => {
                                                const tile = SHIP_TECH_TILES.find((t) => t.id === id);
                                                if (!tile) return null;
                                                return (
                                                    <button
                                                        key={tile.id}
                                                        type="button"
                                                        onClick={() => onSelectTechTile(tile.id)}
                                                        className="p-3 rounded-lg border-2 border-yellow-500/40 bg-zinc-900/80 hover:border-yellow-500 text-left"
                                                    >
                                                        <div className="text-[10px] font-bold text-zinc-100">{tile.label}</div>
                                                        <div className="text-[8px] text-zinc-500 truncate">{tile.description}</div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* 고급 기술 타일: 덮을 일반 타일 선택 */}
                {pendingAdvancedCover && onConfirmAdvancedTechCover && currentPlayer && (
                    <div className="space-y-3 p-3 rounded-xl border border-cyan-500/30 bg-cyan-500/5">
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-cyan-400">덮을 일반 기술 타일을 선택하세요</h4>
                        <p className="text-[9px] text-zinc-400">선택한 타일은 고급 타일에 의해 덮이며, 수입·액션·큰건물 보너스가 적용되지 않습니다.</p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {(currentPlayer.techTiles || [])
                                .filter((id: string) => !(currentPlayer.coveredTechTiles || []).includes(id) && !id.startsWith('adv-'))
                                .map((id: string) => {
                                    const tile = ALL_TECH_TILES.find(t => t.id === id) || ALL_ADVANCED_TECH_TILES.find(t => t.id === id) || SHIP_TECH_TILES.find(t => t.id === id);
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => onConfirmAdvancedTechCover(id)}
                                            className="p-3 rounded-lg border-2 border-cyan-500/40 bg-zinc-900/80 hover:border-cyan-400 text-left"
                                        >
                                            <div className="text-[10px] font-bold text-zinc-100">{tile?.label ?? id}</div>
                                            <div className="text-[8px] text-zinc-500 truncate">{tile?.description}</div>
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                )}

                {/* 우주선 기술 타일 / 고급 기술 타일 획득 후: 올릴 트랙 선택 (6개 중 1개) */}
                {(pendingShipTrack || pendingAdvTechTrack) && onAdvanceTech && (
                    <div className="space-y-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-400">올릴 기술 라인을 클릭하세요</h4>
                        <p className="text-[9px] text-zinc-400">{pendingAdvTechTrack ? '고급 기술 타일 보상' : '우주선 기술 타일 보상'} — 6개 트랙 중 하나를 선택하세요.</p>
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            {RESEARCH_TRACKS.map((track) => {
                                const lvl = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                const navBlocked = track.id === 'navigation' && !balTakCanAdvanceNav;
                                const disabled = lvl >= 5 || navBlocked;
                                return (
                                    <button
                                        key={track.id}
                                        type="button"
                                        disabled={disabled}
                                        title={navBlocked ? "발타크: 의회 건설 후 Nav 트랙 진행 가능" : undefined}
                                        onClick={() => onAdvanceTech(track.id as ResearchTrack)}
                                        className="p-3 rounded-lg border-2 border-amber-500/40 bg-zinc-900/80 hover:border-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-center"
                                        style={{ borderColor: disabled ? undefined : track.color ? `${track.color}80` : undefined }}
                                    >
                                        <div className="text-[10px] font-bold text-zinc-100">{track.name}</div>
                                        <div className="text-[9px] text-zinc-500">Lv.{lvl}/5</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Research Tracks Grid */}
                <div className="grid grid-cols-6 gap-3">
                    {RESEARCH_TRACKS.map((track) => {
                        const navBlocked = track.id === 'navigation' && !balTakCanAdvanceNav;
                        return (
                        <div
                            key={track.id}
                            className={`flex flex-col gap-2 p-1 rounded transition-colors group ${navBlocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'}`}
                            onClick={() => { if (!navBlocked) handleTrackClick(track.id as ResearchTrack); }}
                            title={navBlocked ? "발타크: 의회 건설 후 Nav 트랙 진행 가능" : undefined}
                        >
                            {/* Track Title */}
                            <div className="text-[10px] font-black uppercase tracking-tighter text-center truncate px-1" style={{ color: track.color }}>
                                {track.name}
                            </div>

                            {/* Track Levels & Tiles Stack */}
                            <div className="flex flex-col-reverse gap-1 bg-zinc-900/30 p-1 rounded-xl border border-white/5 relative">
                                {/* Standard Tech Tile Slot (Exactly under Level 0) - 빈 칸이어도 자리 유지 */}
                                {getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack) ? (
                                    (() => {
                                        const trackTile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack)!;
                                        return (
                                    <div
                                        className="mt-1 p-2 bg-zinc-900/60 rounded-lg border border-yellow-500/20 hover:border-yellow-500/50 transition-all cursor-pointer group relative shadow-lg"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (pendingTech && onSelectTechTile) {
                                                if (selectedTileIdNeedingTrack) {
                                                    onSelectTechTile(selectedTileIdNeedingTrack, track.id as ResearchTrack);
                                                    setSelectedTileIdNeedingTrack(null);
                                                } else {
                                                    onSelectTechTile(trackTile.id, track.id as ResearchTrack);
                                                }
                                            } else {
                                                onGainTechTile(trackTile.id);
                                            }
                                        }}
                                    >
                                        <div className="text-[9px] font-black text-center text-zinc-100 uppercase truncate leading-none py-1">
                                            {trackTile.label}
                                        </div>
                                        {/* Tooltip */}
                                        <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-50 w-48 p-2 bg-zinc-950 border border-yellow-500/20 rounded-lg shadow-2xl">
                                            <div className="text-[10px] font-black text-yellow-500 mb-1 uppercase pb-1 border-b border-white/5">
                                                {trackTile.label}
                                            </div>
                                            <p className="text-[10px] text-zinc-300 leading-relaxed font-medium">
                                                {trackTile.description}
                                            </p>
                                        </div>
                                    </div>
                                        );
                                    })()
                                ) : (
                                    <div className="mt-1 p-2 rounded-lg border border-dashed border-white/10 bg-zinc-900/30 flex items-center justify-center text-[8px] text-zinc-500 min-h-[2.5rem]">빈 칸</div>
                                )}

                                {/* Levels 0-5 */}
                                {[0, 1, 2, 3, 4, 5].map((level) => {
                                    const getTrackBonus = (trackId: string, lvl: number): string => {
                                        if (trackId === 'terraforming') {
                                            if (lvl === 0) return '3 Ore/Step';
                                            if (lvl === 1) return '2 Ore/Step (+2O)';
                                            if (lvl === 2) return '2 Ore/Step';
                                            if (lvl === 3) return '1 Ore/Step';
                                            if (lvl === 4) return '1 Ore/Step (+2O)';
                                            if (lvl === 5) return 'L5: 연방';
                                        }
                                        if (trackId === 'navigation') {
                                            if (lvl === 0) return 'Range 1';
                                            if (lvl === 1) return 'Range 1 (+1Q)';
                                            if (lvl === 2) return 'Range 2';
                                            if (lvl === 3) return 'Range 2 (+1Q)';
                                            if (lvl === 4) return 'Range 3';
                                            if (lvl === 5) return 'Range 4';
                                        }
                                        if (trackId === 'artificialIntelligence') {
                                            if (lvl === 0) return '';
                                            if (lvl === 1) return '+1 QIC';
                                            if (lvl === 2) return '+1 QIC';
                                            if (lvl === 3) return '+2 QIC';
                                            if (lvl === 4) return '+2 QIC';
                                            if (lvl === 5) return '+4 QIC';
                                        }
                                        if (trackId === 'gaiaProject') {
                                            if (lvl === 0) return '';
                                            if (lvl === 1) return '1 Gaiaformer';
                                            if (lvl === 2) return '+3 Tokens';
                                            if (lvl === 3) return '2 Gaiaformers';
                                            if (lvl === 4) return '3 Gaiaformers';
                                            if (lvl === 5) return '4VP + Gaia';
                                        }
                                        if (trackId === 'economy') {
                                            if (lvl === 0) return '';
                                            if (lvl === 1) return '1C, 1P';
                                            if (lvl === 2) return '1O, 2C, 2P';
                                            if (lvl === 3) return game.economyVariant === 'vp' ? '1O, 3C, 1VP' : '1O, 2C, 3P';
                                            if (lvl === 4) return game.economyVariant === 'vp' ? '2O, 4C, 1VP' : '2O, 2C, 2P';
                                            if (lvl === 5) return 'L5: 3O, 6C, 6P';
                                        }
                                        if (trackId === 'science') {
                                            if (lvl === 0) return '';
                                            if (lvl === 1) return '1K';
                                            if (lvl === 2) return '2K';
                                            if (lvl === 3) return '3K';
                                            if (lvl === 4) return '4K';
                                            if (lvl === 5) return 'L5: +9K';
                                        }
                                        return '';
                                    };

                                    return (
                                        <div key={level} className="flex flex-col gap-1">
                                            {/* 2-3단계 사이 선 (3P 보너스 표시) */}
                                            {level === 2 && (
                                                <div className="relative my-1">
                                                    <div className="h-0.5 bg-gradient-to-r from-transparent via-yellow-500/50 to-transparent" />
                                                    <div className="absolute inset-0 flex items-center justify-center">
                                                        <Badge variant="outline" className="bg-yellow-500/10 border-yellow-500/30 text-yellow-400 text-[7px] px-1.5 py-0 font-black">
                                                            +3P
                                                        </Badge>
                                                    </div>
                                                </div>
                                            )}
                                            
                                            <div
                                                className={`h-12 rounded border flex flex-col items-center justify-center relative transition-all ${level === 5 ? 'border-primary/50 bg-primary/5 shadow-[inset_0_0_10px_rgba(var(--primary),0.1)]' : 'border-white/5'
                                                    }`}
                                            >
                                                <span className="absolute top-0 left-1 text-[8px] font-bold text-zinc-700">L{level}</span>
                                                <div className="text-[7px] text-zinc-500 font-bold uppercase text-center px-1 leading-tight">
                                                    {level === 5 && track.id === 'terraforming' && game.federationOnTerraforming5
                                                        ? (FEDERATION_REWARDS.find(r => r.id === game.federationOnTerraforming5)?.label ?? 'L5 연방')
                                                        : getTrackBonus(track.id, level)}
                                                </div>
                                                <div className="flex flex-wrap items-center justify-center gap-1 p-1">
                                                    {players
                                                        .filter(p => p.research && p.research[track.id as ResearchTrack] === level)
                                                        .map(p => {
                                                            const faction = FACTIONS.find(f => f.id === p.faction);
                                                            return (
                                                                <div
                                                                    key={p.id}
                                                                    className="w-4 h-4 rounded-full border border-white/20 shadow-lg cursor-help group relative"
                                                                    style={{ backgroundColor: faction?.color || '#fff' }}
                                                                >
                                                                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-50">
                                                                        <Badge variant="outline" className="bg-zinc-950 text-[8px] whitespace-nowrap border-white/20">
                                                                            {p.name}
                                                                        </Badge>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            </div>

                                            {/* Advanced Tech Tile Slot between L4 and L5 — 기술 타일 선택 시 조건 충족하면 클릭으로 고급 타일 획득 가능 */}
                                            {level === 5 && game.advancedTechTilesByTrack?.[track.id as ResearchTrack] && (() => {
                                                const advTile = game.advancedTechTilesByTrack?.[track.id as ResearchTrack];
                                                const playerLvl = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                                const canTakeAdvanced = pendingTech && onSelectAdvancedTechTile && playerId && playerLvl >= 4
                                                    && countGreenFederations(game.players[playerId]) >= 1
                                                    && (game.players[playerId]?.techTiles || []).filter((id: string) => !isTechTileCovered(game.players[playerId], id) && !id.startsWith('adv-')).length >= 1;
                                                return (
                                                <div
                                                    className={`mt-1 py-1.5 px-2 rounded border transition-all group relative shadow-[0_0_10px_rgba(6,182,212,0.1)] ${canTakeAdvanced ? 'bg-gradient-to-b from-cyan-900/40 to-cyan-950/60 border-cyan-500/30 hover:border-cyan-400 cursor-pointer' : 'bg-gradient-to-b from-cyan-900/40 to-cyan-950/60 border-cyan-500/30 cursor-help'}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (canTakeAdvanced && advTile?.id) onSelectAdvancedTechTile(advTile.id, track.id as ResearchTrack);
                                                    }}
                                                >
                                                    <div className="text-[9px] font-black text-center text-zinc-100 uppercase truncate leading-none py-1">
                                                        {advTile?.label}
                                                    </div>
                                                    {canTakeAdvanced && <div className="text-[7px] text-cyan-400 text-center">클릭 시 고급 획득</div>}
                                                    {/* Tooltip */}
                                                    <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 hidden group-hover:block z-50 w-56 p-3 bg-zinc-950 border border-cyan-500/40 rounded-xl shadow-2xl backdrop-blur-md">
                                                        <div className="flex items-center gap-2 mb-1.5 border-b border-white/10 pb-1">
                                                            <div className="w-2 h-2 rounded-full bg-cyan-400" />
                                                            <span className="text-[10px] font-black text-cyan-400 uppercase tracking-widest">Advanced Tech</span>
                                                        </div>
                                                        <p className="text-[10px] font-bold text-zinc-100 mb-1">{advTile?.label}</p>
                                                        <p className="text-[9px] text-zinc-400 leading-relaxed">{advTile?.description}</p>
                                                        {canTakeAdvanced && <p className="text-[9px] text-cyan-400 mt-1">클릭 시 이 타일 획득 (일반 타일 1개 덮기 + 연방 1 소모 + 트랙 1칸)</p>}
                                                    </div>
                                                </div>
                                                );
                                            })()}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                    })}
                </div>

                {/* 하단: 풀 3개(위) + 7번째 고급 타일(아래 오른쪽) */}
                {/* Tech Tiles Pool (왼쪽 3개) — 위 */}
                <div className="flex flex-wrap justify-center gap-4 mt-4">
                    {game.techTilesPool?.map((tile, idx) => {
                        if (!tile) {
                            return <div key={`pool-slot-${idx}`} className="w-40 bg-zinc-900/30 p-2 rounded-lg border border-dashed border-white/10 flex items-center justify-center text-[9px] text-zinc-500 min-h-[4rem]">빈 칸</div>;
                        }
                        const curPlayer = playerId ? game.players[playerId] : null;
                        const isUsed = curPlayer?.usedTechActions?.includes(tile.id);
                        const isAction = tile.id === 'tech-act-4p';
                        const hasTile = curPlayer?.techTiles?.includes(tile.id);
                        return (
                            <div
                                key={tile.id}
                                className={`w-40 bg-zinc-900/60 p-2 rounded-lg border border-yellow-500/20 hover:border-yellow-500/50 transition-all group relative shadow-lg ${isUsed ? 'grayscale opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                onClick={() => {
                                    if (isUsed) return;
                                    if (isAction && hasTile) {
                                        onUseTechAction(tile.id);
                                    } else {
                                        onGainTechTile(tile.id);
                                    }
                                }}
                            >
                                <div className="text-[9px] font-black text-center text-zinc-100 uppercase truncate leading-none py-1">{tile.label}</div>
                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-50 w-48 p-2 bg-zinc-950 border border-yellow-500/20 rounded-lg shadow-2xl">
                                    <div className="text-[10px] font-black text-yellow-500 mb-1 uppercase pb-1 border-b border-white/5">{tile.label}</div>
                                    <p className="text-[10px] text-zinc-300 leading-relaxed font-medium">{tile.description}</p>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {/* 7번째 고급 타일 — 아래 오른쪽 */}
                <div className="flex items-stretch justify-end gap-4 mt-2">
                    {game.extraAdvancedTechTile && (() => {
                        const extra = game.extraAdvancedTechTile;
                        const cond = game.extraAdvancedTechCondition;
                        const condLabel = cond === '25vp' ? '25 VP+' : '3 우주선';
                        const canTakeExtra = pendingTech && onSelectAdvancedTechTile && playerId
                            && countGreenFederations(game.players[playerId]) >= 1
                            && (game.players[playerId]?.techTiles || []).filter((id: string) => !isTechTileCovered(game.players[playerId], id) && !id.startsWith('adv-')).length >= 1
                            && (cond === '25vp' ? (game.players[playerId]?.score ?? 0) >= 25 : (game.players[playerId]?.spaceshipsEntered ?? []).length >= 3);
                        return (
                            <div className="relative shrink-0 w-full sm:w-auto sm:min-w-[160px] rounded border-2 border-cyan-500/50 bg-gradient-to-b from-cyan-900/30 to-cyan-950/50 overflow-hidden">
                                <div className="absolute top-0 left-0 z-10 px-2 py-1 text-[9px] font-black uppercase tracking-wider bg-cyan-500/90 text-zinc-900 rounded-br">
                                    {condLabel}
                                </div>
                                <button
                                    type="button"
                                    disabled={!canTakeExtra}
                                    onClick={() => canTakeExtra && onSelectAdvancedTechTile(extra.id)}
                                    className="w-full h-full min-h-[3.5rem] p-2 pt-6 pb-2 text-left flex flex-col justify-center hover:bg-cyan-500/10 disabled:opacity-60 disabled:cursor-default"
                                >
                                    <div className="text-[10px] font-bold text-zinc-100 truncate">{extra.label}</div>
                                    <div className="text-[8px] text-zinc-500 truncate" title={extra.description}>{extra.description}</div>
                                </button>
                            </div>
                        );
                    })()}
                </div>

                {/* 발타크 프리 액션: 1 포머 → 1 QIC (사용한 포머는 다음 라운드까지 잠김) */}
                {playerId && currentPlayer?.faction === 'bal_tak' && onUseBalTakGaiaformerToQic && (
                    <div className="space-y-2 pt-4 border-t border-white/5">
                        <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-amber-400/90">Bal T&apos;aks (Free Action)</h4>
                        <div className="flex items-center gap-2 flex-wrap">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={effectiveGaiaformers < 1}
                                className="border-amber-500/30 bg-amber-950/30 hover:bg-amber-900/40"
                                onClick={() => onUseBalTakGaiaformerToQic()}
                            >
                                1 포머 → 1 QIC
                            </Button>
                            {(currentPlayer.balTakGaiaformersUsedForQic ?? 0) > 0 && (
                                <span className="text-[10px] text-amber-400/90">
                                    가이아 토큰 보관: {(currentPlayer.balTakGaiaformersUsedForQic ?? 0)}개 (다음 라운드 복귀)
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* 내 기술 타일 액션 (4PW 등 — 라운드당 1회 사용) */}
                {playerId && onUseTechAction && (() => {
                    const cur = game.players[playerId];
                    const actionTileIds = ['tech-act-4p', 'adv-act-3k', 'adv-act-3o', 'adv-act-1q-5c'];
                    const myActionTiles = actionTileIds.filter(id => cur?.techTiles?.includes(id) && !isTechTileCovered(cur, id));
                    if (myActionTiles.length === 0) return null;
                    return (
                        <div className="pt-4 border-t border-white/5">
                            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground mb-2">Tech Tile Actions (1/round each)</h4>
                            <div className="flex flex-wrap gap-2">
                                {myActionTiles.map((tileId) => {
                                    const tile = ALL_TECH_TILES.find(t => t.id === tileId) || ALL_ADVANCED_TECH_TILES.find(t => t.id === tileId) || SHIP_TECH_TILES.find(t => t.id === tileId);
                                    const used = cur?.usedTechActions?.includes(tileId);
                                    if (!tile) return null;
                                    return (
                                        <Button
                                            key={tileId}
                                            variant="outline"
                                            size="sm"
                                            disabled={used}
                                            className={`h-auto py-2 px-3 text-left ${used ? 'opacity-40 grayscale' : 'border-amber-500/40 hover:border-amber-500'}`}
                                            onClick={() => !used && onUseTechAction(tileId)}
                                        >
                                            <span className="text-[10px] font-bold">{tile.label}</span>
                                            {used && <span className="text-[8px] text-zinc-500 ml-1">(used)</span>}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {/* 아카데미(오른쪽) Special은 왼쪽 패널(PlayerPanel) Technology Tiles 위에서 사용 */}

                {/* Hadsch Hallas 의회 프리 액션 (4C→1QIC, 4C→1K, 3C→1O) */}
                {playerId && game.players[playerId]?.faction === 'hadsch_hallas' && game.players[playerId]?.hadschHallasPIActions?.length && onUseHadschHallasPIAction && (
                    <div className="space-y-2 pt-4 border-t border-white/5">
                        <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-amber-400/90">Hadsch Hallas PI (Free Actions)</h4>
                        <div className="grid grid-cols-3 gap-2">
                            {game.players[playerId].hadschHallasPIActions!.map((action) => {
                                const canAfford = (game.players[playerId]?.credits ?? 0) >= action.costCredits;
                                return (
                                    <Button
                                        key={action.id}
                                        variant="outline"
                                        className={`h-12 flex flex-col items-center justify-center gap-0.5 border-amber-500/30 transition-all ${!canAfford ? 'opacity-50 cursor-not-allowed bg-zinc-900' : 'bg-amber-950/30 hover:bg-amber-900/40 hover:border-amber-500/50'}`}
                                        disabled={!canAfford}
                                        onClick={() => onUseHadschHallasPIAction(action.id)}
                                    >
                                        <div className={`text-[10px] font-bold ${canAfford ? 'text-amber-200' : 'text-zinc-500'}`}>
                                            {action.label}
                                        </div>
                                        <div className="text-[8px] text-amber-400/80">{action.costCredits}C</div>
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Power Actions Section */}
                <div className="space-y-4 pt-4 border-t border-white/5">
                    <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Main Board Power Actions</h4>
                    <div className="grid grid-cols-7 gap-2">
                        {game.powerActions.map((action) => (
                            <Button
                                key={action.id}
                                variant="outline"
                                className={`h-16 flex flex-col items-center justify-center gap-1 border-white/5 transition-all ${action.isUsed
                                    ? 'opacity-30 grayscale cursor-not-allowed bg-zinc-900'
                                    : 'bg-zinc-900/50 hover:bg-zinc-800 hover:border-primary/50'
                                    }`}
                                disabled={action.isUsed}
                                onClick={() => onUsePowerAction(action.id)}
                            >
                                <div className={`text-xs font-black ${action.isUsed ? 'text-zinc-500' : 'text-primary'}`}>
                                    {action.label}
                                </div>
                                <div className="text-[8px] uppercase font-bold text-zinc-500 tracking-tighter">
                                    {action.cost} {action.costType.toUpperCase()}
                                </div>
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Spaceships Section: 잠긴 우주선도 액션·기술 타일 정보 + 우주선별 연방 표시 */}
                {game.spaceships && Object.keys(game.spaceships).length > 0 && (() => {
                    const byShip = game.spaceshipFederationByShip || {};
                    return (
                    <div className="space-y-4 pt-4 border-t border-white/5">
                        <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Spaceships (3 actions each)</h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {game.map.filter((t) => t.type?.startsWith('ship_') && game.spaceships?.[t.id]).map((tile) => {
                                const ship = game.spaceships![tile.id];
                                const name = SHIP_NAMES[tile.type] || tile.type;
                                const currentPlayer = playerId ? game.players[playerId] : null;
                                const isLocked = !ship.unlocked;
                                const isInShip = playerId && ship.occupants.includes(playerId);
                                const usedIndices = ship.usedActionIndices ?? [];
                                const actionsUsedCount = usedIndices.length;
                                const actionLabels = SHIP_ACTION_LABELS[tile.type] || ['—', '—', '—'];
                                const techId = game.shipTechByShip?.[tile.type] ?? SHIP_TECH_BY_SHIP[tile.type];
                                const techTile = techId ? SHIP_TECH_TILES.find((t) => t.id === techId) : null;
                                const shipFedId = byShip[tile.type];
                                const shipFedTaken = shipFedId && Object.values(game.players).some((p) => getFederationEntries(p).some((e) => e.rewardId === shipFedId));
                                const shipFedLabel = shipFedId ? SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === shipFedId)?.label : null;

                                return (
                                    <div key={tile.id} className="bg-zinc-900/60 rounded-lg border border-white/10 p-2 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold text-zinc-300">{name}</span>
                                            {isLocked && <span className="text-[8px] text-amber-400 font-bold">LOCKED</span>}
                                        </div>
                                        {shipFedLabel != null && (
                                            <div className="text-[9px] text-zinc-400">
                                                {shipFedTaken ? <span className="text-zinc-500">없음</span> : shipFedLabel}
                                            </div>
                                        )}
                                        <div className="text-[9px] text-zinc-500 min-h-[2rem]">
                                            탑승: {ship.occupants.length > 0
                                                ? ship.occupants.map((pid) => game.players[pid]?.name ?? pid).join(', ')
                                                : '—'}
                                        </div>
                                        {techTile && (
                                            <div className="p-1.5 bg-zinc-800/80 rounded border border-yellow-500/20">
                                                <div className="text-[8px] font-bold text-yellow-500/90 uppercase">Tech</div>
                                                <div className="text-[9px] text-zinc-300">{techTile.label}</div>
                                                <div className="text-[7px] text-zinc-500 truncate" title={techTile.description}>{techTile.description}</div>
                                            </div>
                                        )}
                                        {tile.type === 'ship_twilight' && (game.twilightArtifactSlots?.length ?? 0) > 0 && (
                                            <div className="p-1.5 bg-purple-900/40 rounded border border-purple-500/30">
                                                <div className="text-[8px] font-bold text-purple-300 uppercase">Artifacts (6P 1→2→3)</div>
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {(game.twilightArtifactSlots ?? []).map((aid, idx) => {
                                                        if (!aid) return null;
                                                        const art = ARTIFACTS.find(a => a.id === aid);
                                                        if (!art) return null;
                                                        const totalPower = (currentPlayer?.power1 ?? 0) + (currentPlayer?.power2 ?? 0) + (currentPlayer?.power3 ?? 0);
                                                        const canTake = isInShip && onTakeTwilightArtifact && game.turnOrder?.[game.currentPlayerIndex ?? 0] === playerId && !game.hasDoneMainAction && totalPower >= 6;
                                                        return (
                                                            <Button key={idx} size="sm" variant="outline" className="text-[7px] h-auto py-1 px-1.5 border-purple-500/50 bg-purple-900/30 hover:bg-purple-800/50 disabled:opacity-50" disabled={!canTake} onClick={() => onTakeTwilightArtifact?.(aid)} title={art.description}>
                                                                {art.label}
                                                            </Button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                        <div className="space-y-1 pt-1 border-t border-white/5">
                                            <div className="text-[8px] text-zinc-500">Actions ({actionsUsedCount}/3)</div>
                                            {[0, 1, 2].map((idx) => {
                                                const actionNum = idx + 1;
                                                const label = actionLabels[idx];
                                                const alreadyUsed = usedIndices.includes(actionNum);
                                                const canUse = isInShip && onUseShipAction && !alreadyUsed && actionsUsedCount < 3;
                                                const disabled = alreadyUsed;
                                                if (canUse) {
                                                    return (
                                                        <Button key={idx} size="sm" className="w-full text-[8px] h-6" onClick={() => onUseShipAction(tile.id, actionNum)} disabled={disabled}>
                                                            {label}
                                                        </Button>
                                                    );
                                                }
                                                return (
                                                    <div key={idx} className={`text-[8px] py-0.5 ${disabled ? 'text-zinc-600 line-through' : 'text-zinc-500'}`}>{label}{disabled ? ' (사용됨)' : ''}</div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    );
                })()}
            </CardContent>
        </Card >
    );
}
