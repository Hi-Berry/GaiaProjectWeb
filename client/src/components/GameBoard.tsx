import { useState, useCallback, useRef, useMemo } from 'react';
import { HexGrid, Layout, Hexagon, Text } from 'react-hexgrid';
import { motion } from 'framer-motion';

import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import type { GaiaGameState, HexTile, PlanetType, StructureType, ResearchTrack } from '@shared/gameConfig';
import { PLANET_COLORS, SECTOR_COLORS, STRUCTURE_SYMBOLS, FACTIONS, getTerraformSteps, getTerraformStepsForFaction, getTerraformCost, getRange, getEffectiveBaseRange, hasNearbyPlayersForTradingDiscount, isEmptyHex, isPlanetHex, BUILDING_LIMITS, HOME_PLANETS } from '@shared/gameConfig';

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

// 건물 렌더링 함수 - 가이아 프로젝트 기하학적 정확한 형태 (2배 확대)
const renderStructure = (structureType: StructureType, color: string, ownerColor?: string) => {
  const strokeColor = '#000';
  const highlightColor = lightenColor(color, 50);
  const shadowColor = darkenColor(color, 35);
  const scale = 1.7; // 전체 크기 1.7배 (15% 축소)
  
  switch (structureType) {
    case 'mine':
    case 'lost_planet_mine':
      // Mine / 잊혀진 행성: 단순한 박스형 + 작은 돌기들 (잊혀진 행성은 O 없음, 업그레이드 불가)
      return (
        <g transform="translate(0, 0.2)">
          {/* 바닥 그림자 */}
          <ellipse cx="0" cy={0.75*scale} rx={0.65*scale} ry={0.18*scale} fill="rgba(0,0,0,0.6)" />
          
          {/* 정육면체 본체 */}
          <rect
            x={-0.5*scale}
            y={-0.15*scale}
            width={1*scale}
            height={1*scale}
            fill={color}
            stroke={strokeColor}
            strokeWidth={0.09*scale}
          />
          
          {/* 왼쪽 측면 */}
          <path
            d={`M ${-0.5*scale} ${-0.15*scale} L ${-0.85*scale} ${-0.4*scale} L ${-0.85*scale} ${0.6*scale} L ${-0.5*scale} ${0.85*scale} Z`}
            fill={shadowColor}
            stroke={strokeColor}
            strokeWidth={0.09*scale}
          />
          
          {/* 윗면 */}
          <path
            d={`M ${-0.5*scale} ${-0.15*scale} L 0 ${-0.4*scale} L ${0.5*scale} ${-0.15*scale} L 0 ${0.1*scale} Z`}
            fill={highlightColor}
            stroke={strokeColor}
            strokeWidth={0.09*scale}
          />
          
          {/* 작은 돌기들 (디테일) */}
          <rect x={-0.15*scale} y={-0.55*scale} width={0.3*scale} height={0.15*scale} fill={color} stroke={strokeColor} strokeWidth={0.06*scale} />
          <circle cx={-0.25*scale} cy={-0.3*scale} r={0.08*scale} fill={highlightColor} stroke={strokeColor} strokeWidth={0.05*scale} />
          <circle cx={0.25*scale} cy={-0.25*scale} r={0.08*scale} fill={highlightColor} stroke={strokeColor} strokeWidth={0.05*scale} />
        </g>
      );
      
    case 'trading_station':
      // Trading Station: L자형 고층 건물 (하단 넓은 베이스 + 상단 타워)
      return (
        <g transform="translate(0, -0.2)">
          {/* 바닥 그림자 */}
          <ellipse cx="0" cy={1.3*scale} rx={1*scale} ry={0.28*scale} fill="rgba(0,0,0,0.6)" />
          
          {/* 하단 블록 (넓은 베이스) - 앞면 */}
          <rect
            x={-0.75*scale}
            y={0.4*scale}
            width={1.5*scale}
            height={0.85*scale}
            fill={color}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
          
          {/* 하단 블록 왼쪽 측면 */}
          <path
            d={`M ${-0.75*scale} ${0.4*scale} L ${-1*scale} ${0.2*scale} L ${-1*scale} ${1.05*scale} L ${-0.75*scale} ${1.25*scale} Z`}
            fill={shadowColor}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
          
          {/* 하단 블록 윗면 */}
          <path
            d={`M ${-0.75*scale} ${0.4*scale} L 0 ${0.2*scale} L ${0.75*scale} ${0.4*scale} L 0 ${0.6*scale} Z`}
            fill={highlightColor}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
          
          {/* 상단 타워 (하단 위에 올라간 높은 블록) - 앞면 */}
          <rect
            x={-0.45*scale}
            y={-0.65*scale}
            width={0.9*scale}
            height={1.05*scale}
            fill={darkenColor(color, 5)}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
          
          {/* 상단 타워 왼쪽 측면 */}
          <path
            d={`M ${-0.45*scale} ${-0.65*scale} L ${-0.7*scale} ${-0.8*scale} L ${-0.7*scale} ${0.2*scale} L ${-0.45*scale} ${0.4*scale} Z`}
            fill={darkenColor(color, 30)}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
          
          {/* 상단 타워 윗면 */}
          <path
            d={`M ${-0.45*scale} ${-0.65*scale} L 0 ${-0.8*scale} L ${0.45*scale} ${-0.65*scale} L 0 ${-0.5*scale} Z`}
            fill={lightenColor(color, 60)}
            stroke={strokeColor}
            strokeWidth={0.11*scale}
          />
        </g>
      );
      
    case 'research_lab':
      // Research Lab: 원통형 베이스 + 층층이 쌓인 돔 + 수직 핀들
      return (
        <g transform="translate(0, -0.3)">
          {/* 바닥 그림자 */}
          <ellipse cx="0" cy={1.5*scale} rx={1*scale} ry={0.28*scale} fill="rgba(0,0,0,0.6)" />
          
          {/* 원통형 베이스 */}
          <ellipse cx="0" cy={0.9*scale} rx={0.85*scale} ry={0.3*scale} fill={color} stroke={strokeColor} strokeWidth={0.1*scale} />
          <rect x={-0.85*scale} y={0.2*scale} width={1.7*scale} height={0.7*scale} fill={color} stroke="none" />
          <ellipse cx="0" cy={0.2*scale} rx={0.85*scale} ry={0.3*scale} fill={highlightColor} stroke={strokeColor} strokeWidth={0.1*scale} />
          
          {/* 층층이 쌓인 돔 */}
          <ellipse cx="0" cy={-0.1*scale} rx={0.75*scale} ry={0.28*scale} fill={darkenColor(color, 5)} stroke={strokeColor} strokeWidth={0.09*scale} />
          <ellipse cx="0" cy={-0.5*scale} rx={0.6*scale} ry={0.24*scale} fill={darkenColor(color, 8)} stroke={strokeColor} strokeWidth={0.08*scale} />
          <ellipse cx="0" cy={-0.8*scale} rx={0.4*scale} ry={0.18*scale} fill={lightenColor(color, 40)} stroke={strokeColor} strokeWidth={0.08*scale} />
          
          {/* 수직 핀들 (양쪽) */}
          <rect x={-0.95*scale} y={0*scale} width={0.12*scale} height={0.9*scale} fill={shadowColor} stroke={strokeColor} strokeWidth={0.06*scale} />
          <rect x={0.83*scale} y={0*scale} width={0.12*scale} height={0.9*scale} fill={shadowColor} stroke={strokeColor} strokeWidth={0.06*scale} />
          <rect x={-0.5*scale} y={0.1*scale} width={0.1*scale} height={0.7*scale} fill={darkenColor(color, 15)} stroke={strokeColor} strokeWidth={0.05*scale} />
          <rect x={0.4*scale} y={0.1*scale} width={0.1*scale} height={0.7*scale} fill={darkenColor(color, 15)} stroke={strokeColor} strokeWidth={0.05*scale} />
        </g>
      );
      
    case 'planetary_institute':
      // PI: 거대한 계단식 피라미드 + 중앙 꼭대기 돔
      return (
        <g transform="translate(0, -0.6)">
          {/* 바닥 그림자 */}
          <ellipse cx="0" cy={2.1*scale} rx={1.6*scale} ry={0.42*scale} fill="rgba(0,0,0,0.65)" />
          
          {/* 1층 (가장 넓은 기단) */}
          <rect x={-1.4*scale} y={1.4*scale} width={2.8*scale} height={0.6*scale} fill={color} stroke={strokeColor} strokeWidth={0.12*scale} />
          <path d={`M ${-1.4*scale} ${1.4*scale} L ${-1.8*scale} ${1.1*scale} L ${-1.8*scale} ${1.7*scale} L ${-1.4*scale} ${2*scale} Z`} fill={shadowColor} stroke={strokeColor} strokeWidth={0.12*scale} />
          <path d={`M ${-1.4*scale} ${1.4*scale} L 0 ${1.1*scale} L ${1.4*scale} ${1.4*scale} L 0 ${1.7*scale} Z`} fill={highlightColor} stroke={strokeColor} strokeWidth={0.12*scale} />
          
          {/* 2층 */}
          <rect x={-1.1*scale} y={0.8*scale} width={2.2*scale} height={0.6*scale} fill={darkenColor(color, 5)} stroke={strokeColor} strokeWidth={0.11*scale} />
          <path d={`M ${-1.1*scale} ${0.8*scale} L ${-1.45*scale} ${0.55*scale} L ${-1.45*scale} ${1.15*scale} L ${-1.1*scale} ${1.4*scale} Z`} fill={darkenColor(color, 30)} stroke={strokeColor} strokeWidth={0.11*scale} />
          <path d={`M ${-1.1*scale} ${0.8*scale} L 0 ${0.55*scale} L ${1.1*scale} ${0.8*scale} L 0 ${1.05*scale} Z`} fill={lightenColor(color, 45)} stroke={strokeColor} strokeWidth={0.11*scale} />
          
          {/* 3층 */}
          <rect x={-0.8*scale} y={0.2*scale} width={1.6*scale} height={0.6*scale} fill={darkenColor(color, 8)} stroke={strokeColor} strokeWidth={0.1*scale} />
          <path d={`M ${-0.8*scale} ${0.2*scale} L ${-1.1*scale} ${0*scale} L ${-1.1*scale} ${0.6*scale} L ${-0.8*scale} ${0.8*scale} Z`} fill={darkenColor(color, 33)} stroke={strokeColor} strokeWidth={0.1*scale} />
          <path d={`M ${-0.8*scale} ${0.2*scale} L 0 ${0*scale} L ${0.8*scale} ${0.2*scale} L 0 ${0.4*scale} Z`} fill={lightenColor(color, 50)} stroke={strokeColor} strokeWidth={0.1*scale} />
          
          {/* 중앙 꼭대기 돔 */}
          <ellipse cx="0" cy={-0.2*scale} rx={0.5*scale} ry={0.3*scale} fill={lightenColor(color, 55)} stroke={strokeColor} strokeWidth={0.1*scale} />
          <ellipse cx="0" cy={-0.5*scale} rx={0.35*scale} ry={0.22*scale} fill={lightenColor(color, 65)} stroke={strokeColor} strokeWidth={0.09*scale} />
        </g>
      );
      
    case 'academy':
      // Academy: 연구소처럼 원통형 베이스 + 층층이 돔 (동그란 형태)
      return (
        <g transform="translate(0, -0.4)">
          {/* 바닥 그림자 */}
          <ellipse cx="0" cy={1.6*scale} rx={1.1*scale} ry={0.32*scale} fill="rgba(0,0,0,0.6)" />
          {/* 원통형 베이스 */}
          <ellipse cx="0" cy={1*scale} rx={1*scale} ry={0.35*scale} fill={color} stroke={strokeColor} strokeWidth={0.1*scale} />
          <rect x={-1*scale} y={0.3*scale} width={2*scale} height={0.7*scale} fill={color} stroke="none" />
          <ellipse cx="0" cy={0.3*scale} rx={1*scale} ry={0.35*scale} fill={highlightColor} stroke={strokeColor} strokeWidth={0.1*scale} />
          {/* 층층이 돔 (연구소보다 약간 크게) */}
          <ellipse cx="0" cy={-0.1*scale} rx={0.9*scale} ry={0.32*scale} fill={darkenColor(color, 5)} stroke={strokeColor} strokeWidth={0.1*scale} />
          <ellipse cx="0" cy={-0.5*scale} rx={0.7*scale} ry={0.28*scale} fill={darkenColor(color, 10)} stroke={strokeColor} strokeWidth={0.09*scale} />
          <ellipse cx="0" cy={-0.85*scale} rx={0.5*scale} ry={0.22*scale} fill={lightenColor(color, 35)} stroke={strokeColor} strokeWidth={0.08*scale} />
          {/* 양쪽 핀들 */}
          <rect x={-1.1*scale} y={0.1*scale} width={0.14*scale} height={0.9*scale} fill={shadowColor} stroke={strokeColor} strokeWidth={0.06*scale} />
          <rect x={0.96*scale} y={0.1*scale} width={0.14*scale} height={0.9*scale} fill={shadowColor} stroke={strokeColor} strokeWidth={0.06*scale} />
        </g>
      );
      
    default:
      return null;
  }
};

// 색상 밝게 하는 유틸 함수
function lightenColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xFF) + percent);
  const g = Math.min(255, ((num >> 8) & 0xFF) + percent);
  const b = Math.min(255, (num & 0xFF) + percent);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// 색상 어둡게 하는 유틸 함수
function darkenColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, ((num >> 16) & 0xFF) - percent);
  const g = Math.max(0, ((num >> 8) & 0xFF) - percent);
  const b = Math.max(0, (num & 0xFF) - percent);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

interface GameBoardProps {
  game: GaiaGameState;
  playerId: string | null;
  onPlaceStartingMine: (tileId: string, factionId?: string) => void;
  onBuildMine: (tileId: string, useGaiaformer?: boolean) => void;
  onUpgrade: (tileId: string, target: StructureType | 'academy_left' | 'academy_right') => void;
  onAdvanceTech: (trackId: ResearchTrack) => void;
  onUsePowerAction: (actionId: string) => void;
  onEndTurn: () => void;
  onPass: () => void;
  highlightedTileId?: string | null;
  onPlaceGaiaformer?: (tileId: string, qicUsed?: number) => void;
  onEnterSpaceship?: (tileId: string, useRangeBonus: boolean, qicToUse: number) => void;
  onEclipseBuildAsteroidMine?: (tileId: string) => void;
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
  onPass,
  highlightedTileId,
  onPlaceGaiaformer,
  onEnterSpaceship,
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
}: GameBoardProps) {

  const [selectedTile, setSelectedTile] = useState<HexTile | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const currentPlayer = playerId ? game.players[playerId] : null;
  const isStartingPhase = game.currentPhase === 'startingMines' && currentPlayer && (currentPlayer.startingMinesPlaced || 0) < (currentPlayer.faction ? (FACTIONS.find(f => f.id === currentPlayer.faction)?.startingMines ?? 2) : 2);
  const faction = currentPlayer?.faction ? FACTIONS.find(f => f.id === currentPlayer.faction) : null;

  const isEclipseAsteroidMode = game.pendingEclipseAsteroidMine?.playerId === playerId;
  const eclipseBuildableTileIds = useMemo(() => {
    if (!isEclipseAsteroidMode || !currentPlayer || !playerId) return new Set<string>();
    const baseRange = getEffectiveBaseRange(currentPlayer);
    const rangeTiles = game.map.filter((t: HexTile) => (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId);
    if (rangeTiles.length === 0) return new Set<string>();
    const ids = new Set<string>();
    game.map.forEach((t: HexTile) => {
      if (t.type === 'asteroid' && t.structure === null) {
        const minDist = Math.min(...rangeTiles.map((s: HexTile) => getDistance(s, t)));
        if (minDist <= baseRange) ids.add(t.id);
      }
    });
    return ids;
  }, [isEclipseAsteroidMode, currentPlayer, game.map, playerId]);

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
        {/* 간단한 육각형 우주선 */}
        <path
          d="M 0,-2.5 L 1.5,-1 L 1.5,1 L 0,2.5 L -1.5,1 L -1.5,-1 Z"
          fill={shipColor}
          stroke={accentColor}
          strokeWidth="0.25"
          opacity="0.85"
        />
        {/* 중앙 창문/엔진 */}
        <circle
          cx="0"
          cy="0"
          r="0.7"
          fill={accentColor}
          opacity="0.6"
        />
        {/* 우주선 약자 (대문자 2글자, 상단 레이어·흰색·선명) */}
        <text
          y="0.2"
          style={{
            fill: '#ffffff',
            fontSize: '2.4px',
            fontWeight: 'bold',
            textAnchor: 'middle',
            dominantBaseline: 'central',
            pointerEvents: 'none',
            fontFamily: 'inherit',
            letterSpacing: '0.08em',
            paintOrder: 'stroke fill',
            stroke: 'rgba(0,0,0,0.8)',
            strokeWidth: '0.2px',
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
      if (isEmptyHex(tile) && !mySatellite) {
        onFederationToggleHex(tile.id);
        return;
      }
      if ((tile.type === 'space' || tile.type === 'deep_space') && tile.spaceStation?.ownerId === playerId) {
        onFederationToggleHex(tile.id);
        return;
      }
      if (isPlanetHex(tile)) {
        onFederationToggleHex(tile.id);
        return;
      }
    }
    if (!hasDragged && onEclipseBuildAsteroidMine && isEclipseAsteroidMode && eclipseBuildableTileIds.has(tile.id)) {
      onEclipseBuildAsteroidMine(tile.id);
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
  }, [ivitsSpaceStationMode, ambasSwapPiMineMode, onAmbasSwapPiMine, firaksDowngradeMode, onFiraksDowngradeSelectLab, moweyipPlaceRingMode, onMoweyipPlaceRing, hasDragged, isFederationMode, onFederationToggleHex, game.satellites, playerId, onEclipseBuildAsteroidMine, isEclipseAsteroidMode, eclipseBuildableTileIds, onTwilightTSUpgrade, twilightTSSelectableIds, onRebellionMineToTS, rebellionMineSelectableIds]);

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
      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId
    );
    const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile))) : 0;
    const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

    // 소행성: faction 없이도 비용 계산 (가이아포머 1개 사용, 비용 0)
    if (selectedTile.type === 'asteroid') {
      return { oreCost: 0, credits: 0, qicCost: neededQIC, terraformSteps: 0, terraformingLevel: 0, needsExtraTerraforming: false, terraformDiscount: 0 };
    }

    if (!faction) return null;
    
    let oreCost = 1;
    let credits = 2;
    let qicCost = neededQIC;
    const terraformingLevel = currentPlayer.research?.terraforming ?? 0;
    let terraformSteps = 0;
    let needsExtraTerraforming = false;
    
    // Proto 또는 기본 7색상 행성: 확장 4종족 규칙 반영
    if (selectedTile.type === 'proto' || HOME_PLANETS.includes(selectedTile.type as import('@shared/gameConfig').PlanetType)) {
      terraformSteps = getTerraformStepsForFaction(game, currentPlayer.faction, selectedTile.type as import('@shared/gameConfig').PlanetType);
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
      oreCost = 1;
      credits = 2;
      qicCost = 0;
    }
    // 가이아 행성 (다른 출처, 내 pending 아님)
    else if (selectedTile.type === 'gaia') {
      qicCost += 1;
    }
    
    const pendingTerraformSteps = currentPlayer.pendingTerraformSteps || 0;
    const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
    return { oreCost, credits, qicCost, terraformSteps, terraformingLevel, needsExtraTerraforming, terraformDiscount: discountSteps };
  }, [selectedTile, currentPlayer, faction, game.map, playerId]);

  const canBuildMine = useMemo(() => {
    const isTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
    if (!selectedTile || !currentPlayer || game.currentPhase !== 'main' || !isTurn) return false;

    if (selectedTile.structure !== null) return false;
    
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
    
    if (['space', 'deep_space', 'gas_cloud', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(selectedTile.type)) return false;
    
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
      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId
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
    // 글린 가이아: 1 QIC 대신 1 광물 가능 (오른쪽 아카데미 있어도 유지)
    if (selectedTile.type === 'gaia' && currentPlayer.faction === 'gleens') {
      const ore = currentPlayer.ore ?? 0;
      const cred = currentPlayer.credits ?? 0;
      const qic = currentPlayer.qic ?? 0;
      if (cred < 2) return false;
      if (ore >= 2 && qic >= Math.max(0, mineBuildCost.qicCost - 1)) return true;
      if (ore >= 1 && qic >= mineBuildCost.qicCost) return true;
      return false;
    }
    if (mineBuildCost.qicCost > 0 && (currentPlayer.qic ?? 0) < mineBuildCost.qicCost) return false;
    return true;
  }, [selectedTile, currentPlayer, game.currentPhase, game.map, playerId, mineBuildCost]);

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
        className="flex-1 min-w-0 bg-black rounded-lg border border-white/5 overflow-hidden relative"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: isMouseDown ? 'grabbing' : 'grab' }}
      >
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] opacity-20 pointer-events-none" />

        {/* Turn Status Overlay */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center">
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
              {/* 행성 그라디언트 (입체감) */}
              <radialGradient id="planetGradient" cx="35%" cy="35%" r="65%">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.5)" />
                <stop offset="70%" stopColor="rgba(255, 255, 255, 0.1)" />
                <stop offset="100%" stopColor="rgba(0, 0, 0, 0.6)" />
              </radialGradient>
              
              {/* 행성 질감 패턴들 */}
              <pattern id="planetTexture" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.5" fill="rgba(0,0,0,0.1)" />
                <circle cx="6" cy="6" r="0.4" fill="rgba(0,0,0,0.08)" />
                <circle cx="5" cy="2" r="0.3" fill="rgba(255,255,255,0.05)" />
              </pattern>
              
              {/* 가스 행성 효과 (소용돌이) */}
              <pattern id="gasTexture" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
                <path d="M 0 5 Q 5 3, 10 5" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" fill="none" />
                <path d="M 0 7 Q 5 5, 10 7" stroke="rgba(0,0,0,0.1)" strokeWidth="0.4" fill="none" />
              </pattern>
              
              {/* 얼음 행성 크리스탈 패턴 */}
              <pattern id="iceTexture" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
                <line x1="0" y1="3" x2="6" y2="3" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
                <line x1="3" y1="0" x2="3" y2="6" stroke="rgba(255,255,255,0.15)" strokeWidth="0.3" />
                <line x1="1" y1="1" x2="5" y2="5" stroke="rgba(200,230,255,0.1)" strokeWidth="0.2" />
              </pattern>
            </defs>
            <Layout size={{ x: 4.8, y: 4.8 }} flat={false} spacing={1.0} origin={{ x: 0, y: 0 }}>
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
                      fill: SECTOR_COLORS[tile.sector] || '#1a1a1a',
                      stroke: isSelected ? '#00FFFF' : isFederationSelected ? '#0ea5e9' : isEclipseBuildable ? '#22c55e' : isShipActionSelectable ? '#a855f7' : isHighlighted ? '#FFD700' : (tile.type === 'space' || tile.type === 'deep_space' ? '#333' : '#555'),
                      strokeWidth: isSelected ? 0.8 : (isHighlighted || isEclipseBuildable || isShipActionSelectable || isFederationSelected) ? 0.6 : 0.2,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      fillOpacity: isHighlighted || isEclipseBuildable || isShipActionSelectable ? 0.9 : 1.0,
                      filter: isEclipseBuildable ? 'drop-shadow(0px 0px 8px rgba(34, 197, 94, 0.9))' : isShipActionSelectable ? 'drop-shadow(0px 0px 8px rgba(168, 85, 247, 0.9))' : isHighlighted ? 'drop-shadow(0px 0px 8px rgba(255, 215, 0, 0.8))' : 'none',
                    }}
                  >
                    {/* Planet Circle (Round Shape) with Texture */}
                    {tile.type !== 'space' && tile.type !== 'deep_space' && tile.type !== 'lost_fleet_ship' && (
                      <g>
                        {/* Shadow/Glow */}
                        <circle r="3.3" fill="rgba(0,0,0,0.5)" />
                        
                        {/* Base Planet Color */}
                        <circle
                          r="3.0"
                          fill={planetColor}
                          style={{
                            filter: 'drop-shadow(0px 0px 3px rgba(0,0,0,0.7))',
                            opacity: hasStructure ? 0.75 : 1.0
                          }}
                        />
                        
                        {/* Texture Layer (타입별로 다른 텍스처) */}
                        <circle
                          r="3.0"
                          fill={tile.type === 'ice' ? 'url(#iceTexture)' : 
                                tile.type === 'gaia' || tile.type === 'transdim' ? 'url(#gasTexture)' : 
                                'url(#planetTexture)'}
                          style={{ opacity: hasStructure ? 0.3 : 0.5 }}
                        />
                        
                        {/* 3D Shading Effect */}
                        <circle
                          r="3.0"
                          fill="url(#planetGradient)"
                          style={{ opacity: hasStructure ? 0.4 : 0.6 }}
                        />
                        
                        {/* 외곽 테두리 (행성 윤곽 강조) */}
                        <circle
                          r="3.0"
                          fill="none"
                          stroke="rgba(0,0,0,0.3)"
                          strokeWidth="0.15"
                        />
                      </g>
                    )}

                    {(tile.type === 'lost_fleet_ship' || (tile.type && tile.type.startsWith('ship_'))) && renderSpaceship(tile.type)}

                    {/* 가이아 포머 표시 (transdim 또는 성숙 가이아에 설치된 경우) */}
                    {(tile.type === 'transdim' || tile.type === 'gaia') && tile.hasGaiaformer && !hasStructure && (
                      <g transform="translate(0, 1.5)">
                        <circle r="1.2" fill="rgba(34, 197, 94, 0.3)" />
                        <circle r="1" fill="#22c55e" stroke="#16a34a" strokeWidth="0.15" />
                        <text
                          y="0.2"
                          style={{
                            fill: '#fff',
                            fontSize: '1px',
                            fontWeight: 'bold',
                            textAnchor: 'middle',
                            dominantBaseline: 'central',
                            pointerEvents: 'none'
                          }}
                        >
                          GF
                        </text>
                      </g>
                    )}

                    {hasStructure && renderStructure(tile.structure!, structureColor, ownerFaction?.color)}

                    {/* 모웨이드 링: 해당 건물 파워 수신/연방 시 +2 */}
                    {tile.moweyipRing && (
                      <g>
                        <circle r="2.4" fill="none" stroke="#f59e0b" strokeWidth="0.28" opacity="0.95" />
                        <circle r="2.15" fill="none" stroke="rgba(245,158,11,0.5)" strokeWidth="0.15" />
                      </g>
                    )}

                    {/* 란티다 기생 광산: 기존 건물 오른쪽 하단에 작은 광산 아이콘 */}
                    {tile.parasiticMine && (() => {
                      const parasiticOwner = game.players[tile.parasiticMine!.ownerId];
                      const parasiticFac = parasiticOwner?.faction ? FACTIONS.find(f => f.id === parasiticOwner.faction) : null;
                      return (
                        <g transform="translate(1.35, 1.35) scale(0.42)">
                          {renderStructure('mine', parasiticFac?.color ?? '#888')}
                        </g>
                      );
                    })()}

                    {/* 위성 표시 (연방 빈공간 가운데, 여러 플레이어면 첫 번째는 중앙·나머지는 둘러싸 배치) */}
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

                    {/* 하이브 우주정거장 (빈 공간에만, 연방 1파워·거리 기준점) */}
                    {tile.spaceStation && (() => {
                      const ssOwner = game.players[tile.spaceStation!.ownerId];
                      const ssFac = ssOwner?.faction ? FACTIONS.find(f => f.id === ssOwner.faction) : null;
                      return (
                        <g>
                          <circle r="1" fill={ssFac?.color ?? '#888'} stroke="#000" strokeWidth="0.15" opacity="0.95" />
                          <text y="0.25" style={{ fontSize: '0.65px', fill: '#fff', textAnchor: 'middle', dominantBaseline: 'central', fontWeight: 'bold', pointerEvents: 'none' }}>SS</text>
                        </g>
                      );
                    })()}

                    {/* Sector & Coordinate Debug Display */}
                    <text
                      y="3.5"
                      style={{
                        fill: game.isTestMode ? 'rgba(0, 255, 255, 0.9)' : 'rgba(255,255,255,0.4)',
                        fontSize: game.isTestMode ? '1.4px' : '1px',
                        fontWeight: game.isTestMode ? 'bold' : 'normal',
                        textAnchor: 'middle',
                        dominantBaseline: 'central',
                        pointerEvents: 'none',
                        fontFamily: 'monospace'
                      }}
                    >
                      {game.isTestMode
                        ? `${tile.q},${tile.r}`
                        : (tile.type !== 'space' && tile.type !== 'deep_space' ? `S${tile.sector}` : '')}
                    </text>

                  </Hexagon>
                );
              })}
            </Layout>
          </HexGrid>
        </motion.div>

        <div className="absolute top-4 right-4 flex flex-col gap-2 z-10">
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
          >
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>

        <div className="absolute bottom-4 left-4 bg-black/70 backdrop-blur-sm rounded-lg p-3 border border-white/10">
          <p className="text-xs text-muted-foreground">Scroll to zoom | Drag to pan</p>
        </div>
      </div>

      {/* 행성/타일 선택 패널: 절대 위치 오버레이로 맵 영역 크기에 영향 없음 */}
      {selectedTile && (
        <div className="absolute top-0 right-0 bottom-0 w-64 bg-card border-l border-border p-4 space-y-4 shadow-xl z-10 overflow-y-auto">
          <h3 className="font-semibold capitalize">
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
          {game.currentPhase === 'main' && selectedTile.type?.startsWith('ship_') && onEnterSpaceship && currentPlayer && playerId && game.spaceships?.[selectedTile.id] && (
            (() => {
              const ship = game.spaceships[selectedTile.id];
              const isMyTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
              const enteredCount = currentPlayer.spaceshipsEntered?.length ?? 0;
              const alreadyEntered = currentPlayer.spaceshipsEntered?.includes(selectedTile.id);
              const canEnter = isMyTurn && enteredCount < 3 && !alreadyEntered;
              const isLocked = !ship.unlocked;
              const needVP = isLocked && (currentPlayer.score ?? 0) < 5;
              const isItarsOrNevlas = currentPlayer.faction === 'itars' || currentPlayer.faction === 'nevlas';
              const totalPower = (currentPlayer.power1 ?? 0) + (currentPlayer.power2 ?? 0) + (currentPlayer.power3 ?? 0);
              const needToken = isItarsOrNevlas && totalPower < 1;
              const baseRange = getEffectiveBaseRange(currentPlayer);
              // 거리 출발점: 내 건물 + 내 우주정거장 (서버와 동일)
              const rangeTiles = game.map.filter((t: HexTile) =>
                (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId
              );
              const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map((t: HexTile) => getDistance(t, selectedTile))) : Infinity;
              const neededQIC = minDist !== Infinity && minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
              const canReach = minDist === Infinity || minDist <= baseRange + ((currentPlayer.qic ?? 0) * 2);
              const qicOk = neededQIC <= (currentPlayer.qic ?? 0);
              if (!canEnter) return null;
              const shipName = SHIP_NAMES[selectedTile.type] || selectedTile.type;
              return (
                <div className="space-y-2 p-2 bg-zinc-900/60 rounded-lg border border-white/10">
                  <p className="text-xs font-semibold text-white">{shipName} 입장</p>
                  <p className="text-xs text-zinc-300">{isLocked ? '5 VP로 입장' : '입장'}{isItarsOrNevlas && ' · 1 토큰 (1→2→3그릇)'}</p>
                  {minDist !== Infinity && (
                    <p className="text-xs text-muted-foreground">
                      거리: {minDist} | 기본 범위: {baseRange}
                      {neededQIC > 0 && (
                        <span className="text-yellow-400"> | 필요 QIC: {neededQIC}</span>
                      )}
                    </p>
                  )}
                  {!canReach && <p className="text-xs text-red-400">거리가 너무 멉니다</p>}
                  {canReach && needVP && <p className="text-xs text-amber-400">잠긴 우주선: 5 VP 필요</p>}
                  {canReach && isItarsOrNevlas && needToken && <p className="text-xs text-amber-400">입장 비용: 파워 토큰 1개 필요 (1/2/3그릇 순)</p>}
                  <Button
                    className="w-full text-xs"
                    size="sm"
                    disabled={!canReach || needVP || needToken || (neededQIC > 0 && !qicOk)}
                    onClick={() => {
                      onEnterSpaceship(selectedTile.id, false, neededQIC);
                      setSelectedTile(null);
                    }}
                  >
                    입장{neededQIC > 0 ? ` (${neededQIC} QIC)` : ''}{isItarsOrNevlas ? ' (1 토큰)' : ''}
                  </Button>
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
                    // 거리 체크: Nav + Nav보너스 + 트왈라잇/보너스 +3 (서버 place_gaiaformer와 동일)
                    const baseRange = getEffectiveBaseRange(currentPlayer);
                    // 트왈라잇 1K·보너스 타일 +3이 반영되도록 플레이어 객체에서 직접 읽기 (최신 game.players 참조)
                    const playerForRange = playerId ? game.players[playerId] : null;
                    const effectiveBaseRange = playerForRange
                      ? getRange(playerForRange.research?.navigation ?? 0) + (playerForRange.navigationBonus ?? 0) + (playerForRange.tempRangeBonus ? 3 : 0) + (playerForRange.rangeBonusActive ? 3 : 0)
                      : baseRange;
                    const rangeTiles = game.map.filter((t: HexTile) =>
                      (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId
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
                              (game.hasDoneMainAction && game.pendingTFMarsGaiaProject?.playerId !== playerId)
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
                    disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)}
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
          {isEclipseAsteroidMode && onEclipseBuildAsteroidMine && selectedTile.type === 'asteroid' && !selectedTile.structure && eclipseBuildableTileIds.has(selectedTile.id) && (
            <div className="space-y-2">
              <p className="text-xs text-green-400">Eclipse: 소행성 광산 건설 가능</p>
              <Button
                className="w-full bg-primary/20 border-primary text-primary hover:bg-primary/30"
                variant="secondary"
                onClick={() => {
                  onEclipseBuildAsteroidMine(selectedTile.id);
                  setSelectedTile(null);
                }}
                data-testid="button-eclipse-build-asteroid"
              >
                짓기 (6C 지불됨)
              </Button>
            </div>
          )}

          {/* 란티다 기생 광산: 다른 플레이어 건물이 있는 행성에 테라포밍 없이 1O 2C (의회 있으면 +2K, 연방 포함·업그레이드 불가) */}
          {currentPlayer?.faction === 'lantids' && selectedTile.structure != null && selectedTile.ownerId !== playerId && selectedTile.ownerId != null && !selectedTile.parasiticMine && onBuildMine && (() => {
            const playerTiles = game.map.filter((t: HexTile) => (t.ownerId === playerId || t.parasiticMine?.ownerId === playerId) && (t.structure != null || t.parasiticMine));
            const playerForRange = playerId ? game.players[playerId] : null;
            const effectiveBaseRange = playerForRange
              ? getRange(playerForRange.research?.navigation ?? 0) + (playerForRange.navigationBonus ?? 0) + (playerForRange.tempRangeBonus ? 3 : 0) + (playerForRange.rangeBonusActive ? 3 : 0)
              : 0;
            const minDist = playerTiles.length > 0 ? Math.min(...playerTiles.map((t: HexTile) => getDistance(t, selectedTile))) : Infinity;
            const neededQIC = minDist > effectiveBaseRange ? Math.ceil((minDist - effectiveBaseRange) / 2) : 0;
            const canReach = minDist <= effectiveBaseRange + ((currentPlayer?.qic ?? 0) * 2);
            const canAfford = (currentPlayer?.ore ?? 0) >= 1 && (currentPlayer?.credits ?? 0) >= 2 && (currentPlayer?.qic ?? 0) >= neededQIC;
            return (
              <div className="space-y-2 p-2 bg-amber-950/30 rounded-lg border border-amber-500/30">
                <p className="text-xs text-amber-300 font-semibold">란티다 기생 광산</p>
                <p className="text-xs text-muted-foreground">다른 플레이어 건물이 있는 행성에 1O 2C로 건설 (업그레이드 불가, 연방·광산 이벤트 포함)</p>
                {minDist !== Infinity && (
                  <p className="text-xs text-muted-foreground">
                    거리: {minDist} | 기본 범위: {effectiveBaseRange}
                    {neededQIC > 0 && <span className="text-yellow-400"> | 필요 QIC: {neededQIC}</span>}
                  </p>
                )}
                {!canReach && <p className="text-xs text-red-400">거리가 너무 멉니다</p>}
                <Button
                  className="w-full border-amber-500/50 text-amber-200 hover:bg-amber-500/20"
                  variant="secondary"
                  disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !canReach || !canAfford}
                  onClick={() => {
                    onBuildMine(selectedTile.id);
                    setSelectedTile(null);
                  }}
                >
                  Build Parasitic Mine (1 Ore, 2 Credits){neededQIC > 0 ? ` + ${neededQIC} QIC` : ''}
                </Button>
              </div>
            );
          })()}

          {canBuildMine && mineBuildCost && (
            <div className="space-y-2">
              <Button
                className="w-full"
                variant="secondary"
                disabled={game.hasDoneMainAction}
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
                  <>Build Mine (1O, 2C, 1O or 1Q{mineBuildCost.qicCost > 1 ? `, ${mineBuildCost.qicCost - 1} QIC` : ''}) — Gleens +2 VP</>
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
                          Academy (왼쪽) — 수익 2K (6O, 6C) 매안
                        </Button>
                      )}
                      {isBescods && canBuildAcademyRight && (
                        <Button className="w-full" variant="secondary" disabled={game.hasDoneMainAction || (game.turnOrder[game.currentPlayerIndex] !== playerId)} onClick={() => { onUpgrade(selectedTile.id, 'academy_right'); setSelectedTile(null); }}>
                          Academy (오른쪽) — Special 1QIC (6O, 6C) 매안
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
                        Upgrade to PI (4O, 6C) 매안
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
                          Academy (오른쪽) — Special {game.players[playerId]?.faction === 'bal_tak' ? '4C' : '1QIC'} (6O, 6C)
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
      )}
    </div>
  );
}
