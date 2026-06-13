import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { HexGrid, Layout, Hexagon, Text } from 'react-hexgrid';
import { motion } from 'framer-motion';

import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw, Menu, X, HelpCircle, Grid3x3 } from 'lucide-react';
import { GameUiHelpDialog } from '@/components/GameUiHelpDialog';
import { fireTurnNotification } from '@/lib/turnNotify';
import type { GaiaGameState, HexTile, PlanetType, StructureType, ResearchTrack } from '@shared/gameConfig';
import {
  PLANET_COLORS,
  SECTOR_COLORS,
  STRUCTURE_SYMBOLS,
  FACTIONS,
  getTerraformSteps,
  getTerraformStepsForFaction,
  getTerraformCost,
  getRange,
  getEffectiveBaseRange,
  hasNearbyPlayersForTradingDiscount,
  isEmptyHex,
  isPlanetHex,
  BUILDING_LIMITS,
  HOME_PLANETS,
  SECTOR_CENTERS,
  getGaiaBaseQic,
  ARTIFACTS,
  SHIP_TECH_BY_SHIP,
  SHIP_TECH_TILES,
  SPACESHIP_FEDERATION_REWARDS,
  getFederationEntries
} from '@shared/gameConfig';

const HEX_SIZE = 4.8;
const SQRT3 = Math.sqrt(3);

function getHexOffset(q: number, r: number, sectorIdx: number) {
  const center = SECTOR_CENTERS[sectorIdx];
  if (!center) return { x: 0, y: 0 };

  const dq = q - center.q;
  const dr = r - center.r;

  const x = HEX_SIZE * SQRT3 * (dq + dr / 2);
  const y = HEX_SIZE * 1.5 * dr;

  return { x, y };
}

/** 플레이어 건물 개수 (맵 기준, 아카데미는 left/right 구분) */
function getStructureCounts(game: GaiaGameState, playerId: string) {
  const owned = game.map.filter((t: HexTile) => t.ownerId === playerId);
  const mineCount = owned.filter((t: HexTile) => t.structure === 'mine' || t.structure === 'lost_planet_mine').length
    + game.map.filter((t: HexTile) => t.parasiticMine?.ownerId === playerId).length
    + (game.players[playerId]?.virtualMineAsteroid ? 1 : 0)
    + (game.players[playerId]?.virtualMineProto ? 1 : 0);
  const tsCount = owned.filter((t: HexTile) => t.structure === 'trading_station').length;
  const labCount = owned.filter((t: HexTile) => t.structure === 'research_lab').length;
  const piCount = owned.filter((t: HexTile) => t.structure === 'planetary_institute').length;
  const academyLeft = owned.filter((t: HexTile) => t.structure === 'academy' && (t.academyType === 'left' || t.academyType == null)).length;
  const academyRight = owned.filter((t: HexTile) => t.structure === 'academy' && t.academyType === 'right').length;
  return { mineCount, tsCount, labCount, piCount, academyLeft, academyRight };
}


const MAX_ZOOM = 3;
const MIN_ZOOM = 0.5;
const ZOOM_STEP = 0.2;

const getDistance = (a: { q: number; r: number }, b: { q: number; r: number }) => {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
};

// 건물 렌더링 함수 - 새로 생성된 종족별 건물 PNG 에셋 적용
const renderStructure = (structureType: StructureType, color: string, ownerColor?: string) => {
  // color 헥스코드(ownerColor 우선)로 원래 종족(행성) 이름을 역추적하여 파일명으로 활용
  const targetColorHex = (ownerColor || color || '').toUpperCase();

  // 잊혀진 행성 광산: 전용 이미지(/map/lost_planet.png)를 칸 가운데 출력 + 외곽을 소유자(종족) 색으로 살짝 글로우
  if (structureType === 'lost_planet_mine') {
    const sizeL = 7;
    const edgeColor = targetColorHex || '#888';
    return (
      <g transform={`translate(${-sizeL / 2}, ${-sizeL / 2})`}>
        <image
          href="/map/lost_planet.png"
          width={sizeL}
          height={sizeL}
          preserveAspectRatio="xMidYMid meet"
          style={{
            pointerEvents: 'none',
            // 종족 색 외곽 글로우(누구 것인지 표시) + 어두운 외곽선(어떤 행성색에서도 분리)
            filter: `drop-shadow(0 0 0.55px ${edgeColor}) drop-shadow(0 0 0.55px ${edgeColor}) drop-shadow(0 0 0.25px rgba(0,0,0,0.9))`,
          }}
        />
      </g>
    );
  }

  let colorName = 'titanium'; // 기본값 (회색조)
  for (const [key, hex] of Object.entries(PLANET_COLORS)) {
    if (hex.toUpperCase() === targetColorHex) {
      colorName = key;
      break;
    }
  }

  // 렌더링할 건물 타입 매핑
  let buildingType = structureType as string;
  if (buildingType === 'lost_planet_mine') buildingType = 'mine';
  if (buildingType === 'academy_left' || buildingType === 'academy_right') buildingType = 'academy';

  // 아카데미, 의회 등은 이미지가 크므로 스케일 적용 (더 크게 조정 -> 피드백 5% 축소)
  let scaleW = 11.75;
  let scaleH = 11.75;

  if (buildingType === 'mine') {
    scaleW = 7.875; scaleH = 7.875;
  } else if (buildingType === 'trading_station') {
    // 피드백: 5% 축소
    scaleW = 8.98; scaleH = 8.98;
  } else if (buildingType === 'research_lab') {
    // 피드백: 5% 축소
    scaleW = 9.83; scaleH = 9.83;
  }

  // Bounding box 타이트 크롭 후에는 이미지가 여백 없이 꽉 차므로 
  // 정중앙 위치를 위해 Y 오프셋을 정확히 절반(-scaleH / 2)으로 둡니다.
  const offsetY = -scaleH / 2;

  return (
    <g transform={`translate(${-scaleW / 2}, ${offsetY})`}>
      <image
        href={`/image/buildings/${colorName}_${buildingType}.png`}
        width={scaleW}
        height={scaleH}
        preserveAspectRatio="xMidYMid meet"
        style={{
          pointerEvents: 'none',
          // 색감 강한 맵에서 건물이 묻히는 문제 → 건물 모양을 따라가는 테두리.
          // 어두운 외곽선(밝은 행성에서 분리) + 옅은 흰 후광(어두운 행성에서 분리)으로 어떤 행성색에서도 도드라지게.
          filter: 'drop-shadow(0 0 0.22px rgba(0,0,0,0.95)) drop-shadow(0 0 0.22px rgba(0,0,0,0.95)) drop-shadow(0 0 0.85px rgba(255,255,255,0.45))',
        }}
      />
    </g>
  );
};

interface GameBoardProps {
  game: GaiaGameState;
  playerId: string | null;
  onPlaceStartingMine: (tileId: string, factionId?: string) => void;
  onBuildMine: (tileId: string, useGaiaformer?: boolean) => void;
  onUpgrade: (tileId: string, target: StructureType | 'academy_left' | 'academy_right') => void;
  onAdvanceTech: (trackId: ResearchTrack) => void;
  onUsePowerAction: (actionId: string) => void;
  onEndTurn: () => void;
  highlightedTileId?: string | null;
  onPlaceGaiaformer?: (tileId: string, qicUsed?: number) => void;
  onEnterSpaceship?: (tileId: string, useRangeBonus: boolean, qicToUse: number) => void;
  onUseShipAction?: (shipTileId: string, actionIndex: number, targetTileId?: string) => void;
  onTakeTwilightArtifact?: (artifactId: string) => void;
  onEclipseBuildAsteroidMine?: (tileId: string, qicToSpend: number) => void;
  pendingTwilightTSUpgrade?: string | null;
  pendingRebellionMineToTS?: string | null;
  onTwilightTSUpgrade?: (tileId: string) => void;
  onRebellionMineToTS?: (tileId: string) => void;
  onToggleFactionSelect?: () => void;
  isFactionSelectOpen?: boolean;
  showFactionSelectButton?: boolean;
  onFederationToggleMode?: () => void;
  onFederationToggleHex?: (tileId: string) => void;
  onFederationComplete?: () => void;
  onPlaceIvitsSpaceStation?: (tileId: string) => void;
  /** 우주정거장 배치 모드: true면 맵에서는 타일 선택만 가능, 우주정거장 배치 후/취소 시 false */
  ivitsSpaceStationMode?: boolean;
  onCancelIvitsSpaceStation?: () => void;
  /** 거리 5 잊혀진 행성 배치 (tileId, qicToSpend) */
  onPlaceLostPlanet?: (tileId: string, qicToSpend: number) => void;
  /** 엠바스(Ambas) Special: 의회↔광산 교체 모드 (광산 타일 클릭 시 교체 실행) */
  ambasSwapPiMineMode?: boolean;
  onAmbasSwapPiMine?: (mineTileId: string) => void;
  onCancelAmbasSwapPiMine?: () => void;
  /** 파이락(Firaks) Downgrade 모드: 연구소 클릭 시 해당 타일 ID 전달 → 트랙 선택으로 진행 */
  firaksDowngradeMode?: boolean;
  onFiraksDowngradeSelectLab?: (tileId: string) => void;
  onCancelFiraksDowngrade?: () => void;
  /** 모웨이드(Moweyip) 링 놓기 모드: 본인 건물(링 없는 것) 클릭 시 링 배치 */
  moweyipPlaceRingMode?: boolean;
  onMoweyipPlaceRing?: (tileId: string) => void;
  onCancelMoweyipPlaceRing?: () => void;
  /** 줌/팬 상태 외부 제어 (phase 전환 시에도 유지) */
  zoomValue?: number;
  panValue?: { x: number; y: number };
  onZoomChange?: (zoom: number) => void;
  onPanChange?: (pan: { x: number; y: number }) => void;
  hoveredPlayerId?: string | null;
  /** 상태창(Sidebar) 열림 여부 */
  isSidebarOpen?: boolean;
  /** 상태창 너비(px) — 오버레이를 맵 영역 중앙에 맞출 때 사용 */
  sidebarWidth?: number;
  /** 상태창 토글 함수 */
  onToggleSidebar?: () => void;
  /** 플레이어 상세 팝오버 배율 (1 | 2) */
  playerDetailScale?: 1 | 1.5 | 2;
  /** 플레이어 상세 1배/2배 토글 */
  onTogglePlayerDetailScale?: () => void;
}


export function GameBoard({
  game,
  playerId,
  onPlaceStartingMine,
  onBuildMine,
  onUpgrade,
  onAdvanceTech,
  onUsePowerAction,
  onEndTurn,
  highlightedTileId,
  onPlaceGaiaformer,
  onEnterSpaceship,
  onUseShipAction,
  onTakeTwilightArtifact,
  onEclipseBuildAsteroidMine,
  pendingTwilightTSUpgrade = null,
  pendingRebellionMineToTS = null,
  onTwilightTSUpgrade,
  onRebellionMineToTS,
  onToggleFactionSelect,
  isFactionSelectOpen,
  showFactionSelectButton,
  onFederationToggleMode,
  onFederationToggleHex,
  onFederationComplete,
  onPlaceIvitsSpaceStation,
  ivitsSpaceStationMode = false,
  onCancelIvitsSpaceStation,
  onPlaceLostPlanet,
  ambasSwapPiMineMode = false,
  onAmbasSwapPiMine,
  onCancelAmbasSwapPiMine,
  firaksDowngradeMode = false,
  onFiraksDowngradeSelectLab,
  onCancelFiraksDowngrade,
  moweyipPlaceRingMode = false,
  onMoweyipPlaceRing,
  onCancelMoweyipPlaceRing,
  zoomValue,
  panValue,
  onZoomChange,
  onPanChange,
  hoveredPlayerId = null,
  isSidebarOpen = false,
  sidebarWidth = 0,
  onToggleSidebar,
  playerDetailScale = 1,
  onTogglePlayerDetailScale,
}: GameBoardProps) {

  const [selectedTile, setSelectedTile] = useState<HexTile | null>(null);
  const [isUiHelpOpen, setIsUiHelpOpen] = useState(false);
  // 타일 외곽 테두리 구분선 보기 토글 (각 칸 구분용)
  const [showTileBorders, setShowTileBorders] = useState(() => localStorage.getItem('show-tile-borders') === 'true');
  const [zoom, setZoomInternal] = useState(zoomValue ?? 1);
  const [pan, setPanInternal] = useState(panValue ?? { x: 0, y: 0 });
  const isSyncingRef = useRef(false);

  // 부모 props(zoomValue, panValue)가 변경되면(예: 페이즈 전환 후 리마운트) 내부 상태 동기화
  useEffect(() => {
    if (zoomValue !== undefined && Math.abs(zoomValue - zoom) > 0.001) {
      isSyncingRef.current = true;
      setZoomInternal(zoomValue);
      setTimeout(() => { isSyncingRef.current = false; }, 0);
    }
  }, [zoomValue]);

  useEffect(() => {
    if (panValue !== undefined && (Math.abs(panValue.x - pan.x) > 0.1 || Math.abs(panValue.y - pan.y) > 0.1)) {
      isSyncingRef.current = true;
      setPanInternal(panValue);
      setTimeout(() => { isSyncingRef.current = false; }, 0);
    }
  }, [panValue?.x, panValue?.y]);

  const setZoom = (v: number | ((prev: number) => number)) => {
    setZoomInternal(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      // onZoomChange는 useEffect를 통해 호출하거나 여기서 직접 호출 (안전하게 감쌀 것)
      return next;
    });
  };

  const setPan = (v: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => {
    setPanInternal(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      return next;
    });
  };

  // 내부 상태가 바뀌었을 때만 부모 알림 (useEffect 사용)
  // 마운트 시에는 부모 값으로 이미 초기화되었으므로 리셋 방지를 위해 동기화 중이 아닐 때만 업데이트
  useEffect(() => {
    if (!isSyncingRef.current) {
      onZoomChange?.(zoom);
    }
  }, [zoom]);

  useEffect(() => {
    if (!isSyncingRef.current) {
      onPanChange?.(pan);
    }
  }, [pan.x, pan.y]);
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Pinch-to-zoom state
  const [initialPinchDist, setInitialPinchDist] = useState<number | null>(null);
  const [initialPinchZoom, setInitialPinchZoom] = useState<number>(1);
  const [isPinching, setIsPinching] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // 내 차례 데스크톱 알림: "내 차례 아님 → 내 차례" 전환 시 (백그라운드 탭일 때) 알림.
  const isMyTurnForNotify = !!playerId && game.turnOrder?.[game.currentPlayerIndex] === playerId;
  const prevMyTurnRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevMyTurnRef.current;
    prevMyTurnRef.current = isMyTurnForNotify;
    if (prev === null) return; // 마운트 첫 렌더에선 알림 안 함 (새로고침 시 오발 방지)
    if (!prev && isMyTurnForNotify && game.currentPhase !== 'gameEnd') {
      const myName = playerId ? game.players[playerId]?.name : '';
      fireTurnNotification('가이아 프로젝트 — 당신 차례', `${myName ? myName + ', ' : ''}행동할 차례입니다.`);
    }
  }, [isMyTurnForNotify, game.currentPhase, playerId]);

  const currentPlayer = playerId ? game.players[playerId] : null;
  const isStartingPhase = game.currentPhase === 'startingMines' && currentPlayer && (currentPlayer.startingMinesPlaced || 0) < (currentPlayer.faction ? (FACTIONS.find(f => f.id === currentPlayer.faction)?.startingMines ?? 2) : 2);
  const faction = currentPlayer?.faction ? FACTIONS.find(f => f.id === currentPlayer.faction) : null;

  const hoveredFederationHexIds = useMemo(() => {
    const seeds = hoveredPlayerId ? game.playerFederationHexes?.[hoveredPlayerId] ?? [] : [];
    const expanded = new Set(seeds);
    if (!hoveredPlayerId || seeds.length === 0) return expanded;

    const byId = new Map(game.map.map((t: HexTile) => [t.id, t]));
    const byCoord = new Map(game.map.map((t: HexTile) => [`${t.q},${t.r}`, t]));
    const dirs = [
      [1, 0], [1, -1], [0, -1],
      [-1, 0], [-1, 1], [0, 1],
    ];
    const getNeighborTiles = (tile: HexTile) => dirs
      .map(([dq, dr]) => byCoord.get(`${tile.q + dq},${tile.r + dr}`))
      .filter((t): t is HexTile => Boolean(t));
    const isOwnFederationNode = (tile: HexTile) =>
      (tile.ownerId === hoveredPlayerId && Boolean(tile.structure) && tile.structure !== 'ship')
      || tile.parasiticMine?.ownerId === hoveredPlayerId
      || tile.spaceStation?.ownerId === hoveredPlayerId;
    const addConnectedComponent = (start: HexTile) => {
      if (!isOwnFederationNode(start)) return;
      const queue = [start];
      expanded.add(start.id);
      for (let i = 0; i < queue.length; i += 1) {
        for (const neighbor of getNeighborTiles(queue[i])) {
          if (expanded.has(neighbor.id) || !isOwnFederationNode(neighbor)) continue;
          expanded.add(neighbor.id);
          queue.push(neighbor);
        }
      }
    };

    for (const seedId of seeds) {
      const seed = byId.get(seedId);
      if (!seed) continue;
      addConnectedComponent(seed);
      getNeighborTiles(seed).forEach(addConnectedComponent);
    }
    return expanded;
  }, [game.map, game.playerFederationHexes, hoveredPlayerId]);

  const isEclipseAsteroidMode = game.pendingEclipseAsteroidMine?.playerId === playerId;
  // 이클립스 소행성 광산 기준 사거리(서버와 동일: Nav+navigationBonus, 임시보너스 제외). QIC당 +2로 연장.
  const eclipseBaseRange = (currentPlayer ? getRange(currentPlayer.research?.navigation ?? 0) + (currentPlayer.navigationBonus ?? 0) : 0);
  const eclipseRangeTiles = useMemo(() => game.map.filter((t: HexTile) => (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId || t.parasiticMine?.ownerId === playerId), [game.map, playerId]);
  const eclipseNeededQic = useCallback((tile: HexTile): number => {
    if (eclipseRangeTiles.length === 0) return 0;
    const minDist = Math.min(...eclipseRangeTiles.map((s: HexTile) => getDistance(s, tile)));
    return minDist > eclipseBaseRange ? Math.ceil((minDist - eclipseBaseRange) / 2) : 0;
  }, [eclipseRangeTiles, eclipseBaseRange]);
  const eclipseBuildableTileIds = useMemo(() => {
    if (!isEclipseAsteroidMode || !currentPlayer || !playerId) return new Set<string>();
    if (eclipseRangeTiles.length === 0) return new Set<string>();
    const maxRange = eclipseBaseRange + (currentPlayer.qic ?? 0) * 2; // QIC당 +2 거리
    const ids = new Set<string>();
    game.map.forEach((t: HexTile) => {
      if (t.type === 'asteroid' && t.structure === null) {
        const minDist = Math.min(...eclipseRangeTiles.map((s: HexTile) => getDistance(s, t)));
        if (minDist <= maxRange) ids.add(t.id);
      }
    });
    return ids;
  }, [isEclipseAsteroidMode, currentPlayer, game.map, playerId, eclipseRangeTiles, eclipseBaseRange]);

  const twilightTSSelectableIds = useMemo(() => {
    if (!pendingTwilightTSUpgrade || !playerId) return new Set<string>();
    return new Set(
      game.map
        .filter((t: HexTile) => t.ownerId === playerId && t.structure === 'trading_station')
        .map((t: HexTile) => t.id)
    );
  }, [pendingTwilightTSUpgrade, playerId, game.map]);

  const rebellionMineSelectableIds = useMemo(() => {
    if (!pendingRebellionMineToTS || !playerId) return new Set<string>();
    return new Set(
      game.map
        .filter((t: HexTile) => t.ownerId === playerId && t.structure === 'mine')
        .map((t: HexTile) => t.id)
    );
  }, [pendingRebellionMineToTS, playerId, game.map]);

  const SHIP_ABBR: Record<string, string> = {
    ship_twilight: 'TW',
    ship_rebellion: 'RB',
    ship_tf_mars: 'TF',
    ship_eclipse: 'EC',
  };
  const SHIP_NAMES: Record<string, string> = {
    ship_twilight: 'Twilight',
    ship_rebellion: 'Rebellion',
    ship_tf_mars: 'TF Mars',
    ship_eclipse: 'Eclipse',
  };
  const SHIP_ACTION_LABELS: Record<string, [string, string, string]> = {
    ship_twilight: ['3Q → Fed', '2O+3P → TS→Lab', '1K → +3 Range'],
    ship_rebellion: ['3Q → Tech', '1O+3P → M→TS', '2K → 1Q 2C'],
    ship_tf_mars: ['2Q → (2+기술타일)VP', '2P → Gaia', '3C → 1 TF'],
    ship_eclipse: ['2Q → (2+행성종류)VP', '2K+3P → Research', '6C → 소행성'],
  };
  // 우주선별 액션 스트립 이미지 (가로 3칸 = 액션 1/2/3). public/image/Action*.jpg
  const SHIP_ACTION_IMG: Record<string, string> = {
    ship_twilight: '/image/ActionTwilight.jpg',
    ship_rebellion: '/image/ActionRebellion.jpg',
    ship_tf_mars: '/image/ActionTFMars.jpg',
    ship_eclipse: '/image/ActionEclipse.jpg',
  };

  const renderSpaceship = (type: PlanetType) => {
    let shipColor = "#334155";
    let accentColor = "#64748b";

    if (type === 'ship_rebellion') { shipColor = "#7f1d1d"; accentColor = "#dc2626"; }
    if (type === 'ship_twilight') { shipColor = "#581c87"; accentColor = "#9333ea"; }
    if (type === 'ship_tf_mars') { shipColor = "#7c2d12"; accentColor = "#ea580c"; }
    if (type === 'ship_eclipse') { shipColor = "#1e3a8a"; accentColor = "#2563eb"; }

    const abbr = SHIP_ABBR[type] || '??';

    return (
      <g>
        {/* 간단한 육각형 우주선 - 크기 확대 (2.5 -> 3.5, 1.5 -> 2.2) */}
        <path
          d="M 0,-3.5 L 2.2,-1.4 L 2.2,1.4 L 0,3.5 L -2.2,1.4 L -2.2,-1.4 Z"
          fill={shipColor}
          stroke={accentColor}
          strokeWidth="0.35"
          opacity="0.9"
        />
        {/* 중앙 창문/엔진 - 크기 확대 (0.7 -> 1.0) */}
        <circle
          cx="0"
          cy="0"
          r="1.0"
          fill={accentColor}
          opacity="0.7"
        />
        {/* 우주선 약자 - 폰트 크기 및 가인성 대폭 강화 (2.4px -> 3.2px) */}
        <text
          y="0.3"
          style={{
            fill: '#ffffff',
            fontSize: '3.2px',
            fontWeight: '900',
            textAnchor: 'middle',
            dominantBaseline: 'central',
            pointerEvents: 'none',
            fontFamily: 'inherit',
            letterSpacing: '0.1em',
            paintOrder: 'stroke fill',
            stroke: 'rgba(0,0,0,0.95)',
            strokeWidth: '0.4px',
          }}
        >
          {abbr}
        </text>
      </g>
    );
  };

  const isFederationMode = game.federationMode?.playerId === playerId;
  const federationSelectedIds = useMemo(() => new Set(game.federationMode?.selectedHexIds ?? []), [game.federationMode?.selectedHexIds]);

  const handleTileClick = useCallback((tile: HexTile) => {
    if (ivitsSpaceStationMode && !hasDragged) {
      setSelectedTile(tile);
      return;
    }
    if (ambasSwapPiMineMode && !hasDragged && onAmbasSwapPiMine && tile.ownerId === playerId && (tile.structure === 'mine' || tile.structure === 'lost_planet_mine')) {
      onAmbasSwapPiMine(tile.id);
      setSelectedTile(null);
      return;
    }
    if (firaksDowngradeMode && !hasDragged && onFiraksDowngradeSelectLab && tile.ownerId === playerId && tile.structure === 'research_lab') {
      onFiraksDowngradeSelectLab(tile.id);
      setSelectedTile(null);
      return;
    }
    if (moweyipPlaceRingMode && !hasDragged && onMoweyipPlaceRing && tile.ownerId === playerId && tile.structure && tile.structure !== 'ship' && !tile.moweyipRing) {
      onMoweyipPlaceRing(tile.id);
      setSelectedTile(null);
      return;
    }
    if (isFederationMode && onFederationToggleHex && !hasDragged) {
      const satList = game.satellites?.[tile.id];
      const mySatellite = Array.isArray(satList) ? satList.includes(playerId!) : satList === playerId;
      const isSpaceHex = tile.type === 'space' || tile.type === 'deep_space';
      // 내 우주정거장 칸: 연결 건물로 토글 (파워 +1)
      if (isSpaceHex && tile.spaceStation?.ownerId === playerId) {
        onFederationToggleHex(tile.id);
        return;
      }
      // 빈 우주칸, 또는 "상대 우주정거장만 있는" 우주칸 → 내 위성 배치 가능 (내 위성이 이미 있으면 제외).
      // isEmptyHex는 spaceStation이 있으면 false라, 상대 하이브 우주정거장 칸이 막히던 버그 수정.
      if (isSpaceHex && tile.structure == null && tile.spaceStation?.ownerId !== playerId && !mySatellite) {
        onFederationToggleHex(tile.id);
        return;
      }
      if (isPlanetHex(tile)) {
        onFederationToggleHex(tile.id);
        return;
      }
    }
    if (!hasDragged && onEclipseBuildAsteroidMine && isEclipseAsteroidMode && eclipseBuildableTileIds.has(tile.id)) {
      onEclipseBuildAsteroidMine(tile.id, eclipseNeededQic(tile));
      return;
    }
    if (!hasDragged && onTwilightTSUpgrade && twilightTSSelectableIds.has(tile.id)) {
      onTwilightTSUpgrade(tile.id);
      return;
    }
    if (!hasDragged && onRebellionMineToTS && rebellionMineSelectableIds.has(tile.id)) {
      onRebellionMineToTS(tile.id);
      return;
    }
    if (!hasDragged) {
      setSelectedTile(tile);
    }
  }, [ivitsSpaceStationMode, ambasSwapPiMineMode, onAmbasSwapPiMine, firaksDowngradeMode, onFiraksDowngradeSelectLab, moweyipPlaceRingMode, onMoweyipPlaceRing, hasDragged, isFederationMode, onFederationToggleHex, game.satellites, playerId, onEclipseBuildAsteroidMine, isEclipseAsteroidMode, eclipseBuildableTileIds, eclipseNeededQic, onTwilightTSUpgrade, twilightTSSelectableIds, onRebellionMineToTS, rebellionMineSelectableIds]);

  const handleZoomIn = useCallback(() => {
    setZoom(prev => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom(prev => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleReset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom(prev => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsMouseDown(true);
      setHasDragged(false);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isMouseDown) {
      const dx = Math.abs(e.clientX - (dragStart.x + pan.x));
      const dy = Math.abs(e.clientY - (dragStart.y + pan.y));
      if (dx > 5 || dy > 5) {
        setHasDragged(true);
      }
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  }, [isMouseDown, dragStart, pan]);

  const handleMouseUp = useCallback(() => {
    setIsMouseDown(false);
    setTimeout(() => setHasDragged(false), 50);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsMouseDown(false);
    setHasDragged(false);
    setIsPinching(false);
  }, []);

  // Touch handlers for mobile pan and pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      // Single touch -> Pan
      setIsMouseDown(true);
      setHasDragged(false);
      setIsPinching(false);
      setDragStart({ x: e.touches[0].clientX - pan.x, y: e.touches[0].clientY - pan.y });
    } else if (e.touches.length === 2) {
      // Two touches -> Pinch-to-zoom
      setIsMouseDown(false); // Stop panning
      setIsPinching(true);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      setInitialPinchDist(dist);
      setInitialPinchZoom(zoom);
    }
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (isPinching && e.touches.length === 2 && initialPinchDist !== null) {
      // Handle Zoom
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);

      const scale = dist / initialPinchDist;
      let newZoom = initialPinchZoom * scale;
      newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
      setZoom(newZoom);
    } else if (isMouseDown && e.touches.length === 1 && !isPinching) {
      // Handle Pan
      const dx = Math.abs(e.touches[0].clientX - (dragStart.x + pan.x));
      const dy = Math.abs(e.touches[0].clientY - (dragStart.y + pan.y));
      if (dx > 5 || dy > 5) {
        setHasDragged(true);
      }
      setPan({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y,
      });
    }
  }, [isMouseDown, dragStart, pan, isPinching, initialPinchDist, initialPinchZoom]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      setIsPinching(false);
      setInitialPinchDist(null);
    }
    if (e.touches.length === 0) {
      setIsMouseDown(false);
      setTimeout(() => setHasDragged(false), 50);
    }
  }, []);

  const canPlaceStartingMine = useMemo(() => {
    if (!selectedTile || !currentPlayer || !isStartingPhase) return false;
    if (selectedTile.structure !== null) return false;
    // 종족이 선택되지 않았으면 집 배치 불가
    if (!faction) return false;
    return selectedTile.type === faction.homePlanet;
  }, [selectedTile, currentPlayer, isStartingPhase, faction]);

  const mineBuildCost = useMemo(() => {
    if (!selectedTile || !currentPlayer) return null;

    const baseRange = getEffectiveBaseRange(currentPlayer);
    const rangeTiles = game.map.filter((t: HexTile) =>
      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
      t.parasiticMine?.ownerId === playerId ||
      t.spaceStation?.ownerId === playerId
    );
    const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile))) : 0;
    let neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

    // 가이아포머가 이미 설치된 행성에 광산을 지을 때는 거리 비용(QIC) 차감 안함 (UI 표시용)
    if ((selectedTile.type === 'transdim' || selectedTile.type === 'gaia') && currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id)) {
      neededQIC = 0;
    }

    // 소행성: faction 없이도 비용 계산 (가이아포머 1개 사용, 비용 0)
    const isLantidaParasitic = currentPlayer.faction === 'lantids' &&
      selectedTile.structure !== null &&
      selectedTile.ownerId !== playerId &&
      selectedTile.ownerId != null &&
      !selectedTile.parasiticMine;

    if (isLantidaParasitic) {
      return { oreCost: 1, credits: 2, qicCost: neededQIC, terraformSteps: 0, terraformingLevel: 0, needsExtraTerraforming: false, terraformDiscount: 0 };
    }

    if (!faction) return null;

    const freeMine = !!currentPlayer.nextMineFreeFromShipTech || !!currentPlayer.spaceshipFed3TfMineFree;
    let oreCost = freeMine ? 0 : 1;
    let credits = freeMine ? 0 : 2;
    let qicCost = neededQIC;
    const terraformingLevel = currentPlayer.research?.terraforming ?? 0;
    let terraformSteps = 0;
    let needsExtraTerraforming = false;

    // Proto 또는 기본 7색상 행성: 확장 4종족 규칙 반영
    if (selectedTile.type === 'proto' || HOME_PLANETS.includes(selectedTile.type as import('@shared/gameConfig').PlanetType)) {
      terraformSteps = getTerraformStepsForFaction(game, faction.id, selectedTile.type as import('@shared/gameConfig').PlanetType);
      const pendingTerraformSteps = currentPlayer.pendingTerraformSteps || 0;
      const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
      const actualSteps = terraformSteps - discountSteps;
      const terraformCostPerStep = getTerraformCost(terraformingLevel);
      const terraformOreCost = actualSteps * terraformCostPerStep;
      oreCost += terraformOreCost;
      if (actualSteps > 0 && terraformingLevel < 3 && actualSteps > 1) {
        needsExtraTerraforming = true;
      }
    }
    // Transdim에 가이아 포머 설치·성숙 대기 또는 가이아(내가 가이아포밍한 성숙 타일): 1O 2C
    else if (
      (selectedTile.type === 'transdim' && selectedTile.hasGaiaformer && currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id)) ||
      (selectedTile.type === 'gaia' && currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id))
    ) {
      oreCost = freeMine ? 0 : 1;
      credits = freeMine ? 0 : 2;
      qicCost = 0;
    }
    // 가이아 행성 (다른 출처, 내 pending 아님)
    else if (selectedTile.type === 'gaia') {
      if (currentPlayer.faction === 'gleens') {
        oreCost += 1;
      } else {
        qicCost += getGaiaBaseQic(faction.id);
      }
    }

    const pendingTerraformSteps = currentPlayer.pendingTerraformSteps || 0;
    const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
    return { oreCost, credits, qicCost, terraformSteps, terraformingLevel, needsExtraTerraforming, terraformDiscount: discountSteps };
  }, [selectedTile, currentPlayer, faction, game.map, playerId]);

  const canBuildMine = useMemo(() => {
    const isTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
    if (!selectedTile || !currentPlayer || game.currentPhase !== 'main' || !isTurn) return false;

    // 란티다 기생 광산 체크
    const isLantidaParasitic = currentPlayer.faction === 'lantids' &&
      selectedTile.structure !== null &&
      selectedTile.ownerId !== playerId &&
      selectedTile.ownerId != null &&
      !selectedTile.parasiticMine;

    if (selectedTile.structure !== null && !isLantidaParasitic) return false;

    if (game.pendingSpaceshipFedMine?.playerId === playerId) {
      if (['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(selectedTile.type)) return false;
      if (selectedTile.type === 'asteroid') return false;
      return true;
    }

    if (isLantidaParasitic) {
      const baseRange = getEffectiveBaseRange(currentPlayer);
      const playerQIC = currentPlayer.qic ?? 0;
      const maxRangeWithQIC = baseRange + (playerQIC * 2);
      const rangeTiles = game.map.filter((t: HexTile) =>
        (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
        t.parasiticMine?.ownerId === playerId ||
        t.spaceStation?.ownerId === playerId
      );
      if (rangeTiles.length === 0) return false;

      const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
      if (minDist > maxRangeWithQIC && !game.isTestMode) return false;
      if (!mineBuildCost) return false;
      if (currentPlayer.ore < mineBuildCost.oreCost || currentPlayer.credits < mineBuildCost.credits) return false;
      if (mineBuildCost.qicCost > 0 && (currentPlayer.qic ?? 0) < mineBuildCost.qicCost) return false;
      return true;
    }

    // Transdim+가이아포머: pendingGaiaformerTiles에 있을 때만 건설 가능 (TF2/보너스 즉포만 당장 들어감, 일반은 다음 라운드)
    if (selectedTile.type === 'transdim') {
      if (!selectedTile.hasGaiaformer) return false;
      if (!currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id)) return false;
      return true;
    }
    // 가이아(성숙): 내가 가이아포밍한 타일만 pendingGaiaformerTiles에 있음 → 1O 2C 건설 가능
    if (selectedTile.type === 'gaia' && currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id)) {
      return true;
    }

    if (['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(selectedTile.type)) return false;

    // 소행성은 가이아 포머가 있어야 함 (발타크: QIC 전환으로 잠긴 포머 제외)
    if (selectedTile.type === 'asteroid') {
      const total = currentPlayer.gaiaformers ?? 0;
      const locked = currentPlayer.faction === 'bal_tak' ? (currentPlayer.balTakGaiaformersUsedForQic ?? 0) : 0;
      const hasGaiaformer = total - locked > 0;
      if (!hasGaiaformer) return false;
    }

    // Range check with QIC extension (+3 거리 보너스 포함). 거리 출발점: 내 건물 + 내 우주정거장
    const baseRange = getEffectiveBaseRange(currentPlayer);
    const playerQIC = currentPlayer.qic ?? 0;
    const maxRangeWithQIC = baseRange + (playerQIC * 2); // QIC당 +2 거리

    const rangeTiles = game.map.filter((t: HexTile) =>
      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId || t.parasiticMine?.ownerId === playerId
    );

    if (rangeTiles.length === 0) return false;

    const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
    const hasReach = minDist <= maxRangeWithQIC;

    if (!hasReach && !game.isTestMode) return false;
    if (!mineBuildCost) return false;

    // 소행성은 무료이므로 비용 체크 불필요
    if (selectedTile.type === 'asteroid') {
      return true;
    }

    if (currentPlayer.ore < mineBuildCost.oreCost || currentPlayer.credits < mineBuildCost.credits) return false;
    // 글린 가이아 비용 체크는 이제 mineBuildCost.oreCost(2 Ore)에 반영되므로 표준 로직을 따름
    if (mineBuildCost.qicCost > 0 && (currentPlayer.qic ?? 0) < mineBuildCost.qicCost) return false;
    return true;
  }, [selectedTile, currentPlayer, game.currentPhase, game.map, playerId, mineBuildCost]);

  const canShowBuildMineOption = useMemo(() => {
    const isTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
    if (!selectedTile || !currentPlayer || game.currentPhase !== 'main' || !isTurn || !mineBuildCost) return false;
    if (selectedTile.structure !== null) return false;

    if (game.pendingSpaceshipFedMine?.playerId === playerId) {
      if (['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(selectedTile.type)) return false;
      if (selectedTile.type === 'asteroid') return false;
      return true;
    }

    if (selectedTile.type === 'transdim') {
      return !!selectedTile.hasGaiaformer && !!currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id);
    }
    if (selectedTile.type === 'gaia' && currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id)) {
      return true;
    }
    if (['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(selectedTile.type)) {
      return false;
    }
    if (selectedTile.type === 'asteroid') {
      const total = currentPlayer.gaiaformers ?? 0;
      const locked = currentPlayer.faction === 'bal_tak' ? (currentPlayer.balTakGaiaformersUsedForQic ?? 0) : 0;
      return total - locked > 0;
    }

    const baseRange = getEffectiveBaseRange(currentPlayer);
    const playerQIC = currentPlayer.qic ?? 0;
    const maxRangeWithQIC = baseRange + (playerQIC * 2);
    const rangeTiles = game.map.filter((t: HexTile) =>
      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
      t.parasiticMine?.ownerId === playerId ||
      t.spaceStation?.ownerId === playerId
    );
    if (rangeTiles.length === 0) return false;

    const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
    return game.isTestMode || minDist <= maxRangeWithQIC;
  }, [selectedTile, currentPlayer, game.currentPhase, game.map, game.isTestMode, playerId, mineBuildCost]);

  if (!game || !game.map || game.map.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-background p-8">
        <div className="text-center space-y-4">
          <Skeleton className="w-32 h-32 rounded-full mx-auto" />
          <p className="text-muted-foreground font-mono animate-pulse">Loading galaxy...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex relative">
      {/* 맵 영역: 우측 패널 표시 여부와 관계없이 항상 동일 크기 유지 (행성 클릭 시 확대/팬 깨짐 방지) */}
      <div
        ref={containerRef}
        className="flex-1 min-w-0 bg-black rounded-lg border border-white/5 overflow-hidden relative touch-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ cursor: isMouseDown ? 'grabbing' : 'grab' }}
      >
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] opacity-20 pointer-events-none" />

        {/* Turn Status Overlay */}
        {/* fixed로 올려서 우측 패널 열림 시에도 중앙 유지(좌측 미니뷰와 겹침 방지) */}
        <div
          className="fixed top-4 z-[35] flex flex-col items-center pointer-events-none -translate-x-1/2"
          style={{
            left: isSidebarOpen && sidebarWidth > 0
              ? `calc((100% - ${sidebarWidth}px) / 2)`
              : '50%',
          }}
        >
          <div className="bg-black/80 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full shadow-2xl flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Round {game.roundNumber}</span>
              <span className="text-sm font-semibold text-white">
                {game.hasDoneMainAction ? 'Main Action Complete ✓' : 'Perform Main Action'}
              </span>
            </div>
            <div className="h-8 w-[1px] bg-white/10" />
            <div className="flex gap-2">
              {/* 종족 선택 버튼 (startingMines 또는 factionSelect 단계에서) */}
              {showFactionSelectButton && onToggleFactionSelect && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold"
                  onClick={onToggleFactionSelect}
                  // fixed overlay가 포인터 이벤트를 막지 않도록 버튼만 예외
                  style={{ pointerEvents: 'auto' }}
                >
                  {isFactionSelectOpen ? 'Hide Faction' : 'Select Faction'}
                </Button>
              )}
            </div>

          </div>
        </div>


        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
        >
          <HexGrid width={1200} height={1000} viewBox="-50 -50 250 250">
            <defs>
              {/* Tile Special Patterns - using objectBoundingBox for per-hex anchoring */}
              <pattern id="ts-space" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_100.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-asteroid" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_110.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-proto" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_111.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-rebellion" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_112.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-tf-mars" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_113.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-eclipse" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_114.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-twilight" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_115.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
              <pattern id="ts-forming" patternContentUnits="objectBoundingBox" width="1" height="1">
                <image href="/map/ts_forming.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
              </pattern>
            </defs>
            {/* 행성 배경만 살짝 채도/밝기를 낮춰 건물이 도드라지게 (행성색 정보는 유지되는 선에서 약하게). 건물은 윗 레이어라 영향 없음. */}
            <g id="sector-backgrounds-layer" style={{ filter: 'saturate(0.82) brightness(0.9)' }}>
              {SECTOR_CENTERS.map((center) => {
                const cx = HEX_SIZE * SQRT3 * (center.q + center.r / 2);
                const cy = HEX_SIZE * 1.5 * center.r;

                // Find the actual tile at this center to determine layout ID and rotation
                const slotTile = game.map.find((t: HexTile) => t.q === center.q && t.r === center.r);
                if (!slotTile || slotTile.sector === null) return null;

                const layoutId = slotTile.sector;
                const rotation = slotTile.rotation ?? 0;
                const isExternal = layoutId >= 11 && layoutId !== 90;

                let filename = '';
                let imgW = 41.57;
                let imgH = 38.4;
                let offsetX = imgW / 2;
                let offsetY = imgH / 2;

                if (layoutId === 90) {
                  return null; // Do not draw background for internal strategic hexes
                } else if (isExternal) {
                  // Hardcoded prefix based on available files: Map_B11, O12, B13, B14, O15, O16, B17, O18
                  const isSideO = [12, 15, 16, 18].includes(layoutId);
                  const prefix = isSideO ? 'Map_O' : 'Map_B';
                  filename = `${prefix}${String(layoutId).padStart(2, '0')}.png`;

                  imgW = 16.62;
                  imgH = 16.8;
                  offsetX = 12.47;
                  offsetY = 12.0;
                } else {
                  filename = `Map_B${String(layoutId + 1).padStart(2, '0')}.gif`;
                  imgW = 41.57;
                  imgH = 38.4;
                  offsetX = imgW / 2;
                  offsetY = imgH / 2;
                }

                return (
                  <image
                    key={`sector-bg-${center.sector}`} // slot index for stable key
                    href={`/map/${filename}`}
                    x={cx - offsetX}
                    y={cy - offsetY}
                    width={imgW}
                    height={imgH}
                    transform={`rotate(${rotation * 60}, ${cx}, ${cy})`}
                    style={{ pointerEvents: 'none', opacity: 1.0 }}
                    preserveAspectRatio="xMidYMid slice"
                  />
                );
              })}
            </g>
            <Layout size={{ x: HEX_SIZE, y: HEX_SIZE }} flat={false} spacing={1.0} origin={{ x: 0, y: 0 }}>
              {game.map.map((tile: HexTile) => {
                const isSelected = selectedTile?.id === tile.id;
                const isEclipseBuildable = eclipseBuildableTileIds.has(tile.id);
                const isTwilightTSSelectable = twilightTSSelectableIds.has(tile.id);
                const isRebellionMineSelectable = rebellionMineSelectableIds.has(tile.id);
                const isShipActionSelectable = isTwilightTSSelectable || isRebellionMineSelectable;
                const isFederationSelected = federationSelectedIds.has(tile.id);
                const satelliteOwnerIds = (() => {
                  const v = game.satellites?.[tile.id];
                  if (!v) return [];
                  return Array.isArray(v) ? v : [v];
                })();
                const isHighlighted = highlightedTileId === tile.id || isEclipseBuildable || isShipActionSelectable || isFederationSelected;
                const hasStructure = tile.structure !== null;
                const planetColor = PLANET_COLORS[tile.type as PlanetType] || '#FF00FF';

                const owner = tile.ownerId ? game.players[tile.ownerId] : null;
                const ownerFaction = (owner && owner.faction) ? FACTIONS.find(f => f.id === owner.faction) : null;
                const structureColor = ownerFaction?.color || '#fff';



                return (
                  <Hexagon
                    key={tile.id}
                    q={tile.q}
                    r={tile.r}
                    s={-tile.q - tile.r}
                    onClick={() => handleTileClick(tile)}
                    style={{
                      fill: 'transparent', // 배경 이미지가 잘 보이도록 투명하게 설정
                      stroke: isSelected ? '#00FFFF' : isFederationSelected ? '#0ea5e9' : isEclipseBuildable ? '#22c55e' : isShipActionSelectable ? '#a855f7' : isHighlighted ? '#FFD700' : (tile.type === 'space' || tile.type === 'deep_space' ? '#333' : '#555'),
                      strokeWidth: isSelected ? 0.8 : (isHighlighted || isEclipseBuildable || isShipActionSelectable || isFederationSelected) ? 0.6 : 0.2,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      fillOpacity: isHighlighted || isEclipseBuildable || isShipActionSelectable ? 0.9 : 1.0,
                      filter: isEclipseBuildable ? 'drop-shadow(0px 0px 8px rgba(34, 197, 94, 0.9))' : isShipActionSelectable ? 'drop-shadow(0px 0px 8px rgba(168, 85, 247, 0.9))' : isHighlighted ? 'drop-shadow(0px 0px 8px rgba(255, 215, 0, 0.8))' : 'none',
                    }}
                  >
                    {/* Planet Circle (Round Shape) removed as they are in the background image */}
                    {/* Space Texture (ts_100) - Only for sector 90 to avoid blurring background images */}
                    {(tile.type === 'space' || tile.type === 'deep_space') && tile.sector === 90 && (
                      <circle r="4.15" fill="url(#ts-space)" fillOpacity={0.1} pointerEvents="none" />
                    )}
                    {/* Single-hex Strategic Tiles & Ships (Only for sector 90 to prevent drawing on outer bridges) */}
                    {tile.sector === 90 && (
                      <>
                        {tile.type === 'asteroid' && <circle r="4.15" fill="url(#ts-asteroid)" pointerEvents="none" />}
                        {tile.type === 'proto' && <circle r="4.15" fill="url(#ts-proto)" pointerEvents="none" />}
                        {tile.type === 'ship_rebellion' && <circle r="4.15" fill="url(#ts-rebellion)" pointerEvents="none" transform="rotate(-90)" />}
                        {tile.type === 'ship_tf_mars' && <circle r="4.15" fill="url(#ts-tf-mars)" pointerEvents="none" transform="rotate(-90)" />}
                        {tile.type === 'ship_twilight' && <circle r="4.15" fill="url(#ts-twilight)" pointerEvents="none" transform="rotate(-90)" />}
                        {tile.type === 'ship_eclipse' && <circle r="4.15" fill="url(#ts-eclipse)" pointerEvents="none" transform="rotate(-90)" />}
                        {/* 우주선 탑승자: 맵에서도 누가 탔는지 진영색 점으로 표시 (어떤 색이든 잘 보이게 흰 테두리) */}
                        {(() => {
                          const occ = game.spaceships?.[tile.id]?.occupants ?? [];
                          if (occ.length === 0) return null;
                          const gap = 1.7;
                          const startX = -((occ.length - 1) * gap) / 2;
                          return (
                            <g pointerEvents="none" transform="translate(0, 2.7)">
                              {occ.map((pid, i) => {
                                const fac = game.players[pid]?.faction ? FACTIONS.find(f => f.id === game.players[pid].faction) : null;
                                return (
                                  <circle key={pid} cx={startX + i * gap} cy={0} r={0.75}
                                    fill={fac?.color || '#888'} stroke="#fff" strokeWidth={0.22}>
                                    <title>{game.players[pid]?.name ?? pid} 탑승</title>
                                  </circle>
                                );
                              })}
                            </g>
                          );
                        })()}
                      </>
                    )}

                    {/* 가이아 프로젝트로 변환된(transdim→gaia) 땅에만 오버레이 (원래 가이아 땅 제외) */}
                    {tile.type === 'gaia' && (tile as { isGaiaformed?: boolean }).isGaiaformed === true && (
                      <circle r="4.15" fill="url(#ts-forming)" pointerEvents="none" />
                    )}

                    {/* 가이아 포머 표시 (transdim 또는 성숙 가이아에 설치된 경우) */}
                    {tile.hasGaiaformer && (() => {
                      // ownerId가 있으면 그 플레이어의 색상을, 없으면 포머 설치자, 마지막으로 로컬 playerId 사용
                      const gaiaOwnerId = tile.ownerId || tile.gaiaformerOwnerId || playerId;
                      const ownerFaction = gaiaOwnerId ? (game.players[gaiaOwnerId]?.faction ? FACTIONS.find(f => f.id === game.players[gaiaOwnerId].faction) : null) : null;

                      const targetColorHex = (ownerFaction?.color || '#4CAF50').toUpperCase();
                      let colorName = 'titanium';
                      for (const [key, hex] of Object.entries(PLANET_COLORS)) {
                        if (hex.toUpperCase() === targetColorHex) {
                          colorName = key;
                          break;
                        }
                      }

                      // 가이아포머 스케일 지정
                      const scaleW = 9;
                      const scaleH = 9;
                      const offsetY = -scaleH / 2;

                      return (
                        <g transform={`translate(${-scaleW / 2}, ${offsetY})`}>
                          <image
                            href={`/image/buildings/${colorName}_gaiaformer.png`}
                            width={scaleW}
                            height={scaleH}
                            preserveAspectRatio="xMidYMid meet"
                            style={{ pointerEvents: 'none' }}
                          />
                        </g>
                      );
                    })()}

                    {/* 파괴된 (spent) 가이아포머 표시 (소행성 등) */}
                    {tile.destroyedGaiaformer && (
                      <g>
                        <circle r="1.3" fill="none" stroke="#ef4444" strokeWidth="0.45" opacity="0.8" />
                        <circle r="0.9" fill="#ef4444" opacity="0.3" />
                      </g>
                    )}

                    {/* Player Building / Federation / Satellite Highlight (Hover from sidebar) - 연방 포함=금색, 미포함=파란색(우주정거장 포함) */}
                    {hoveredPlayerId && (() => {
                      const isOwnBuilding = tile.ownerId === hoveredPlayerId && tile.structure && tile.structure !== 'ship';
                      const isSatellite = satelliteOwnerIds.includes(hoveredPlayerId);
                      const isSpaceStation = tile.spaceStation?.ownerId === hoveredPlayerId;
                      if (!isOwnBuilding && !isSatellite && !isSpaceStation) return null;

                      const isFederated = hoveredFederationHexIds.has(tile.id);
                      // 건물: 연방 포함→금색, 미포함→시안. 위성 칸→금색. 우주정거장: 연방 포함→금색, 미포함→파란색
                      const highlightColor = isSpaceStation
                        ? (isFederated ? '#FFD700' : '#3b82f6')
                        : (isFederated && isOwnBuilding) || isSatellite
                          ? '#FFD700'
                          : '#00F2FF';

                      return (
                        <g className="pointer-events-none">
                          <circle
                            r="4.2"
                            fill="none"
                            stroke={highlightColor}
                            strokeWidth="0.5"
                            strokeDasharray="1.2 0.8"
                            className="animate-pulse"
                            style={{
                              filter: `drop-shadow(0 0 4px ${highlightColor})`,
                              opacity: 0.8
                            }}
                          />
                          <circle r="4.5" fill="none" stroke={highlightColor} strokeWidth="0.1" opacity="0.4" />
                        </g>
                      );
                    })()}

                    {/* 모웨이드 링 — 건물 밑 레이어(헥스 살짝 넘쳐도 OK). 톱니형 청록 링 + 핑크 점 2개 */}
                    {tile.moweyipRing && (() => {
                      const teeth = 15;
                      // 바깥 크기 유지, 구멍을 키워 띠 두께만 0.7배 (기존 4.84-2.97=1.87 → 약 1.31)
                      const rOut = 4.84, rTooth = 4.5, hole = 3.53;
                      // 톱니형 바깥 경계 (큰/작은 반지름 교차)
                      let cog = '';
                      for (let i = 0; i < teeth * 2; i++) {
                        const ang = (Math.PI / teeth) * i - Math.PI / 2;
                        const r = i % 2 === 0 ? rOut : rTooth;
                        cog += `${i === 0 ? 'M' : 'L'}${(r * Math.cos(ang)).toFixed(2)} ${(r * Math.sin(ang)).toFixed(2)} `;
                      }
                      cog += 'Z';
                      // 안쪽 구멍 (evenodd로 뚫음 → 가운데 건물이 그대로 보임)
                      const holePath = `M${hole} 0 A${hole} ${hole} 0 1 0 ${-hole} 0 A${hole} ${hole} 0 1 0 ${hole} 0 Z`;
                      // 방사형 리지(줄무늬) 라인
                      const ridges = Array.from({ length: teeth }, (_, i) => {
                        const ang = (2 * Math.PI / teeth) * i - Math.PI / 2;
                        const c = Math.cos(ang), s = Math.sin(ang);
                        return (
                          <line key={i}
                            x1={(hole * c).toFixed(2)} y1={(hole * s).toFixed(2)}
                            x2={(rTooth * c).toFixed(2)} y2={(rTooth * s).toFixed(2)}
                            stroke="rgba(28,96,96,0.5)" strokeWidth="0.14" />
                        );
                      });
                      return (
                        <g opacity="0.97">
                          <path d={`${cog} ${holePath}`} fillRule="evenodd" fill="#5cc2bd" stroke="#2a8f8a" strokeWidth="0.16" />
                          {ridges}
                          {/* 하단 핑크 점 2개 (얇아진 띠 중앙에 맞춤) */}
                          <circle cx="-0.62" cy="4.15" r="0.36" fill="#ff3ea5" stroke="#c01e74" strokeWidth="0.06" />
                          <circle cx="0.62" cy="4.15" r="0.36" fill="#ff3ea5" stroke="#c01e74" strokeWidth="0.06" />
                        </g>
                      );
                    })()}

                    {hasStructure && renderStructure(tile.structure!, structureColor, ownerFaction?.color)}

                    {/* 란티다 기생 광산 */}
                    {tile.parasiticMine && (() => {
                      const parasiticOwner = game.players[tile.parasiticMine!.ownerId];
                      const parasiticFac = parasiticOwner?.faction ? FACTIONS.find(f => f.id === parasiticOwner.faction) : null;
                      return (
                        <g transform="translate(1.8, 1.8)">
                          {renderStructure('mine', parasiticFac?.color ?? '#888')}
                        </g>
                      );
                    })()}

                    {/* 위성 표시 */}
                    {satelliteOwnerIds.length > 0 && satelliteOwnerIds.map((ownerId, idx) => {
                      const fac = game.players[ownerId]?.faction ? FACTIONS.find(f => f.id === game.players[ownerId].faction) : null;
                      if (!fac) return null;
                      const r = 0.55;
                      const count = satelliteOwnerIds.length;
                      const x = count === 1 ? 0 : idx === 0 ? 0 : r * Math.cos((idx - 1) * (2 * Math.PI / Math.max(1, count - 1)));
                      const y = count === 1 ? 0 : idx === 0 ? 0 : r * Math.sin((idx - 1) * (2 * Math.PI / Math.max(1, count - 1)));
                      return (
                        <g key={ownerId} transform={`translate(${x}, ${y})`}>
                          <rect x="-0.5" y="-0.5" width="1" height="1" fill={fac.color} stroke="#000" strokeWidth="0.1" opacity="0.95" />
                        </g>
                      );
                    })}

                    {/* 하이브 우주정거장: 위성(사각형)과 구분되도록 톱니(기어) 모양 */}
                    {tile.spaceStation && (() => {
                      const ssOwner = game.players[tile.spaceStation!.ownerId];
                      const ssFac = ssOwner?.faction ? FACTIONS.find(f => f.id === ssOwner.faction) : null;
                      const teeth = 8;
                      const outerR = 2;
                      const innerR = 1.24;
                      const gearPoints = Array.from({ length: teeth * 2 }, (_, i) => {
                        const angle = (Math.PI * 2 * i) / (teeth * 2) - Math.PI / 2;
                        const r = i % 2 === 0 ? outerR : innerR;
                        return `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
                      }).join(' ');
                      return (
                        <g>
                          <polygon points={gearPoints} fill={ssFac?.color ?? '#888'} stroke="#000" strokeWidth="0.15" opacity="0.95" />
                        </g>
                      );
                    })()}

                    {game.isTestMode && (
                      <text
                        y="3.5"
                        style={{
                          fill: 'rgba(0, 255, 255, 0.9)',
                          fontSize: '1.4px',
                          fontWeight: 'bold',
                          textAnchor: 'middle',
                          dominantBaseline: 'central',
                          pointerEvents: 'none',
                          fontFamily: 'monospace'
                        }}
                      >
                        {`${tile.q},${tile.r}${tile.sector !== null ? ` S${tile.sector}` : ''}`}
                      </text>
                    )}

                  </Hexagon>
                );
              })}
            </Layout>
            {/* 섹터 구분 외곽선: 각 섹터(내부 0-9, 외각 11-18)의 바깥 경계 변만 그림.
                같은 섹터끼리의 내부 변은 생략 → 타일 10개 + 외각 8개로 구역이 구분돼 보임. */}
            {showTileBorders && (() => {
              const secByKey = new Map<string, number>();
              for (const t of game.map) secByKey.set(`${t.q},${t.r}`, t.sector ?? -999);
              // pointy-top: 변 i(코너 i→i+1)가 마주보는 이웃 방향 (axial dq,dr)
              const DIRS: Array<[number, number]> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
              const corner = (cx: number, cy: number, i: number): [number, number] => {
                const a = (60 * i - 30) * Math.PI / 180;
                return [cx + HEX_SIZE * Math.cos(a), cy + HEX_SIZE * Math.sin(a)];
              };
              const segs: Array<{ x1: number; y1: number; x2: number; y2: number; k: string }> = [];
              for (const t of game.map) {
                const sec = t.sector ?? -999;
                if (sec === 90) continue; // 전략 단일헥스(우주선/소행성 등)는 구역 외곽선에서 제외
                const cx = HEX_SIZE * SQRT3 * (t.q + t.r / 2);
                const cy = HEX_SIZE * 1.5 * t.r;
                for (let i = 0; i < 6; i++) {
                  const [dq, dr] = DIRS[i];
                  const nSec = secByKey.get(`${t.q + dq},${t.r + dr}`);
                  if (nSec === sec) continue;                       // 같은 섹터 → 내부 변, 생략
                  if (nSec !== undefined && sec > nSec) continue;   // 인접 섹터 경계는 한 번만 (중복 방지)
                  const [x1, y1] = corner(cx, cy, i);
                  const [x2, y2] = corner(cx, cy, (i + 1) % 6);
                  segs.push({ x1, y1, x2, y2, k: `${t.id}-${i}` });
                }
              }
              return (
                <g pointerEvents="none">
                  {segs.map(s => (
                    <line key={s.k} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke="rgba(255,255,255,0.85)" strokeWidth={0.34} strokeLinecap="round" />
                  ))}
                </g>
              );
            })()}
          </HexGrid>
        </motion.div>

        <div className="absolute top-4 right-4 flex items-start gap-2 z-10">
          {/* 연방 구현 영역 (컴팩트 버전) */}
          {(() => {
            const isMyTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
            if (!isMyTurn || game.currentPhase !== 'main' || game.hasDoneMainAction || game.pendingFederationReward) return null;

            return isFederationMode ? (
              <div className="p-2 bg-black/80 backdrop-blur-md border border-sky-500/40 rounded-xl flex flex-col gap-1.5 w-56 shadow-2xl mt-0">
                <p className="text-[9px] text-sky-300 font-bold leading-tight">
                  위성·건물을 클릭해 연방에 포함할 대상을 선택.
                </p>
                <div className="rounded border border-sky-500/30 bg-sky-950/40 p-1.5">
                  {game.federationPreview ? (
                    <>
                      <div className={`text-[10px] font-black tabular-nums ${game.federationPreview.connected !== false && game.federationPreview.power >= game.federationPreview.requiredPower ? 'text-green-400' : 'text-amber-400'}`}>
                        파워: {game.federationPreview.power} / {game.federationPreview.requiredPower}
                      </div>
                      {game.federationPreview.connected === false && (
                        <div className="text-[8px] text-red-400 font-bold mt-0.5">⚠ 선택한 위성·건물이 하나로 연결되지 않았습니다</div>
                      )}
                      <div className="text-[8px] text-zinc-400 mt-1 max-h-[40px] overflow-y-auto custom-scrollbar">
                        {game.federationPreview.items.length === 0 ? '선택된 칸 없음' : game.federationPreview.items.map(i => `${i.label}(${i.power})`).join(', ')}
                      </div>
                    </>
                  ) : <span className="text-[9px] text-zinc-500">계산 중...</span>}
                </div>
                <div className="flex gap-1.5 mt-0.5">
                  <Button size="sm" variant="outline" className="flex-1 h-6 text-[9px] border-sky-500/50 text-sky-400 px-0" onClick={onFederationToggleMode}>취소</Button>
                  <Button size="sm" disabled={!game.federationPreview || game.federationPreview.connected === false || game.federationPreview.power < game.federationPreview.requiredPower} className="flex-1 h-6 text-[9px] bg-sky-600 hover:bg-sky-500 text-white px-0 disabled:opacity-40 disabled:cursor-not-allowed" onClick={onFederationComplete}>완료</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" className="bg-sky-600/90 hover:bg-sky-500 text-white text-[10px] font-bold h-9 px-4 rounded-full shadow-lg backdrop-blur" onClick={onFederationToggleMode}>
                연방 구현
              </Button>
            );
          })()}

          {/* 기존 상태창 토글 / 줌 컨트롤 */}
          <div className="flex flex-col gap-2 relative">
            {onToggleSidebar && (
              <Button
                size="icon"
                variant="secondary"
                className="rounded-full shadow-lg border border-primary/20 bg-background/80 backdrop-blur mb-2"
                onClick={onToggleSidebar}
                data-testid="button-toggle-sidebar"
              >
                {isSidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              </Button>
            )}
            {onTogglePlayerDetailScale && (
              <Button
                size="icon"
                variant="secondary"
                className="rounded-full shadow-lg border border-primary/20 bg-background/80 backdrop-blur mb-2 text-[10px] font-black leading-none px-0"
                onClick={onTogglePlayerDetailScale}
                title={`플레이어 상세 배율 (현재 ×${playerDetailScale}) — 클릭 시 ×1 → ×1.5 → ×2 순환`}
                data-testid="button-toggle-player-detail-scale"
              >
                ×{playerDetailScale}
              </Button>
            )}
            <Button
              size="icon"
              variant="secondary"
              onClick={handleZoomIn}
              data-testid="button-zoom-in"
            >
              <ZoomIn className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={handleZoomOut}
              data-testid="button-zoom-out"
            >
              <ZoomOut className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={handleReset}
              data-testid="button-reset-view"
              title="맵 보기 초기화"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => setShowTileBorders((v) => { const n = !v; localStorage.setItem('show-tile-borders', String(n)); return n; })}
              data-testid="button-toggle-tile-borders"
              title="타일 외곽 테두리 구분선 보기 (각 칸 구분)"
              className={showTileBorders ? 'text-amber-300 hover:text-amber-200 ring-1 ring-amber-400/60' : 'text-zinc-300 hover:text-white'}
            >
              <Grid3x3 className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => setIsUiHelpOpen(true)}
              data-testid="button-ui-help"
              title="UI · 단축키 안내"
              className="text-blue-300 hover:text-blue-200"
            >
              <HelpCircle className="w-4 h-4" />
            </Button>
            <div className="bg-black/60 backdrop-blur-md border border-white/10 px-2.5 py-1.5 rounded-lg text-[10px] font-mono text-zinc-300 text-center shadow-xl">
              {Math.round(zoom * 100)}%
            </div>
          </div>
        </div>

        <GameUiHelpDialog open={isUiHelpOpen} onOpenChange={setIsUiHelpOpen} />

      </div>

      {/* 행성/타일 선택 패널: 절대 위치 오버레이로 맵 영역 크기에 영향 없음 */}
      {
        selectedTile && (
          <div
            className="absolute top-0 bottom-0 right-0 w-64 bg-card border-l border-border p-4 space-y-4 shadow-xl z-20 overflow-y-auto transition-all duration-300 ease-in-out"

          >
            {/* 닫기 — 이 패널이 맵 오른쪽을 가려 클릭을 막으므로, 닫아서 맵을 바로 누를 수 있게 함 */}
            <button
              type="button"
              onClick={() => setSelectedTile(null)}
              title="닫기 (맵 클릭 가능)"
              className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-md bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-white/10 text-sm font-bold leading-none"
            >
              ✕
            </button>
            <h3 className="font-semibold capitalize pr-8">
              {selectedTile.type?.startsWith('ship_') ? 'Spaceship' : `${selectedTile.type} Planet`}
            </h3>
            <p className="text-sm text-muted-foreground">
              Sector {selectedTile.sector} | ({selectedTile.q}, {selectedTile.r})
            </p>

            {/* 엠바스(Ambas) Special: 의회↔광산 교체 — 광산 클릭 시 즉시 교체 */}
            {ambasSwapPiMineMode && (
              <div className="space-y-2 p-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <p className="text-xs font-semibold text-amber-300">엠바스 Special: PI ↔ 광산 교체</p>
                <p className="text-xs text-muted-foreground">맵에서 <span className="text-white font-medium">교체할 내 광산</span>을 클릭하면 의회와 위치가 바뀝니다.</p>
                {onCancelAmbasSwapPiMine && (
                  <Button variant="outline" size="sm" className="w-full text-xs border-amber-500/50 text-amber-300 hover:bg-amber-500/20" onClick={onCancelAmbasSwapPiMine}>취소</Button>
                )}
              </div>
            )}

            {/* 파이락(Firaks) Downgrade: 연구소 클릭 시 트랙 선택 다이얼로그로 진행 */}
            {firaksDowngradeMode && (
              <div className="space-y-2 p-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <p className="text-xs font-semibold text-amber-300">파이락 Special: Downgrade</p>
                <p className="text-xs text-muted-foreground">맵에서 <span className="text-white font-medium">다운그레이드할 연구소</span>를 클릭하면 트랙 선택 창이 뜹니다.</p>
                {onCancelFiraksDowngrade && (
                  <Button variant="outline" size="sm" className="w-full text-xs border-amber-500/50 text-amber-300 hover:bg-amber-500/20" onClick={onCancelFiraksDowngrade}>취소</Button>
                )}
              </div>
            )}

            {/* 모웨이드(Moweyip) 링 놓기: 링 없는 본인 건물 클릭 시 링 배치 */}
            {moweyipPlaceRingMode && (
              <div className="space-y-2 p-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <p className="text-xs font-semibold text-amber-300">모웨이드 Special: 링 놓기</p>
                <p className="text-xs text-muted-foreground">맵에서 <span className="text-white font-medium">링을 놓을 본인 건물</span>을 클릭하세요. (+2 파워 수신/연방)</p>
                {onCancelMoweyipPlaceRing && (
                  <Button variant="outline" size="sm" className="w-full text-xs border-amber-500/50 text-amber-300 hover:bg-amber-500/20" onClick={onCancelMoweyipPlaceRing}>취소</Button>
                )}
              </div>
            )}

            {/* 우주정거장 배치 모드: 빈 우주 타일일 때만 배치 UI, 아니면 안내 + 취소 */}
            {ivitsSpaceStationMode && (
              <>
                {(selectedTile.type === 'space' || selectedTile.type === 'deep_space') && !selectedTile.structure && !selectedTile.spaceStation && currentPlayer?.faction === 'ivits' && onPlaceIvitsSpaceStation && !currentPlayer.usedIvitsSpaceStationThisRound && (() => {
                  const satList = game.satellites?.[selectedTile.id];
                  const mySatellite = Array.isArray(satList) ? satList.includes(playerId!) : satList === playerId;
                  if (mySatellite) return null;
                  const rangeTiles = game.map.filter((t: HexTile) =>
                    (t.ownerId === playerId && t.structure != null) || t.spaceStation?.ownerId === playerId
                  );
                  if (rangeTiles.length === 0) return <p className="text-xs text-amber-400">내 건물/우주정거장이 없으면 배치할 수 없습니다.</p>;
                  const baseRange = getRange(currentPlayer!.research?.navigation ?? 0) + (currentPlayer!.navigationBonus ?? 0);
                  const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
                  const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                  const qicOk = (currentPlayer!.qic ?? 0) >= neededQIC;
                  return (
                    <div className="space-y-2 p-2 bg-amber-500/10 rounded-lg border border-amber-500/30">
                      <p className="text-xs font-semibold text-amber-300">우주정거장 배치</p>
                      <p className="text-xs text-muted-foreground">
                        거리: {minDist} | Nav: {baseRange}
                        {neededQIC > 0 && <span className="text-yellow-400"> | QIC: {neededQIC}</span>}
                      </p>
                      <Button className="w-full text-xs" size="sm" disabled={!qicOk} onClick={() => { onPlaceIvitsSpaceStation(selectedTile.id); setSelectedTile(null); }}>
                        우주정거장 배치{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}
                      </Button>
                    </div>
                  );
                })()}
                {(!(selectedTile.type === 'space' || selectedTile.type === 'deep_space') || selectedTile.structure || selectedTile.spaceStation) && (
                  <div className="space-y-2 p-2 rounded-lg border border-white/20">
                    <p className="text-xs text-zinc-400">맵에서 <span className="text-white font-medium">빈 우주 타일(검은 칸)</span>을 클릭하세요.</p>
                    {onCancelIvitsSpaceStation && (
                      <Button variant="outline" size="sm" className="w-full text-xs" onClick={onCancelIvitsSpaceStation}>취소</Button>
                    )}
                  </div>
                )}
              </>
            )}

            {!ivitsSpaceStationMode && (
              <>
                {/* 우주선 입장: 메인 단계에서만 표시 (세팅 단계에서는 무반응 방지) */}
                {selectedTile.type?.startsWith('ship_') && currentPlayer && playerId && game.spaceships?.[selectedTile.id] && (
                  (() => {
                    const ship = game.spaceships[selectedTile.id];
                    const shipName = SHIP_NAMES[selectedTile.type] || selectedTile.type;
                    const isMyTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
                    const isInShip = ship.occupants.includes(playerId);
                    const totalPower = (currentPlayer.power1 ?? 0) + (currentPlayer.power2 ?? 0) + (currentPlayer.power3 ?? 0);

                    // 우주선 기술타일 (탑승/미탑승 공통 표시)
                    const techId = game.shipTechByShip?.[selectedTile.type] ?? SHIP_TECH_BY_SHIP[selectedTile.type];
                    const techTile = techId ? SHIP_TECH_TILES.find(t => t.id === techId) : null;
                    const techTileNode = techTile ? (
                      <div className="flex items-center gap-2 p-1.5 bg-zinc-800/80 rounded border border-yellow-500/30">
                        {techTile.image ? <img src={techTile.image} alt={techTile.label} className="h-10 w-auto object-contain shrink-0" /> : null}
                        <div className="min-w-0">
                          <div className="text-[8px] font-black text-yellow-500/90 uppercase tracking-tight">Technology</div>
                          <div className="text-[10px] font-bold text-zinc-100 truncate">{techTile.label}</div>
                          <div className="text-[9px] text-zinc-400 leading-tight line-clamp-2" title={techTile.description}>{techTile.description}</div>
                        </div>
                      </div>
                    ) : null;

                    // 이 우주선에서 획득 가능한 연방 보상 (탑승/미탑승 공통 표시)
                    const shipFedId = game.spaceshipFederationByShip?.[selectedTile.type];
                    const shipFedReward = shipFedId ? SPACESHIP_FEDERATION_REWARDS.find(r => r.id === shipFedId) : null;
                    const shipFedTaken = shipFedId ? Object.values(game.players).some(pl => getFederationEntries(pl).some(e => e.rewardId === shipFedId)) : false;
                    const shipFedIdx = shipFedId ? SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === shipFedId) : -1;
                    const shipFedImg = shipFedIdx !== -1 ? `/image/Federation_${shipFedIdx + 7}.gif` : null;
                    const shipFedNode = shipFedReward ? (
                      <div className="flex items-center gap-2 p-1.5 bg-zinc-800/60 rounded border border-cyan-500/30">
                        <span className="text-[10px] text-zinc-400 font-semibold shrink-0">연방 보상</span>
                        {shipFedTaken
                          ? <span className="text-[10px] text-zinc-500 italic">이미 획득됨</span>
                          : shipFedImg
                            ? <img src={shipFedImg} alt={shipFedReward.label} title={shipFedReward.label} className="h-12 w-auto object-contain rounded-sm border border-white/10" />
                            : <span className="text-[10px] text-zinc-200 font-bold">{shipFedReward.label}</span>}
                      </div>
                    ) : null;

                    // === 이미 탑승: 액션 UI ===
                    if (isInShip) {
                      const usedIndices = ship.usedActionIndices ?? [];
                      const actionsUsedCount = usedIndices.length;
                      const actionLabels = SHIP_ACTION_LABELS[selectedTile.type] || ['—', '—', '—'];
                      const canActNow = isMyTurn && game.currentPhase === 'main' && !game.hasDoneMainAction;
                      return (
                        <div className="space-y-2 p-2 bg-zinc-900/60 rounded-lg border border-blue-500/40">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-white">{shipName} · 탑승 중</p>
                            <span className="text-[10px] text-zinc-400">액션 {actionsUsedCount}/3</span>
                          </div>
                          {techTileNode}
                          {shipFedNode}
                          {!canActNow && <p className="text-[11px] text-amber-400">{!isMyTurn ? '내 턴이 아닙니다' : '이번 턴 메인 액션을 이미 사용했습니다'}</p>}
                          <div className="relative w-full rounded-md overflow-hidden border border-blue-500/30">
                            {SHIP_ACTION_IMG[selectedTile.type] && (
                              <img src={SHIP_ACTION_IMG[selectedTile.type]} alt="ship actions" className="block w-full h-auto" />
                            )}
                            <div className="absolute inset-0 grid grid-cols-3">
                              {[0, 1, 2].map((idx) => {
                                const actionNum = idx + 1;
                                const isUsed = usedIndices.includes(actionNum);
                                const canUse = canActNow && !!onUseShipAction && !isUsed && actionsUsedCount < 3;
                                const usedBy = isUsed ? ship.usedActionBy?.[actionNum] : undefined;
                                const usedByPlayer = usedBy ? game.players[usedBy] : undefined;
                                const usedByColor = usedByPlayer?.faction ? FACTIONS.find(f => f.id === usedByPlayer.faction)?.color : undefined;
                                return (
                                  <button
                                    key={idx}
                                    disabled={!canUse}
                                    onClick={() => { if (canUse) { onUseShipAction!(selectedTile.id, actionNum); setSelectedTile(null); } }}
                                    className={`relative h-full border-r last:border-r-0 border-black/30 transition-colors ${canUse ? 'cursor-pointer hover:bg-blue-400/25' : 'cursor-default'}`}
                                    title={actionLabels[idx] + (isUsed ? ` (사용: ${usedByPlayer?.name ?? '?'})` : '')}
                                  >
                                    {isUsed && <div className="absolute inset-0 bg-black/65" />}
                                    {usedByColor && (
                                      <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-black/60 shadow-sm" style={{ backgroundColor: usedByColor }} />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          {selectedTile.type === 'ship_twilight' && (game.twilightArtifactSlots?.length ?? 0) > 0 && (
                            <div className="pt-2 border-t border-white/5">
                              <p className="text-[10px] text-zinc-400 mb-1">인공물 (파워 6 소모)</p>
                              <div className="grid grid-cols-4 gap-1.5">
                                {(game.twilightArtifactSlots ?? []).map((aid, i) => {
                                  if (!aid) return <div key={i} className="h-12 rounded border border-dashed border-white/5 bg-black/20" />;
                                  const art = ARTIFACTS.find(a => a.id === aid);
                                  if (!art) return <div key={i} />;
                                  const artIndex = ARTIFACTS.findIndex(a => a.id === aid);
                                  const artImg = artIndex !== -1 ? `/image/Art${artIndex + 1}.png` : null;
                                  const canTake = canActNow && !!onTakeTwilightArtifact && totalPower >= 6;
                                  return (
                                    <button key={i} disabled={!canTake}
                                      onClick={() => { if (canTake) { onTakeTwilightArtifact!(aid); setSelectedTile(null); } }}
                                      className="h-12 p-0.5 rounded border border-purple-500/40 bg-purple-900/20 hover:bg-purple-800/40 disabled:opacity-40"
                                      title={`${art.label}: ${art.description}`}>
                                      {artImg ? <img src={artImg} alt={art.label} className="h-full w-full object-contain" /> : <span className="text-[8px]">{art.label}</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }

                    // === 미탑승: 입장 가능하면 입장 UI, 아니면 안내 메시지 ===
                    const enteredCount = currentPlayer.spaceshipsEntered?.length ?? 0;
                    const vpCost = currentPlayer.faction === 'bal_tak' ? 7 : 5;
                    const needVP = (currentPlayer.score ?? 0) < vpCost;
                    const isItarsOrNevlas = currentPlayer.faction === 'itars' || currentPlayer.faction === 'nevlas';
                    const needToken = isItarsOrNevlas && totalPower < 1;
                    const baseRange = getEffectiveBaseRange(currentPlayer);
                    const rangeTiles = game.map.filter((t: HexTile) =>
                      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId || t.parasiticMine?.ownerId === playerId
                    );
                    const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile))) : Infinity;
                    const neededQIC = minDist !== Infinity && minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                    const canReach = minDist === Infinity || minDist <= baseRange + ((currentPlayer.qic ?? 0) * 2);
                    const qicOk = neededQIC <= (currentPlayer.qic ?? 0);
                    const canEnter = isMyTurn && game.currentPhase === 'main' && enteredCount < 3 && !!onEnterSpaceship;

                    return (
                      <div className="space-y-2 p-2 bg-zinc-900/60 rounded-lg border border-white/10">
                        <p className="text-xs font-semibold text-white">{shipName}</p>
                        {techTileNode}
                        {shipFedNode}
                        {/* 미탑승/상대턴이어도 액션 사용 현황(사용됨/가능)을 상시 표시 — 전략 미리 파악용 */}
                        <div>
                          <p className="text-[10px] text-zinc-400 mb-1">우주선 액션 ({(ship.usedActionIndices ?? []).length}/3 사용됨)</p>
                          <div className="relative w-full rounded-md overflow-hidden border border-white/10">
                            {SHIP_ACTION_IMG[selectedTile.type] && (
                              <img src={SHIP_ACTION_IMG[selectedTile.type]} alt="ship actions" className="block w-full h-auto" />
                            )}
                            <div className="absolute inset-0 grid grid-cols-3">
                              {(SHIP_ACTION_LABELS[selectedTile.type] || ['—', '—', '—']).map((label, idx) => {
                                const isUsed = (ship.usedActionIndices ?? []).includes(idx + 1);
                                const usedBy = isUsed ? ship.usedActionBy?.[idx + 1] : undefined;
                                const usedByPlayer = usedBy ? game.players[usedBy] : undefined;
                                const usedByColor = usedByPlayer?.faction ? FACTIONS.find(f => f.id === usedByPlayer.faction)?.color : undefined;
                                return (
                                  <div
                                    key={idx}
                                    className="relative h-full border-r last:border-r-0 border-black/30"
                                    title={label + (isUsed ? ` (사용: ${usedByPlayer?.name ?? '?'})` : ' (사용 가능)')}
                                  >
                                    {isUsed && <div className="absolute inset-0 bg-black/65" />}
                                    {usedByColor && (
                                      <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-black/60 shadow-sm" style={{ backgroundColor: usedByColor }} />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        {/* 미탑승이어도 트왈라잇 인공물을 미리보기(읽기전용)로 표시 — 획득은 탑승 후 파워 6 소모 */}
                        {selectedTile.type === 'ship_twilight' && (game.twilightArtifactSlots?.filter(Boolean).length ?? 0) > 0 && (
                          <div>
                            <p className="text-[10px] text-zinc-400 mb-1">인공물 (탑승 후 파워 6 소모하여 획득)</p>
                            <div className="grid grid-cols-4 gap-1.5">
                              {(game.twilightArtifactSlots ?? []).map((aid, i) => {
                                if (!aid) return <div key={i} className="h-12 rounded border border-dashed border-white/5 bg-black/20" />;
                                const art = ARTIFACTS.find(a => a.id === aid);
                                if (!art) return <div key={i} />;
                                const artIndex = ARTIFACTS.findIndex(a => a.id === aid);
                                const artImg = artIndex !== -1 ? `/image/Art${artIndex + 1}.png` : null;
                                return (
                                  <div key={i}
                                    className="h-12 p-0.5 rounded border border-purple-500/30 bg-purple-900/15 opacity-70"
                                    title={`${art.label}: ${art.description}`}>
                                    {artImg ? <img src={artImg} alt={art.label} className="h-full w-full object-contain" /> : <span className="text-[8px]">{art.label}</span>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <p className="text-[11px] text-amber-400">아직 이 우주선에 탑승하지 않았습니다.</p>
                        {!isMyTurn && <p className="text-[11px] text-zinc-400">내 턴에 입장할 수 있습니다.</p>}
                        {isMyTurn && game.currentPhase !== 'main' && <p className="text-[11px] text-zinc-400">우주선 입장은 메인(액션) 단계에서 가능합니다.</p>}
                        {isMyTurn && game.currentPhase === 'main' && enteredCount >= 3 && <p className="text-[11px] text-zinc-400">이미 우주선 3척에 탑승하여 더 탈 수 없습니다.</p>}
                        {canEnter && (
                          <>
                            <p className="text-xs text-zinc-300">{vpCost} VP로 입장{isItarsOrNevlas && ' · 1 토큰 (1→2→3그릇)'}</p>
                            {minDist !== Infinity && (
                              <p className="text-xs text-muted-foreground">
                                거리: {minDist} | 기본 범위: {baseRange}
                                {neededQIC > 0 && <span className="text-yellow-400"> | 필요 QIC: {neededQIC}</span>}
                              </p>
                            )}
                            {!canReach && <p className="text-xs text-red-400">거리가 너무 멉니다</p>}
                            {canReach && needVP && <p className="text-xs text-amber-400">입장 비용: {vpCost} VP 필요</p>}
                            {canReach && isItarsOrNevlas && needToken && <p className="text-xs text-amber-400">입장 비용: 파워 토큰 1개 필요 (1/2/3그릇 순)</p>}
                            <Button
                              className="w-full text-xs"
                              size="sm"
                              disabled={!canReach || needVP || needToken || (neededQIC > 0 && !qicOk)}
                              onClick={() => {
                                onEnterSpaceship!(selectedTile.id, !!currentPlayer.rangeBonusActive, neededQIC);
                                setSelectedTile(null);
                              }}
                            >
                              입장{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}{isItarsOrNevlas ? ' (1 토큰)' : ''}
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })()
                )}

                {selectedTile.structure && (
                  <div className="p-2 bg-muted rounded">
                    <p className="text-sm capitalize">Structure: {selectedTile.structure.replace('_', ' ')}</p>
                    <p className="text-xs text-muted-foreground">
                      Owner: {selectedTile.ownerId ? (game.players[selectedTile.ownerId]?.name || 'Unknown') : 'None'}
                    </p>
                  </div>
                )}

                {isStartingPhase && canPlaceStartingMine && (
                  <div className="space-y-2">
                    <p className="text-xs text-blue-400">
                      {faction?.startingStructure === 'planetary_institute'
                        ? 'Starting Phase: 의회를 놓으세요'
                        : 'Starting Phase: Place free mine'}
                    </p>
                    <Button
                      className="w-full"
                      onClick={() => {
                        onPlaceStartingMine(selectedTile.id, faction?.id);
                        setSelectedTile(null);
                      }}
                      data-testid="button-place-starting-mine"
                    >
                      {faction?.startingStructure === 'planetary_institute' ? '의회 놓기' : 'Place Starting Mine'}
                    </Button>
                  </div>
                )}

                {/* Transdim 가이아 포머 설치 */}
                {selectedTile.type === 'transdim' && !selectedTile.hasGaiaformer && !selectedTile.structure && currentPlayer && (
                  <div className="space-y-2">
                    {(() => {
                      const total = currentPlayer.gaiaformers ?? 0;
                      const locked = currentPlayer.faction === 'bal_tak' ? (currentPlayer.balTakGaiaformersUsedForQic ?? 0) : 0;
                      const available = total - locked;
                      return available > 0 ? (
                        <>
                          <p className="text-xs text-green-400">가이아 포머 설치 가능</p>
                          <p className="text-xs text-muted-foreground">
                            보유: {total}개{locked > 0 ? ` (사용 가능: ${available})` : ''} |
                            기술 레벨: {currentPlayer.research?.gaiaProject || 0}
                          </p>
                          {(() => {
                            // 거리 체크: getEffectiveBaseRange로 통일 (Nav + Nav보너스 + 트왈라잇/보너스 +3 + 글린 +2). 서버 place_gaiaformer와 동일
                            const playerForRange = playerId ? game.players[playerId] : null;
                            const effectiveBaseRange = getEffectiveBaseRange(playerForRange ?? currentPlayer);
                            const rangeTiles = game.map.filter((t: HexTile) =>
                              (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId || t.parasiticMine?.ownerId === playerId
                            );
                            const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile))) : Infinity;
                            const neededQIC = minDist > effectiveBaseRange ? Math.ceil((minDist - effectiveBaseRange) / 2) : 0;
                            const canReach = minDist <= effectiveBaseRange + ((currentPlayer.qic ?? 0) * 2);

                            return (
                              <>
                                {minDist !== Infinity && (
                                  <p className="text-xs text-muted-foreground">
                                    거리: {minDist} | 기본 범위: {effectiveBaseRange}
                                    {(playerForRange?.tempRangeBonus || playerForRange?.rangeBonusActive) && (
                                      <span className="text-green-400"> (+3 보너스)</span>
                                    )}
                                    {neededQIC > 0 && (
                                      <span className="text-yellow-400"> | 필요 QIC: {neededQIC}</span>
                                    )}
                                  </p>
                                )}
                                {!canReach && (
                                  <p className="text-xs text-red-400">거리가 너무 멉니다</p>
                                )}
                                {onPlaceGaiaformer && (
                                  <Button
                                    className="w-full"
                                    variant="secondary"
                                    disabled={
                                      (game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId))
                                      || (game.turnOrder[game.currentPlayerIndex] !== playerId)
                                      || !canReach
                                      || (neededQIC > 0 && (currentPlayer.qic ?? 0) < neededQIC)
                                    }
                                    onClick={() => {
                                      onPlaceGaiaformer(selectedTile.id, neededQIC);
                                      setSelectedTile(null);
                                    }}
                                  >
                                    Place Gaiaformer{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}
                                    {game.pendingTFMarsGaiaProject?.playerId === playerId
                                      ? (game.pendingTFMarsGaiaProject.shipTileId === 'bonus-gaia' ? ' (Bonus)' : ' (TF Mars)')
                                      : ''}
                                  </Button>
                                )}
                              </>
                            );
                          })()}
                        </>
                      ) : (
                        <p className="text-xs text-red-400">가이아 포머가 필요합니다</p>
                      );
                    })()}
                  </div>
                )}

                {/* 하이브(이비츠) 우주정거장: 빈 공간(space/deep_space), 내 위성 없을 때만, 라운드당 1회 */}
                {(selectedTile.type === 'space' || selectedTile.type === 'deep_space') && !selectedTile.structure && !selectedTile.spaceStation && currentPlayer?.faction === 'ivits' && onPlaceIvitsSpaceStation && !currentPlayer.usedIvitsSpaceStationThisRound && !game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && (() => {
                  const satList = game.satellites?.[selectedTile.id];
                  const mySatellite = Array.isArray(satList) ? satList.includes(playerId!) : satList === playerId;
                  if (mySatellite) return null;
                  const rangeTiles = game.map.filter((t: HexTile) =>
                    (t.ownerId === playerId && t.structure != null) || t.spaceStation?.ownerId === playerId
                  );
                  if (rangeTiles.length === 0) return null;
                  const baseRange = getRange(currentPlayer.research?.navigation ?? 0) + (currentPlayer.navigationBonus ?? 0);
                  const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
                  const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                  const qicOk = (currentPlayer.qic ?? 0) >= neededQIC;
                  return (
                    <div className="space-y-2 p-2 bg-zinc-900/60 rounded-lg border border-white/10">
                      <p className="text-xs font-semibold text-white">우주정거장 배치 (하이브)</p>
                      <p className="text-xs text-muted-foreground">
                        거리: {minDist} | Nav 범위: {baseRange}
                        {neededQIC > 0 && <span className="text-yellow-400"> | QIC: {neededQIC}</span>}
                      </p>
                      <Button
                        className="w-full text-xs"
                        size="sm"
                        disabled={!qicOk}
                        onClick={() => {
                          onPlaceIvitsSpaceStation(selectedTile.id);
                          setSelectedTile(null);
                        }}
                      >
                        우주정거장 배치{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}
                      </Button>
                    </div>
                  );
                })()}

                {/* 거리 5 보상 잊혀진 행성: 빈 우주(위성 없음)에 특수 광산 1개 배치 */}
                {game.pendingLostPlanet?.playerId === playerId && (selectedTile.type === 'space' || selectedTile.type === 'deep_space') && !selectedTile.structure && !selectedTile.spaceStation && currentPlayer && onPlaceLostPlanet && (() => {
                  const satList = game.satellites?.[selectedTile.id];
                  const hasSatellite = Array.isArray(satList) ? satList.length > 0 : !!satList;
                  if (hasSatellite) return null;
                  const rangeTiles = game.map.filter((t: HexTile) =>
                    (t.ownerId === playerId && t.structure != null) || t.spaceStation?.ownerId === playerId
                  );
                  if (rangeTiles.length === 0) return <p className="text-xs text-amber-400">내 건물/우주정거장이 없으면 배치할 수 없습니다.</p>;
                  const baseRange = getRange(5) + (currentPlayer.navigationBonus ?? 0);
                  const minDist = Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile)));
                  const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                  const qicOk = (currentPlayer.qic ?? 0) >= neededQIC;
                  return (
                    <div className="space-y-2 p-2 bg-indigo-500/10 rounded-lg border border-indigo-400/30">
                      <p className="text-xs font-semibold text-indigo-300">잊혀진 행성 (Nav 5)</p>
                      <p className="text-xs text-muted-foreground">
                        거리: {minDist} | Nav 5 범위: {baseRange}
                        {neededQIC > 0 && <span className="text-yellow-400"> | QIC: {neededQIC}</span>}
                      </p>
                      <Button
                        className="w-full text-xs"
                        size="sm"
                        disabled={!qicOk}
                        onClick={() => {
                          onPlaceLostPlanet(selectedTile.id, neededQIC);
                          setSelectedTile(null);
                        }}
                      >
                        잊혀진 행성 배치{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}
                      </Button>
                    </div>
                  );
                })()}

                {/* Transdim에 가이아 포머가 설치된 경우 다음 라운드 건설 가능 */}
                {selectedTile.type === 'transdim' && selectedTile.hasGaiaformer && !selectedTile.structure && currentPlayer && (
                  <div className="space-y-2">
                    {currentPlayer.pendingGaiaformerTiles?.includes(selectedTile.id) ? (
                      <>
                        <p className="text-xs text-green-400">건설 가능</p>
                        <Button
                          className="w-full"
                          variant="secondary"
                          disabled={(game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId)) || (game.turnOrder[game.currentPlayerIndex] !== playerId)}
                          onClick={() => {
                            onBuildMine(selectedTile.id);
                            setSelectedTile(null);
                          }}
                        >
                          Build Mine (1O, 2C)
                        </Button>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">가이아 포머 설치됨 (다음 라운드 건설 가능)</p>
                    )}
                  </div>
                )}

                {/* Eclipse 액션3: 6C 지불 후 소행성 선택 시 광산 건설 (가이아포머 없이) */}
                {isEclipseAsteroidMode && onEclipseBuildAsteroidMine && selectedTile.type === 'asteroid' && !selectedTile.structure && eclipseBuildableTileIds.has(selectedTile.id) && (() => {
                  const q = eclipseNeededQic(selectedTile);
                  return (
                  <div className="space-y-2">
                    <p className="text-xs text-green-400">Eclipse: 소행성 광산 건설 가능{q > 0 ? ` (사거리 연장 ${q} QIC)` : ''}</p>
                    <Button
                      className="w-full bg-primary/20 border-primary text-primary hover:bg-primary/30"
                      variant="secondary"
                      onClick={() => {
                        onEclipseBuildAsteroidMine(selectedTile.id, q);
                        setSelectedTile(null);
                      }}
                      data-testid="button-eclipse-build-asteroid"
                    >
                      짓기 (6C{q > 0 ? ` + ${q} QIC` : ''})
                    </Button>
                  </div>
                  );
                })()}

                {/* 란티다 기생 광산: 버튼만 심플하게 표시 */}
                {currentPlayer?.faction === 'lantids' && selectedTile.structure != null && selectedTile.ownerId !== playerId && selectedTile.ownerId != null && !selectedTile.parasiticMine && onBuildMine && (() => {
                  const playerTiles = game.map.filter((t: HexTile) => (t.ownerId === playerId || t.parasiticMine?.ownerId === playerId) && (t.structure != null || t.parasiticMine));
                  const playerForRange = playerId ? game.players[playerId] : null;
                  const effectiveBaseRange = getEffectiveBaseRange(playerForRange ?? currentPlayer);
                  const minDist = playerTiles.length > 0 ? Math.min(...playerTiles.map((t: HexTile) => getDistance(t, selectedTile))) : Infinity;
                  const neededQIC = minDist > effectiveBaseRange ? Math.ceil((minDist - effectiveBaseRange) / 2) : 0;
                  const canReach = minDist <= effectiveBaseRange + ((currentPlayer?.qic ?? 0) * 2);
                  const canAfford = (currentPlayer?.ore ?? 0) >= 1 && (currentPlayer?.credits ?? 0) >= 2 && (currentPlayer?.qic ?? 0) >= neededQIC;

                  if (!canReach) return <p className="text-xs text-red-400 p-2">기생 광산: 거리가 너무 멉니다</p>;

                  return (
                    <Button
                      className="w-full border-amber-500/50 text-amber-200 hover:bg-amber-500/20"
                      variant="secondary"
                      disabled={(game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId)) || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !canAfford}
                      onClick={() => {
                        onBuildMine(selectedTile.id);
                        setSelectedTile(null);
                      }}
                    >
                      Build Parasitic Mine (1O, 2C){neededQIC > 0 ? ` + ${neededQIC} QIC` : ''}
                    </Button>
                  );
                })()}

                {/* 일반 광산 건설 버튼: 타일에 건물이 없을 때만 표시 */}
                {canShowBuildMineOption && !selectedTile.structure && mineBuildCost && (
                  <div className="space-y-2">
                    <Button
                      className="w-full"
                      variant="secondary"
                      disabled={
                        // 테라포밍 파워 액션(1 step 등) 사용 중에는 메인 액션 완료 후에도 광산 건설을 이어서 해야 하므로 예외로 활성화
                        !canBuildMine ||
                        (game.hasDoneMainAction
                          && !(currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0)
                          && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId)
                          && (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId))
                      }
                      onClick={() => {
                        onBuildMine(selectedTile.id, selectedTile.type === 'asteroid' ? true : undefined);
                        setSelectedTile(null);
                      }}
                      data-testid="button-build-mine"
                    >
                      {selectedTile.type === 'asteroid' ? (
                        <>Build Mine (Free - Use 1 Gaiaformer)</>
                      ) : (selectedTile.type === 'gaia' && currentPlayer?.pendingGaiaformerTiles?.includes(selectedTile.id)) || (selectedTile.type === 'transdim' && selectedTile.hasGaiaformer && currentPlayer?.pendingGaiaformerTiles?.includes(selectedTile.id)) ? (
                        <>Build Mine (1 Ore, 2 Credits)</>
                      ) : selectedTile.type === 'proto' ? (
                        <>Build Mine ({mineBuildCost.oreCost} Ore, {mineBuildCost.credits} Credits
                          {mineBuildCost.qicCost > 0 && `, ${mineBuildCost.qicCost} QIC`}) - +6 VP</>
                      ) : selectedTile.type === 'gaia' && currentPlayer?.faction === 'gleens' ? (
                        <>Build Mine ({mineBuildCost.oreCost} Ore, {mineBuildCost.credits} Credits{mineBuildCost.qicCost > 0 && `, ${mineBuildCost.qicCost} QIC`}) — +2 VP</>
                      ) : (
                        <>Build Mine ({mineBuildCost.oreCost} Ore, {mineBuildCost.credits} Credits
                          {mineBuildCost.qicCost > 0 && `, ${mineBuildCost.qicCost} QIC`})</>
                      )}
                    </Button>
                    {mineBuildCost.terraformSteps > 0 && (
                      <div className="text-xs space-y-1">
                        <div className={`${mineBuildCost.needsExtraTerraforming ? 'text-red-400' : 'text-amber-400'}`}>
                          Terraforming: {mineBuildCost.terraformSteps} step{mineBuildCost.terraformSteps > 1 ? 's' : ''}
                          @ {getTerraformCost(mineBuildCost.terraformingLevel)}/step
                          {mineBuildCost.terraformDiscount && mineBuildCost.terraformDiscount > 0 && (
                            <span className="text-green-400 ml-1">
                              (-{mineBuildCost.terraformDiscount} free)
                            </span>
                          )}
                          {mineBuildCost.needsExtraTerraforming && ' ⚠️'}
                        </div>
                        {mineBuildCost.needsExtraTerraforming && (
                          <div className="text-red-400 text-[10px] font-bold bg-red-500/10 p-1 rounded border border-red-500/30">
                            Terraforming Level {mineBuildCost.terraformingLevel} - Extra terraforming required!
                          </div>
                        )}
                      </div>
                    )}
                    {!canBuildMine && (
                      <div className="text-red-400 text-[10px] font-bold bg-red-500/10 p-1 rounded border border-red-500/30">
                        자원 또는 QIC가 부족합니다.
                      </div>
                    )}
                  </div>
                )}

                {/* Upgrade Options */}
                {selectedTile.ownerId === playerId && playerId && (() => {
                  const counts = getStructureCounts(game, playerId);
                  const canUpgradeMineToTS = counts.tsCount < BUILDING_LIMITS.trading_station;
                  const canUpgradeTSToLab = counts.labCount < BUILDING_LIMITS.research_lab;
                  const canUpgradeTSToPI = counts.piCount < BUILDING_LIMITS.planetary_institute;
                  const academyTotal = counts.academyLeft + counts.academyRight;
                  const canBuildAcademyLeft = academyTotal < BUILDING_LIMITS.academy && counts.academyLeft < 1;
                  const canBuildAcademyRight = academyTotal < BUILDING_LIMITS.academy && counts.academyRight < 1;
                  return (
                    <div className="space-y-2">
                      {selectedTile.structure === 'mine' && (
                        canUpgradeMineToTS ? (
                          (() => {
                            const tsCreditCost = hasNearbyPlayersForTradingDiscount(game.map, selectedTile, playerId) ? 3 : 6;
                            return (
                              <Button
                                className="w-full"
                                variant="secondary"
                                disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !!(currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0)}
                                onClick={() => {
                                  if (currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0) return;
                                  onUpgrade(selectedTile.id, 'trading_station');
                                  setSelectedTile(null);
                                }}
                              >
                                Upgrade to Trading Station (2O, {tsCreditCost}C)
                              </Button>
                            );
                          })()
                        ) : (
                          <p className="text-xs text-amber-400">업그레이드할 건물이 없습니다 (교역소 4개 한도)</p>
                        )
                      )}
                      {selectedTile.structure === 'trading_station' && (
                        (() => {
                          const isBescods = currentPlayer?.faction === 'bescods';
                          const canUpgradeTS = canUpgradeTSToLab || (!isBescods && canUpgradeTSToPI) || (isBescods && (canBuildAcademyLeft || canBuildAcademyRight));
                          if (!canUpgradeTS) return <p className="text-xs text-amber-400">업그레이드할 건물이 없습니다 (의회·연구소·아카데미 한도)</p>;
                          return (
                            <>
                              {canUpgradeTSToLab && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !!(currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0)} onClick={() => { if (currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0) return; onUpgrade(selectedTile.id, 'research_lab'); setSelectedTile(null); }}>
                                  Upgrade to Lab (3O, 5C)
                                </Button>
                              )}
                              {!isBescods && canUpgradeTSToPI && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !!(currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0)} onClick={() => { if (currentPlayer?.pendingTerraformSteps && currentPlayer.pendingTerraformSteps > 0) return; onUpgrade(selectedTile.id, 'planetary_institute'); setSelectedTile(null); }}>
                                  Upgrade to PI (4O, 6C)
                                </Button>
                              )}
                              {isBescods && canBuildAcademyLeft && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'academy_left'); setSelectedTile(null); }}>
                                  Academy (왼쪽) — 수익 2K (6O, 6C)
                                </Button>
                              )}
                              {isBescods && canBuildAcademyRight && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'academy_right'); setSelectedTile(null); }}>
                                  Academy (오른쪽) — 1QIC (6O, 6C)
                                </Button>
                              )}
                            </>
                          );
                        })()
                      )}
                      {selectedTile.structure === 'research_lab' && (
                        (() => {
                          const isBescods = currentPlayer?.faction === 'bescods';
                          if (isBescods) {
                            if (!canUpgradeTSToPI) return <p className="text-xs text-amber-400">업그레이드할 건물이 없습니다 (의회 1개 한도)</p>;
                            return (
                              <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'planetary_institute'); setSelectedTile(null); }}>
                                Upgrade to PI (4O, 6C)
                              </Button>
                            );
                          }
                          return (canBuildAcademyLeft || canBuildAcademyRight) ? (
                            <>
                              {canBuildAcademyLeft && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'academy_left'); setSelectedTile(null); }}>
                                  Academy (왼쪽) — 수익 {game.players[playerId]?.faction === 'itars' ? '3K' : '2K'} (6O, 6C)
                                </Button>
                              )}
                              {canBuildAcademyRight && (
                                <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'academy_right'); setSelectedTile(null); }}>
                                  Academy (오른쪽) — {game.players[playerId]?.faction === 'bal_tak' ? '4C' : '1QIC'} (6O, 6C)
                                </Button>
                              )}
                            </>
                          ) : (
                            <p className="text-xs text-amber-400">업그레이드할 건물이 없습니다 (아카데미 2개 한도)</p>
                          );
                        })()
                      )}
                    </div>
                  );
                })()}

              </>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={() => setSelectedTile(null)}
              data-testid="button-close-tile"
            >
              Close
            </Button>
          </div>
        )
      }
    </div >
  );
}
