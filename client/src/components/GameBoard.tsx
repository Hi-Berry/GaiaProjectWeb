import { useState, useCallback, useRef, useMemo } from 'react';
import { HexGrid, Layout, Hexagon, Text } from 'react-hexgrid';
import { motion } from 'framer-motion';

import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
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
  getGaiaBaseQic
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
        style={{ pointerEvents: 'none' }}
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
      oreCost = 1;
      credits = 2;
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
    // 글린 가이아 비용 체크는 이제 mineBuildCost.oreCost(2 Ore)에 반영되므로 표준 로직을 따름
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
            </defs>
            <g id="sector-backgrounds-layer">
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
                      <circle r="4.8" fill="url(#ts-space)" fillOpacity={0.1} pointerEvents="none" />
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
                      </>
                    )}

                    {/* 가이아 포머 표시 (transdim 또는 성숙 가이아에 설치된 경우) */}
                    {tile.hasGaiaformer && (() => {
                      // ownerId가 있으면 그 플레이어의 색상을, 없으면 로컬 playerId의 색상을 사용 (이전 로직 유지)
                      const gaiaOwnerId = tile.ownerId || playerId;
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
                    {hasStructure && renderStructure(tile.structure!, structureColor, ownerFaction?.color)}

                    {/* 모웨이드 링 */}
                    {tile.moweyipRing && (
                      <g>
                        <circle r="2.4" fill="none" stroke="#f59e0b" strokeWidth="0.28" opacity="0.95" />
                        <circle r="2.15" fill="none" stroke="rgba(245,158,11,0.5)" strokeWidth="0.15" />
                      </g>
                    )}

                    {/* 란티다 기생 광산 */}
                    {tile.parasiticMine && (() => {
                      const parasiticOwner = game.players[tile.parasiticMine!.ownerId];
                      const parasiticFac = parasiticOwner?.faction ? FACTIONS.find(f => f.id === parasiticOwner.faction) : null;
                      return (
                        <g transform="translate(1.35, 1.35) scale(0.42)">
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

                    {/* 하이브 우주정거장 */}
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
      {
        selectedTile && (
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
                    const vpCost = currentPlayer.faction === 'bal_tak' ? 7 : 5;
                    const needVP = isLocked && (currentPlayer.score ?? 0) < vpCost;
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
                        <p className="text-xs text-zinc-300">{isLocked ? `${vpCost} VP로 입장` : '입장'}{isItarsOrNevlas && ' · 1 토큰 (1→2→3그릇)'}</p>
                        {minDist !== Infinity && (
                          <p className="text-xs text-muted-foreground">
                            거리: {minDist} | 기본 범위: {baseRange}
                            {neededQIC > 0 && (
                              <span className="text-yellow-400"> | 필요 QIC: {neededQIC}</span>
                            )}
                          </p>
                        )}
                        {!canReach && <p className="text-xs text-red-400">거리가 너무 멉니다</p>}
                        {canReach && needVP && <p className="text-xs text-amber-400">잠긴 우주선: {vpCost} VP 필요</p>}
                        {canReach && isItarsOrNevlas && needToken && <p className="text-xs text-amber-400">입장 비용: 파워 토큰 1개 필요 (1/2/3그릇 순)</p>}
                        <Button
                          className="w-full text-xs"
                          size="sm"
                          disabled={!canReach || needVP || needToken || (neededQIC > 0 && !qicOk)}
                          onClick={() => {
                            onEnterSpaceship(selectedTile.id, !!currentPlayer.rangeBonusActive, neededQIC);
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
                        disabled={(game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId)) || (game.turnOrder[game.currentPlayerIndex] !== playerId) || !canReach || !canAfford}
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
                      disabled={game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId)}
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
                        <>Build Mine ({mineBuildCost.oreCost} Ore, {mineBuildCost.credits} Credits{mineBuildCost.qicCost > 0 && `, ${mineBuildCost.qicCost} QIC`}) — Gleens +2 VP</>
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
        )
      }
    </div >
  );
}
