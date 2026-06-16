import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FlaskConical, Gift, Lock } from 'lucide-react';
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
    /** 메인 액션 취소 (턴 시작 상태로 복구) */
    onResetTurn?: () => void;
    /** 화면 왼쪽에 상시 고정되는 축소 버전 여부 */
    isMini?: boolean;
}

const SHIP_NAMES: Record<string, string> = {
    ship_twilight: 'Twilight',
    ship_rebellion: 'Rebellion',
    ship_tf_mars: 'TF Mars',
    ship_eclipse: 'Eclipse',
};

/** 우주선별 액션 스트립 이미지 (가로 3칸 = 액션 1/2/3). public/image/Action*.jpg */
const SHIP_ACTION_IMG: Record<string, string> = {
    ship_twilight: '/image/ActionTwilight.jpg',
    ship_rebellion: '/image/ActionRebellion.jpg',
    ship_tf_mars: '/image/ActionTFMars.jpg',
    ship_eclipse: '/image/ActionEclipse.jpg',
};

/** 우주선별 액션 라벨 (잠긴 우주선에서도 표시용) */
const SHIP_ACTION_LABELS: Record<string, [string, string, string]> = {
    ship_twilight: ['3Q → Fed', '2O+3P → TS→Lab', '1K → +3 Range'],
    ship_rebellion: ['3Q → Tech', '1O+3P → M→TS', '2K → 1Q 2C'],
    ship_tf_mars: ['2Q → (2 + Tech Tiles)VP', '2P → Gaia', '3C → 1 TF'],
    ship_eclipse: ['2Q → (2 + Planet Types)VP', '2K+3P → Research', '6C → Ast'],
};

/** 우주선별 액션 테마 색상 (QIC, Power, Knowledge, Terraform, Credit, Asteroid 등 자원/액션 성격에 맞춤) */
const SHIP_ACTION_THEME: Record<string, { color: string; border: string; hover: string; text: string }[]> = {
    ship_twilight: [
        { color: 'bg-emerald-500/20', border: 'border-emerald-500/40', hover: 'hover:bg-emerald-500/30', text: 'text-emerald-400' }, // QIC
        { color: 'bg-purple-500/20', border: 'border-purple-500/40', hover: 'hover:bg-purple-500/30', text: 'text-purple-400' }, // Power
        { color: 'bg-blue-500/20', border: 'border-blue-500/40', hover: 'hover:bg-blue-500/30', text: 'text-blue-400' }, // Knowledge
    ],
    ship_rebellion: [
        { color: 'bg-emerald-500/20', border: 'border-emerald-500/40', hover: 'hover:bg-emerald-500/30', text: 'text-emerald-400' }, // QIC
        { color: 'bg-purple-500/20', border: 'border-purple-500/40', hover: 'hover:bg-purple-500/30', text: 'text-purple-400' }, // Power
        { color: 'bg-blue-500/20', border: 'border-blue-500/40', hover: 'hover:bg-blue-500/30', text: 'text-blue-400' }, // Knowledge
    ],
    ship_tf_mars: [
        { color: 'bg-emerald-500/20', border: 'border-emerald-500/40', hover: 'hover:bg-emerald-500/30', text: 'text-emerald-400' }, // QIC
        { color: 'bg-purple-500/20', border: 'border-purple-500/40', hover: 'hover:bg-purple-500/30', text: 'text-purple-400' }, // Terraform
        { color: 'bg-yellow-500/20', border: 'border-yellow-500/40', hover: 'hover:bg-yellow-500/30', text: 'text-yellow-400' }, // Money
    ],
    ship_eclipse: [
        { color: 'bg-emerald-500/20', border: 'border-emerald-500/40', hover: 'hover:bg-emerald-500/30', text: 'text-emerald-400' }, // QIC
        { color: 'bg-purple-500/20', border: 'border-purple-500/40', hover: 'hover:bg-purple-500/30', text: 'text-purple-400' }, // Power
        { color: 'bg-pink-500/20', border: 'border-pink-500/40', hover: 'hover:bg-pink-500/30', text: 'text-pink-400' }, // Asteroid
    ],
};

const MINI_SHIP_RING_INACTIVE = 'rgba(82, 82, 91, 0.45)'; // zinc-600

/** 시계 구간 — 종족 선택 시 고른 턴 순서 번호(1~4)와 1:1 */
const SHIP_QUADRANT_CLOCK = ['9~12시', '12~3시', '3~6시', '6~9시'] as const;

/**
 * 우주선 테두리 구역: 플레이어 고정 좌석(selectedTurnOrder 1~4).
 * 라운드마다 turnOrder가 바뀌어도, A가 1번 자리면 항상 9~12시 구역.
 */
function getShipQuadrantsByPlayerSeat(game: GameState, occupants: string[]) {
    const quadrantFactionColors: Array<string | null> = [null, null, null, null];
    const quadrantTitles: Array<string | undefined> = [undefined, undefined, undefined, undefined];

    for (const pid of occupants) {
        const p = game.players[pid];
        const seat = p?.selectedTurnOrder;
        if (seat == null || seat < 1 || seat > 4) continue;
        const slot = seat - 1;
        const faction = p?.faction ? FACTIONS.find((f) => f.id === p.faction) : null;
        quadrantFactionColors[slot] = faction?.color ?? null;
        const name = p?.name;
        quadrantTitles[slot] = name
            ? `${name} · ${SHIP_QUADRANT_CLOCK[slot]} (자리 ${seat})`
            : undefined;
    }

    return { quadrantFactionColors, quadrantTitles };
}

/** 미니 우주선 카드: 시계 방향 4등분(12→3→6→9→12) 테두리 링 */
function MiniShipQuadrantFrame({
    /** selectedTurnOrder 1~4 → [9~12, 12~3, 3~6, 6~9], 탑승 중인 플레이어만 색 */
    quadrantFactionColors,
    quadrantTitles,
    children,
    className = '',
}: {
    quadrantFactionColors: Array<string | null | undefined>;
    quadrantTitles?: Array<string | undefined>;
    children: React.ReactNode;
    className?: string;
}) {
    // 탑승: 진영 색(불투명). 미탑승: transparent → 아래 빗금(해치) 패턴이 비쳐서
    // 회색 진영(티타늄 #424242)이 들어와도 "단색 vs 빗금"으로 빈 칸과 확실히 구분됨.
    const seg = (idx: number) => quadrantFactionColors[idx] ?? 'transparent';
    // CSS conic-gradient: 0deg = 12시, 시계 방향
    const c12to3 = seg(1);
    const c3to6 = seg(2);
    const c6to9 = seg(3);
    const c9to12 = seg(0);
    const hasAnyOccupant = quadrantFactionColors.some(Boolean);
    const ringThickness = hasAnyOccupant ? 4 : 3;
    // 빈 칸용 대각선 빗금 패턴 (탑승 칸은 단색이 위에 덮여 가려짐)
    const emptyHatch = `repeating-linear-gradient(45deg, ${MINI_SHIP_RING_INACTIVE} 0px, ${MINI_SHIP_RING_INACTIVE} 2px, rgba(24,24,27,0.7) 2px, rgba(24,24,27,0.7) 5px)`;

    return (
        <div
            className={`relative rounded-lg h-full ${className}`}
            style={{
                padding: ringThickness,
                background: `conic-gradient(from 0deg, ${c12to3} 0deg 90deg, ${c3to6} 90deg 180deg, ${c6to9} 180deg 270deg, ${c9to12} 270deg 360deg), ${emptyHatch}`,
            }}
            title={quadrantTitles?.filter(Boolean).join(' · ')}
        >
            <div className="relative flex flex-col gap-1 rounded-[6px] bg-zinc-950/95 min-h-0 h-full">
                {children}
            </div>
        </div>
    );
}

/** 메인 보드 파워 액션 — 어두운 배경에서 잘 보이도록 앰버(밝은 텍스트) */
const POWER_ACTION_BTN = {
    available:
        'border-amber-400/55 bg-amber-950/70 text-amber-50 hover:bg-amber-500/25 hover:border-amber-300/70 cursor-pointer shadow-[0_0_6px_rgba(251,191,36,0.12)]',
    used: 'border-white/5 bg-zinc-900 text-zinc-600 line-through cursor-not-allowed opacity-50',
    labelAvailable: 'text-amber-50',
    labelUsed: 'text-zinc-500',
    costAvailable: 'text-amber-200/90',
    costUsed: 'text-zinc-600',
    panelAvailable: 'bg-amber-950/50 hover:bg-amber-900/55 border-amber-500/45 hover:border-amber-400/65',
};

export function ResearchBoard({ game, playerId, onUsePowerAction, onUseHadschHallasPIAction, onUseBalTakGaiaformerToQic, onGainTechTile, onUseTechAction, onAdvanceTech, onUseShipAction, onSelectTechTile, onSelectAdvancedTechTile, onConfirmAdvancedTechCover, onTakeTwilightArtifact, onUseAcademyQic, onEndTurn, onResetTurn, isMini }: ResearchBoardProps) {
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
    const pendingEclipseTrack = game.pendingEclipseResearch?.playerId === playerId;
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
        <Card className={`w-full text-zinc-100 font-orbitron ${isMini ? 'border-none bg-transparent shadow-none overflow-visible' : 'bg-zinc-950 border-white/5 overflow-hidden'}`}>
            {!isMini && (
                <CardHeader className="py-3 px-4 border-b border-white/5 bg-zinc-900/50">
                    <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400">
                        Galactic Research & Power Systems
                    </CardTitle>
                </CardHeader>
            )}
            <CardContent className={`${isMini ? 'p-0 space-y-0' : 'p-4 space-y-8'}`}>
                {/* 메인 액션 완료 후, 기술/트랙 등 선택할 게 없을 때만 턴 종료 버튼 표시 */}
                {!isMini && playerId && game.turnOrder?.[game.currentPlayerIndex] === playerId && game.hasDoneMainAction && game.currentPhase === 'main' && game.pendingTFMarsGaiaProject?.playerId !== playerId && game.pendingLostPlanet?.playerId !== playerId && !pendingTech && !pendingAdvancedCover && !pendingShipTrack && !pendingAdvTechTrack && !pendingEclipseTrack && (!game.players[playerId]?.pendingTerraformSteps || game.players[playerId].pendingTerraformSteps === 0) && (onEndTurn || onResetTurn) && (
                    <div className="p-3 rounded-xl border border-green-500/40 bg-green-500/10 mb-4">
                        <p className="text-[10px] text-zinc-400 mb-2 font-medium">메인 액션을 완료했습니다. 행동을 확정(Turn End)하거나 취소(Reset)할 수 있습니다.</p>
                        <div className="flex gap-2">
                            {onResetTurn && (
                                <Button 
                                    variant="outline" 
                                    size="sm" 
                                    className="flex-1 border-red-500/50 hover:bg-red-500/10 text-red-400 text-xs font-bold" 
                                    onClick={onResetTurn}
                                >
                                    리셋 (Reset)
                                </Button>
                            )}
                            {onEndTurn && (
                                <Button 
                                    size="sm" 
                                    className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-bold shadow-[0_0_15px_rgba(34,197,94,0.3)]" 
                                    onClick={onEndTurn}
                                >
                                    턴 종료 (End Turn)
                                </Button>
                            )}
                        </div>
                    </div>
                )}
                {/* 기술 타일 선택 (R창 내, 팝업 없음) */}
                {pendingTech && onSelectTechTile && !isMini && (
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
                                        const tile = getFirstTrackTile(game.techTilesByTrack, track.id);
                                        // 소진/획득돼도 칸을 당기지 않고 트랙 위치 고정 (빈 자리로 유지)
                                        if (!tile) return (
                                            <div key={track.id} className="p-2 rounded-lg border border-dashed border-white/10 bg-zinc-900/40 min-h-[3rem] flex items-center justify-center text-[9px] text-zinc-500">소진</div>
                                        );
                                        const count = (game.techTilesByTrack[track.id] || []).filter(t => t).length;
                                        const isOwned = currentPlayer?.techTiles?.includes(tile.id);
                                        return (
                                            <button
                                                key={track.id}
                                                type="button"
                                                onClick={() => !isOwned && onSelectTechTile && onSelectTechTile(tile.id, track.id)}
                                                className={`p-2 rounded-lg border relative group w-full flex flex-col items-center gap-1 ${isOwned ? 'opacity-40 grayscale cursor-not-allowed border-transparent bg-black/40' : 'border-white/20 bg-zinc-900/80 hover:border-yellow-500/50'}`}
                                            >
                                                {tile.image ? (
                                                    <img src={tile.image} alt={tile.label} className="h-[60px] w-auto object-contain" />
                                                ) : (
                                                    <div className="text-[9px] font-bold text-zinc-100 truncate">{tile.label}</div>
                                                )}
                                                <div className="absolute -top-1 -right-1 bg-yellow-600 text-white text-[8px] px-1 rounded-full font-bold shadow-sm">
                                                    {count}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="text-[9px] text-zinc-500 mt-1">하단 풀 3개 (선택 후 트랙 클릭):</div>
                                <div className="grid grid-cols-3 gap-2">
                                    {(() => {
                                        // 중복된 타일을 종류별로 묶어서 첫 번째 것만 렌더링하고 개수 표시
                                        const pool = game.techTilesPool || [];
                                        const uniqueTiles: { tile: TechTile; count: number }[] = [];
                                        pool.forEach(t => {
                                            if (!t) return;
                                            const existing = uniqueTiles.find(u => u.tile.id === t.id);
                                            if (existing) existing.count++;
                                            else uniqueTiles.push({ tile: t, count: 1 });
                                        });

                                        return uniqueTiles.map(({ tile, count }) => {
                                            const isOwned = currentPlayer?.techTiles?.includes(tile.id);
                                            return (
                                            <button
                                                key={tile.id}
                                                type="button"
                                                onClick={() => !isOwned && setSelectedTileIdNeedingTrack(tile.id)}
                                                className={`p-2 rounded-lg border relative group flex flex-col items-center gap-1 ${isOwned ? 'opacity-40 grayscale cursor-not-allowed border-transparent bg-black/40' : 'border-yellow-500/30 bg-zinc-900/80 hover:border-yellow-500'}`}
                                            >
                                                {tile.image ? (
                                                    <img src={tile.image} alt={tile.label} className="h-[60px] w-auto object-contain" />
                                                ) : (
                                                    <div className="text-[9px] font-bold text-zinc-100 truncate">{tile.label}</div>
                                                )}
                                                <div className="absolute -top-1 -right-1 bg-yellow-600 text-white text-[8px] px-1 rounded-full font-bold shadow-sm">
                                                    {count}
                                                </div>
                                            </button>
                                        ); });
                                    })()}
                                    {/* 빈 칸 표시 (3종류 중 하나라도 완전히 소진된 경우 대비) */}
                                    {(() => {
                                        const pool = game.techTilesPool || [];
                                        const uniqueIds = new Set(pool.filter(t => t).map(t => t!.id));
                                        const emptySlots = Math.max(0, 3 - uniqueIds.size);
                                        return Array(emptySlots).fill(null).map((_, i) => (
                                            <div key={`pool-empty-${i}`} className="p-2 rounded-lg border border-dashed border-white/10 bg-zinc-900/40 min-h-[3rem] flex items-center justify-center text-[9px] text-zinc-500">품절</div>
                                        ));
                                    })()}
                                </div>
                                {hasShipTechOptions && (
                                    <>
                                        <div className="text-[9px] text-zinc-500 mt-3">우주선 기술 타일:</div>
                                        <div className="grid grid-cols-3 gap-2">
                                            {(game.availableShipTechTileIds || []).map((id) => {
                                                const tile = SHIP_TECH_TILES.find((t) => t.id === id);
                                                if (!tile) return null;
                                                const count = game.shipTechPool?.[id] ?? 0;
                                                const isOwned = currentPlayer?.techTiles?.includes(tile.id);
                                                return (
                                                    <button
                                                        key={tile.id}
                                                        type="button"
                                                        onClick={() => !isOwned && onSelectTechTile(tile.id)}
                                                        className={`p-2 rounded-lg border-2 flex flex-col items-center gap-1 relative group ${isOwned ? 'opacity-40 grayscale cursor-not-allowed border-transparent bg-black/40' : 'border-yellow-500/40 bg-zinc-900/80 hover:border-yellow-500'}`}
                                                    >
                                                        {tile.image ? (
                                                            <img src={tile.image} alt={tile.label} className="h-[60px] w-auto object-contain" />
                                                        ) : (
                                                            <div className="text-[10px] font-bold text-zinc-100">{tile.label}</div>
                                                        )}
                                                        {count > 0 && (
                                                            <div className="absolute -top-1 -right-1 bg-yellow-600 text-white text-[8px] px-1 rounded-full font-bold shadow-sm">
                                                                {count}
                                                            </div>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}
                                {/* 획득 가능한 고급 기술 타일 (트랙 L4+ · 연방 1 · 덮을 일반타일 1개) */}
                                {onSelectAdvancedTechTile && playerId && (() => {
                                    const p = game.players[playerId];
                                    if (!p) return null;
                                    const greenOk = countGreenFederations(p) >= 1;
                                    const hasCoverable = (p.techTiles || []).filter((id: string) => !isTechTileCovered(p, id) && !id.startsWith('adv-')).length >= 1;
                                    if (!greenOk || !hasCoverable) return null;
                                    const eligible: { id: string; label: string; description: string; image?: string; trackId?: ResearchTrack }[] = [];
                                    RESEARCH_TRACKS.forEach((tr) => {
                                        const adv = game.advancedTechTilesByTrack?.[tr.id as ResearchTrack];
                                        if (!adv) return;
                                        const taken = Object.values(game.players).some((pl) => pl.techTiles?.includes(adv.id));
                                        const lvl = p.research?.[tr.id as ResearchTrack] ?? 0;
                                        if (!taken && lvl >= 4) eligible.push({ ...adv, trackId: tr.id as ResearchTrack });
                                    });
                                    const extra = game.extraAdvancedTechTile;
                                    if (extra) {
                                        const taken = Object.values(game.players).some((pl) => pl.techTiles?.includes(extra.id));
                                        const condOk = game.extraAdvancedTechCondition === '25vp' ? (p.score ?? 0) >= 25 : (p.spaceshipsEntered?.length ?? 0) >= 3;
                                        if (!taken && condOk) eligible.push({ ...extra });
                                    }
                                    if (eligible.length === 0) return null;
                                    return (
                                        <>
                                            <div className="text-[9px] text-cyan-400 mt-3">고급 기술 타일 (연방 1 + 일반타일 1개 덮기):</div>
                                            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                                                {eligible.map((adv) => (
                                                    <button
                                                        key={adv.id}
                                                        type="button"
                                                        title={`${adv.label}: ${adv.description}`}
                                                        onClick={() => onSelectAdvancedTechTile(adv.id, adv.trackId)}
                                                        className="p-2 rounded-lg border-2 border-cyan-500/40 bg-zinc-900/80 hover:border-cyan-400 flex flex-col items-center gap-1"
                                                    >
                                                        {adv.image ? (
                                                            <img src={adv.image} alt={adv.label} className="h-[60px] w-auto object-contain" />
                                                        ) : (
                                                            <div className="text-[9px] font-bold text-zinc-100">{adv.label}</div>
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    );
                                })()}
                            </>
                        )}
                    </div>
                )}

                {/* 고급 기술 타일: 덮을 일반 타일 선택 */}
                {pendingAdvancedCover && onConfirmAdvancedTechCover && currentPlayer && !isMini && (
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
                                            title={tile ? `${tile.label}: ${tile.description}` : id}
                                            className="p-2 rounded-lg border-2 border-cyan-500/40 bg-zinc-900/80 hover:border-cyan-400 hover:scale-105 transition-all flex flex-col items-center gap-1"
                                        >
                                            {tile?.image ? (
                                                <img src={tile.image} alt={tile.label} className="h-[60px] w-auto object-contain rounded" />
                                            ) : (
                                                <>
                                                    <div className="text-[10px] font-bold text-zinc-100">{tile?.label ?? id}</div>
                                                    <div className="text-[8px] text-zinc-500 truncate">{tile?.description}</div>
                                                </>
                                            )}
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                )}

                {/* Eclipse 2K+3P: 올릴 트랙 선택 */}
                {pendingEclipseTrack && !isMini && (
                    <div className="space-y-3 p-3 rounded-xl border border-violet-500/30 bg-violet-500/5">
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-violet-400">Eclipse: 연구 트랙 선택</h4>
                        <p className="text-[9px] text-zinc-400">2K+3P 지불됨 — 아래 트랙 또는 6개 라인 중 하나를 클릭하세요.</p>
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
                                        className="p-3 rounded-lg border-2 border-violet-500/40 bg-zinc-900/80 hover:border-violet-400 disabled:opacity-50 disabled:cursor-not-allowed text-center"
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

                {/* 우주선 기술 타일 / 고급 기술 타일 획득 후: 올릴 트랙 선택 (6개 중 1개) */}
                {(pendingShipTrack || pendingAdvTechTrack) && onAdvanceTech && !isMini && (
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

                {/* Eclipse 2K+3P — 미니 R 패널 */}
                {pendingEclipseTrack && isMini && (
                    <div className="px-1 py-1 mb-1 rounded border border-violet-500/40 bg-violet-500/10">
                        <p className="text-[7px] font-black text-violet-300 uppercase">Eclipse: 트랙 클릭 (2K+3P 지불됨)</p>
                    </div>
                )}

                {/* Research Tracks — Mini View: vertical columns (like real board) */}
                {isMini ? (
                    <div className="flex flex-col gap-0">
                        {/* 6 track columns */}
                        <div className="grid grid-cols-6 gap-1 mb-0">
                            {RESEARCH_TRACKS.map((track) => {
                                const trackTile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack);
                                const advTile = game.advancedTechTilesByTrack?.[track.id as ResearchTrack];
                                const isAdvTaken = advTile ? Object.values(game.players).some(p => p.techTiles?.includes(advTile.id)) : false;
                                const navBlocked = track.id === 'navigation' && !balTakCanAdvanceNav;
                                return (
                                    <div
                                        key={track.id}
                                        className={`flex flex-col items-stretch gap-0 rounded-lg p-0.5 relative ${navBlocked ? 'opacity-50 grayscale bg-black/40' : ''}`}
                                        style={{ backgroundColor: navBlocked ? 'transparent' : `${track.color}08`, borderTop: `1px solid ${navBlocked ? '#333' : `${track.color}40`}` }}
                                    >
                                        {/* Restricted (Locked) Overlay for Bal'Tak Nav */}
                                        {navBlocked && (
                                            <div className="absolute inset-x-0 top-6 bottom-0 flex flex-col items-center pt-10 bg-black/10 z-10 pointer-events-none">
                                                <Lock className="w-4 h-4 text-zinc-600 opacity-40" />
                                                <div className="text-[5px] font-black text-zinc-600 mt-0.5 uppercase tracking-tighter">Locked</div>
                                            </div>
                                        )}
                                        {/* Track name */}
                                        <div className="text-[6px] font-black uppercase text-center leading-none truncate mb-0.5" style={{ color: track.color }}>
                                            {track.name === 'Terraforming' ? 'Terra' : track.name === 'Navigation' ? 'Nav' : track.name === 'Artificial Intelligence' ? 'AI' : track.name === 'Gaia Project' ? 'Gaia' : track.name === 'Economy' ? 'Eco' : 'Sci'}
                                        </div>

                                        {/* Level slots: L5 → L0 (위→아래). 고급 기술 타일은 L5와 L4 사이. */}
                                        {[5, 4, 3, 2, 1, 0].map((level) => {
                                            const playersHere = players.filter(p => p.research && p.research[track.id as ResearchTrack] === level);
                                            // L5 특수 이미지: 테라포밍 연방 / Nav 잊혀진 행성 (선착 도달 전까지)
                                            let l5Img: string | null = null;
                                            if (level === 5) {
                                                if (track.id === 'terraforming' && game.federationOnTerraforming5 && !players.some(p => (p.research?.terraforming ?? 0) >= 5)) {
                                                    const ri = FEDERATION_REWARDS.findIndex(r => r.id === game.federationOnTerraforming5);
                                                    if (ri !== -1) l5Img = `/image/Federation_${ri + 1}.gif`;
                                                } else if (track.id === 'navigation' && !players.some(p => (p.research?.navigation ?? 0) >= 5)) {
                                                    l5Img = '/map/lost_planet.png';
                                                }
                                            }
                                            // 경제 트랙 3·4단계 변형 라벨 (VP면 VP, 파워면 PW)
                                            const ecoLabel = track.id === 'economy' && (level === 3 || level === 4) ? (game.economyVariant === 'vp' ? 'VP' : 'PW') : null;
                                            const cell = (
                                                <div
                                                    key={`lvl-${level}`}
                                                    className={`rounded flex items-center justify-center relative border overflow-hidden cursor-pointer hover:bg-white/5 transition-all flex-shrink-0 ${level === 5 ? 'h-9 border-primary/30' : 'h-6 border-white/5'}`}
                                                    style={{
                                                        backgroundColor: level > 0 ? `${track.color}${level === 5 ? '25' : '12'}` : 'rgba(0,0,0,0.1)',
                                                    }}
                                                    onClick={() => { if (!navBlocked) handleTrackClick(track.id as ResearchTrack); }}
                                                >
                                                    <span className="text-[9px] font-black text-zinc-400 absolute left-0.5 top-0 leading-none select-none z-10">{level}</span>
                                                    {l5Img && <img src={l5Img} alt="L5" className="w-[35px] h-[35px] object-contain" title={track.id === 'navigation' ? 'Nav5: 잊혀진 행성 (선착)' : '테라L5 연방 보상'} />}
                                                    {ecoLabel && <span className="text-[8px] font-black text-orange-300 absolute right-0.5" title={game.economyVariant === 'vp' ? '점수형(+VP)' : '파워형'}>{ecoLabel}</span>}
                                                    {playersHere.length > 0 && (
                                                        <div className="flex ml-1.5 items-center justify-center">
                                                            {playersHere.map((p, i) => {
                                                                const faction = FACTIONS.find(f => f.id === p.faction);
                                                                return (
                                                                    <div
                                                                        key={p.id}
                                                                        className="w-3 h-3 rounded-full border border-black/50 shadow-md flex-shrink-0"
                                                                        style={{ backgroundColor: faction?.color || '#fff', marginLeft: i > 0 ? '-3px' : '0' }}
                                                                        title={p.name}
                                                                    />
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                            if (level !== 5) return cell;
                                            // 기술타일 선택 중(pendingTech)이고 트랙 L4+·연방 1개·덮을 일반타일이 있으면 고급 타일도 선택지로 클릭 가능
                                            const myLvlForAdv = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                            const canTakeAdvMini = !!(pendingTech && onSelectAdvancedTechTile && advTile && !isAdvTaken && playerId && myLvlForAdv >= 4
                                                && countGreenFederations(game.players[playerId]) >= 1
                                                && (game.players[playerId]?.techTiles || []).filter((id: string) => !isTechTileCovered(game.players[playerId], id) && !id.startsWith('adv-')).length >= 1);
                                            const adv = (
                                                <div
                                                    key="adv"
                                                    onClick={(e) => { if (canTakeAdvMini && advTile?.id) { e.stopPropagation(); onSelectAdvancedTechTile!(advTile.id, track.id as ResearchTrack); } }}
                                                    className={`h-[40px] w-full rounded overflow-hidden flex items-center justify-center bg-cyan-950/20 border group relative my-0.5 ${canTakeAdvMini ? 'border-cyan-400 cursor-pointer ring-1 ring-cyan-400/40 hover:bg-cyan-500/15' : 'border-cyan-500/10'}`}
                                                >
                                                    {advTile && !isAdvTaken && advTile.image ? (
                                                        <>
                                                            <img src={advTile.image} alt={advTile.label} className="w-full h-full object-contain" />
                                                            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 w-48 p-2 bg-zinc-950 border border-cyan-500/30 rounded-lg shadow-2xl text-[9px] text-zinc-300 whitespace-normal pointer-events-none hidden group-hover:block z-[130]">
                                                                <span className="text-cyan-400 font-bold block mb-0.5">{advTile.label}</span>{advTile.description}{canTakeAdvMini && <span className="text-cyan-400 block mt-0.5">클릭 시 획득 (일반 1개 덮기+연방 1)</span>}
                                                            </div>
                                                        </>
                                                    ) : advTile && isAdvTaken ? (
                                                        <span className="text-[6px] text-cyan-600/60 uppercase font-black tracking-wider">획득</span>
                                                    ) : (
                                                        <span className="text-[6px] text-zinc-700 opacity-30">—</span>
                                                    )}
                                                </div>
                                            );
                                            return [cell, adv];
                                        })}

                                        {/* Standard Tech Tile (bottom) */}
                                        <div className="h-[44px] w-full rounded overflow-hidden flex items-center justify-center bg-zinc-900/60 border border-yellow-500/10 relative group cursor-pointer hover:border-yellow-500/40 transition-colors"
                                            onClick={(e) => { e.stopPropagation(); if (!trackTile) return; if (pendingTech && onSelectTechTile) { onSelectTechTile(trackTile.id, track.id as ResearchTrack); } else { onGainTechTile(trackTile.id); } }}
                                        >
                                            {trackTile?.image ? (
                                                <>
                                                    <img src={trackTile.image} alt={trackTile.label} className="w-full h-full object-contain" />
                                                    <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-[130] w-48 p-2 bg-zinc-950 border border-yellow-500/30 rounded-lg shadow-2xl text-[9px] text-zinc-300 whitespace-normal pointer-events-none">
                                                        <span className="text-yellow-400 font-bold block mb-0.5">{trackTile.label}</span>{trackTile.description}
                                                    </div>
                                                </>
                                            ) : (
                                                <span className="text-[6px] text-zinc-700 opacity-30">—</span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Pool Tech Tiles (3 extra tiles not in any track) & Extra Advanced Tech Tile — ZERO GAP */}
                        {((game.techTilesPool && game.techTilesPool.filter(t => t).length > 0) || game.extraAdvancedTechTile) && (() => {
                            const pool: TechTile[] = (game.techTilesPool || []).filter((t): t is TechTile => t != null);
                            const seen: { tile: TechTile; count: number }[] = [];
                            pool.forEach(t => {
                                const ex = seen.find(s => s.tile.id === t.id);
                                if (ex) ex.count++; else seen.push({ tile: t, count: 1 });
                            });
                            return (
                                <div className="border-t border-white/5 pt-0.5 mt-0.5 w-full">
                                    <div className="relative w-full h-[44px]">
                                        {/* Center: Pool Tiles */}
                                        <div className="absolute inset-0 pointer-events-none flex justify-center items-center gap-1">
                                            {seen.map(({ tile }) => (
                                                <div
                                                    key={tile.id}
                                                    className="relative h-[44px] rounded-md overflow-hidden bg-zinc-900/60 border border-yellow-500/10 hover:border-yellow-500/30 cursor-pointer group transition-all shrink-0 pointer-events-auto"
                                                    style={{ width: 'calc((100% - 20px) / 6)' }}
                                                    onClick={() => {
                                                        if (pendingTech && onSelectTechTile) {
                                                            setSelectedTileIdNeedingTrack(tile.id);
                                                        } else {
                                                            onGainTechTile(tile.id);
                                                        }
                                                    }}
                                                >
                                                    {tile.image ? (
                                                        <img src={tile.image} alt={tile.label} className="w-full h-full object-contain" />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center text-[6px] text-zinc-500 text-center px-0.5 leading-none">{tile.label}</div>
                                                    )}
                                                    <div className="absolute top-0 left-0 w-full h-full hidden group-hover:block z-[130] pointer-events-none">
                                                        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 w-48 p-2 bg-zinc-950 border border-yellow-500/30 rounded-lg shadow-2xl text-[9px] text-zinc-300 whitespace-normal">
                                                            <span className="text-yellow-400 font-bold block mb-0.5">{tile.label}</span>{tile.description}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Right: 7th Extra Advanced Tech Tile */}
                                        {game.extraAdvancedTechTile && onSelectAdvancedTechTile && (
                                            <div className="absolute inset-0 pointer-events-none flex justify-end items-center gap-0.5">
                                                <div className="flex flex-col items-center justify-center text-[5px] text-zinc-400 font-bold uppercase text-center leading-[1.1] w-7 shrink-0 pointer-events-auto tracking-tighter">
                                                    <span>조건</span>
                                                    <span className="text-cyan-400 mt-[1px]">
                                                        {game.extraAdvancedTechCondition === '25vp' ? '25VP' : '우주선3'}
                                                    </span>
                                                </div>
                                                <div
                                                    className="relative h-[44px] rounded-md overflow-hidden bg-cyan-950/40 border border-cyan-500/20 hover:border-cyan-500/50 cursor-pointer group transition-all shrink-0 pointer-events-auto"
                                                    style={{ width: 'calc((100% - 20px) / 6)' }}
                                                    onClick={() => !Object.values(game.players).some(p => p.techTiles?.includes(game.extraAdvancedTechTile!.id)) && onSelectAdvancedTechTile(game.extraAdvancedTechTile!.id)}
                                                >
                                                    {(() => {
                                                        const advTile = game.extraAdvancedTechTile!;
                                                        const isTaken = Object.values(game.players).some(p => p.techTiles?.includes(advTile.id));
                                                        return isTaken ? (
                                                            <div className="w-full h-full flex items-center justify-center bg-black/50 text-[6px] text-zinc-600 font-bold">TAKEN</div>
                                                        ) : (
                                                            <>
                                                                {advTile.image ? (
                                                                    <img src={advTile.image} alt={advTile.label} className="w-full h-full object-contain" />
                                                                ) : (
                                                                    <div className="w-full h-full flex items-center justify-center text-[6px] text-zinc-500 text-center px-0.5 leading-none">{advTile.label}</div>
                                                                )}
                                                                <div className="absolute top-0 left-0 w-full h-full hidden group-hover:block z-[130] pointer-events-none">
                                                                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 w-48 p-2 bg-zinc-950 border border-cyan-500/30 rounded-lg shadow-2xl text-[9px] text-zinc-300 whitespace-normal">
                                                                        <span className="text-cyan-400 font-bold block mb-0.5">{advTile.label}</span>
                                                                        {advTile.description}
                                                                        <div className="mt-1 pt-1 border-t border-white/10 text-amber-400/80 text-[8px] font-bold">
                                                                            조건: {game.extraAdvancedTechCondition === '25vp' ? '진행 점수 25 VP 이상 도달' : '어떤 우주선이든 3회 진입 달성'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}


                        {/* Power Actions — 이미지 스트립(7등분 클릭존). 미니: 위 비용부분 크롭(object-bottom) */}
                        <div className="pt-1 border-t border-white/10 mt-1">
                            <div className="relative w-full aspect-[8/1] rounded overflow-hidden border border-amber-500/20">
                                <img src="/image/powerAction.jpg" alt="power actions" className="absolute inset-0 w-full h-full object-cover object-bottom" />
                                <div className="absolute inset-0 grid grid-cols-7">
                                    {game.powerActions.map((action) => {
                                        const usedByColor = action.isUsed && action.usedByPlayerId ? FACTIONS.find(f => f.id === game.players[action.usedByPlayerId!]?.faction)?.color : undefined;
                                        return (
                                            <button
                                                key={action.id}
                                                disabled={action.isUsed}
                                                onClick={() => !action.isUsed && onUsePowerAction(action.id)}
                                                className={`relative h-full border-r last:border-r-0 border-black/30 transition-colors ${action.isUsed ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-amber-300/25'}`}
                                                title={action.isUsed ? `${action.label} (${action.cost} ${action.costType.toUpperCase()}) · 사용: ${action.usedByPlayerName ?? '?'}` : `${action.label} (${action.cost} ${action.costType.toUpperCase()})`}
                                            >
                                                {action.isUsed && <div className="absolute inset-0 bg-black/65" />}
                                                {usedByColor && <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full border border-black/60" style={{ backgroundColor: usedByColor }} />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* Spaceships — 2x2 Grid for Mini View */}
                        {game.spaceships && Object.keys(game.spaceships).length > 0 && (
                            <div className="pt-1 border-t border-white/10 mt-1">
                                <div className="text-[7px] uppercase font-black text-zinc-500 mb-1">Spaceships</div>
                                <div className="grid grid-cols-2 gap-1.5">
                                    {['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].map((shipType) => {
                                        const tile = game.map.find((t) => t.type === shipType);
                                        if (!tile || !game.spaceships?.[tile.id]) return null;
                                        const ship = game.spaceships![tile.id];
                                        const isInShip = playerId && ship.occupants.includes(playerId);
                                        const usedIndices = ship.usedActionIndices ?? [];
                                        const shipFedId = game.spaceshipFederationByShip?.[tile.type];
                                        const shipFedTaken = shipFedId && Object.values(game.players).some((p) => getFederationEntries(p).some((e) => e.rewardId === shipFedId));
                                        const rewardIndex = shipFedId != null ? SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === shipFedId) : -1;
                                        const imgUrl = rewardIndex !== -1 ? `/image/Federation_${rewardIndex + 7}.gif` : null;
                                        const techId = game.shipTechByShip?.[tile.type] ?? SHIP_TECH_BY_SHIP[tile.type];
                                        const techTile = techId ? SHIP_TECH_TILES.find((t) => t.id === techId) : null;
                                        const actionLabels = SHIP_ACTION_LABELS[tile.type] || ['—', '—', '—'];

                                        const { quadrantFactionColors: quadrantColors, quadrantTitles } =
                                            getShipQuadrantsByPlayerSeat(game, ship.occupants ?? []);

                                        return (
                                            <MiniShipQuadrantFrame
                                                key={tile.id}
                                                quadrantFactionColors={quadrantColors}
                                                quadrantTitles={quadrantTitles}
                                                className={isInShip ? 'shadow-[0_0_12px_rgba(52,211,153,0.2)]' : ''}
                                            >
                                                <div className="p-1.5 flex flex-col gap-1 min-h-0 h-full">
                                                <div className="flex justify-between items-center border-b border-white/5 pb-0.5 min-w-0">
                                                    <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                                                        <span className="text-[7px] font-black text-zinc-200 uppercase leading-none truncate">{SHIP_NAMES[tile.type]}</span>
                                                        {/* 탑승자: 종족색 배경 칩 + 플레이어 이름 → 한눈에 누가 탔는지 식별 (기존엔 1.5px 점이라 안 보였음) */}
                                                        <div className="flex flex-wrap items-center gap-0.5 shrink min-w-0">
                                                            {ship.occupants.map((pid) => {
                                                                const p = game.players[pid];
                                                                const faction = p?.faction ? FACTIONS.find(f => f.id === p.faction) : null;
                                                                const nm = p?.name || pid;
                                                                return (
                                                                    <span
                                                                        key={pid}
                                                                        className="px-1 rounded-[2px] text-[7px] font-black uppercase leading-[1.5] border border-black/50 shadow-sm truncate max-w-[52px]"
                                                                        style={{ backgroundColor: faction?.color || '#888', color: '#fff', textShadow: '0 1px 1px rgba(0,0,0,0.85)' }}
                                                                        title={`${nm}${faction?.name ? ` · ${faction.name}` : ''}`}
                                                                    >
                                                                        {nm}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                    {!isInShip && (
                                                        <span className="shrink-0 ml-1 inline-flex items-center gap-0.5 rounded-sm border border-amber-400/40 bg-amber-500/10 px-1 py-0.5">
                                                            <Lock className="w-2.5 h-2.5 text-amber-300" />
                                                            <span className="text-[6px] font-black uppercase tracking-wide text-amber-200">LOCK</span>
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex items-center justify-center gap-1 py-1 flex-grow">
                                                    {/* Federation Reward (Reduced to 80%) */}
                                                    <div className="w-[35px] h-[35px] shrink-0 flex items-center justify-center">
                                                        {shipFedTaken ? (
                                                            <div className="w-full h-full flex items-center justify-center">
                                                                <span className="text-[7px] text-zinc-500 italic">Taken</span>
                                                            </div>
                                                        ) : imgUrl ? (
                                                            <img src={imgUrl} alt="Fed" className="w-full h-full object-contain" />
                                                        ) : (
                                                            <div className="w-full h-full rounded bg-black/40 border border-white/5" />
                                                        )}
                                                    </div>

                                                    {/* Tech Tile or Artifacts (Twilight 2x2 - Restored) */}
                                                    <div className={`${tile.type === 'ship_twilight' ? 'w-[110px] h-[72px]' : 'w-[44px] h-[44px]'} shrink-0 flex items-center justify-center relative`}>
                                                        {tile.type === 'ship_twilight' ? (
                                                            <div className="grid grid-cols-2 gap-0.5">
                                                                {[0, 1, 2, 3].map((idx) => {
                                                                    const aid = game.twilightArtifactSlots?.[idx];
                                                                    if (!aid) return <div key={idx} className="w-[54px] h-[35px] rounded-[1px] border border-dashed border-white/10" />;
                                                                    const art = ARTIFACTS.find(a => a.id === aid);
                                                                    const artIndex = ARTIFACTS.findIndex(a => a.id === aid);
                                                                    const artImgUrl = artIndex !== -1 ? `/image/Art${artIndex + 1}.png` : null;
                                                                    
                                                                    const totalPower = (currentPlayer?.power1 ?? 0) + (currentPlayer?.power2 ?? 0) + (currentPlayer?.power3 ?? 0);
                                                                    const canTake = isInShip && onTakeTwilightArtifact && game.turnOrder?.[game.currentPlayerIndex ?? 0] === playerId && !game.hasDoneMainAction && totalPower >= 6;
                                                                    
                                                                    return (
                                                                        <div 
                                                                            key={idx} 
                                                                            onClick={() => canTake && onTakeTwilightArtifact?.(aid)}
                                                                            className={`w-[54px] h-[35px] rounded-[2px] bg-purple-900/40 overflow-hidden border shadow-sm transition-all ${canTake ? 'border-purple-500 cursor-pointer hover:bg-purple-800/60 shadow-[0_0_8px_rgba(168,85,247,0.3)]' : 'border-purple-500/20 cursor-default'}`}
                                                                            title={art ? `${art.label}: ${art.description}` : ''}
                                                                        >
                                                                            {artImgUrl && <img src={artImgUrl} alt="Art" className="w-full h-full object-contain" />}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        ) : (
                                                            techTile && (
                                                                <div 
                                                    className={`w-full h-full rounded bg-zinc-800/40 border border-yellow-500/20 flex items-center justify-center overflow-hidden transition-all ${pendingTech ? 'hover:border-yellow-500 cursor-pointer shadow-[0_0_10px_rgba(234,179,8,0.2)]' : ''}`}
                                                    onClick={(e) => {
                                                        if (pendingTech && onSelectTechTile) {
                                                            e.stopPropagation();
                                                            onSelectTechTile(techTile.id);
                                                        }
                                                    }}
                                                >
                                                                    {techTile.image ? (
                                                                        <img src={techTile.image} alt="Tech" className="w-full h-full object-contain" />
                                                                    ) : (
                                                                        <div className="text-[5px] text-zinc-500">T</div>
                                                                    )}
                                                                </div>
                                                            )
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Action Strip Image (가로 3칸 클릭존) — 텍스트 버튼 대체.
                                                    미니뷰: 위 필요자원 영역 크롭(object-bottom, 좁은 비율). 전체 Research: 자연 비율로 다 표시. */}
                                                <div className={`relative w-full mt-auto rounded-[2px] overflow-hidden border border-white/10 ${isMini ? 'aspect-[3.4/1]' : ''}`}>
                                                    {SHIP_ACTION_IMG[tile.type] && (
                                                        <img src={SHIP_ACTION_IMG[tile.type]} alt="actions" className={isMini ? 'absolute inset-0 w-full h-full object-cover object-bottom' : 'block w-full h-auto'} />
                                                    )}
                                                    {/* 좌측 이미지 여백(불필요 픽셀)을 첫 칸이 흡수하도록 1칸을 살짝 넓게 (TF Mars는 여백이 더 커서 1.12) */}
                                                    <div className={`absolute inset-0 grid ${tile.type === 'ship_tf_mars' ? 'grid-cols-[1.16fr_1fr_1fr]' : 'grid-cols-[1.12fr_1fr_1fr]'}`}>
                                                        {actionLabels.map((label, idx) => {
                                                            const isUsed = usedIndices.includes(idx + 1);
                                                            const actionNum = idx + 1;
                                                            const isInShip = playerId && ship.occupants.includes(playerId);
                                                            const canUse = isInShip && onUseShipAction && !isUsed && usedIndices.length < 3;
                                                            const usedBy = isUsed ? ship.usedActionBy?.[actionNum] : undefined;
                                                            const usedByPlayer = usedBy ? game.players[usedBy] : undefined;
                                                            const usedByColor = usedByPlayer?.faction ? FACTIONS.find(f => f.id === usedByPlayer.faction)?.color : undefined;
                                                            return (
                                                                <button
                                                                    key={idx}
                                                                    disabled={!canUse}
                                                                    onClick={() => canUse && onUseShipAction(tile.id, actionNum)}
                                                                    className={`relative h-full border-r last:border-r-0 border-black/30 transition-colors ${canUse ? 'cursor-pointer hover:bg-emerald-300/25' : 'cursor-default'}`}
                                                                    title={label + (isUsed ? ` (사용: ${usedByPlayer?.name ?? '?'})` : !isInShip ? ' (우주선 탑승 필요)' : '')}
                                                                >
                                                                    {isUsed && <div className="absolute inset-0 bg-black/65" />}
                                                                    {usedByColor && (
                                                                        <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full border border-black/60" style={{ backgroundColor: usedByColor }} />
                                                                    )}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>

                                                </div>
                                            </MiniShipQuadrantFrame>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className={`grid grid-cols-6 gap-3`}>
                        {RESEARCH_TRACKS.map((track) => {
                            const navBlocked = track.id === 'navigation' && !balTakCanAdvanceNav;
                            return (
                                <div
                                    key={track.id}
                                    className={`flex flex-col gap-2 p-1.5 rounded-xl transition-all duration-300 border border-transparent z-10 hover:z-[100] ${navBlocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-white/10'}`}
                                    onClick={() => { if (!navBlocked) handleTrackClick(track.id as ResearchTrack); }}
                                    title={navBlocked ? "발타크: 의회 건설 후 Nav 트랙 진행 가능" : undefined}
                                    style={{
                                        backgroundColor: navBlocked ? 'transparent' : `${track.color}08`,
                                        boxShadow: navBlocked ? 'none' : `inset 0 0 20px ${track.color}08`,
                                        borderColor: navBlocked ? '#333' : `${track.color}20`
                                    }}
                                >
                                    {/* Track Title */}
                                    <div className={`${isMini ? 'text-[8px]' : 'text-[10px]'} font-black uppercase tracking-tighter text-center truncate px-1`} style={{ color: track.color }}>
                                        {track.name}
                                    </div>

                                    {/* Track Levels & Tiles Stack */}
                                    <div className={`flex flex-col-reverse gap-0.5 ${isMini ? 'p-1' : 'p-1.5'} rounded-lg border border-white/5 relative bg-black/20 backdrop-blur-sm`} style={{ borderLeftColor: `${track.color}40`, borderLeftWidth: '2px' }}>
                                        {/* Standard Tech Tile Slot (Exactly under Level 0) - 빈 칸이어도 자리 유지 */}
                                        {getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack) ? (
                                            (() => {
                                                const trackTile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack)!;
                                                return (
                                                    <div
                                                        className={`mt-0.5 ${isMini ? 'p-1' : 'p-2'} bg-zinc-900/60 rounded-lg border border-yellow-500/20 hover:border-yellow-500/50 transition-all cursor-pointer group relative shadow-lg z-10 hover:z-20`}
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
                                                        <div className="flex flex-col items-center justify-center gap-0.5">
                                                            {trackTile.image ? (
                                                                <img src={trackTile.image} alt={trackTile.label} className={`${isMini ? 'h-[32px]' : 'h-[60px]'} w-auto object-contain`} />
                                                            ) : (
                                                                <div className="text-[9px] font-black text-center text-zinc-100 uppercase truncate leading-none py-1">
                                                                    {trackTile.label}
                                                                </div>
                                                            )}
                                                        </div>
                                                        {/* Count Badge */}
                                                        {(() => {
                                                            const count = (game.techTilesByTrack[track.id as ResearchTrack] || []).filter(t => t).length;
                                                            return (
                                                                <div className="absolute -top-1 -right-1 bg-yellow-600 text-white text-[8px] px-1 rounded-full font-bold shadow-sm z-10">
                                                                    {count}
                                                                </div>
                                                            );
                                                        })()}
                                                        {/* Tooltip */}
                                                        <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-[110] w-48 p-2 bg-zinc-950 border border-yellow-500/20 rounded-lg shadow-2xl">
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
                                            const isTerraforming5FederationAvailable =
                                                level === 5 &&
                                                track.id === 'terraforming' &&
                                                !!game.federationOnTerraforming5 &&
                                                !Object.values(game.players).some((p) => (p.research?.terraforming ?? 0) >= 5);
                                            // Nav 5 보상 = 잊혀진 행성. 아무도 Nav5에 도달하기 전까지 슬롯에 잊혀진 행성 이미지 표시(선착 1명이 획득).
                                            const isNav5LostPlanetAvailable =
                                                level === 5 &&
                                                track.id === 'navigation' &&
                                                !Object.values(game.players).some((p) => (p.research?.navigation ?? 0) >= 5);
                                            const getTrackBonus = (trackId: string, lvl: number): string => {
                                                if (trackId === 'terraforming') {
                                                    if (lvl === 0) return '3O/Step';
                                                    if (lvl === 1) return '+2O';
                                                    if (lvl === 2) return '2O/Step';
                                                    if (lvl === 3) return '1O/Step';
                                                    if (lvl === 4) return '+2O';
                                                    if (lvl === 5) return '';
                                                }
                                                if (trackId === 'navigation') {
                                                    if (lvl === 0) return 'Range 1';
                                                    if (lvl === 1) return '+1QIC';
                                                    if (lvl === 2) return 'Range 2';
                                                    if (lvl === 3) return '+1QIC';
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
                                                    if (lvl === 1) return '+1 former : 6T';
                                                    if (lvl === 2) return '+3 Tokens';
                                                    if (lvl === 3) return '+1 former : 4T';
                                                    if (lvl === 4) return '+1 former : 3T';
                                                    if (lvl === 5) return '4VP + Gaia';
                                                }
                                                if (trackId === 'economy') {
                                                    if (lvl === 0) return '';
                                                    if (lvl === 1) return '2C, 1P';
                                                    if (lvl === 2) return '1O, 2C, 2P';
                                                    if (lvl === 3) return game.economyVariant === 'vp' ? '1O, 3C, 1VP' : '1O, 2C, 3P';
                                                    if (lvl === 4) return game.economyVariant === 'vp' ? '2O, 4C, 1VP' : '2O, 2C, 2P';
                                                    if (lvl === 5) return '+3O, +6C, +6P';
                                                }
                                                if (trackId === 'science') {
                                                    if (lvl === 0) return '';
                                                    if (lvl === 1) return '1K';
                                                    if (lvl === 2) return '2K';
                                                    if (lvl === 3) return '3K';
                                                    if (lvl === 4) return '4K';
                                                    if (lvl === 5) return '+9K';
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
                                                        className={`rounded border flex flex-col items-center justify-center relative transition-all z-10 hover:z-20 ${isMini ? 'h-7' : 'h-12'} ${level === 5 ? 'border-primary/50 bg-primary/5 shadow-[inset_0_0_10px_rgba(var(--primary),0.1)]' : 'border-white/5'
                                                            }`}
                                                        style={{
                                                            backgroundColor: level > 0 ? `${track.color}${level === 5 ? '30' : '15'}` : undefined,
                                                            borderColor: level > 0 ? `${track.color}40` : undefined
                                                        }}
                                                    >
                                                        <span className={`absolute top-0 left-1 font-black ${isMini ? 'text-[6px] text-zinc-600' : 'text-[8px] text-zinc-300/80'}`}>L{level}</span>
                                                        <div className="flex flex-col items-center justify-center p-0.5">
                                                            {isTerraforming5FederationAvailable ? (() => {
                                                                const rewardIdx = FEDERATION_REWARDS.findIndex((r) => r.id === game.federationOnTerraforming5);
                                                                const label = FEDERATION_REWARDS[rewardIdx]?.label ?? 'L5 Federation';
                                                                return rewardIdx !== -1 ? (
                                                                    <img
                                                                        src={`/image/Federation_${rewardIdx + 1}.gif`}
                                                                        alt={label}
                                                                        className={`${isMini ? 'h-7' : 'h-12'} w-auto object-contain`}
                                                                        title={`Terraforming 5 보상: ${label}`}
                                                                    />
                                                                ) : (
                                                                    <div className={`${isMini ? 'text-[7px] text-zinc-400' : 'text-[10px] text-zinc-50'} font-black uppercase text-center px-1 leading-tight tracking-tight drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]`}>
                                                                        {label}
                                                                    </div>
                                                                );
                                                            })() : isNav5LostPlanetAvailable ? (
                                                                <img
                                                                    src="/map/lost_planet.png"
                                                                    alt="Lost Planet"
                                                                    className={`${isMini ? 'h-7' : 'h-12'} w-auto object-contain`}
                                                                    title="Navigation 5 보상: 잊혀진 행성 (선착 1명)"
                                                                />
                                                            ) : (
                                                                <div className={`${isMini ? 'text-[7px] text-zinc-400' : 'text-[10px] text-zinc-50'} font-black uppercase text-center px-1 leading-tight tracking-tight drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]`}>
                                                                    {getTrackBonus(track.id, level)}
                                                                </div>
                                                            )}
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
                                                                            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-[110]">
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

                                                        // 이미 누군가 획득했으면 빈 자리(획득됨)로 유지 — 칸을 당겨 레이아웃이 밀리지 않도록
                                                        const isTaken = Object.values(game.players).some(p => p.techTiles?.includes(advTile!.id));
                                                        if (isTaken) return (
                                                            <div className={`mt-1 py-1.5 px-2 rounded border border-dashed border-cyan-500/15 bg-cyan-950/20 flex items-center justify-center ${isMini ? 'h-[40px]' : 'h-[72px]'}`}>
                                                                <span className="text-[8px] text-cyan-600/70 uppercase font-black tracking-wider">획득됨</span>
                                                            </div>
                                                        );

                                                        const playerLvl = playerId ? (game.players[playerId]?.research?.[track.id as ResearchTrack] ?? 0) : 0;
                                                        const canTakeAdvanced = pendingTech && onSelectAdvancedTechTile && playerId && playerLvl >= 4
                                                            && countGreenFederations(game.players[playerId]) >= 1
                                                            && (game.players[playerId]?.techTiles || []).filter((id: string) => !isTechTileCovered(game.players[playerId], id) && !id.startsWith('adv-')).length >= 1;
                                                        return (
                                                            <div
                                                                className={`mt-1 py-1.5 px-2 rounded border transition-all group relative z-10 hover:z-20 shadow-[0_0_10px_rgba(6,182,212,0.1)] ${canTakeAdvanced ? 'bg-gradient-to-b from-cyan-900/40 to-cyan-950/60 border-cyan-500/30 hover:border-cyan-400 cursor-pointer' : 'bg-gradient-to-b from-cyan-900/40 to-cyan-950/60 border-cyan-500/30 cursor-help'}`}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (canTakeAdvanced && advTile?.id) onSelectAdvancedTechTile(advTile.id, track.id as ResearchTrack);
                                                                }}
                                                            >
                                                                <div className="flex flex-col items-center justify-center">
                                                                    {advTile?.image ? (
                                                                        <img src={advTile.image} alt={advTile?.label} className={`${isMini ? 'h-[32px]' : 'h-[60px]'} w-auto object-contain`} />
                                                                    ) : (
                                                                        <div className="text-[9px] font-black text-center text-zinc-100 uppercase truncate leading-none py-1">
                                                                            {advTile?.label}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                {canTakeAdvanced && <div className="text-[7px] text-cyan-400 text-center">클릭 시 고급 획득</div>}
                                                                {/* Tooltip — pointer-events-none: 펼쳐진 툴팁이 아래 레벨 셀을 덮어 호버를 가로채던 문제 방지 */}
                                                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block pointer-events-none z-[110] w-56 p-3 bg-zinc-950 border border-cyan-500/40 rounded-xl shadow-2xl backdrop-blur-md">
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
                )} {/* end regular-view grid / ternary */}

                {/* 하단: 풀 3개(위) + 7번째 고급 타일(아래 오른쪽) */}
                {!isMini && (
                    <>
                        {/* Tech Tiles Pool (3 extra tiles not in tracks) – Aligned with the 6-column grid */}
                        <div className="grid grid-cols-6 gap-3 mt-4">
                            {(() => {
                                const pool = game.techTilesPool || [];
                                const uniqueTiles: { tile: TechTile; count: number }[] = [];
                                pool.forEach(t => {
                                    if (!t) return;
                                    const existing = uniqueTiles.find(u => u.tile.id === t.id);
                                    if (existing) existing.count++;
                                    else uniqueTiles.push({ tile: t, count: 1 });
                                });

                                // empty slots (based on 3 pool tile types)
                                const uniqueIds = new Set(pool.filter(t => t).map(t => t!.id));
                                const emptySlots = Math.max(0, 3 - uniqueIds.size);
                                const empties = Array(emptySlots).fill(null).map((_, i) => (
                                    <div key={`pool-empty-${i}`} className="col-span-2 bg-zinc-900/30 p-2 rounded-xl border border-dashed border-white/10 flex flex-col items-center justify-center text-[10px] text-zinc-600 min-h-[5rem] uppercase font-black tracking-widest">
                                        Sold Out
                                    </div>
                                ));

                                return [...uniqueTiles.map(({ tile, count }) => {
                                    const curPlayer = playerId ? game.players[playerId] : null;
                                    const isUsed = curPlayer?.usedTechActions?.includes(tile.id);
                                    const isAction = tile.id === 'tech-act-4p' || tile.id.startsWith('adv-act-');
                                    const hasTile = curPlayer?.techTiles?.includes(tile.id);
                                    return (
                                        <div
                                            key={tile.id}
                                            className={`col-span-2 bg-zinc-900/60 p-2 rounded-xl border border-yellow-500/20 hover:border-yellow-500/50 transition-all group relative shadow-lg z-10 hover:z-20 ${isUsed ? 'grayscale opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                                            onClick={() => {
                                                if (isUsed) return;
                                                if (isAction && hasTile) {
                                                    onUseTechAction(tile.id);
                                                } else if (pendingTech && onSelectTechTile) {
                                                    setSelectedTileIdNeedingTrack(tile.id);
                                                } else {
                                                    onGainTechTile(tile.id);
                                                }
                                            }}
                                        >
                                            <div className="flex flex-col items-center justify-center gap-1">
                                                {tile.image ? (
                                                    <img src={tile.image} alt={tile.label} className="h-[64px] w-auto object-contain" />
                                                ) : (
                                                    <div className="text-[10px] font-black text-center text-zinc-100 uppercase py-2 leading-tight">{tile.label}</div>
                                                )}
                                            </div>
                                            <div className="absolute top-1 right-1 bg-yellow-600 text-white text-[9px] w-4 h-4 rounded-full font-black flex items-center justify-center shadow-sm z-10 border border-black/20">
                                                {count}
                                            </div>
                                            <div className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 hidden group-hover:block z-[110] w-56 p-3 bg-zinc-950/95 backdrop-blur-md border border-yellow-500/30 rounded-xl shadow-2xl pointer-events-none">
                                                <div className="text-[11px] font-black text-yellow-500 mb-1 uppercase tracking-wider pb-1.5 border-b border-white/5">{tile.label}</div>
                                                <p className="text-[10px] text-zinc-300 leading-relaxed font-medium">{tile.description}</p>
                                            </div>
                                        </div>
                                    );
                                }), ...empties];
                            })()}
                        </div>

                        {game.extraAdvancedTechTile && (
                            <div className="flex items-stretch justify-end gap-4 mt-2">
                                {(() => {
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
                                                <div className="flex items-center justify-center gap-2">
                                                    {extra.image ? (
                                                        <img src={extra.image} alt={extra.label} className="h-10 w-auto object-contain" />
                                                    ) : (
                                                        <div className="text-[10px] font-bold text-zinc-100 truncate">{extra.label}</div>
                                                    )}
                                                    <div className="flex flex-col">
                                                        <div className="text-[10px] font-bold text-zinc-100 truncate">{extra.label}</div>
                                                        <div className="text-[8px] text-zinc-500 truncate" title={extra.description}>{extra.description}</div>
                                                    </div>
                                                </div>
                                            </button>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}

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

                        {/* Power Actions Section — 이미지 스트립(7등분 클릭존), 전체뷰: 다 표시 */}
                        <div className="space-y-4 pt-4 border-t border-white/5">
                            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Main Board Power Actions</h4>
                            <div className="relative w-[50%] mx-auto rounded-md overflow-hidden border border-amber-500/20">
                                <img src="/image/powerAction.jpg" alt="power actions" className="block w-full h-auto" />
                                <div className="absolute inset-0 grid grid-cols-7">
                                    {game.powerActions.map((action) => {
                                        const usedByColor = action.isUsed && action.usedByPlayerId ? FACTIONS.find(f => f.id === game.players[action.usedByPlayerId!]?.faction)?.color : undefined;
                                        return (
                                            <button
                                                key={action.id}
                                                disabled={action.isUsed}
                                                onClick={() => !action.isUsed && onUsePowerAction(action.id)}
                                                className={`relative h-full border-r last:border-r-0 border-black/30 transition-colors ${action.isUsed ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-amber-300/25'}`}
                                                title={action.isUsed ? `${action.label} (${action.cost} ${action.costType.toUpperCase()}) · 사용: ${action.usedByPlayerName ?? '?'}` : `${action.label} (${action.cost} ${action.costType.toUpperCase()})`}
                                            >
                                                {action.isUsed && <div className="absolute inset-0 bg-black/65" />}
                                                {usedByColor && <span className="absolute top-1 right-1 w-2 h-2 rounded-full border border-black/60" style={{ backgroundColor: usedByColor }} />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* Spaceships Section: 잠긴 우주선도 액션·기술 타일 정보 + 우주선별 연방 표시 */}
                        {game.spaceships && Object.keys(game.spaceships).length > 0 && (() => {
                            const byShip = game.spaceshipFederationByShip || {};
                            return (
                                <div className="space-y-4 pt-4 border-t border-white/5">
                                    <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Spaceships (3 actions each)</h4>
                                    <div className="grid grid-cols-2 gap-4">
                                        {['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].map((shipType) => {
                                            const tile = game.map.find((t) => t.type === shipType);
                                            if (!tile || !game.spaceships?.[tile.id]) return null;
                                            const ship = game.spaceships![tile.id];
                                            const name = SHIP_NAMES[tile.type] || tile.type;
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
                                                <div key={tile.id} className={`bg-zinc-900/60 rounded-lg border p-2 space-y-2 ${isInShip ? 'border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.15)]' : 'border-white/10'}`}>
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-[12px] font-bold text-zinc-100">{name}</span>
                                                        {!isInShip && <span className="text-[10px] text-amber-400 font-black tracking-widest">LOCKED</span>}
                                                    </div>
                                                    <div className="flex gap-3 items-start min-h-[100px]">
                                                        {/* Left: Reward & Occupants */}
                                                        <div className="flex-1 space-y-2">
                                                            {shipFedId != null && (() => {
                                                                const rewardIndex = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === shipFedId);
                                                                const imgUrl = rewardIndex !== -1 ? `/image/Federation_${rewardIndex + 7}.gif` : null;
                                                                return (
                                                                    <div className="flex items-center gap-2 py-1">
                                                                        <span className="text-[11px] text-zinc-400 font-semibold shrink-0">보상:</span>
                                                                        {shipFedTaken ? (
                                                                            <span className="text-zinc-500 italic text-[11px]">획득됨</span>
                                                                        ) : imgUrl ? (
                                                                            <img
                                                                                src={imgUrl}
                                                                                alt={shipFedLabel || 'Spaceship Federation Reward'}
                                                                                className="h-16 w-auto object-contain border border-white/10 rounded shadow-sm"
                                                                                title={shipFedLabel || ''}
                                                                            />
                                                                        ) : (
                                                                            <span className="text-[11px] text-zinc-300 font-medium">{shipFedLabel}</span>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}
                                                            <div className="flex items-center flex-wrap gap-1 text-[11px] leading-tight">
                                                                <span className="text-zinc-500 font-semibold mr-0.5">탑승:</span>
                                                                {ship.occupants.length > 0 ? (
                                                                    ship.occupants.map((pid) => {
                                                                        const p = game.players[pid];
                                                                        const faction = p?.faction ? FACTIONS.find(f => f.id === p.faction) : null;
                                                                        const nm = p?.name || pid;
                                                                        return (
                                                                            <span
                                                                                key={pid}
                                                                                className="px-1.5 rounded text-[10px] font-black uppercase leading-[1.6] border border-black/50 shadow-sm"
                                                                                style={{ backgroundColor: faction?.color || '#888', color: '#fff', textShadow: '0 1px 1px rgba(0,0,0,0.85)' }}
                                                                                title={`${nm}${faction?.name ? ` · ${faction.name}` : ''}`}
                                                                            >
                                                                                {nm}
                                                                            </span>
                                                                        );
                                                                    })
                                                                ) : (
                                                                    <span className="text-zinc-500">—</span>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* Right: Tech Tile or Artifacts (Twilight 4x1 Enlarged 1.2x) */}
                                                        <div className={`${tile.type === 'ship_twilight' ? 'w-[360px]' : 'w-[180px]'} shrink-0`}>
                                                            {techTile && (
                                                                <div
                                                                    className={`p-2 bg-zinc-800/80 rounded-lg border border-yellow-500/30 flex items-center gap-2 transition-all ${pendingTech ? 'hover:border-yellow-500 cursor-pointer shadow-lg ring-1 ring-yellow-500/20' : ''}`}
                                                                    onClick={() => {
                                                                        if (pendingTech && onSelectTechTile) {
                                                                            onSelectTechTile(techTile.id);
                                                                        }
                                                                    }}
                                                                >
                                                                    {techTile.image ? (
                                                                        <img src={techTile.image} alt={techTile.label} className="h-[60px] w-auto object-contain" />
                                                                    ) : (
                                                                        <div className="w-10 h-10 bg-zinc-900 rounded flex items-center justify-center text-[8px] text-zinc-500">No Img</div>
                                                                    )}
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="text-[9px] font-black text-yellow-500/90 uppercase mb-0.5 tracking-tight truncate">Technology</div>
                                                                        <div className="text-[10px] font-bold text-zinc-100 mb-0.5 truncate">{techTile.label}</div>
                                                                        <div className="text-[9px] text-zinc-400 line-clamp-2 leading-tight" title={techTile.description}>{techTile.description}</div>
                                                                    </div>
                                                                </div>
                                                            )}
                                                            {tile.type === 'ship_twilight' && (game.twilightArtifactSlots?.length ?? 0) > 0 && (
                                                                <div className="p-1">
                                                                    <div className="grid grid-cols-4 gap-2">
                                                                        {(game.twilightArtifactSlots ?? []).map((aid, idx) => {
                                                                            if (!aid) return <div key={idx} className="h-20 w-20 rounded border border-dashed border-white/5 bg-black/20" />;
                                                                            const art = ARTIFACTS.find(a => a.id === aid);
                                                                            if (!art) return null;
                                                                            const artIndex = ARTIFACTS.findIndex(a => a.id === aid);
                                                                            const artImgUrl = artIndex !== -1 ? `/image/Art${artIndex + 1}.png` : null;

                                                                            const totalPower = (currentPlayer?.power1 ?? 0) + (currentPlayer?.power2 ?? 0) + (currentPlayer?.power3 ?? 0);
                                                                            const canTake = isInShip && onTakeTwilightArtifact && game.turnOrder?.[game.currentPlayerIndex ?? 0] === playerId && !game.hasDoneMainAction && totalPower >= 6;
                                                                            return (
                                                                                <Button
                                                                                    key={idx}
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    className="h-20 w-20 p-1 border-purple-500/40 bg-purple-900/20 hover:bg-purple-800/40 disabled:opacity-100 disabled:cursor-default"
                                                                                    disabled={!canTake}
                                                                                    onClick={() => onTakeTwilightArtifact?.(aid)}
                                                                                    title={`${art.label}: ${art.description}`}
                                                                                >
                                                                                    {artImgUrl ? (
                                                                                        <img src={artImgUrl} alt={art.label} className="h-full w-full object-contain" />
                                                                                    ) : (
                                                                                        <span className="text-[8px] font-bold text-center leading-none">{art.label}</span>
                                                                                    )}
                                                                                </Button>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-1.5 pt-2 border-t border-white/5">
                                                        <div className="text-[10px] font-black uppercase text-zinc-500 tracking-wider">Actions ({actionsUsedCount}/3)</div>
                                                        <div className="relative w-[50%] mx-auto rounded-md overflow-hidden border border-white/10">
                                                            {SHIP_ACTION_IMG[tile.type] && (
                                                                <img src={SHIP_ACTION_IMG[tile.type]} alt="actions" className="block w-full h-auto" />
                                                            )}
                                                            <div className="absolute inset-0 grid grid-cols-3">
                                                                {[0, 1, 2].map((idx) => {
                                                                    const actionNum = idx + 1;
                                                                    const label = actionLabels[idx];
                                                                    const isUsed = usedIndices.includes(actionNum);
                                                                    const canUse = isInShip && onUseShipAction && !isUsed && actionsUsedCount < 3;
                                                                    const usedBy = isUsed ? ship.usedActionBy?.[actionNum] : undefined;
                                                                    const usedByPlayer = usedBy ? game.players[usedBy] : undefined;
                                                                    const usedByColor = usedByPlayer?.faction ? FACTIONS.find(f => f.id === usedByPlayer.faction)?.color : undefined;
                                                                    return (
                                                                        <button
                                                                            key={idx}
                                                                            disabled={!canUse}
                                                                            onClick={() => canUse && onUseShipAction(tile.id, actionNum)}
                                                                            className={`relative h-full border-r last:border-r-0 border-black/30 transition-colors ${canUse ? 'cursor-pointer hover:bg-emerald-300/25' : 'cursor-default'}`}
                                                                            title={label + (isUsed ? ` (사용: ${usedByPlayer?.name ?? '?'})` : !isInShip ? ' (우주선 탑승 필요)' : '')}
                                                                        >
                                                                            {isUsed && <div className="absolute inset-0 bg-black/65" />}
                                                                            {usedByColor && (
                                                                                <span className="absolute top-1 right-1 w-2 h-2 rounded-full border border-black/60" style={{ backgroundColor: usedByColor }} />
                                                                            )}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })()}
                    </>
                )}
            </CardContent>
        </Card >
    );
}
