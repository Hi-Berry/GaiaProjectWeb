import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import { log } from './index';
import type {
  GaiaGameState,
  PlayerState,
  HexTile,
  StructureType,
  ResearchTrack,
  PowerAction
} from '@shared/gameConfig';
import {
  FACTIONS,
  generateMap,
  INITIAL_POWER_ACTIONS,
  ECONOMY_INCOME,
  ECONOMY_INCOME_POWER,
  ECONOMY_INCOME_VP,
  STRUCTURE_INCOME,
  chargePower,
  chargePowerTaklons,
  canSpendTaklonsPower,
  spendTaklonsPower,
  createInitialPlayerState,
  ALL_TECH_TILES,
  ALL_ADVANCED_TECH_TILES,
  ALL_BONUS_TILES,
  getRange,
  getTerraformCost,
  getTerraformSteps,
  getTerraformStepsForFaction,
  computeExpansionThreeStepPlanets,
  HOME_PLANETS,
  getDistance,
  BonusTile,
  ROUND_MISSION_POOL,
  ScoringTile,
  SHIP_TECH_TILES,
  SHIP_TECH_BY_SHIP,
  FEDERATION_REWARDS,
  FEDERATION_12VP_ID,
  SPACESHIP_FEDERATION_REWARDS,
  getFederationEntries,
  countGreenFederations,
  spendGreenFederation,
  isTechTileCovered,
  ARTIFACTS,
  getNeighbors,
  isEmptyHex,
  isPlanetHex,
  BUILDING_LIMITS,
  FINAL_MISSION_IDS,
  getFinalMissionValue,
  RESEARCH_TRACK_END_BONUS,
  RESEARCH_TRACKS,
  type ScoreBreakdown,
} from '@shared/gameConfig';
import { executeBotTurnIfNeeded } from './botHandler';




// Extend GaiaGameState for server-specific metadata
export interface ServerGameState extends GaiaGameState {
  id: string;
  hostId: string;
  /** 방장 브라우저의 socket.id (한 컴퓨터 4인플 시 조작 전환 후에도 방장이 다시 전환 가능하도록) */
  hostSocketId?: string;
  currentPlayerIndex: number;
  maxPlayers: number;
  createdAt: number;
  /** AI 봇 플레이어 ID 목록 */
  botPlayerIds?: string[];
  turnStartState?: Record<string, any>; // [playerId]: PlayerTurnState
  isBotExecuting?: boolean; // 봇 로직이 실행 중인지 확인하는 락
}



const games = new Map<string, ServerGameState>();
const playerGameMap = new Map<string, string>();
const socketToPlayerMap = new Map<string, string>();

/** 자원 상한: O/K 최대 15, C 최대 30 */
const MAX_ORE = 15;
const MAX_KNOWLEDGE = 15;
const MAX_CREDITS = 30;

function clampPlayerResources(game: GaiaGameState): void {
  for (const p of Object.values(game.players)) {
    if (p.ore != null && p.ore > MAX_ORE) p.ore = MAX_ORE;
    if (p.knowledge != null && p.knowledge > MAX_KNOWLEDGE) p.knowledge = MAX_KNOWLEDGE;
    if (p.credits != null && p.credits > MAX_CREDITS) p.credits = MAX_CREDITS;
  }
}

function ensureScoreBreakdown(player: PlayerState): ScoreBreakdown {
  if (!player.scoreBreakdown) {
    player.scoreBreakdown = {
      roundMissions: [],
      bonusTilePass: [],
      techTiles: [],
      finalMissions: 0,
      powerReceived: 0,
      spaceships: [],
      researchTracks: 0,
      other: [],
    };
  }
  return player.scoreBreakdown;
}

function addScore(game: GaiaGameState, playerId: string, vp: number, category: keyof ScoreBreakdown, detail?: { round?: number; tileId?: string; shipTileId?: string; source?: string }) {
  const player = game.players[playerId];
  if (!player) return;
  ensureScoreBreakdown(player);
  player.score = Math.max(0, player.score + vp);
  const b = player.scoreBreakdown!;
  if (category === 'roundMissions' && detail?.round != null) {
    b.roundMissions.push({ round: detail.round, vp: vp });
  } else if (category === 'bonusTilePass' && detail?.round != null) {
    b.bonusTilePass.push({ round: detail.round, vp: vp });
  } else if (category === 'techTiles' && detail?.tileId) {
    b.techTiles.push({ tileId: detail.tileId, vp: vp });
  } else if (category === 'finalMissions') {
    b.finalMissions += vp;
  } else if (category === 'powerReceived' && vp < 0) {
    b.powerReceived += -vp;
  } else if (category === 'spaceships' && detail?.shipTileId) {
    b.spaceships.push({ shipTileId: detail.shipTileId, vp: vp });
  } else if (category === 'researchTracks') {
    b.researchTracks += vp;
  } else if (category === 'other' && detail?.source) {
    b.other.push({ source: detail.source, vp: vp });
  }
}

/** 플레이어가 입장한 우주선들의 전용 기술 타일 ID 목록 (이미 보유한 타일 제외). 게임마다 shipTechByShip 랜덤 배정 사용 */
function getShipTechTileIdsForPlayer(game: ServerGameState, playerId: string): string[] {
  const ids: string[] = [];
  const entered = game.players[playerId]?.spaceshipsEntered ?? [];
  const owned = game.players[playerId]?.techTiles ?? [];
  const byShip = game.shipTechByShip ?? SHIP_TECH_BY_SHIP;
  for (const tileId of entered) {
    const tile = game.map.find(t => t.id === tileId);
    if (tile?.type && byShip[tile.type]) {
      const techId = byShip[tile.type];
      if (!ids.includes(techId) && !owned.includes(techId)) ids.push(techId);
    }
  }
  return ids;
}

// 파워 교환 헬퍼 함수들
function getStructurePowerValue(structure: StructureType, hasBigBuildingTechTile: boolean): number {
  if (!structure) return 0;
  switch (structure) {
    case 'planetary_institute':
    case 'academy':
      return hasBigBuildingTechTile ? 4 : 3;
    case 'trading_station':
    case 'research_lab':
      return 2;
    case 'mine':
      return 1;
    default:
      return 0;
  }
}

function findNearbyPlayersForPower(game: ServerGameState, tile: HexTile, sourcePlayerId: string): Array<{ playerId: string; maxPower: number; tileId: string }> {
  const result: Array<{ playerId: string; maxPower: number; tileId: string }> = [];
  const processedPlayers = new Set<string>();

  // 2칸 이내의 다른 플레이어 건물 찾기
  for (const otherTile of game.map) {
    if (!otherTile.structure || otherTile.structure === 'ship') continue;
    if (otherTile.ownerId === sourcePlayerId || !otherTile.ownerId) continue;

    const distance = getDistance(tile, otherTile);
    if (distance > 2) continue;

    const targetPlayerId = otherTile.ownerId;

    // 이미 처리한 플레이어는 최대값만 업데이트
    const hasBigBuildingTechTile = game.players[targetPlayerId]?.techTiles?.includes('tech-big-4str') || false;
    let powerValue = getStructurePowerValue(otherTile.structure, hasBigBuildingTechTile);
    // 매안(Bescods) 의회 보유 시 모행성(titanium) 건물은 파워 +1
    const targetPlayer = game.players[targetPlayerId];
    const bescodsHasPI = targetPlayer?.faction === 'bescods' && game.map.some(t => t.ownerId === targetPlayerId && t.structure === 'planetary_institute');
    if (bescodsHasPI && otherTile.type === 'titanium') powerValue += 1;
    // 모웨이드 의회: 링이 놓인 건물은 파워 수신 시 +2
    if (targetPlayer?.faction === 'moweyip' && otherTile.moweyipRing) powerValue += 2;

    if (processedPlayers.has(targetPlayerId)) {
      const existing = result.find(r => r.playerId === targetPlayerId);
      if (existing && powerValue > existing.maxPower) {
        existing.maxPower = powerValue;
        existing.tileId = otherTile.id;
      }
    } else {
      processedPlayers.add(targetPlayerId);
      result.push({ playerId: targetPlayerId, maxPower: powerValue, tileId: otherTile.id });
    }
  }

  return result;
}

export function hasNearbyPlayersForDiscount(game: ServerGameState, tile: HexTile, sourcePlayerId: string): boolean {
  return findNearbyPlayersForPower(game, tile, sourcePlayerId).length > 0;
}

/** 파워 수익: 새 토큰 추가 없음. amount만큼 1→2로 옮기고, 남은 양만큼 2→3으로 옮김. 그래도 남으면 소멸(3그릇에 넣지 않음) */
function applyPowerIncome(player: PlayerState, amount: number): void {
  let rem = amount;
  const from1 = Math.min(rem, player.power1 || 0);
  player.power1 = (player.power1 || 0) - from1;
  player.power2 = (player.power2 || 0) + from1;
  rem -= from1;
  const from2 = Math.min(rem, player.power2 || 0);
  player.power2 = (player.power2 || 0) - from2;
  player.power3 = (player.power3 || 0) + from2;
  /* rem - from2 는 소멸 (추가하지 않음) */
}

/** 파워 토큰 소비: 1그릇 → 2그릇 → 3그릇 순. 성공 시 true */
function spendPowerTokens(player: PlayerState, amount: number): boolean {
  const total = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
  if (total < amount) return false;
  let remaining = amount;
  const from1 = Math.min(remaining, player.power1 || 0);
  player.power1 = (player.power1 || 0) - from1;
  remaining -= from1;
  const from2 = Math.min(remaining, player.power2 || 0);
  player.power2 = (player.power2 || 0) - from2;
  remaining -= from2;
  const from3 = Math.min(remaining, player.power3 || 0);
  player.power3 = (player.power3 || 0) - from3;
  return true;
}

/** 플레이어 광산 수 (오레 수익용: 일반 광산 + 기생 + 가상만, 잊혀진 행성 제외) */
function getEffectiveMineCount(game: GaiaGameState, playerId: string): number {
  const player = game.players[playerId];
  let n = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine').length;
  n += game.map.filter(t => t.parasiticMine?.ownerId === playerId).length;
  if (player?.virtualMineAsteroid) n += 1;
  if (player?.virtualMineProto) n += 1;
  return n;
}

/** 패스/보너스/기술타일용 광산 수 (잊혀진 행성 포함) */
function getMineCountForPassAndBonuses(game: GaiaGameState, playerId: string): number {
  let n = getEffectiveMineCount(game, playerId);
  n += game.map.filter(t => t.ownerId === playerId && t.structure === 'lost_planet_mine').length;
  return n;
}

/** 기오덴 의회 보너스(새 행성 유형당 3K)용: 플레이어가 보유한 행성 유형 집합 (맵 건물·기생·잊혀진 행성·가상 광산 포함) */
function getPlayerPlanetTypesForGeodens(game: GaiaGameState, playerId: string): Set<string> {
  const types = new Set<string>();
  for (const t of game.map) {
    if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
      if (t.structure === 'lost_planet_mine') types.add('lost_planet');
      else if (t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
    }
    if (t.parasiticMine?.ownerId === playerId && t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
  }
  const player = game.players[playerId];
  if (player?.virtualMineAsteroid) types.add('asteroid');
  if (player?.virtualMineProto) types.add('proto');
  return types;
}

/** 기오덴: 의회 보유 시 새 행성 유형을 얻은 경우 +3K (build_mine / place_lost_planet / 인공물 소행성·원시행성 직후 호출) */
function applyGeodensNewPlanetTypeBonus(game: GaiaGameState, playerId: string, typesBefore: Set<string>) {
  const player = game.players[playerId];
  if (player?.faction !== 'geodens') return;
  const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
  if (!hasPI) return;
  const typesAfter = getPlayerPlanetTypesForGeodens(game, playerId);
  if (typesAfter.size <= typesBefore.size) return;
  player.knowledge = (player.knowledge || 0) + 3;
  addGameLog(game, playerId, 'Geodens Council', '+3 Knowledge (new planet type)', '');
  log(`Player ${player.name} (Geodens) gained 3 Knowledge from new planet type (Council)`, 'game');
}

/** 발타크: 의회(PI)가 있을 때만 Nav 트랙 진행 가능 (없으면 Nav+1 타일·3거리 보너스·QIC 임시 거리 등은 가능) */
function canBalTakAdvanceNavigation(game: GaiaGameState, playerId: string): boolean {
  const player = game.players[playerId];
  if (player?.faction !== 'bal_tak') return true;
  return game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
}

/** 사용 가능한 가이아 포머 수 (발타크: QIC 전환으로 잠긴 포머 제외, 다음 라운드에 복귀) */
function getEffectiveGaiaformers(player: PlayerState): number {
  const total = player.gaiaformers ?? 0;
  if (player.faction !== 'bal_tak') return total;
  const locked = player.balTakGaiaformersUsedForQic ?? 0;
  return Math.max(0, total - locked);
}

/** 플레이어 건물 개수 (맵만, 기생/가상 제외). 아카데미는 academyType 별도. */
function getStructureCount(game: GaiaGameState, playerId: string, structure: 'planetary_institute' | 'trading_station' | 'research_lab' | 'mine'): number {
  if (structure === 'mine') {
    return game.map.filter(t => t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine')).length
      + game.map.filter(t => t.parasiticMine?.ownerId === playerId).length
      + (game.players[playerId]?.virtualMineAsteroid ? 1 : 0)
      + (game.players[playerId]?.virtualMineProto ? 1 : 0);
  }
  return game.map.filter(t => t.ownerId === playerId && t.structure === structure).length;
}

function getAcademyLeftCount(game: GaiaGameState, playerId: string): number {
  return game.map.filter(t => t.ownerId === playerId && t.structure === 'academy' && (t.academyType === 'left' || t.academyType == null)).length;
}

function getAcademyRightCount(game: GaiaGameState, playerId: string): number {
  return game.map.filter(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right').length;
}

/** 글린: 오른쪽 아카데미 없으면 QIC 획득 시 전부 광물로 변환. 그 외 종족은 QIC 그대로 */
function grantQic(game: GaiaGameState, playerId: string, amount: number): void {
  if (amount <= 0) return;
  const player = game.players[playerId];
  if (!player) return;
  const gleensNoRightAcademy = player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1;
  if (gleensNoRightAcademy) {
    player.ore = (player.ore ?? 0) + amount;
  } else {
    player.qic = (player.qic ?? 0) + amount;
  }
}

/** 거리 계산용: 내 건물 + 내 우주정거장이 있는 타일 (하이브 우주정거장도 기준점) */
function getPlayerRangeTiles(game: ServerGameState, playerId: string, excludeShip?: boolean): HexTile[] {
  return game.map.filter(t => {
    if (t.ownerId === playerId && t.structure !== null && (excludeShip !== true || t.structure !== 'ship'))
      return true;
    if (t.spaceStation?.ownerId === playerId) return true;
    return false;
  });
}

/** 연방: 행성 타일 ID 집합에 있는 해당 플레이어 건물의 파워 합 (광산=1, TS/연구소=2, 아카데미/의회=3, 큰건물기술타일 있으면 4). 란티다 기생 광산=1. 위성=0, 우주정거장=1(selectedEmptyHexIds에 있는 타일만) */
function getFederationBuildingPower(
  game: ServerGameState,
  playerId: string,
  planetTileIds: Set<string>,
  selectedEmptyHexIds?: string[]
): number {
  const hasBig = game.players[playerId]?.techTiles?.includes('tech-big-4str') ?? false;
  let sum = 0;
  const player = game.players[playerId];
  const bescodsHasPI = player?.faction === 'bescods' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
  planetTileIds.forEach((tileId) => {
    const tile = game.map.find(t => t.id === tileId);
    if (!tile) return;
    if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') {
      sum += getStructurePowerValue(tile.structure, hasBig);
      if (bescodsHasPI && tile.type === 'titanium') sum += 1; // 매안(Bescods) 의회: 모행성(titanium) 건물 +1
      if (player?.faction === 'moweyip' && tile.moweyipRing) sum += 2; // 모웨이드 의회: 링 건물 연방 시 +2
    }
    if (tile.parasiticMine?.ownerId === playerId)
      sum += 1; // 기생 광산 = 1
  });
  // 하이브: 선택된 빈공간 중 내 우주정거장이 있으면 1파워씩 (위성은 0)
  if (selectedEmptyHexIds?.length) {
    for (const hexId of selectedEmptyHexIds) {
      const tile = game.map.find(t => t.id === hexId);
      if (tile?.spaceStation?.ownerId === playerId) sum += 1;
    }
  }
  return sum;
}

/** 행성만으로 연결된 컴포넌트 (해당 행성 타일 ID 포함, 인접 행성만 BFS) */
function getPlanetConnectedComponent(game: ServerGameState, startTileId: string): Set<string> {
  const start = game.map.find(t => t.id === startTileId);
  if (!start || !isPlanetHex(start)) return new Set();
  const component = new Set<string>();
  const queue: string[] = [startTileId];
  component.add(startTileId);
  while (queue.length > 0) {
    const tid = queue.shift()!;
    const tile = game.map.find(t => t.id === tid)!;
    const neighbors = getNeighbors(game.map, tile);
    for (const n of neighbors) {
      if (!isPlanetHex(n)) continue;
      if (component.has(n.id)) continue;
      component.add(n.id);
      queue.push(n.id);
    }
  }
  return component;
}

/** 선택된 빈공간들 + 인접 행성들(및 행성끼리 연결된 전체) → 연방에 포함된 행성 타일 ID 집합. 건물끼리 붙어 있으면 한 연방에 같이 포함 */
function getFederationPlanetIdsFromSelectedEmpties(game: ServerGameState, selectedHexIds: string[]): Set<string> {
  const planetIds = new Set<string>();
  for (const hexId of selectedHexIds) {
    const tile = game.map.find(t => t.id === hexId);
    if (!tile || !isEmptyHex(tile)) continue;
    const neighbors = getNeighbors(game.map, tile);
    for (const n of neighbors) {
      if (isPlanetHex(n)) {
        // 인접 행성뿐 아니라, 그 행성과 행성끼리 연결된 전체 컴포넌트 포함
        const component = getPlanetConnectedComponent(game, n.id);
        component.forEach(id => planetIds.add(id));
      }
    }
  }
  return planetIds;
}

/** 연방 1회당 필요 파워. 제노스는 의회 보유 시 6, 그 외 7 */
function getFederationRequiredPower(game: ServerGameState, playerId: string): number {
  const player = game.players[playerId];
  const n = getFederationEntries(player).length + 1;
  const hasPI = player && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
  const powerPerFed = (player?.faction === 'xenos' && hasPI) ? 6 : 7;
  return powerPerFed * n;
}

const STRUCTURE_LABELS: Record<string, string> = {
  planetary_institute: '의회',
  academy: '아카데미',
  trading_station: '교역소',
  research_lab: '연구소',
  mine: '광산',
};

/** 연방 모드 선택 기준으로 포함될 건물·파워 미리보기 계산 */
function computeFederationPreview(game: ServerGameState, playerId: string): { power: number; requiredPower: number; items: Array<{ tileId: string; label: string; power: number }> } | null {
  const mode = game.federationMode;
  if (!mode || mode.playerId !== playerId) return null;
  const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
  const selectedHexIds = mode.selectedHexIds ?? [];
  const selectedPlanetIds = mode.selectedPlanetIds ?? [];
  const selectedSpaceStationHexIds = mode.selectedSpaceStationHexIds ?? [];
  const planetIds = new Set<string>(getFederationPlanetIdsFromSelectedEmpties(game, selectedHexIds));
  selectedPlanetIds.forEach(id => {
    const component = getPlanetConnectedComponent(game, id);
    component.forEach(pid => planetIds.add(pid));
  });
  const allHexIds = [...fedHexes, ...selectedHexIds, ...selectedSpaceStationHexIds];
  const power = getFederationBuildingPower(game, playerId, planetIds, allHexIds);
  const requiredPower = getFederationRequiredPower(game, playerId);
  const hasBig = game.players[playerId]?.techTiles?.includes('tech-big-4str') ?? false;
  const items: Array<{ tileId: string; label: string; power: number }> = [];
  planetIds.forEach(tileId => {
    const t = game.map.find(x => x.id === tileId);
    if (!t || t.ownerId !== playerId) return;
    if (t.structure && t.structure !== 'ship') {
      const p = getStructurePowerValue(t.structure, hasBig);
      items.push({ tileId, label: STRUCTURE_LABELS[t.structure] ?? t.structure, power: p });
    }
    if (t.parasiticMine?.ownerId === playerId) items.push({ tileId, label: '기생광산', power: 1 });
  });
  for (const hexId of selectedSpaceStationHexIds) {
    const t = game.map.find(x => x.id === hexId);
    if (t?.spaceStation?.ownerId === playerId) items.push({ tileId: hexId, label: '우주정거장', power: 1 });
  }
  return { power, requiredPower, items };
}

/** 특정 연방 보상 ID가 이미 누군가에게 획득되었는지 */
function isSpaceshipFederationRewardTaken(game: GaiaGameState, rewardId: string): boolean {
  for (const p of Object.values(game.players)) {
    const entries = getFederationEntries(p);
    if (entries.some(e => e.rewardId === rewardId)) return true;
  }
  return false;
}

function createPowerOffers(game: ServerGameState, tile: HexTile, sourcePlayerId: string): void {
  const nearbyPlayers = findNearbyPlayersForPower(game, tile, sourcePlayerId);
  if (!game.pendingPowerOffers) game.pendingPowerOffers = [];

  const sourcePlayer = game.players[sourcePlayerId];
  for (const { playerId, maxPower, tileId } of nearbyPlayers) {
    const targetPlayer = game.players[playerId];
    const maxAffordable = Math.min(maxPower, targetPlayer.score + 1);
    const vpCost = maxAffordable - 1;
    // 이타르·타클론 제외: 1파워는 묻지 않고 자동 수락 (단, 소스 건물의 파워가 1보다 크면 오해 방지를 위해 오퍼 띄움)
    // maxAffordable === 1 이라도 maxPower > 1 이면 (VP 부족 등으로 깎인 경우) 사용자 확인 필요
    const autoAcceptOne = maxAffordable === 1 && maxPower === 1 && targetPlayer.faction !== 'itars' && targetPlayer.faction !== 'taklons';
    if (autoAcceptOne) {
      addScore(game, playerId, -vpCost, 'powerReceived');
      chargePower(targetPlayer, 1);
      addGameLog(game, playerId, 'Received Power', `+1P from ${sourcePlayer?.name} (auto)`, tileId);
      continue;
    }
    // Bot Auto-Accept Logic: If target is a bot, handle immediately without UI
    if (game.botPlayerIds?.includes(playerId)) {
      // Simple Bot Logic: Always accept if VP cost is low enough (e.g. < 2 or based on strategy)
      // For now, mirroring user request: "Auto accept internally"
      // But we should probably only accept if it makes sense. 
      // User said "Auto accept", so let's default to accepting.
      // However, converting VP to Power is not always good. 
      // Let's assume standard bot behavior: Accept if VP cost <= 1 or Power gained >= 2 ??
      // Actually, user wants it "Internal". Let's just auto-accept for now to verify the flow.

      const shouldAccept = true; // Bot strategy can be refined later
      if (shouldAccept) {
        addScore(game, playerId, -vpCost, 'powerReceived');
        chargePower(targetPlayer, maxAffordable);
        addGameLog(game, playerId, 'Received Power (Bot)', `+${maxAffordable}P from ${sourcePlayer?.name}`, tileId);
      } else {
        // Log decline
      }
      continue;
    }

    game.pendingPowerOffers.push({
      id: `${Date.now()}_${playerId}_${Math.random()}`,
      targetPlayerId: playerId,
      sourcePlayerId,
      amount: maxAffordable,
      vpCost,
      tileId,
      responded: false
    });
  }
}

/** 맵 위 모든 건물에 대해 인접 플레이어에게 파워 제안 생성 (설정 종료 후 첫 수익 단계 등). 란티다 기생 광산도 포함 */
function createPowerOffersForAllStructures(game: ServerGameState): void {
  for (const tile of game.map) {
    if (tile.structure != null && tile.ownerId) {
      createPowerOffers(game, tile, tile.ownerId);
    }
    if (tile.parasiticMine?.ownerId) {
      createPowerOffers(game, tile, tile.parasiticMine.ownerId);
    }
  }
}

function generateGameId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function generatePlayerId(): string {
  return 'p_' + Math.random().toString(36).substring(2, 12);
}

/** 룰: 턴 순서(하이브·확장4 제외) 1개씩 → 역순 1개씩 → 제노스 1개 → 확장 4종족 각 1개 → 하이브 의회 */
function buildStartingMineSequence(game: GaiaGameState): string[] {
  const turnOrder = game.turnOrder ?? Object.keys(game.players);
  const basePlayers: string[] = [];
  const xenosPlayer: string | null = turnOrder.find(pid => game.players[pid]?.faction === 'xenos') ?? null;
  const expansionPlayers: string[] = [];
  const ivitsPlayer: string | null = turnOrder.find(pid => game.players[pid]?.faction === 'ivits') ?? null;

  for (const pid of turnOrder) {
    const pFaction = FACTIONS.find(f => f.id === game.players[pid]?.faction);
    const pMaxMines = pFaction?.startingMines ?? 2;
    if (pFaction?.id === 'ivits') continue;
    if (pFaction?.id === 'xenos') {
      basePlayers.push(pid);
    } else if (pMaxMines === 1) {
      expansionPlayers.push(pid);
    } else {
      basePlayers.push(pid);
    }
  }
  const out: string[] = [];
  for (const pid of basePlayers) out.push(pid);
  for (let i = basePlayers.length - 1; i >= 0; i--) out.push(basePlayers[i]);
  if (xenosPlayer) out.push(xenosPlayer);
  for (const pid of expansionPlayers) out.push(pid);
  if (ivitsPlayer) out.push(ivitsPlayer);
  return out;
}

// Helper functions moved to top level
export function addGameLog(game: GaiaGameState, playerId: string, action: string, details?: string, tileId?: string) {
  if (!game.gameLog) {
    game.gameLog = [];
  }
  const player = game.players[playerId];
  if (player) {
    game.gameLog.push({
      timestamp: Date.now(),
      playerId,
      playerName: player.name,
      action,
      details,
      tileId,
    });
    if (game.gameLog.length > 100) {
      game.gameLog.shift();
    }
  }
}

export function applyRoundMissionScore(game: GaiaGameState, playerId: string, triggerType: string) {
  const currentRoundIndex = game.roundNumber - 1;
  if (currentRoundIndex < 0 || currentRoundIndex >= game.roundScoringTiles.length) return;

  const currentRoundMission = game.roundScoringTiles[currentRoundIndex];
  if (!currentRoundMission || currentRoundMission.triggerType !== triggerType) return;

  const player = game.players[playerId];
  if (!player) return;

  const vpGain = currentRoundMission.vp;
  addScore(game, playerId, vpGain, 'roundMissions', { round: game.roundNumber });
  log(`Player ${player.name} gained ${vpGain} VP from Round ${game.roundNumber} mission: ${currentRoundMission.condition}`, 'game');
  addGameLog(game, playerId, 'Round Mission Score', `+${vpGain} VP (${currentRoundMission.condition})`);
}

export function applyFinalMissionScoring(game: GaiaGameState) {
  if (game.finalMissionScoresApplied || !game.finalMissionIds?.length) return;
  const missionIds = game.finalMissionIds;
  const POINTS = [18, 12, 6];

  for (const missionId of missionIds) {
    const values = game.turnOrder.map(pid => ({ playerId: pid, value: getFinalMissionValue(game, pid, missionId) }));
    const withValue = values.filter(v => v.value > 0).sort((a, b) => b.value - a.value);
    if (withValue.length === 0) continue;

    let placeIndex = 0;
    while (placeIndex < withValue.length) {
      const group: typeof withValue = [];
      const firstVal = withValue[placeIndex].value;
      const startPlace = placeIndex;
      while (placeIndex < withValue.length && withValue[placeIndex].value === firstVal) {
        group.push(withValue[placeIndex]);
        placeIndex++;
      }
      const pool = group.reduce((sum, _, i) => sum + (POINTS[startPlace + i] ?? 0), 0);
      const pointsEach = group.length > 0 ? Math.floor((pool * 10) / group.length) / 10 : 0;
      for (const { playerId } of group) {
        const p = game.players[playerId];
        if (p) {
          addScore(game, playerId, pointsEach, 'finalMissions');
          addGameLog(game, playerId, 'Final Mission', `+${pointsEach} VP (${missionId})`);
        }
      }
    }
  }
  game.finalMissionScoresApplied = true;
}

export function qualifiesForNewSectorRoundMission(game: GaiaGameState, playerId: string, tileId: string, sector?: number): boolean {
  const tile = game.map.find(t => t.id === tileId || String(t.id) === tileId);
  if (!tile) return false;
  const sec = sector ?? tile.sector;
  if (sec == null || sec === undefined) return false;
  const hadStructureInThisSector = game.map.some(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === sec);
  const isNewSector = !hadStructureInThisSector;
  const isBridgeSector = sec >= 11 && sec <= 18;
  return isNewSector || isBridgeSector;
}

export function applyAdvancedTechTileEffect(game: GaiaGameState, playerId: string, actionType: 'build_mine' | 'build_ts' | 'research' | 'terraform' | 'qic_action') {
  const player = game.players[playerId];
  if (!player || !player.techTiles) return;

  for (const tileId of player.techTiles) {
    if (actionType === 'build_mine' && tileId === 'adv-vp-build-mine') {
      addScore(game, playerId, 3, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Bonus', '+3 VP (Mine built)');
    }
    else if (actionType === 'build_ts' && tileId === 'adv-vp-build-ts') {
      addScore(game, playerId, 3, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Bonus', '+3 VP (TS built)');
    }
    else if (actionType === 'research' && tileId === 'adv-vp-research') {
      addScore(game, playerId, 2, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Bonus', '+2 VP (Research advanced)');
    }
    else if (actionType === 'terraform' && tileId === 'adv-vp-terraform') {
      addScore(game, playerId, 2, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Bonus', '+2 VP (Terraform step)');
    }
    else if (actionType === 'qic_action' && tileId === 'adv-vp-qic-action') {
      addScore(game, playerId, 4, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Bonus', '+4 VP (QIC action)');
    }
  }
}

export function applyAdvancedTechTilePassEffect(game: GaiaGameState, playerId: string) {
  const player = game.players[playerId];
  if (!player || !player.techTiles) return;

  for (const tileId of player.techTiles) {
    if (tileId === 'adv-pass-1vp-type') {
      const planetTypes = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.type !== 'space').map(t => t.type));
      const vp = planetTypes.size;
      addScore(game, playerId, vp, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (1 per planet type)`);
    }
    else if (tileId === 'adv-pass-3vp-lab') {
      const labCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
      const vp = labCount * 3;
      addScore(game, playerId, vp, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (3 per lab)`);
    }
    else if (tileId === 'adv-pass-3vp-fed') {
      const fedCount = getFederationEntries(player).length;
      const vp = fedCount * 3;
      addScore(game, playerId, vp, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (3 per federation)`);
    }
    else if (tileId === 'adv-pass-2vp-asteroid') {
      const asteroidCount = game.map.filter(t => t.ownerId === playerId && t.type === 'asteroid').length;
      const vp = asteroidCount * 2;
      addScore(game, playerId, vp, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (2 per asteroid)`);
    }
    else if (tileId === 'adv-pass-2vp-outer') {
      const outerCount = game.map.filter(t => t.ownerId === playerId && t.structure && t.sector >= 20 && t.sector < 30).length;
      const vp = outerCount * 2;
      addScore(game, playerId, vp, 'techTiles', { tileId });
      addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (2 per outer sector)`);
    }
  }
}

// 트랙 레벨 상승 시 즉시 보너스를 주는 공통 함수 (playerId는 grantQic용)
export function applyTrackLevelBonus(game: GaiaGameState, playerId: string, player: PlayerState, track: ResearchTrack, newLevel: number) {
  // 레벨 3에서 공통 보너스: 파워 3 충전
  if (newLevel === 3) {
    if (player.faction === 'taklons') chargePowerTaklons(player, 3, true);
    else chargePower(player, 3);
    log(`Player ${player.name} gained 3 power from reaching level 3 in ${track}`, 'game');
  }

  // Navigation 트랙 보너스
  if (track === 'navigation') {
    if (newLevel === 1 || newLevel === 3) {
      grantQic(game, playerId, 1);
      const isGleensOre = player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1;
      log(`Player ${player.name} gained 1 ${isGleensOre ? 'Ore (Gleens)' : 'QIC'} from Navigation level ${newLevel}`, 'game');
    }
    if (newLevel === 5) {
      game.pendingLostPlanet = { playerId };
      log(`Player ${player.name} reached Navigation 5: Lost Planet placement pending`, 'game');
    }
  }

  // Artificial Intelligence 트랙 보너스
  if (track === 'artificialIntelligence') {
    if (newLevel === 1) {
      grantQic(game, playerId, 1);
      log(`Player ${player.name} gained 1 QIC from AI level 1`, 'game');
    } else if (newLevel === 2) {
      grantQic(game, playerId, 1);
      log(`Player ${player.name} gained 1 QIC from AI level 2`, 'game');
    } else if (newLevel === 3) {
      grantQic(game, playerId, 2);
      log(`Player ${player.name} gained 2 QIC from AI level 3`, 'game');
    } else if (newLevel === 4) {
      grantQic(game, playerId, 2);
      log(`Player ${player.name} gained 2 QIC from AI level 4`, 'game');
    } else if (newLevel === 5) {
      grantQic(game, playerId, 4);
      log(`Player ${player.name} gained 4 QIC from AI level 5`, 'game');
    }
  }

  // Terraforming 트랙 보너스
  if (track === 'terraforming') {
    if (newLevel === 1 || newLevel === 4) {
      player.ore += 2;
      log(`Player ${player.name} gained 2 Ore from Terraforming level ${newLevel}`, 'game');
    }
    if (newLevel === 5) {
      const rewardId = game.federationOnTerraforming5;
      if (!game.federationPool) {
        game.federationPool = {};
        FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
      }
      const pool = game.federationPool;
      if (rewardId && pool[rewardId] != null && pool[rewardId] > 0) {
        const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
        if (reward) {
          const playerId = Object.keys(game.players).find(id => game.players[id] === player);
          if (playerId) {
            player.score += reward.vp;
            if ('ore' in reward && reward.ore) player.ore += reward.ore;
            if ('credits' in reward && reward.credits) player.credits += reward.credits;
            if ('knowledge' in reward && reward.knowledge) player.knowledge += reward.knowledge;
            if ('qic' in reward && reward.qic) grantQic(game, playerId, reward.qic);
            if ('powerTokens' in reward && reward.powerTokens) player.power1 = (player.power1 || 0) + reward.powerTokens;
            if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
              player.federations = getFederationEntries(player);
            }
            player.federations.push({ rewardId, isGreen: rewardId !== FEDERATION_12VP_ID });
            pool[rewardId] -= 1;
            addGameLog(game, playerId, 'Terraforming 5', `연방 보상 획득: ${reward.label}`);
            log(`Player ${player.name} gained federation reward from Terraforming 5: ${reward.label}`, 'game');
          }
        }
      }
    }
  }

  // Gaia Project 트랙 보너스
  if (track === 'gaiaProject') {
    if (newLevel === 1) {
      // 1단계: 가이아포머 1개
      player.gaiaformers = (player.gaiaformers || 0) + 1;
      log(`Player ${player.name} gained 1 Gaiaformer from Gaia Project level 1 (Total: ${player.gaiaformers})`, 'game');
    } else if (newLevel === 2) {
      // 2단계: 1단계 토큰 3개 (power1에 3개 추가)
      player.power1 = (player.power1 || 0) + 3;
      log(`Player ${player.name} gained 3 power tokens from Gaia Project level 2`, 'game');
    } else if (newLevel === 3) {
      // 3단계: 포머 2개
      player.gaiaformers = (player.gaiaformers || 0) + 1;
      log(`Player ${player.name} gained 1 Gaiaformers from Gaia Project level 3 (Total: ${player.gaiaformers})`, 'game');
    } else if (newLevel === 4) {
      // 4단계: 포머 3개
      player.gaiaformers = (player.gaiaformers || 0) + 1;
      log(`Player ${player.name} gained 1 Gaiaformers from Gaia Project level 4 (Total: ${player.gaiaformers})`, 'game');
    } else if (newLevel === 5) {
      // 5단계: 4점 + 가이아 행성만큼 점수
      const playerId = Object.keys(game.players).find(id => game.players[id] === player);
      if (playerId) {
        const playerStructures = game.map.filter(t => t.ownerId === playerId);
        const gaiaPlanets = playerStructures.filter(t => t.type === 'gaia').length;
        const vpGain = 4 + gaiaPlanets;
        player.score += vpGain;
        log(`Player ${player.name} gained ${vpGain} VP from Gaia Project level 5 (4 base + ${gaiaPlanets} Gaia planets)`, 'game');
      }
    }
  }

  // Economy 트랙 보너스 (레벨 5)
  if (track === 'economy' && newLevel === 5) {
    player.ore += 3;
    player.credits += 6;
    if (player.faction === 'taklons') chargePowerTaklons(player, 6, true);
    else chargePower(player, 6);
    log(`Player ${player.name} gained 3 Ore, 6 Credits, and 6 Power from Economy level 5`, 'game');
  }

  // Science 트랙 보너스 (레벨 5)
  if (track === 'science' && newLevel === 5) {
    player.knowledge += 9;
    log(`Player ${player.name} gained 9 Knowledge from Science level 5`, 'game');
  }
}


export function helperTriggerIncomePhase(io: SocketIOServer, game: GaiaGameState) {
  // 이미 수익 선택이 진행 중이면 중복 호출 방지
  if (game.pendingIncomeOrder) {
    log(`Income phase already in progress for player ${game.pendingIncomeOrder.playerId}`, 'game');
    return;
  }
  // 파워 수신은 건물 지을 때만 표시. 라운드 시작(수익 단계)에서는 이전 라운드 잔여 제안 제거
  if (game.pendingPowerOffers && game.pendingPowerOffers.length > 0) {
    game.pendingPowerOffers = [];
    log(`Income phase: cleared pending power offers (파워 수신은 건물 배치 시에만)`, 'game');
  }
  log(`Triggering income phase for round ${game.roundNumber}`, 'game');
  const turnOrder = game.turnOrder ?? Object.keys(game.players);

  // 재진입(한 명이 수익 선택 완료 후): 수익 재적용 없이, 파워/토큰 선택이 남은 다음 플레이어만 턴 순서로 찾기
  if ((game as any).incomePhaseAppliedThisRound) {
    for (const pId of turnOrder) {
      const player = game.players[pId];
      const items = (player as any).pendingIncomeItems;
      if (!items?.length) continue;
      game.pendingIncomeOrder = {
        playerId: pId,
        incomeItems: [...items],
        appliedItems: [],
        powerBeforeSnapshots: [],
      };
      log(`[Income] Next: ${player.name} needs to select income items: ${items.length} items`, 'game');
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
      return;
    }
    // 선택 대기 플레이어 없음 → 아래 가이아 포머 복귀 등으로 진행
  } else {
    // 라운드당 1회: 모든 플레이어에게 턴 순서대로 수익 적용 (먼저 모두 수익 → 그 다음 액션 단계)
    const playersNeedingOrder: string[] = [];
    for (const pId of turnOrder) {
      const player = game.players[pId];
      if (!player?.faction) continue;

      player.hasPassed = false;
      const factionId = player.faction;

      const beforeResources = { ore: player.ore, credits: player.credits, knowledge: player.knowledge, qic: player.qic, power3: player.power3 };
      log(`[Income] ${player.name} BEFORE: O:${beforeResources.ore} C:${beforeResources.credits} K:${beforeResources.knowledge} Q:${beforeResources.qic} P3:${beforeResources.power3} | BonusTile: ${player.bonusTile}`, 'game');

      // 수익 단계에서 파워와 토큰 수익을 개별 아이템으로 수집
      const incomeItems: Array<{ type: 'power' | 'tokens'; amount: number; id: string }> = [];

      // 1. Base Income (faction-specific)
      const faction = FACTIONS.find(f => f.id === factionId);
      const baseOre = faction?.baseIncome?.ore ?? 1;
      const baseKnowledge = faction?.baseIncome?.knowledge ?? 1;
      const baseCredits = faction?.baseIncome?.credits ?? 0;
      const baseQic = faction?.baseIncome?.qic ?? 0;
      const basePowerTokens = faction?.baseIncome?.powerTokens ?? 0;

      player.ore += baseOre;
      player.knowledge += baseKnowledge;
      player.credits = (player.credits || 0) + baseCredits;
      grantQic(game, pId, baseQic);
      if (basePowerTokens > 0) {
        incomeItems.push({ type: 'tokens', amount: basePowerTokens, id: `base-tokens-${pId}` });
      }
      // 인공물 수익: 1=매라운드 2토큰(3그릇), 2=매라운드 1K 1O
      const arts = player.artifacts ?? [];
      if (arts.includes('art-income-2p3')) player.power3 = (player.power3 || 0) + 2;
      if (arts.includes('art-income-1k1o')) {
        player.knowledge += 1;
        player.ore += 1;
      }

      // 2. Structure Income
      const playerStructures = game.map.filter(t => t.ownerId === pId);

      // Mines (일반 광산 + 란티다 기생 광산)
      const mineCount = getEffectiveMineCount(game, pId);
      for (let i = 0; i < mineCount && i < STRUCTURE_INCOME.mine.length; i++) {
        player.ore += STRUCTURE_INCOME.mine[i];
      }

      // Trading Stations
      const tsCount = playerStructures.filter(t => t.structure === 'trading_station').length;
      for (let i = 0; i < tsCount && i < STRUCTURE_INCOME.trading_station.length; i++) {
        if (factionId === 'moweyip') {
          player.knowledge += 1;
        } else {
          player.credits += STRUCTURE_INCOME.trading_station[i];
        }
      }

      // Research Labs
      const labCount = playerStructures.filter(t => t.structure === 'research_lab').length;
      if (labCount > 0) {
        if (factionId === 'nevlas') {
          // 네뷸라: 연구소당 2파워 (1K 대신)
          incomeItems.push({ type: 'power', amount: 2 * labCount, id: `nevlas-lab-${pId}` });
        } else {
          let labBaseKnowledge = factionId === 'firaks' ? 2 : 1;
          player.knowledge += labBaseKnowledge;
          if (factionId === 'moweyip') {
            const labCredits = [3, 4, 5];
            for (let i = 0; i < labCount && i < labCredits.length; i++) {
              player.credits += labCredits[i];
            }
          } else {
            for (let i = 1; i < labCount; i++) {
              player.knowledge += 1;
            }
          }
        }
      }

      // Academies (왼쪽: 수익 2K, 아이타는 3K / 오른쪽: Special 액션 1QIC, 발타크는 4C)
      const leftAcademyCount = playerStructures.filter(t => t.structure === 'academy' && (t.academyType === 'left' || (t as any).academyType == null)).length;
      if (leftAcademyCount > 0) {
        const kPerLeft = player.faction === 'itars' ? 3 : STRUCTURE_INCOME.academy.left;
        player.knowledge += leftAcademyCount * kPerLeft;
      }

      // Planetary Institute 체크 (PI 자체 수익과 의회 수익 모두에 사용)
      const hasPI = playerStructures.some(t => t.structure === 'planetary_institute');

      // PI 자체의 파워 수익은 즉시 처리 (의회 수익과 별개, 선택 불필요)
      // 3. Tech Track Income: Economy
      const econLevel = player.research.economy || 0;
      if (econLevel < 5) {
        // 경제 트랙 변형에 따라 다른 수익 적용 (레벨 5는 즉시 보상이므로 수익 없음)
        const economyIncome = game.economyVariant === 'vp' ? ECONOMY_INCOME_VP : ECONOMY_INCOME_POWER;
        const ei = economyIncome[econLevel] || economyIncome[0];
        player.credits += ei.credits;
        player.ore += ei.ore;
        if (ei.power) {
          incomeItems.push({ type: 'power', amount: ei.power, id: `economy-${econLevel}-${pId}` });
        }
        if (ei.vp) {
          player.score += ei.vp;
          log(`Player ${player.name} gained ${ei.vp} VP from Economy level ${econLevel}`, 'game');
        }
      }
      // 레벨 5는 advanceTech에서 즉시 보상으로 처리됨

      // 4. Tech Track Income: Science
      const sciLevel = player.research.science || 0;
      if (sciLevel < 5) {
        player.knowledge += sciLevel;
      }
      // 레벨 5는 advanceTech에서 즉시 보상으로 처리됨

      // 5. Technology Tile Income (덮인 타일은 수입 없음)
      if (player.techTiles.includes('tech-inc-1o-1p') && !isTechTileCovered(player, 'tech-inc-1o-1p')) {
        player.ore += 1;
        incomeItems.push({ type: 'power', amount: 1, id: `tech-1o-1p-${pId}` });
      }
      if (player.techTiles.includes('tech-inc-4c') && !isTechTileCovered(player, 'tech-inc-4c')) {
        player.credits += 4;
      }
      if (player.techTiles.includes('tech-inc-1k-1c') && !isTechTileCovered(player, 'tech-inc-1k-1c')) {
        player.knowledge += 1;
        player.credits += 1;
      }

      // 6. Bonus Tile Income
      if (player.bonusTile) {
        const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
        if (bonusTile?.income) {
          if (bonusTile.income.ore) player.ore += bonusTile.income.ore;
          if (bonusTile.income.credits) player.credits += bonusTile.income.credits;
          if (bonusTile.income.knowledge) player.knowledge += bonusTile.income.knowledge;
          if (bonusTile.income.qic) grantQic(game, pId, bonusTile.income.qic);
          if (bonusTile.income.power) incomeItems.push({ type: 'power', amount: bonusTile.income.power, id: `bonus-power-${player.bonusTile}-${pId}` });
          if (bonusTile.income.powerTokens) incomeItems.push({ type: 'tokens', amount: bonusTile.income.powerTokens, id: `bonus-tokens-${player.bonusTile}-${pId}` });
          log(`[Income] ${player.name} bonus tile (${player.bonusTile}): ${JSON.stringify(bonusTile.income)}`, 'game');
        }
      } else {
        log(`[Income] ${player.name} has NO bonus tile`, 'game');
      }

      // 7. Planetary Institute(의회) 수익 - 종족별 power/tokens/ore/qic
      if (hasPI && faction?.piIncome) {
        const pi = faction.piIncome;
        const piPower = pi.power ?? 0;
        const piTokens = pi.tokens ?? 0;
        if (piPower > 0) {
          incomeItems.push({ type: 'power', amount: piPower, id: `pi-income-power-${pId}` });
        }
        if (piTokens > 0) {
          incomeItems.push({ type: 'tokens', amount: piTokens, id: `pi-income-tokens-${pId}` });
        }
        if (pi.ore) player.ore += pi.ore;
        if (pi.qic) grantQic(game, pId, pi.qic);
      }

      // 수익 아이템이 있으면 개별 선택 요청
      // 단, 1개만 있고 파워와 토큰이 섞여있지 않으면 자동 처리
      if (incomeItems.length > 0) {
        // 1개만 있고 파워/토큰이 섞여있지 않으면 자동 처리
        if (incomeItems.length === 1) {
          const item = incomeItems[0];
          if (item.type === 'power') {
            applyPowerIncome(player, item.amount);
          } else {
            player.power1 = (player.power1 || 0) + item.amount;
          }
          log(`[Income] ${player.name} auto-received income: ${item.amount} ${item.type}`, 'game');
        } else {
          // 여러 개이거나 파워/토큰이 섞여있으면 선택 요청
          playersNeedingOrder.push(pId);
          (player as any).pendingIncomeItems = incomeItems;
        }
      } else {
        // 수익 아이템이 없으면 로그만 남기고 계속 진행
        log(`[Income] ${player.name} has no power/token income items`, 'game');
      }

      // Reset used actions
      player.usedTechActions = [];
      player.usedSpecialActions = [];
      player.usedBonusAction = false;
      player.gleensNavBonusActive = false;
      // 타클론: 가이아에 있던 브레인 스톤을 그릇1으로 복귀
      if (player.faction === 'taklons' && player.brainStoneInGaia) {
        player.brainStoneInGaia = false;
        player.brainStoneBowl = 1;
        player.power1 = (player.power1 ?? 0) + 1;
        log(`[Income] ${player.name} (Taklons): Brain Stone returned to Bowl 1`, 'game');
      }
      // 아이타: 2그릇 태울 때 보관해 둔 토큰을 1그릇으로 복귀
      const itarsPending = player.itarsPendingBowl1Tokens ?? 0;
      if (player.faction === 'itars' && itarsPending > 0) {
        player.power1 = (player.power1 ?? 0) + itarsPending;
        player.itarsPendingBowl1Tokens = 0;
        log(`[Income] ${player.name} (Itars): ${itarsPending} token(s) returned to Bowl 1`, 'game');
      }

      const afterResources = { ore: player.ore, credits: player.credits, knowledge: player.knowledge, qic: player.qic, power3: player.power3 };
      log(`[Income] ${player.name} AFTER: O:${afterResources.ore} C:${afterResources.credits} K:${afterResources.knowledge} Q:${afterResources.qic} P3:${afterResources.power3}`, 'game');
    }
    (game as any).incomePhaseAppliedThisRound = true;
    // 수익 선택이 필요한 플레이어는 턴 순서대로 한 명씩만 대기 (모든 수익 적용 후 선택만 순서대로)
    if (playersNeedingOrder.length > 0) {
      const firstPlayerId = playersNeedingOrder[0];
      const firstPlayer = game.players[firstPlayerId];
      const incomeItems = (firstPlayer as any).pendingIncomeItems || [];
      if (incomeItems.length > 0) {
        game.pendingIncomeOrder = {
          playerId: firstPlayerId,
          incomeItems: [...incomeItems],
          appliedItems: [],
          powerBeforeSnapshots: [],
        };
        log(`[Income] ${firstPlayer.name} needs to select income items: ${incomeItems.length} items`, 'game');
        clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
        return;
      }
      delete (firstPlayer as any).pendingIncomeItems;
      playersNeedingOrder.shift();
      helperTriggerIncomePhase(io, game); // 다음 대기 플레이어 처리
      return;
    }
  }

  // 수익 단계 모두 완료 (재진입에서 대기자 없음, 또는 첫 진입에서 선택 필요자 없음)

  // 수익 단계가 모두 끝난 후 가이아 포머 파워 토큰 복귀
  // 테란: 기본 능력으로 2그릇으로 복귀. 의회 있으면 추가로 토큰 수만큼 해택 선택.
  // 그 외 종족: 1그릇으로 복귀
  const terranCouncilQueue: { playerId: string; tokenCount: number }[] = [];
  Object.entries(game.players).forEach(([pId, player]) => {
    if (!player.gaiaformerPower || player.gaiaformerPower <= 0) return;
    const powerToReturn = player.gaiaformerPower;
    const isTerran = player.faction === 'terran';
    const hasPI = game.map.some(t => t.ownerId === pId && t.structure === 'planetary_institute');
    if (isTerran) {
      player.power2 = (player.power2 || 0) + powerToReturn;
      log(`Player ${player.name} (Terran): ${powerToReturn} tokens from Gaiaformer → Bowl 2`, 'game');
      if (hasPI) {
        terranCouncilQueue.push({ playerId: pId, tokenCount: powerToReturn });
      }
    } else if (player.faction === 'itars' && hasPI && powerToReturn >= 4) {
      game.pendingItarsGaiaformerExchange = { playerId: pId, tokensRemaining: powerToReturn };
      player.gaiaformerPower = 0;
      log(`Player ${player.name} (Itars PI): ${powerToReturn} tokens in Gaiaformer → exchange or Bowl 1 choice`, 'game');
    } else {
      player.power1 = (player.power1 || 0) + powerToReturn;
      log(`Player ${player.name} returned ${powerToReturn} power tokens from Gaiaformer area to Bowl 1`, 'game');
    }
    player.gaiaformerPower = 0;
  });

  if (game.pendingItarsGaiaformerExchange) {
    game.terranCouncilQueueAfterItars = terranCouncilQueue.length > 0 ? terranCouncilQueue : undefined;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return;
  }

  if (terranCouncilQueue.length > 0) {
    game.pendingTerranCouncilBenefit = terranCouncilQueue[0];
    game.terranCouncilQueue = terranCouncilQueue.slice(1);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return;
  }

  // 팅커로이드: 라운드 시작 시 Special 1개 선택 (게임 중 각 1회만, 3/6라운드는 남은 1개 자동 지정)
  const tinkeroidPlayerId = Object.keys(game.players).find(pid => game.players[pid].faction === 'tinkeroids');
  let tinkeroidsPending = false;
  if (tinkeroidPlayerId) {
    const tinkeroidPlayer = game.players[tinkeroidPlayerId];
    const chosen = tinkeroidPlayer.tinkeroidsChosenSpecialIds ?? [];
    const round13 = ['tinkeroid-1tf-mine', 'tinkeroid-1qic', 'tinkeroid-4power'];
    const round46 = ['tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
    const pool = game.roundNumber >= 1 && game.roundNumber <= 3 ? round13 : round46;
    const options = pool.filter((id: string) => !chosen.includes(id));
    if (options.length === 1) {
      tinkeroidPlayer.tinkeroidRoundSpecialId = options[0];
      tinkeroidPlayer.tinkeroidsChosenSpecialIds = [...chosen, options[0]];
      log(`Tinkeroid: round ${game.roundNumber} special auto-selected: ${options[0]}`, 'game');
    } else if (options.length > 1) {
      game.pendingTinkeroidSpecialChoice = { playerId: tinkeroidPlayerId, round: game.roundNumber, options };
      tinkeroidsPending = true;
    }
  }

  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

  if (!tinkeroidsPending) {
    helperStartNewRoundTurn(io, game);
  }
}

export function helperStartNewRoundTurn(io: SocketIOServer, game: GaiaGameState) {
  // 수익 단계 종료 → 액션 단계는 항상 턴 순서 1번(선 플레이어)부터
  game.currentPlayerIndex = 0;
  const currentId = game.turnOrder[game.currentPlayerIndex];
  if (currentId) {
    if (!game.turnStartState) game.turnStartState = {};
    game.turnStartState[currentId] = {
      playerState: JSON.parse(JSON.stringify(game.players[currentId])),
      mapState: JSON.parse(JSON.stringify(game.map)),
      spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
      gameLogLength: game.gameLog?.length || 0,
    };
  }
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

  // 첫 플레이어가 봇이면 바로 봇 턴 시작
  executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
    log(`Bot turn execution error (StartNewRoundTurn): ${err}`, 'error');
  });
}

export function helperProceedAfterItarsGaiaformerOrTerran(io: SocketIOServer, game: GaiaGameState) {
  const terranQueue = game.terranCouncilQueueAfterItars;
  game.terranCouncilQueueAfterItars = undefined;
  if (terranQueue && terranQueue.length > 0) {
    game.pendingTerranCouncilBenefit = terranQueue[0];
    game.terranCouncilQueue = terranQueue.slice(1);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return;
  }
  game.currentPlayerIndex = 0;
  const currentId = game.turnOrder[game.currentPlayerIndex];
  if (currentId) {
    if (!game.turnStartState) game.turnStartState = {};
    game.turnStartState[currentId] = {
      playerState: JSON.parse(JSON.stringify(game.players[currentId])),
      mapState: JSON.parse(JSON.stringify(game.map)),
      spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
      gameLogLength: game.gameLog?.length || 0,
    };
  }
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
}

export function helperFinishAfterGaiaformerPhase(io: SocketIOServer, game: GaiaGameState) {
  const currentId = game.turnOrder[game.currentPlayerIndex];
  if (currentId) {
    if (!game.turnStartState) game.turnStartState = {};
    game.turnStartState[currentId] = {
      playerState: JSON.parse(JSON.stringify(game.players[currentId])),
      mapState: JSON.parse(JSON.stringify(game.map)),
      spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
      gameLogLength: game.gameLog?.length || 0,
    };
  }
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
}

export function setupGameServer(httpServer: HTTPServer) {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    log(`Player connected: ${socket.id}`, 'socket.io');

    socket.on('list_games', (callback) => {
      const gameList = Array.from(games.values()).map(g => ({
        id: g.id,
        playerCount: Object.keys(g.players).length,
        maxPlayers: g.maxPlayers,
        phase: g.currentPhase,
        createdAt: g.createdAt,
      }));
      callback({ games: gameList });
    });

    socket.on('create_game', ({ playerName }, callback) => {
      const gameId = generateGameId();
      const playerId = generatePlayerId();

      // Shuffle bonus tiles
      const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);

      const game: ServerGameState = {
        id: gameId,
        hostId: playerId,
        players: { [playerId]: createInitialPlayerState(playerName) },
        map: generateMap(),
        currentPhase: 'lobby',
        roundNumber: 0,
        currentPlayerIndex: 0,
        turnOrder: [playerId],
        maxPlayers: 4,
        createdAt: Date.now(),
        isTestMode: false,
        hasDoneMainAction: false,
        powerActions: [...INITIAL_POWER_ACTIONS],
        availableBonusTiles: shuffledBonusTiles.slice(0, 7), // Players + 3 extra (will adjust when game starts)
        roundScoringTiles: Array(6).fill(null).map(() => ({ id: '', label: '', condition: '', vp: 0 })), // 임시 초기화
        usedRoundMissions: [], // 사용된 라운드 미션 추적
        finalScoringTiles: [
          { id: 'fs1', label: 'Final 1', condition: 'Satellites', vp: 0 },
          { id: 'fs2', label: 'Final 2', condition: 'Structures', vp: 0 },
        ],
        techTilesByTrack: {},
        advancedTechTilesByTrack: {},
        techTilesPool: [],
        passingOrder: [],
        pendingBonusSelection: null,
        nextRoundBonusTiles: {},
        pendingTechTileSelection: null,
        gameLog: [],
        economyVariant: Math.random() < 0.5 ? 'power' : 'vp', // 랜덤으로 경제 트랙 변형 선택
      };

      // Randomize Standard Tech Tiles (트랙당 플레이어 수만큼 = 각 플레이어가 한 번씩 가져갈 수 있음)
      const numPlayers = game.turnOrder.length;
      const neededStandard = 6 * numPlayers;
      const repeatedStandard = Array.from({ length: Math.ceil(neededStandard / ALL_TECH_TILES.length) }, () => [...ALL_TECH_TILES]).flat();
      const shuffledStandard = repeatedStandard.sort(() => Math.random() - 0.5).slice(0, neededStandard + 3);
      const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

      tracks.forEach((track, i) => {
        game.techTilesByTrack[track] = shuffledStandard.slice(i * numPlayers, (i + 1) * numPlayers);
      });
      game.techTilesPool = shuffledStandard.slice(6 * numPlayers, 6 * numPlayers + 3);



      // Randomize Advanced Tech Tiles (7개: 6개는 트랙 4–5 사이, 1개는 하단 풀 오른쪽 슬롯)
      const shuffledAdvanced = [...ALL_ADVANCED_TECH_TILES].sort(() => Math.random() - 0.5);
      tracks.forEach((track, i) => {
        game.advancedTechTilesByTrack[track] = shuffledAdvanced[i];
      });
      game.extraAdvancedTechTile = shuffledAdvanced[6];
      game.extraAdvancedTechCondition = Math.random() < 0.5 ? '25vp' : '3ships';

      // 게임 시작 시 모든 라운드 미션을 미리 랜덤 선택
      initializeRoundMissions(game);

      // 최종미션: 9개 중 2개 랜덤 선택
      const shuffledFinal = [...FINAL_MISSION_IDS].sort(() => Math.random() - 0.5);
      game.finalMissionIds = shuffledFinal.slice(0, 2);

      // 우주선 타일별 상태 초기화
      game.spaceships = {};
      for (const tile of game.map) {
        if (tile.type === 'ship_twilight' || tile.type === 'ship_rebellion' || tile.type === 'ship_tf_mars' || tile.type === 'ship_eclipse') {
          game.spaceships[tile.id] = { unlocked: false, occupants: [], usedActionIndices: [] };
        }
      }
      // 우주선 전용 기술 타일 3개를 3종 우주선에 매 게임 랜덤 배정
      const shipTechIds = SHIP_TECH_TILES.map(t => t.id);
      const shuffledShipTech = [...shipTechIds].sort(() => Math.random() - 0.5);
      game.shipTechByShip = {
        ship_rebellion: shuffledShipTech[0],
        ship_tf_mars: shuffledShipTech[1],
        ship_eclipse: shuffledShipTech[2],
      };

      // 트왈라잇 인공물: 13종 중 4개 랜덤 배치
      const allArtifactIds = ARTIFACTS.map(a => a.id);
      const shuffledArtifacts = [...allArtifactIds].sort(() => Math.random() - 0.5);
      game.twilightArtifactSlots = shuffledArtifacts.slice(0, 4);

      // 연방 풀: 6종류 각 3개. 테라포밍 5단계에 랜덤 1종 배치 → 그 종은 풀에서 1개 차감(2개 남음)
      game.federationPool = {};
      FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
      const shuffledFed = [...FEDERATION_REWARDS].sort(() => Math.random() - 0.5);
      game.federationOnTerraforming5 = shuffledFed[0].id;
      game.federationPool![shuffledFed[0].id] -= 1;
      const shuffledShipFed = [...SPACESHIP_FEDERATION_REWARDS].sort(() => Math.random() - 0.5);
      const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
      game.spaceshipFederationByShip = {};
      shipTypes.forEach((shipType, i) => { game.spaceshipFederationByShip![shipType] = shuffledShipFed[i].id; });
      game.satellites = {};

      games.set(gameId, game);
      game.hostSocketId = socket.id;
      playerGameMap.set(playerId, gameId);
      socketToPlayerMap.set(socket.id, playerId);
      socket.join(gameId);

      log(`Game created: ${gameId} by ${playerName}`, 'game');
      callback({ gameId, playerId, game });
    });

    socket.on('join_game', ({ gameId, playerName }, callback) => {
      const game = games.get(gameId);
      if (!game || Object.keys(game.players).length >= game.maxPlayers || game.currentPhase !== 'lobby') {
        callback({ error: 'Cannot join game' }); return;
      }
      const playerId = generatePlayerId();
      game.players[playerId] = createInitialPlayerState(playerName);
      game.turnOrder.push(playerId);
      playerGameMap.set(playerId, gameId);
      socketToPlayerMap.set(socket.id, playerId);
      socket.join(gameId);
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
      callback({ gameId, playerId, game });
    });

    /** 방장 전용: 플레이어 슬롯 추가 (한 컴퓨터에서 교대로 조작하는 4인플용) */
    socket.on('host_add_player', ({ gameId, playerName }, callback) => {
      const game = games.get(gameId);
      if (!game) { callback({ error: 'Game not found' }); return; }
      const callerId = socketToPlayerMap.get(socket.id);
      if (callerId !== game.hostId) { callback({ error: 'Only host can add players' }); return; }
      if (game.currentPhase !== 'lobby') { callback({ error: 'Can only add players in lobby' }); return; }
      if (Object.keys(game.players).length >= game.maxPlayers) { callback({ error: 'Max players reached' }); return; }
      const newPlayerId = generatePlayerId();
      const name = playerName || `Player ${Object.keys(game.players).length + 1}`;
      game.players[newPlayerId] = createInitialPlayerState(name);
      game.turnOrder.push(newPlayerId);
      clampPlayerResources(game);
      io.to(gameId).emit('game_updated', game);
      callback({ playerId: newPlayerId, name, game });
    });

    /** 방장 전용: AI 봇 플레이어 추가 */
    socket.on('host_add_bot', ({ gameId, botName }, callback) => {
      const game = games.get(gameId);
      if (!game) { callback({ error: 'Game not found' }); return; }
      const callerId = socketToPlayerMap.get(socket.id);
      if (callerId !== game.hostId) { callback({ error: 'Only host can add bots' }); return; }
      if (game.currentPhase !== 'lobby') { callback({ error: 'Can only add bots in lobby' }); return; }
      if (Object.keys(game.players).length >= game.maxPlayers) { callback({ error: 'Max players reached' }); return; }

      const botId = `bot-${generatePlayerId()}`;
      const name = botName || `AI Bot ${Object.keys(game.players).length + 1}`;

      game.players[botId] = createInitialPlayerState(name);
      game.turnOrder.push(botId);

      if (!game.botPlayerIds) game.botPlayerIds = [];
      game.botPlayerIds.push(botId);

      log(`AI Bot added: ${name} (${botId}) to game ${gameId}`, 'game');
      clampPlayerResources(game);
      io.to(gameId).emit('game_updated', game);
      callback({ botId, name, game });
    });

    socket.on('rejoin_game', ({ gameId, playerId }, callback) => {
      const game = games.get(gameId);
      if (!game || !game.players[playerId]) { callback({ error: 'Game or player not found' }); return; }
      const currentMapped = socketToPlayerMap.get(socket.id);
      const isHostSocket = game.hostSocketId === socket.id;
      const isHostPlayer = game.hostId === currentMapped;
      const canControl = currentMapped === playerId || (isHostPlayer && game.players[playerId]) || (isHostSocket && game.players[playerId]);
      if (!canControl) { callback({ error: 'Cannot control this player' }); return; }
      socketToPlayerMap.set(socket.id, playerId);
      playerGameMap.set(playerId, gameId);
      socket.join(gameId);
      clampPlayerResources(game);
      io.to(gameId).emit('game_updated', game);
      callback({ game });
    });

    socket.on('get_game', ({ gameId }, callback) => {
      const game = games.get(gameId);
      if (!game) { callback({ error: 'Game not found' }); return; }
      callback({ game });
    });

    socket.on('start_game', ({ gameId }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (playerId !== game.hostId) return;
      // 턴 순서 초기화: 일단 조인 순서 등으로 임시 설정 (이후 executeSelectFaction 완료 시 확정)
      if (!game.turnOrder || game.turnOrder.length === 0) {
        game.turnOrder = Object.keys(game.players);
      }

      const allHaveFaction = Object.values(game.players).every(p => p.faction != null);
      if (allHaveFaction) {
        game.currentPhase = 'startingMines';
        log(`Start game: All factions selected. Resuming startingMines phase.`, 'game');
      } else {
        game.currentPhase = 'factionSelect';
        log(`Start game: Entering factionSelect phase.`, 'game');
      }

      // 확장: 모웨이드/팅커로이드 3테라포밍 땅 3개 설정 (나머지 7색상 4개는 1테라포밍)
      const playerList = Object.values(game.players);
      const moweyipPlayer = playerList.find(p => p.faction === 'moweyip');
      const tinkeroidsPlayer = playerList.find(p => p.faction === 'tinkeroids');
      if (moweyipPlayer) {
        const otherHomes = playerList.filter(p => p.faction && p.faction !== 'moweyip').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
        game.moweyipThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
        log(`Moweyip expansion: 3-step planets = ${game.moweyipThreeStepPlanets.join(', ')}`, 'game');
      }
      if (tinkeroidsPlayer) {
        const otherHomes = playerList.filter(p => p.faction && p.faction !== 'tinkeroids').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
        game.tinkeroidsThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
        log(`Tinkeroids expansion: 3-step planets = ${game.tinkeroidsThreeStepPlanets.join(', ')}`, 'game');
      }

      // 턴 시퀀스 계산 (이미 startingMines라면)
      if (game.currentPhase === 'startingMines') {
        const sequence = buildStartingMineSequence(game);
        (game as any).startingMineSequence = sequence;
        const firstId = sequence[0];
        if (firstId && game.turnOrder?.length) {
          game.currentPlayerIndex = game.turnOrder.indexOf(firstId);
          if (game.currentPlayerIndex < 0) game.currentPlayerIndex = 0;
          log(`Start game: first to place is ${firstId} (index ${game.currentPlayerIndex})`, 'game');
        } else {
          game.currentPlayerIndex = 0;
        }
      } else {
        game.currentPlayerIndex = 0;
      }
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

      // Trigger bot turn if first player is a bot
      executeBotTurnIfNeeded(io, game).catch(err => {
        log(`Bot turn execution error (start_game): ${err}`, 'error');
      });
    });

    socket.on('toggle_test_mode', ({ gameId }) => {
      const game = games.get(gameId);
      if (!game) return;
      game.isTestMode = !game.isTestMode;
      log(`Test mode ${game.isTestMode ? 'ENABLED' : 'DISABLED'} for game ${gameId}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('debug_set_resources', ({ gameId, resources }) => {
      const game = games.get(gameId);
      if (!game || !game.isTestMode) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;
      const player = game.players[playerId];
      if (resources.credits !== undefined) player.credits = resources.credits;
      if (resources.ore !== undefined) player.ore = resources.ore;
      if (resources.knowledge !== undefined) player.knowledge = resources.knowledge;
      if (resources.qic !== undefined) player.qic = resources.qic;
      // Power bowl settings
      if (resources.power1 !== undefined) player.power1 = resources.power1;
      if (resources.power2 !== undefined) player.power2 = resources.power2;
      if (resources.power3 !== undefined) player.power3 = resources.power3;
      log(`Debug: Set resources for ${player.name}: ${JSON.stringify(resources)}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('select_faction', ({ gameId, factionId, turnOrder }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executeSelectFaction(io, game, playerId, factionId, turnOrder);
    });

    socket.on('confirm_factions', ({ gameId }) => {
      const game = games.get(gameId);
      if (!game || !Object.values(game.players).every(p => p.faction !== null)) return;

      // 턴 순서를 selectedTurnOrder에 따라 정렬
      const playersWithTurnOrder = Object.entries(game.players)
        .map(([id, p]) => ({ id, turnOrder: (p as any).selectedTurnOrder as number | undefined }))
        .filter(p => p.turnOrder !== undefined)
        .sort((a, b) => (a.turnOrder || 0) - (b.turnOrder || 0));

      // 모든 플레이어가 턴 순서를 선택했는지 확인
      if (playersWithTurnOrder.length === Object.keys(game.players).length) {
        game.turnOrder = playersWithTurnOrder.map(p => p.id);
      }

      // 모든 플레이어가 종족을 선택했으면 보너스 타일 선택으로 이동
      const numPlayers = Object.keys(game.players).length;
      const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);
      game.availableBonusTiles = shuffledBonusTiles.slice(0, numPlayers + 3);
      game.currentPlayerIndex = game.turnOrder.length - 1;
      game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];

      game.currentPhase = 'bonusSelection';
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('place_starting_mine', ({ gameId, tileId, factionId }) => {
      const game = games.get(gameId);
      if (!game) { io.to(gameId).emit('game_error', { message: '게임을 찾을 수 없습니다.' }); return; }
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) { io.to(gameId).emit('game_error', { message: '플레이어 연결이 없습니다.' }); return; }

      const error = executePlaceStartingMine(io, game, playerId, tileId, factionId);
      if (error) {
        io.to(gameId).emit('game_error', { message: error });
      }
    });

    // Bonus Tile Selection
    socket.on('select_bonus_tile', ({ gameId, bonusTileId }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executeSelectBonus(io, game, playerId, bonusTileId);
    });

    // Use Bonus Tile Special Action
    // terraform_step: 테라포밍 1단계 (무료)
    // gaia_project: 가이아 프로젝트 시작 (보라색 행성에 가이아포머 배치)
    // range_3: +3 거리 추가 (건설, 가이아포밍, 우주선, 소행성 건설에 사용)
    socket.on('use_bonus_action', ({ gameId, actionData }) => {
      const game = games.get(gameId); if (!game || game.currentPhase !== 'main') return;

      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;

      // 액션 시작 시점 상태 저장
      saveActionStartState(game, playerId);

      const player = game.players[playerId];
      if (!player.bonusTile || player.usedBonusAction) return;

      const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
      if (!bonusTile?.specialAction) return;

      // Handle special actions
      switch (bonusTile.specialAction) {
        case 'terraform_step':
          // 테라포밍 1단계 추가
          player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
          player.usedBonusAction = true;
          log(`Player ${player.name} activated bonus action: 1 terraform step (Total: ${player.pendingTerraformSteps})`, 'game');
          // 테라포밍 액션은 자동 패스하지 않음 (광산 건설 후 사용)
          // 자동 패스 로직 제거
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;

        case 'gaia_project':
          // 가이아 프로젝트 = TF Mars 2번과 동일 (Transdim에 가이아포머 배치 또는 건너뛰기)
          player.usedBonusAction = true;
          game.pendingTFMarsGaiaProject = { playerId, shipTileId: 'bonus-gaia' };
          game.hasDoneMainAction = true;
          log(`Player ${player.name} activated bonus action: Gaia Project (place Gaiaformer or skip)`, 'game');
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;

        case 'range_3':
          // +3 거리: 트왈라잇 1K와 동일하게 이번 턴에 광산/포밍 등 행동 후 End Turn (자동 패스 안 함)
          player.usedBonusAction = true;
          player.rangeBonusActive = true;
          log(`Player ${player.name} activated bonus action: +3 range (this turn)`, 'game');
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        default:
          // gaia_project 등 이미 return한 케이스 외 알 수 없는 액션은 자동 패스하지 않음
          log(`Player ${player.name} used bonus action (unhandled specialAction: ${bonusTile.specialAction})`, 'game');
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
      }
    });


    socket.on('build_mine', ({ gameId, tileId, useGaiaformer }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executeBuildMine(io, game, playerId, tileId, useGaiaformer);
    });

    // 우주선 입장 (5VP로 잠금 해제 후 입장, 또는 이미 열린 우주선에 거리 체크 후 입장)
    socket.on('enter_spaceship', ({ gameId, tileId, useRangeBonus, qicToUse }) => {
      const game = games.get(gameId); if (!game || game.hasDoneMainAction) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;

      saveActionStartState(game, playerId);
      const player = game.players[playerId];
      const tile = game.map.find(t => t.id === tileId);
      const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
      if (!tile || !shipTypes.includes(tile.type)) return;

      if (!game.spaceships) {
        game.spaceships = {};
        for (const t of game.map) {
          if (t.type === 'ship_twilight' || t.type === 'ship_rebellion' || t.type === 'ship_tf_mars' || t.type === 'ship_eclipse') {
            game.spaceships[t.id] = { unlocked: false, occupants: [], usedActionIndices: [] };
          }
        }
      }
      const shipState = game.spaceships[tileId];
      if (!shipState) return;

      const entered = player.spaceshipsEntered || [];
      if (entered.length >= 3) return;
      if (entered.includes(tileId)) return; // 이미 이 우주선에 입장함

      // 거리 체크: 플레이어 건물에서 우주선 타일까지 (첫 입장도 동일)
      let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
      if (player.tempRangeBonus) baseRange += 3;
      if (useRangeBonus && player.rangeBonusActive) {
        baseRange += 3;
        player.rangeBonusActive = false;
      }
      if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
      const rangeTiles = getPlayerRangeTiles(game, playerId, true);
      if (rangeTiles.length === 0) return;
      const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
      const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
      const useQic = qicToUse ?? 0;
      if (neededQIC > 0 && useQic < neededQIC) return;
      if (player.qic < useQic) return;
      player.qic -= useQic;

      // 아이타·네뷸라: 우주선 입장 시 토큰 1개 비용 (1그릇 → 2그릇 → 3그릇 순으로 차감, 없으면 입장 불가)
      if (player.faction === 'itars' || player.faction === 'nevlas') {
        const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
        if (p1 + p2 + p3 < 1) {
          io.to(gameId).emit('game_error', { message: '우주선 입장에 파워 토큰 1개가 필요합니다. (1/2/3그릇 순으로 차감)' });
          return;
        }
        if (p1 >= 1) player.power1 = p1 - 1;
        else if (p2 >= 1) player.power2 = p2 - 1;
        else player.power3 = p3 - 1;
      }

      // 잠금 해제 비용: 첫 입장 시 5 VP (거리 통과 후 적용)
      if (!shipState.unlocked) {
        if (player.score < 5) return;
        addScore(game, playerId, -5, 'other', { source: '우주선 잠금해제' });
        shipState.unlocked = true;
        addGameLog(game, playerId, 'Unlocked & Entered Ship', `-5 VP (${tile.type})`, tileId);
      }

      shipState.occupants.push(playerId);
      if (!player.spaceshipsEntered) player.spaceshipsEntered = [];
      player.spaceshipsEntered.push(tileId);

      // 타클론: 우주선 입장 시 브레인 스톤을 가이아 영역으로 (다음 라운드까지 사용 불가)
      if (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) {
        const b = player.brainStoneBowl as 1 | 2 | 3;
        if (b === 1) player.power1 = Math.max(0, (player.power1 ?? 0) - 1);
        else if (b === 2) player.power2 = Math.max(0, (player.power2 ?? 0) - 1);
        else player.power3 = Math.max(0, (player.power3 ?? 0) - 1);
        player.brainStoneInGaia = true;
        addGameLog(game, playerId, 'Taklons: Brain Stone', 'Moved to Gaia (until next round)', tileId);
      }

      // 입장 순서 보상: 2·3번째 2PW, 4번째 3PW
      const idx = shipState.occupants.length;
      if (idx === 2 || idx === 3) chargePower(player, 2);
      else if (idx === 4) chargePower(player, 3);

      if (shipState.unlocked && shipState.occupants.length > 1) {
        addGameLog(game, playerId, 'Entered Ship', `${tile.type} (#${idx})${useQic ? `, ${useQic}QIC` : ''}`, tileId);
      }

      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 우주선 내부 액션 사용 (트왈라잇, Rebellion, TF Mars, Eclipse)
    socket.on('use_ship_action', (payload) => {
      const { gameId, shipTileId, actionIndex, targetTileId } = payload;
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      saveActionStartState(game, playerId);
      const player = game.players[playerId];
      const shipTile = game.map.find(t => t.id === shipTileId);
      const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
      if (!shipTile || !shipTypes.includes(shipTile.type)) return;
      const shipState = game.spaceships?.[shipTileId];
      if (!shipState || !shipState.occupants.includes(playerId)) return;
      const usedIndices = shipState.usedActionIndices ?? (shipState.actionsUsed != null ? [] : []);
      if (usedIndices.includes(actionIndex)) return;
      if (usedIndices.length >= 3) return;

      // --- 트왈라잇 ---
      if (shipTile.type === 'ship_twilight') {
        if (actionIndex === 1) {
          if (player.qic < 3) return;
          player.qic -= 3;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          game.pendingTwilightFederation = { playerId, shipTileId };
          addGameLog(game, playerId, 'Twilight: Federation benefit', '3 QIC (choose reward)', shipTileId);
          game.hasDoneMainAction = true; // 우주선 액션 = 파워액션과 동일, 한 턴에 하나
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 2) {
          if (!targetTileId) return;
          const target = game.map.find(t => t.id === targetTileId);
          if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return;
          if (player.ore < 2 || player.power3 < 3) return;
          player.ore -= 2;
          player.power3 -= 3;
          player.power1 += 3;
          target.structure = 'research_lab';
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          applyRoundMissionScore(game, playerId, 'build_research_lab');
          addGameLog(game, playerId, 'Twilight: TS → Research Lab', '2O, 3P (no 3O 5C)', targetTileId);
          game.pendingTechTileSelection = { playerId, tileId: targetTileId, structureType: 'research_lab' };
          // 연구소 건설 시 6트랙+풀+우주선 기술 타일 모두 선택 가능 (동일 플로우)
          game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 3) {
          // 1K로 +3 거리: 이번 턴에 광산/포밍 등 추가 행동 후 End Turn (메인 액션으로 처리하지 않음)
          if (player.knowledge < 1) return;
          player.knowledge -= 1;
          player.tempRangeBonus = true;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          addGameLog(game, playerId, 'Twilight: +3 Range', '1K (this turn)', shipTileId);
          // hasDoneMainAction 설정하지 않음 → 같은 턴에 광산 건설/가이아포밍 등 후 End Turn
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
      }

      // --- Rebellion ---
      if (shipTile.type === 'ship_rebellion') {
        if (actionIndex === 1) {
          if (player.qic < 3) return;
          player.qic -= 3;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          // 연구소/아카데미와 동일: 6트랙+풀+우주선 기술 타일 모두 선택 가능
          game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
          game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
          addGameLog(game, playerId, 'Rebellion: Gain tech tile', '3 QIC (choose tile + track advance)', shipTileId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 2) {
          const tid = targetTileId != null ? String(targetTileId) : '';
          if (!tid) return;
          const target = game.map.find(t => t.id === tid || String(t.id) === tid);
          if (!target || target.ownerId !== playerId || target.structure !== 'mine') return;
          if (player.ore < 1 || player.power3 < 3) return;
          player.ore -= 1;
          player.power3 -= 3;
          player.power1 += 3;
          target.structure = 'trading_station';
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          applyRoundMissionScore(game, playerId, 'build_trading_station');
          addGameLog(game, playerId, 'Rebellion: Mine → TS', '1O, 3P (no 2O 3C/6C)', targetTileId);
          createPowerOffers(game, target, playerId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 3) {
          if (player.knowledge < 2) return;
          player.knowledge -= 2;
          grantQic(game, playerId, 1);
          player.credits += 2;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          addGameLog(game, playerId, 'Rebellion: 2K → 1Q 2C', '', shipTileId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
      }

      // --- TF Mars ---
      if (shipTile.type === 'ship_tf_mars') {
        if (actionIndex === 1) {
          if (player.qic < 2) return;
          player.qic -= 2;
          const count = player.techTiles?.length ?? 0;
          player.score += count + 2;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          addGameLog(game, playerId, 'TF Mars: Tech tiles + 2 VP', `(${count}+2) VP`, shipTileId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 2) {
          if (player.power3 < 2) return; // 3그릇 2pw = 5 from bowl 3
          player.power3 -= 2;
          player.power1 += 2;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          game.pendingTFMarsGaiaProject = { playerId, shipTileId };
          addGameLog(game, playerId, 'TF Mars: Gaia Project', '2P → place Gaiaformer (same as bonus tile)', shipTileId);
          game.hasDoneMainAction = true; // 가이아포머 배치는 후속 선택이지만 턴은 이미 소모
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 3) {
          // 3C로 1테라포밍 단계 (연구 보드 3PW 1테라포밍 / 보너스 타일 1테라포밍과 동일) → 광산 건설 시 할인 적용
          if (player.credits < 3) return;
          player.credits -= 3;
          player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          addGameLog(game, playerId, 'TF Mars: 3C → 1 Terraform', '(same as 3PW or bonus 1 Step, use when building)', shipTileId);
          // 같은 턴에 광산 건설 시 테라포밍 할인 받을 수 있도록 hasDoneMainAction 설정하지 않음
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
      }

      // --- Eclipse ---
      if (shipTile.type === 'ship_eclipse') {
        if (actionIndex === 1) {
          if (player.qic < 2) return;
          player.qic -= 2;
          const structures = game.map.filter(t => t.ownerId === playerId && t.structure);
          const types = new Set(structures.map(t => t.type).filter(t => t && t !== 'space' && t !== 'deep_space'));
          player.score += types.size + 2;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          addGameLog(game, playerId, 'Eclipse: Planet types + 2 VP', `(${types.size}+2) VP`, shipTileId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 2) {
          // 2K+3P 지불 후 원하는 연구 트랙을 선택해 1칸 진행
          if (player.knowledge < 2 || player.power3 < 3) return;
          player.knowledge -= 2;
          player.power3 -= 3;
          player.power1 = (player.power1 || 0) + 3;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          game.pendingEclipseResearch = { playerId, shipTileId };
          addGameLog(game, playerId, 'Eclipse: 2K+3P → Research', '(choose track)', shipTileId);
          game.hasDoneMainAction = true;
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
        if (actionIndex === 3) {
          // 6C 지불 후 소행성 선택 시 광산 건설 (선택 완료 시점에 hasDoneMainAction 설정)
          if (player.credits < 6) return;
          player.credits -= 6;
          shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
          shipState.actionsUsed = shipState.usedActionIndices.length;
          game.pendingEclipseAsteroidMine = { playerId, shipTileId };
          addGameLog(game, playerId, 'Eclipse: 6C → Build mine on asteroid', '(select tile)', shipTileId);
          // hasDoneMainAction은 소행성 선택 후 eclipse_build_asteroid_mine에서 설정
          clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
          return;
        }
      }

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 트왈라잇 인공물 가져가기 (우주선에 있는 플레이어만, 6파워 1→2→3 순 소모)
    socket.on('take_twilight_artifact', ({ gameId, artifactId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      if (game.hasDoneMainAction) return;
      const player = game.players[playerId];
      const entered = player.spaceshipsEntered ?? [];
      const twilightTile = game.map.find(t => t.type === 'ship_twilight');
      if (!twilightTile || !entered.includes(twilightTile.id)) return;
      const slots = game.twilightArtifactSlots ?? [];
      const slotIdx = slots.findIndex(s => s === artifactId);
      if (slotIdx === -1 || !ARTIFACTS.some(a => a.id === artifactId)) return;
      if (!spendPowerTokens(player, 6)) return;

      saveActionStartState(game, playerId);
      (game.twilightArtifactSlots as (string | null)[])[slotIdx] = null;
      if (!player.artifacts) player.artifacts = [];
      player.artifacts.push(artifactId);

      const art = ARTIFACTS.find(a => a.id === artifactId)!;
      if (art.id === 'art-fed-once') {
        game.pendingTwilightFederation = { playerId, shipTileId: twilightTile.id };
        addGameLog(game, playerId, 'Artifact: Federation benefit', 'Choose one federation reward', twilightTile.id);
      } else if (art.id === 'art-vp-gaia') {
        const lvl = player.research.gaiaProject ?? 0;
        const vp = lvl * 3;
        player.score += vp;
        addGameLog(game, playerId, 'Artifact: Gaia×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
      } else if (art.id === 'art-vp-science') {
        const lvl = player.research.science ?? 0;
        const vp = lvl * 3;
        player.score += vp;
        addGameLog(game, playerId, 'Artifact: Science×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
      } else if (art.id === 'art-vp-tracks3') {
        const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[]).filter(t => (player.research[t] ?? 0) >= 3).length;
        const vp = tracks * 3;
        player.score += vp;
        addGameLog(game, playerId, 'Artifact: Tracks≥3×3 VP', `${tracks}×3 = ${vp} VP`, twilightTile.id);
      } else if (art.id === 'art-vp-planet-types') {
        const structures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
        const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space'));
        if (player.virtualMineAsteroid) types.add('asteroid');
        if (player.virtualMineProto) types.add('proto');
        const vp = 3 + types.size;
        player.score += vp;
        addGameLog(game, playerId, 'Artifact: 3+Planet types VP', `3+${types.size} = ${vp} VP`, twilightTile.id);
      } else if (art.id === 'art-7vp-virtual-asteroid') {
        const geodensTypesBeforeArt = getPlayerPlanetTypesForGeodens(game, playerId);
        player.score += 7;
        player.virtualMineAsteroid = true;
        addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (asteroid)', '', twilightTile.id);
        applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArt);
      } else if (art.id === 'art-7vp-virtual-proto') {
        const geodensTypesBeforeArtProto = getPlayerPlanetTypesForGeodens(game, playerId);
        player.score += 7;
        player.virtualMineProto = true;
        addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (proto)', '', twilightTile.id);
        applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArtProto);
      } else if (art.id === 'art-imm-3o3c') {
        player.ore = (player.ore || 0) + 3;
        player.credits = (player.credits || 0) + 3;
        addGameLog(game, playerId, 'Artifact: 3O 3C', '', twilightTile.id);
      } else if (art.id === 'art-imm-2o5c') {
        player.ore = (player.ore || 0) + 2;
        player.credits = (player.credits || 0) + 5;
        addGameLog(game, playerId, 'Artifact: 2O 5C', '', twilightTile.id);
      } else if (art.id === 'art-imm-3k1q') {
        player.knowledge = (player.knowledge || 0) + 3;
        grantQic(game, playerId, 1);
        addGameLog(game, playerId, 'Artifact: 3K 1Q', '', twilightTile.id);
      } else if (art.id === 'art-vp-bridge') {
        const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
        const withBuilding = bridgeSectors.filter(s => game.map.some(t => t.sector === s && t.ownerId === playerId && t.structure));
        const vp = withBuilding.length * 3;
        player.score += vp;
        addGameLog(game, playerId, 'Artifact: Bridge sections×3 VP', `${withBuilding.length}×3 = ${vp} VP`, twilightTile.id);
      } else {
        addGameLog(game, playerId, 'Artifact', art.label, twilightTile.id);
      }

      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // TF Mars 액션2 / 보너스 타일 가이아 프로젝트: 건너뛰기 (가이아포머 없거나 배치 불가 시)
    socket.on('skip_tfmars_gaia_project', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingTFMarsGaiaProject;
      if (!pending || pending.playerId !== playerId) return;
      const isBonusGaia = pending.shipTileId === 'bonus-gaia';
      game.pendingTFMarsGaiaProject = null;

      if (isBonusGaia) {
        // 보너스 타일 가이아 프로젝트 건너뛰기 → 타일 반납 후 패스 (TF Mars 2번과 동일 플로우)
        const player = game.players[playerId];
        const currentBonusTileId = player.bonusTile;
        if (currentBonusTileId) {
          if (!game.nextRoundBonusTiles) game.nextRoundBonusTiles = {};
          game.nextRoundBonusTiles[playerId] = currentBonusTileId;
          const oldTile = ALL_BONUS_TILES.find(t => t.id === currentBonusTileId);
          if (oldTile) game.availableBonusTiles.push(oldTile);
          player.bonusTile = null;
        }
        addGameLog(game, playerId, 'Bonus: Gaia Project', 'skipped', 'bonus-gaia');
        player.hasPassed = true;
        if (!game.passingOrder.includes(playerId)) game.passingOrder.push(playerId);
        game.hasDoneMainAction = false;

        const allPassed = game.turnOrder.every(pid => game.players[pid].hasPassed);
        if (allPassed) {
          game.roundNumber++;
          (game as any).incomePhaseAppliedThisRound = false;
          game.powerActions.forEach(a => { a.isUsed = false; });
          Object.values(game.players).forEach(p => {
            if (p.hadschHallasPIActions) p.hadschHallasPIActions.forEach(a => { a.isUsed = false; });
            p.usedIvitsSpaceStationThisRound = false;
            if (p.faction === 'bal_tak') p.balTakGaiaformersUsedForQic = 0;
          });
          if (game.spaceships) {
            Object.keys(game.spaceships).forEach(id => {
              game.spaceships![id].actionsUsed = 0;
              game.spaceships![id].usedActionIndices = [];
            });
          }
          game.turnOrder = [...game.passingOrder];
          game.passingOrder = [];
          if (game.nextRoundBonusTiles) {
            Object.entries(game.nextRoundBonusTiles).forEach(([pid, tileId]) => {
              const p = game.players[pid];
              const tileIndex = game.availableBonusTiles.findIndex(t => t.id === tileId);
              if (tileIndex !== -1) {
                p.bonusTile = tileId;
                game.availableBonusTiles.splice(tileIndex, 1);
                p.usedBonusAction = false;
                log(`Player ${p.name} received next round bonus tile: ${tileId}`, 'game');
              }
            });
            game.nextRoundBonusTiles = {};
          }
          Object.values(game.players).forEach(p => { p.hasPassed = false; });
          game.currentPlayerIndex = 0;
          triggerIncomePhase(game);
        } else {
          game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
          while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
            game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
          }
        }
        const newCurrentPlayerId = game.turnOrder[game.currentPlayerIndex];
        if (newCurrentPlayerId) {
          if (!game.turnStartState) game.turnStartState = {};
          game.turnStartState[newCurrentPlayerId] = {
            playerState: JSON.parse(JSON.stringify(game.players[newCurrentPlayerId])),
            mapState: JSON.parse(JSON.stringify(game.map)),
            spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
            gameLogLength: game.gameLog?.length || 0,
          };
        }
      } else {
        addGameLog(game, playerId, 'TF Mars: Gaia Project', 'skipped', pending.shipTileId);
      }
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // Eclipse 액션2: 선택한 연구 트랙 1칸 진행 (비용은 이미 use_ship_action에서 차감됨)
    socket.on('eclipse_advance_track', ({ gameId, trackId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingEclipseResearch;
      if (!pending || pending.playerId !== playerId) return;
      const player = game.players[playerId];
      const track = trackId as ResearchTrack;
      const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
      if (!tracks.includes(track) || player.research[track] >= 5) return;
      if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;
      const newLevel = (player.research[track] ?? 0) + 1;
      if (newLevel === 5 && countGreenFederations(player) < 1) return;

      saveActionStartState(game, playerId);
      if (newLevel === 5) spendGreenFederation(player);
      player.research[track]++;
      const levelNow = player.research[track];
      applyTrackLevelBonus(game, playerId, player, track, levelNow);
      applyRoundMissionScore(game, playerId, 'research_track');
      applyAdvancedTechTileEffect(game, playerId, 'research');
      addGameLog(game, playerId, 'Eclipse: Research', `${track} → Lv.${levelNow} (2K+3P)`, pending.shipTileId);
      game.pendingEclipseResearch = null;
      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // Eclipse 액션3: 6C 지불 후 소행성 광산 건설 (가이아포머 소모 없음)
    socket.on('eclipse_build_asteroid_mine', ({ gameId, tileId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingEclipseAsteroidMine;
      if (!pending || pending.playerId !== playerId) return;
      // Eclipse 3 후속 선택은 이미 턴 소모 후이므로 hasDoneMainAction 체크 제외
      const player = game.players[playerId];
      const tile = game.map.find(t => t.id === tileId);
      if (!tile || tile.type !== 'asteroid' || tile.structure !== null) return;
      let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
      if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
      const rangeTiles = getPlayerRangeTiles(game, playerId, true);
      if (rangeTiles.length === 0) return;
      const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
      if (minDist > baseRange) return;
      const rm7QualifyEclipse = qualifiesForNewSectorRoundMission(game, playerId, tileId);
      tile.structure = 'mine';
      tile.ownerId = playerId;
      game.pendingEclipseAsteroidMine = null;
      applyRoundMissionScore(game, playerId, 'build_mine');
      if (rm7QualifyEclipse) applyRoundMissionScore(game, playerId, 'new_sector');
      applyAdvancedTechTileEffect(game, playerId, 'build_mine');
      createPowerOffers(game, tile, playerId);
      addGameLog(game, playerId, 'Eclipse: Built mine on asteroid', '6C (no Gaiaformer)', tileId);
      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 트왈라잇 액션1: 보유 연방 중 하나 선택 후 해당 해택 재수령 (federation reward id)
    socket.on('confirm_twilight_federation', ({ gameId, rewardId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingTwilightFederation;
      if (!pending || pending.playerId !== playerId) return;
      const player = game.players[playerId];
      const myFed = getFederationEntries(player);
      if (!rewardId || !myFed.some((f) => f.rewardId === rewardId)) return;

      const normalReward = FEDERATION_REWARDS.find(r => r.id === rewardId);
      const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);

      if (normalReward) {
        player.score += normalReward.vp;
        if ('ore' in normalReward && normalReward.ore) player.ore += normalReward.ore;
        if ('credits' in normalReward && normalReward.credits) player.credits += normalReward.credits;
        if ('knowledge' in normalReward && normalReward.knowledge) player.knowledge += normalReward.knowledge;
        if ('qic' in normalReward && normalReward.qic) grantQic(game, playerId, normalReward.qic);
        if ('powerTokens' in normalReward && normalReward.powerTokens) player.power1 = (player.power1 || 0) + normalReward.powerTokens;
        addGameLog(game, playerId, 'Twilight: Federation benefit', normalReward.label, pending.shipTileId);
      } else if (shipReward) {
        switch (rewardId) {
          case 'ship-fed-tech':
            game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
            game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-4vp4k':
            addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
            player.knowledge = (player.knowledge || 0) + 4;
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-4vp1q2o':
            addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
            grantQic(game, playerId, 1); player.ore = (player.ore || 0) + 2;
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-8vp8c':
            addScore(game, playerId, 8, 'spaceships', { shipTileId: pending.shipTileId });
            player.credits = (player.credits || 0) + 8;
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-12vp':
            addScore(game, playerId, 12, 'spaceships', { shipTileId: pending.shipTileId });
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-7vp3p2t':
            addScore(game, playerId, 7, 'spaceships', { shipTileId: pending.shipTileId });
            if (player.faction === 'taklons') chargePowerTaklons(player, 3, true);
            else chargePower(player, 3);
            player.power1 = (player.power1 || 0) + 2;
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
            break;
          case 'ship-fed-mine-free':
          case 'ship-fed-3tf-mine':
            addGameLog(game, playerId, 'Twilight: Spaceship Fed', `${shipReward.label} (재수령은 즉시 효과만)`, pending.shipTileId);
            break;
          default:
            return;
        }
      } else {
        return;
      }
      game.pendingTwilightFederation = null;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // Transdim에 가이아 포머 설치
    socket.on('place_gaiaformer', ({ gameId, tileId, qicUsed }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      // TF Mars 액션2로 부여된 가이아 프로젝트 1회는 메인 액션 소모 없이 실행 가능
      const fromTFMars = game.pendingTFMarsGaiaProject?.playerId === playerId;
      if (!fromTFMars && game.hasDoneMainAction) return;

      // 액션 시작 시점 상태 저장
      saveActionStartState(game, playerId);

      const player = game.players[playerId];
      const tile = game.map.find(t => t.id === tileId);
      if (!tile || tile.type !== 'transdim' || tile.hasGaiaformer || tile.structure !== null) return;

      // 가이아 포머가 있어야 함 (발타크: QIC 전환으로 잠긴 포머 제외)
      if (getEffectiveGaiaformers(player) <= 0) return;

      // 거리 체크 (Nav+1, 보너스/트왈라잇 +3, 글린 +2 적용)
      let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
      if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
      if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
      if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
      const rangeTiles = getPlayerRangeTiles(game, playerId, true);
      if (rangeTiles.length === 0) return;

      const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
      const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

      // QIC 사용량 확인
      const qicToUse = qicUsed || 0;
      if (qicToUse < neededQIC) return; // 필요한 QIC보다 적으면 설치 불가
      if (player.qic < qicToUse) return; // 보유 QIC 부족

      // QIC 소모
      player.qic -= qicToUse;

      const gaiaLevel = player.research.gaiaProject || 0;
      let powerToMove = 0;

      // 가이아 포머 기술 레벨에 따라 파워 토큰 개수 결정
      if (gaiaLevel >= 1 && gaiaLevel < 3) {
        powerToMove = 6; // 1단계: 6개
      } else if (gaiaLevel >= 3 && gaiaLevel < 4) {
        powerToMove = 4; // 3단계: 4개
      } else if (gaiaLevel >= 4) {
        powerToMove = 3; // 4단계: 3개
      } else {
        return; // 가이아 포머 기술이 없으면 설치 불가
      }

      // 파워 토큰 이동: 1그릇->2그릇->3그릇 순
      let remaining = powerToMove;
      let movedFrom1 = Math.min(remaining, player.power1 || 0);
      player.power1 = (player.power1 || 0) - movedFrom1;
      remaining -= movedFrom1;

      let movedFrom2 = Math.min(remaining, player.power2 || 0);
      player.power2 = (player.power2 || 0) - movedFrom2;
      remaining -= movedFrom2;

      let movedFrom3 = Math.min(remaining, player.power3 || 0);
      player.power3 = (player.power3 || 0) - movedFrom3;
      remaining -= movedFrom3;

      if (remaining > 0) return; // 파워 토큰이 부족하면 설치 불가

      // 가이아 포머 구역으로 파워 토큰 이동
      player.gaiaformerPower = (player.gaiaformerPower || 0) + powerToMove;
      player.gaiaformers = (player.gaiaformers || 0) - 1;

      // 타일에 가이아 포머 설치
      tile.hasGaiaformer = true;

      const pendingGaia = game.pendingTFMarsGaiaProject;
      const isBonusGaia = pendingGaia?.shipTileId === 'bonus-gaia';
      const immediateBuildable = fromTFMars || isBonusGaia; // TF2 또는 보너스 즉포는 당장 건설 가능

      if (immediateBuildable) {
        // TF2/보너스: 즉시 성숙 → 가이아 행성으로 표시, 당장 광산 건설 가능. 가이아포머는 타일에 유지
        if (!player.pendingGaiaformerTiles) player.pendingGaiaformerTiles = [];
        player.pendingGaiaformerTiles.push(tileId);
        tile.type = 'gaia';
        // hasGaiaformer 유지 → 설치한 플레이어만 짓는지 확인 가능, 광산 짓을 때 회수
      } else {
        // 일반 배치: 이번 라운드에는 건설 불가, 다음 라운드에 성숙
        if (!player.gaiaformerPlacedThisRound) player.gaiaformerPlacedThisRound = [];
        player.gaiaformerPlacedThisRound.push(tileId);
      }

      game.pendingTFMarsGaiaProject = null;

      const qicText = qicToUse > 0 ? ` (${qicToUse} QIC for range)` : '';
      addGameLog(game, playerId, 'Placed Gaiaformer', `on Transdim (${powerToMove} power tokens moved to Gaiaformer area${qicText})`, tileId);
      log(`Player ${player.name} placed Gaiaformer on Transdim, moved ${powerToMove} power tokens to Gaiaformer area${qicText}`, 'game');

      if (fromTFMars && isBonusGaia) {
        // 보너스 타일 즉포 가이아: 타일만 반납하고 턴 유지 → 같은 턴에 해당 타일에 건설 가능
        const currentBonusTileId = player.bonusTile;
        if (currentBonusTileId) {
          if (!game.nextRoundBonusTiles) game.nextRoundBonusTiles = {};
          game.nextRoundBonusTiles[playerId] = currentBonusTileId;
          const oldTile = ALL_BONUS_TILES.find(t => t.id === currentBonusTileId);
          if (oldTile) game.availableBonusTiles.push(oldTile);
          player.bonusTile = null;
        }
        // 패스/라운드 진행 없음 → 현재 플레이어 턴 유지, 같은 액션에서 건설 가능
      } else if (fromTFMars) {
        // TF Mars 액션2로 수행한 가이아 프로젝트는 메인 액션 소모 없음 → 턴 유지
      } else {
        game.hasDoneMainAction = true;
      }
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 하이브(이비츠) 우주정거장 배치: 빈 공간(space/deep_space), 내 건물·우주정거장에서 거리 계산, Nav 범위 밖이면 2거리당 1 QIC. 다른 플레이어 위성 허용, 내 위성 있으면 불가. 라운드당 1회.
    socket.on('place_ivits_space_station', ({ gameId, tileId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      if (game.hasDoneMainAction) return;

      const player = game.players[playerId];
      if (player.faction !== 'ivits') return;
      if (player.usedIvitsSpaceStationThisRound) return;

      const tile = game.map.find(t => t.id === tileId);
      if (!tile) return;
      if (tile.type !== 'space' && tile.type !== 'deep_space') return;
      if (tile.structure !== null || tile.spaceStation) return;
      const satellites = game.satellites || {};
      const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
      if (onTile.includes(playerId)) return; // 내 위성 있는 칸에는 설치 불가

      const rangeTiles = getPlayerRangeTiles(game, playerId);
      if (rangeTiles.length === 0) return;
      let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
      if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
      const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
      const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
      if (player.qic < neededQIC) return;

      saveActionStartState(game, playerId);
      player.qic -= neededQIC;
      tile.spaceStation = { ownerId: playerId };
      player.usedIvitsSpaceStationThisRound = true;
      game.hasDoneMainAction = true;
      // 우주정거장은 건물이 아니므로 인접 파워 제안 생성 안 함
      addGameLog(game, playerId, 'Ivits: Space Station', neededQIC ? `${neededQIC} QIC (range)` : 'Placed (in Nav range)', tileId);
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 거리 5 보상 잊혀진 행성: 빈 우주(space/deep_space, 위성 없음)에 특수 광산 1개 배치. O 없음, 광산 보너스/패스/행성유형 포함, 업그레이드 불가.
    socket.on('place_lost_planet', ({ gameId, tileId, qicToSpend }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.pendingLostPlanet?.playerId !== playerId) return;

      const player = game.players[playerId];
      const tile = game.map.find(t => t.id === tileId);
      if (!tile) return;
      if (tile.type !== 'space' && tile.type !== 'deep_space') return;
      if (tile.structure != null || tile.spaceStation) return;
      const satellites = game.satellites || {};
      const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
      if (onTile.length > 0) return; // 위성 없는 빈공간만

      const rangeTiles = getPlayerRangeTiles(game, playerId);
      if (rangeTiles.length === 0) return;
      const baseRange = getRange(5) + (player.navigationBonus ?? 0); // Nav 5 = 거리 4, Nav+1 타일이면 navigationBonus 1
      const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
      const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
      const qicSpent = typeof qicToSpend === 'number' ? qicToSpend : 0;
      if (qicSpent !== neededQIC || player.qic < neededQIC) return;
      if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return;

      // 다카니안 의회: 잊혀진 행성도 신규 섹터/외각이면 1K 2C. 건물 배치지 변경에는 미적용.
      const hadStructureInThisSectorLP = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === tile.sector);
      const hadStructureInOuterLP = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector >= 20 && t.sector < 30);
      const isNewSectorLP = !hadStructureInThisSectorLP;
      const isNewOuterSectorLP = (tile.sector >= 20 && tile.sector < 30) && !hadStructureInOuterLP;
      const darkaniansPiBonusLP = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && (isNewSectorLP || isNewOuterSectorLP);

      const geodensTypesBeforeLostPlanet = getPlayerPlanetTypesForGeodens(game, playerId);
      const rm7QualifyLP = qualifiesForNewSectorRoundMission(game, playerId, tileId);
      player.qic -= neededQIC;
      tile.structure = 'lost_planet_mine';
      tile.ownerId = playerId;
      game.pendingLostPlanet = null;
      if (darkaniansPiBonusLP) {
        player.knowledge = (player.knowledge ?? 0) + 1;
        player.credits = (player.credits ?? 0) + 2;
        addGameLog(game, playerId, 'Darkanians PI', 'Lost planet in new sector/outer: +1K, +2C', tileId);
      }
      applyRoundMissionScore(game, playerId, 'build_mine');
      if (rm7QualifyLP) applyRoundMissionScore(game, playerId, 'new_sector');
      applyAdvancedTechTileEffect(game, playerId, 'build_mine');
      applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeLostPlanet);
      addGameLog(game, playerId, 'Lost Planet (Nav 5)', neededQIC ? `${neededQIC} QIC` : 'Placed', tileId);
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('upgrade_structure', ({ gameId, tileId, target }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executeUpgradeStructure(io, game, playerId, tileId, target);
    });

    socket.on('select_tech_tile', ({ gameId, techTileId, trackId }) => {
      const game = games.get(gameId);
      if (!game || !game.pendingTechTileSelection) return;

      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId || game.pendingTechTileSelection.playerId !== playerId) return;

      const player = game.players[playerId];
      const isShipTech = game.availableShipTechTileIds?.includes(techTileId);
      const techTile = ALL_TECH_TILES.find(t => t.id === techTileId) || SHIP_TECH_TILES.find(t => t.id === techTileId);
      if (!techTile) return;

      // 우주선 전용 기술 타일 선택 (3개 중 1개) — 획득 후 하단 풀 3개처럼 6개 트랙 중 원하는 트랙 1칸 진행
      if (isShipTech && SHIP_TECH_TILES.some(t => t.id === techTileId)) {
        if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
        if (techTileId === 'ship-tech-nav+1') {
          player.navigationBonus = (player.navigationBonus || 0) + 1;
          addGameLog(game, playerId, 'Ship Tech: Nav+1', 'Permanent +1 range');
        } else if (techTileId === 'ship-tech-1o3k') {
          player.ore += 1;
          player.knowledge += 3;
          addGameLog(game, playerId, 'Ship Tech: 1O 3K', '+1 Ore, +3 Knowledge');
        } else if (techTileId === 'ship-tech-2tf-mine') {
          player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
          player.nextMineFreeFromShipTech = true;
          addGameLog(game, playerId, 'Ship Tech: 2TF+Mine', '2 terraform steps, next mine free');
        }
        game.pendingTechTileSelection = null;
        game.availableShipTechTileIds = undefined;
        game.pendingShipTechTrackAdvance = { playerId };
        clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
        return;
      }

      // 트랙 타일: 배열 중 첫 번째로 일치하는 칸만 비움 (다른 플레이어는 남은 복사본 가져갈 수 있음)
      const trackEntry = Object.entries(game.techTilesByTrack).find(([_, val]) => {
        const arr = Array.isArray(val) ? val : (val ? [val] : []);
        return arr.some((t: { id?: string } | null) => t?.id === techTileId);
      });
      const isRebellionGainTrack = game.pendingTechTileSelection.structureType === 'rebellion_gain';
      if (trackEntry) {
        const [selectedTrack, arr] = trackEntry;
        const tiles = Array.isArray(arr) ? arr : (arr ? [arr] : []);
        const idx = tiles.findIndex((t: { id?: string } | null) => t?.id === techTileId);
        if (idx !== -1 && selectedTrack) {
          const track = selectedTrack as ResearchTrack;
          const canAdvance = player.research[track] < 5 && (track !== 'navigation' || canBalTakAdvanceNavigation(game, playerId));
          const newLevel = canAdvance ? (player.research[track] ?? 0) + 1 : 0;
          const isAdvancedTile = techTileId.startsWith('adv-') || Object.values(game.advancedTechTilesByTrack || {}).some((t: { id?: string } | null) => t?.id === techTileId);
          const greenNeeded = (isAdvancedTile ? 1 : 0) + (newLevel === 5 ? 1 : 0);
          if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) return;
          for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
          if (canAdvance) {
            player.research[track]++;
            const levelNow = player.research[track];
            applyTrackLevelBonus(game, playerId, player, track, levelNow);
            applyRoundMissionScore(game, playerId, 'research_track');
            if (isRebellionGainTrack) {
              addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', `${techTileId}, ${track} → Lv.${levelNow}`);
              log(`Player ${player.name} (Rebellion) gained tech tile ${techTileId} and advanced ${track} to level ${levelNow}`, 'game');
            } else {
              addGameLog(game, playerId, 'Gained Tech Tile', `${techTileId} and advanced ${track} to L${levelNow}`);
              log(`Player ${player.name} gained tech tile ${techTileId} and advanced ${track} track to level ${newLevel}`, 'game');
            }
          } else if (isRebellionGainTrack) {
            addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', techTileId);
          }
          if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
          (game.techTilesByTrack[track] as (typeof tiles[0] | null)[])[idx] = null;
        }
      } else {
        const isRebellionGain = game.pendingTechTileSelection.structureType === 'rebellion_gain';
        const hasTrackId = trackId != null && String(trackId).trim() !== '';
        if (!hasTrackId && !isRebellionGain) {
          log(`Player ${player.name} selected pool tile but no trackId provided (trackId=${JSON.stringify(trackId)})`, 'game');
          return;
        }
        const selectedTrack = (hasTrackId ? trackId : null) as ResearchTrack | null;
        const validTracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
        const trackOk = selectedTrack && validTracks.includes(selectedTrack);
        const canAdvancePool = trackOk && player.research[selectedTrack] < 5 && (selectedTrack !== 'navigation' || canBalTakAdvanceNavigation(game, playerId));
        const newLevelPool = canAdvancePool ? (player.research[selectedTrack] ?? 0) + 1 : 0;
        const isAdvancedPool = techTileId.startsWith('adv-');
        const greenNeededPool = (isAdvancedPool ? 1 : 0) + (newLevelPool === 5 ? 1 : 0);
        if (greenNeededPool > 0 && countGreenFederations(player) < greenNeededPool) return;
        for (let i = 0; i < greenNeededPool; i++) spendGreenFederation(player);
        if (canAdvancePool) {
          player.research[selectedTrack]++;
          const newLevel = player.research[selectedTrack];
          applyTrackLevelBonus(game, playerId, player, selectedTrack, newLevel);
          applyRoundMissionScore(game, playerId, 'research_track');
          if (isRebellionGain) {
            addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', `${techTileId} from pool, ${selectedTrack} → Lv.${newLevel}`);
            log(`Player ${player.name} (Rebellion) gained tech tile ${techTileId} from pool and advanced ${selectedTrack} to level ${newLevel}`, 'game');
          } else {
            addGameLog(game, playerId, 'Gained Tech Tile', `${techTileId} from pool and advanced ${selectedTrack} to L${newLevel}`);
            log(`Player ${player.name} gained tech tile ${techTileId} from pool and advanced ${selectedTrack} track to level ${newLevel}`, 'game');
          }
        } else if (isRebellionGain && !selectedTrack) {
          addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', techTileId);
        }
        if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
        // 풀에서 해당 칸만 빈 칸으로 표시 (splice로 당기지 않음)
        const poolIndex = game.techTilesPool.findIndex(t => t && t.id === techTileId);
        if (poolIndex !== -1) (game.techTilesPool as (typeof game.techTilesPool[0] | null)[])[poolIndex] = null;
      }

      // 즉시 효과 처리
      if (techTileId === 'tech-imm-7vp') {
        player.score += 7;
        addGameLog(game, playerId, 'Gained Tech Tile', 'tech-imm-7vp: +7 VP');
        log(`Player ${player.name} gained 7 VP from tech tile`, 'game');
      } else if (techTileId === 'tech-imm-1o-1q') {
        player.ore = (player.ore || 0) + 1;
        grantQic(game, playerId, 1);
        addGameLog(game, playerId, 'Gained Tech Tile', 'tech-imm-1o-1q: +1 Ore, +1 QIC');
        log(`Player ${player.name} gained 1 Ore and 1 QIC from tech tile (Ore: ${player.ore}, QIC: ${player.qic})`, 'game');
      } else if (techTileId === 'tech-imm-1k-planet') {
        const playerStructures = game.map.filter(t => t.ownerId === playerId);
        const planetTypes = new Set(
          playerStructures
            .filter(t => t.type !== 'space' && t.type !== 'deep_space')
            .map(t => t.type)
        );
        player.knowledge += planetTypes.size;
        addGameLog(game, playerId, 'Gained Tech Tile', `tech-imm-1k-planet: +${planetTypes.size} Knowledge`);
        log(`Player ${player.name} gained ${planetTypes.size} Knowledge from tech tile (${planetTypes.size} planet types)`, 'game');
      } else {
        addGameLog(game, playerId, 'Gained Tech Tile', techTileId);
      }

      // 아이타 의회: 기술 타일 선택 후 남은 가이아포머 토큰 처리 (4개 이상이면 다시 묻기, 아니면 1그릇 복귀 후 진행)
      if (game.pendingTechTileSelection.structureType === 'itars_pi_exchange') {
        const remaining = game.itarsGaiaformerRemainingAfterTech ?? 0;
        game.itarsGaiaformerRemainingAfterTech = undefined;
        if (remaining >= 4) {
          game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remaining };
        } else {
          player.power1 = (player.power1 || 0) + remaining;
          if (remaining > 0) addGameLog(game, playerId, 'Itars PI', `${remaining} tokens → Bowl 1`);
          proceedAfterItarsGaiaformerOrTerran(game);
        }
      }

      game.pendingTechTileSelection = null;
      game.availableShipTechTileIds = undefined;
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    /** 아이타 의회: 가이아포머 토큰 4개 제거하고 기술 타일 1개 vs 그만하고 나머지 1그릇 복귀 */
    socket.on('itars_gaiaformer_exchange_choice', ({ gameId, takeTile }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingItarsGaiaformerExchange;
      if (!pending || pending.playerId !== playerId) return;
      const player = game.players[playerId];
      const tokensRemaining = pending.tokensRemaining;
      game.pendingItarsGaiaformerExchange = null;

      if (takeTile && tokensRemaining >= 4) {
        const after = tokensRemaining - 4;
        game.itarsGaiaformerRemainingAfterTech = after;
        game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'itars_pi_exchange' };
        addGameLog(game, playerId, 'Itars PI', '4 tokens → 1 Tech Tile (choose tile + track)');
        clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
        return;
      }
      player.power1 = (player.power1 || 0) + tokensRemaining;
      if (tokensRemaining > 0) addGameLog(game, playerId, 'Itars PI', `${tokensRemaining} tokens → Bowl 1`);
      proceedAfterItarsGaiaformerOrTerran(game);
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('advance_tech', ({ gameId, trackId }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executeAdvanceTech(io, game, playerId, trackId);
    });


    socket.on('use_power_action', ({ gameId, actionId }) => {
      const game = games.get(gameId); if (!game || game.hasDoneMainAction) return;
      const action = game.powerActions.find(a => a.id === actionId);
      if (!action || action.isUsed) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;

      // 액션 시작 시점 상태 저장 (테라포밍 액션은 제외 - hasDoneMainAction을 설정하지 않으므로)
      // 하지만 리셋을 위해 상태 저장은 필요함
      saveActionStartState(game, playerId);

      const player = game.players[playerId];
      const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
      const powerCost = action.costType === 'power' ? (hasNevlasPI ? Math.ceil((action.cost as number) / 2) : (action.cost as number)) : 0;
      if (action.costType === 'power' && (player.power3 ?? 0) < powerCost) return;
      if (action.costType === 'qic' && (player.qic ?? 0) < action.cost) return;

      if (action.costType === 'power') { player.power3 = (player.power3 ?? 0) - powerCost; player.power1 = (player.power1 ?? 0) + powerCost; }
      else { player.qic = (player.qic ?? 0) - action.cost; }

      // Simplified rewards
      if (actionId === 'gain-3-knowledge') player.knowledge += 3;
      if (actionId === 'gain-2-knowledge') player.knowledge += 2;
      if (actionId === 'gain-2-ore') player.ore += 2;
      if (actionId === 'gain-7-credits') player.credits += 7;
      if (actionId === 'gain-2-tokens') player.power1 += 2;

      // 테라포밍 단계 추가
      if (actionId === 'gain-1-step') {
        player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
        log(`Player ${player.name} gained 1 terraform step (Total: ${player.pendingTerraformSteps})`, 'game');
      }
      if (actionId === 'gain-2-steps') {
        player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
        log(`Player ${player.name} gained 2 terraform steps (Total: ${player.pendingTerraformSteps})`, 'game');
      }

      action.isUsed = true;
      // 테라포밍 액션은 메인 액션이 아니므로 hasDoneMainAction을 true로 설정하지 않음
      // 대신 광산 건설 시 사용되도록 pendingTerraformSteps에 저장
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 하드쉬 할라 의회 프리 액션: 4C→1QIC, 4C→1K, 3C→1O (Free Action — 크레딧 있으면 반복 사용 가능)
    socket.on('use_hadsch_hallas_pi_action', ({ gameId, actionId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      const player = game.players[playerId];
      if (player.faction !== 'hadsch_hallas') return;
      const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
      if (!hasPI || !player.hadschHallasPIActions?.length) return;
      const action = player.hadschHallasPIActions.find(a => a.id === actionId);
      if (!action) return;
      if ((player.credits ?? 0) < action.costCredits) return;
      player.credits = (player.credits ?? 0) - action.costCredits;
      if (actionId === 'hh-4c-1qic') grantQic(game, playerId, 1);
      else if (actionId === 'hh-4c-1k') player.knowledge = (player.knowledge ?? 0) + 1;
      else if (actionId === 'hh-3c-1o') player.ore = (player.ore ?? 0) + 1;
      else return;
      addGameLog(game, playerId, 'Hadsch Hallas PI', action.label, undefined);
      log(`Player ${player.name} used Hadsch Hallas PI action: ${action.label}`, 'game');
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 발타크 프리 액션: 1 포머 → 1 QIC (사용한 포머는 다음 라운드 시작까지 잠김, 가이아 토큰 표기)
    socket.on('use_bal_tak_gaiaformer_to_qic', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (player?.faction !== 'bal_tak') return;
      if (getEffectiveGaiaformers(player) < 1) return;

      player.balTakGaiaformersUsedForQic = (player.balTakGaiaformersUsedForQic ?? 0) + 1;
      grantQic(game, playerId, 1);
      addGameLog(game, playerId, "Bal T'aks: 1 Gaiaformer → 1 QIC", '1 포머 사용 (다음 라운드까지 복귀)', undefined);
      log(`Player ${player.name} (Bal T'aks) used 1 Gaiaformer for 1 QIC (locked until next round)`, 'game');
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('convert_resource', ({ gameId, type, useBrain }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      const isTaklons = player.faction === 'taklons';
      const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');

      // 네뷸라 전용: 3그릇 토큰 → 가이아포머 공간 + 1K (의회 시 2P→1K)
      if (type === '1power-to-1k-gaiaformer') {
        if (player.faction !== 'nevlas') return;
        if (hasNevlasPI) {
          if ((player.power3 ?? 0) < 2) return;
          player.power3! -= 2;
          player.power1 = (player.power1 ?? 0) + 0; // 토큰은 가이아포머로만
          player.gaiaformerPower = (player.gaiaformerPower ?? 0) + 2;
          player.knowledge = (player.knowledge ?? 0) + 1;
          addGameLog(game, playerId, 'Nebula PI', '2P → Gaiaformer + 1K', undefined);
        } else {
          if ((player.power3 ?? 0) < 1) return;
          player.power3! -= 1;
          player.gaiaformerPower = (player.gaiaformerPower ?? 0) + 1;
          player.knowledge = (player.knowledge ?? 0) + 1;
          addGameLog(game, playerId, 'Nebula', '1P → Gaiaformer + 1K', undefined);
        }
        clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
        return;
      }

      if (type === '3power-to-1ore') {
        if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
          player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.ore = (player.ore ?? 0) + 1;
        } else if (isTaklons) {
          if (!canSpendTaklonsPower(player, 3, 3)) return;
          if (!spendTaklonsPower(player, 3, 3, useBrain ?? false)) return;
          player.ore = (player.ore ?? 0) + 1;
        } else if (player.power3 >= 3) {
          player.power3 -= 3; player.power1 += 3; player.ore += 1;
        }
      }
      else if (type === '3power-to-2ore') {
        if (!hasNevlasPI || (player.power3 ?? 0) < 3) return;
        player.power3! -= 3; player.power1 = (player.power1 ?? 0) + 3; player.ore = (player.ore ?? 0) + 2;
      }
      else if (type === '2power-to-1ore-1credit') {
        if (!hasNevlasPI || (player.power3 ?? 0) < 2) return;
        player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.ore = (player.ore ?? 0) + 1; player.credits = (player.credits ?? 0) + 1;
      }
      else if (type === '4power-to-1qic') {
        if (player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1) return;
        if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
          player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; grantQic(game, playerId, 1);
        } else if (isTaklons) {
          if (!canSpendTaklonsPower(player, 3, 4)) return;
          if (!spendTaklonsPower(player, 3, 4, useBrain ?? false)) return;
          grantQic(game, playerId, 1);
        } else if (player.power3 >= 4) {
          player.power3 -= 4; player.power1 += 4; grantQic(game, playerId, 1);
        }
      }
      else if (type === '1power-to-1credit') {
        if (hasNevlasPI && (player.power3 ?? 0) >= 1) {
          player.power3! -= 1; player.power1 = (player.power1 ?? 0) + 1; player.credits = (player.credits ?? 0) + 2;
        } else if (isTaklons) {
          if (!canSpendTaklonsPower(player, 3, 1)) return;
          if (!spendTaklonsPower(player, 3, 1, useBrain ?? false)) return;
          player.credits += 1;
        } else if (player.power3 >= 1) {
          player.power3 -= 1; player.power1 += 1; player.credits += 1;
        }
      }
      else if (type === '1knowledge-to-1credit' && player.knowledge >= 1) { player.knowledge -= 1; player.credits += 1; }
      else if (type === '1qic-to-1ore' && (player.qic ?? 0) >= 1) { player.qic -= 1; player.ore = (player.ore ?? 0) + 1; }
      else if (type === '1ore-to-1credit' && (player.ore ?? 0) >= 1) { player.ore -= 1; player.credits = (player.credits ?? 0) + 1; }
      else if (type === '1ore-to-1token' && (player.ore ?? 0) >= 1) { player.ore -= 1; player.power1 = (player.power1 ?? 0) + 1; }
      else if (type === '4power-to-1knowledge') {
        if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
          player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.knowledge = (player.knowledge ?? 0) + 1;
        } else if (isTaklons) {
          if (!canSpendTaklonsPower(player, 3, 4)) return;
          if (!spendTaklonsPower(player, 3, 4, useBrain ?? false)) return;
          player.knowledge = (player.knowledge ?? 0) + 1;
        } else if (player.power3 >= 4) {
          player.power3 -= 4; player.power1 += 4; player.knowledge = (player.knowledge ?? 0) + 1;
        }
      }

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('burn_power', ({ gameId, moveBrainToBowl3 }: { gameId: string; moveBrainToBowl3?: boolean }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];

      if (player.power2 >= 2) {
        const isTaklonsBrainIn2 = player.faction === 'taklons' && player.brainStoneBowl === 2 && !player.brainStoneInGaia;
        if (isTaklonsBrainIn2) {
          if (moveBrainToBowl3 === true) {
            player.brainStoneBowl = 3;
            player.power2 -= 2;
            player.power3 += 1;
            log(`Player ${player.name} burned 2 power (Bowl II -> III, moved Brain to III)`, 'game');
          } else if (moveBrainToBowl3 === false && (player.power2 ?? 0) >= 3) {
            player.power2 -= 2;
            player.power3 += 1;
            log(`Player ${player.name} burned 2 power (Bowl II -> III, 2 regular tokens)`, 'game');
          } else {
            return;
          }
        } else {
          player.power2 -= 2;
          player.power3 += 1;
          if (player.faction === 'itars') {
            player.itarsPendingBowl1Tokens = (player.itarsPendingBowl1Tokens ?? 0) + 1;
            log(`Player ${player.name} (Itars) burned 2 power: 1 token to Bowl III, 1 to pending (→Bowl I next round)`, 'game');
          } else {
            log(`Player ${player.name} burned 2 power (Bowl II -> III)`, 'game');
          }
        }
      }

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 고급 기술 타일 획득 시: 기술 타일 선택 대기 중에만 가능. 트랙 타일은 해당 트랙 4/5, 7번째(추가) 타일은 25 VP+ 또는 우주선 3개 입장
    socket.on('select_advanced_tech_tile', ({ gameId, advancedTileId, trackId }: { gameId: string; advancedTileId: string; trackId?: ResearchTrack }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return;

      const player = game.players[playerId];
      if (countGreenFederations(player) < 1) return;
      const uncoveredNormal = (player.techTiles || []).filter(
        (id) => !(player.coveredTechTiles || []).includes(id) && !id.startsWith('adv-')
      );
      if (uncoveredNormal.length < 1) return;

      if (trackId != null) {
        // 트랙 4–5 사이 고급 타일
        const advTile = game.advancedTechTilesByTrack?.[trackId];
        if (!advTile || advTile.id !== advancedTileId) return;
        const level = player.research?.[trackId] ?? 0;
        if (level < 4) return;
        game.pendingAdvancedTechCover = { playerId, advancedTileId, trackId };
      } else {
        // 7번째(추가) 고급 타일: 조건 25 VP+ 또는 우주선 3개 입장
        const extra = game.extraAdvancedTechTile;
        if (!extra || extra.id !== advancedTileId) return;
        const cond = game.extraAdvancedTechCondition;
        if (cond === '25vp') {
          if ((player.score ?? 0) < 25) return;
        } else {
          const entered = (player.spaceshipsEntered ?? []).length;
          if (entered < 3) return;
        }
        game.pendingAdvancedTechCover = { playerId, advancedTileId };
      }
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    // 고급 타일로 덮을 일반 타일 선택 확정 → 연방 1개 소모, 덮기, 고급 타일 추가, 즉시 효과, 트랙 1칸 선택 대기
    socket.on('confirm_advanced_tech_cover', ({ gameId, coverTileId }: { gameId: string; coverTileId: string }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingAdvancedTechCover;
      if (!pending || pending.playerId !== playerId) return;

      const player = game.players[playerId];
      if (!player.techTiles?.includes(coverTileId) || coverTileId.startsWith('adv-')) return;
      if (player.coveredTechTiles?.includes(coverTileId)) return;
      if (countGreenFederations(player) < 1) return;

      spendGreenFederation(player);
      if (!player.coveredTechTiles) player.coveredTechTiles = [];
      player.coveredTechTiles.push(coverTileId);
      if (!player.techTiles.includes(pending.advancedTileId)) player.techTiles.push(pending.advancedTileId);

      applyAdvancedTileImmediateEffect(game, playerId, pending.advancedTileId);

      addGameLog(game, playerId, 'Advanced Tech Tile', `Covered ${coverTileId} → ${pending.advancedTileId}`);
      game.pendingTechTileSelection = null;
      game.pendingAdvancedTechCover = null;
      game.availableShipTechTileIds = undefined;
      game.pendingAdvancedTechTrackAdvance = { playerId };
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    function applyAdvancedTileImmediateEffect(game: GaiaGameState, playerId: string, tileId: string) {
      const player = game.players[playerId];
      if (!player) return;
      if (tileId === 'adv-imm-1o-sector') {
        const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
        player.ore += sectors.size;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size} Ore (1 per sector)`);
      } else if (tileId === 'adv-imm-4vp-ts') {
        const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
        player.score += tsCount * 4;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${tsCount * 4} VP (4 per TS)`);
      } else if (tileId === 'adv-imm-2vp-mine') {
        const mineCount = getMineCountForPassAndBonuses(game, playerId);
        player.score += mineCount * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${mineCount * 2} VP (2 per mine)`);
      } else if (tileId === 'adv-imm-2vp-sector') {
        const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
        player.score += sectors.size * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size * 2} VP (2 per sector)`);
      } else if (tileId === 'adv-imm-4vp-outer') {
        const outerCount = game.map.filter(t => t.ownerId === playerId && t.structure && t.sector >= 20 && t.sector < 30).length;
        player.score += outerCount * 4;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${outerCount * 4} VP (4 per outer sector)`);
      } else if (tileId === 'adv-imm-6vp-big') {
        const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
        player.score += bigCount * 6;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${bigCount * 6} VP (6 per big building)`);
      } else if (tileId === 'adv-imm-2vp-gaia') {
        const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
        player.score += gaiaCount * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${gaiaCount * 2} VP (2 per Gaia)`);
      } else if (tileId === 'adv-imm-5vp-fed') {
        const fedCount = getFederationEntries(player).length;
        player.score += fedCount * 5;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${fedCount * 5} VP (5 per federation)`);
      }
    }

    socket.on('gain_tech_tile', ({ gameId, tileId }) => {
      const game = games.get(gameId); if (!game) return;
      // 보너스 선택 단계에서는 기술 타일 획득 불가
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];

      if (player.techTiles.includes(tileId)) return;
      // 고급 기술 타일 획득 시 초록 연방 1개 소모 (없으면 획득 불가)
      if (tileId.startsWith('adv-')) {
        if (countGreenFederations(player) < 1) return;
        spendGreenFederation(player);
      }
      player.techTiles.push(tileId);

      // Immediate effects
      if (tileId === 'tech-imm-7vp') {
        player.score += 7;
      } else if (tileId === 'tech-imm-1k-planet') {
        const planetTypes = new Set(game.map.filter(t => t.ownerId === playerId && t.type !== 'space').map(t => t.type));
        player.knowledge += planetTypes.size;
      } else if (tileId === 'tech-imm-1o-1q') {
        player.ore += 1;
        grantQic(game, playerId, 1);
      }
      // 고급 타일: 일시불 자원
      else if (tileId === 'adv-imm-1o-sector') {
        const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
        player.ore += sectors.size;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size} Ore (1 per sector)`);
      }
      // 고급 타일: 일시불 점수
      else if (tileId === 'adv-imm-4vp-ts') {
        const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
        player.score += tsCount * 4;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${tsCount * 4} VP (4 per TS)`);
      }
      else if (tileId === 'adv-imm-2vp-mine') {
        const mineCount = getMineCountForPassAndBonuses(game, playerId);
        player.score += mineCount * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${mineCount * 2} VP (2 per mine)`);
      }
      else if (tileId === 'adv-imm-2vp-sector') {
        const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
        player.score += sectors.size * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size * 2} VP (2 per sector)`);
      }
      else if (tileId === 'adv-imm-4vp-outer') {
        const outerCount = game.map.filter(t => t.ownerId === playerId && t.structure && t.sector >= 20 && t.sector < 30).length;
        player.score += outerCount * 4;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${outerCount * 4} VP (4 per outer sector)`);
      }
      else if (tileId === 'adv-imm-6vp-big') {
        const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
        player.score += bigCount * 6;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${bigCount * 6} VP (6 per big building)`);
      }
      else if (tileId === 'adv-imm-2vp-gaia') {
        const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
        player.score += gaiaCount * 2;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${gaiaCount * 2} VP (2 per Gaia)`);
      }
      else if (tileId === 'adv-imm-5vp-fed') {
        const fedCount = getFederationEntries(player).length;
        player.score += fedCount * 5;
        addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${fedCount * 5} VP (5 per federation)`);
      }

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('use_tech_action', ({ gameId, tileId }) => {
      const game = games.get(gameId); if (!game || game.hasDoneMainAction) return;
      // 보너스 선택 단계에서는 기술 타일 액션 사용 불가
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;

      // 액션 시작 시점 상태 저장
      saveActionStartState(game, playerId);
      const player = game.players[playerId];

      if (!player.techTiles.includes(tileId) || player.usedTechActions.includes(tileId)) return;
      if (isTechTileCovered(player, tileId)) return;

      // 기존 타일
      if (tileId === 'tech-act-4p') {
        if (player.faction === 'taklons') chargePowerTaklons(player, 4, true);
        else chargePower(player, 4);
        player.usedTechActions.push(tileId);
        game.hasDoneMainAction = true;
      }
      // 고급 타일: 액션으로 자원 얻기
      else if (tileId === 'adv-act-3k') {
        player.knowledge += 3;
        player.usedTechActions.push(tileId);
        game.hasDoneMainAction = true;
        addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Knowledge');
      }
      else if (tileId === 'adv-act-3o') {
        player.ore += 3;
        player.usedTechActions.push(tileId);
        game.hasDoneMainAction = true;
        addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Ore');
      }
      else if (tileId === 'adv-act-1q-5c') {
        grantQic(game, playerId, 1);
        player.credits += 5;
        player.usedTechActions.push(tileId);
        game.hasDoneMainAction = true;
        addGameLog(game, playerId, 'Used Tech Action', 'Gained 1 QIC and 5 Credits');
      }

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    });

    socket.on('tinkeroid_choose_special', ({ gameId, specialId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingTinkeroidSpecialChoice;
      if (!pending || pending.playerId !== playerId || pending.round !== game.roundNumber) return;
      if (!pending.options.includes(specialId)) return;

      const player = game.players[playerId];
      player.tinkeroidRoundSpecialId = specialId;
      player.tinkeroidsChosenSpecialIds = [...(player.tinkeroidsChosenSpecialIds ?? []), specialId];

      game.pendingTinkeroidSpecialChoice = null;
      addGameLog(game, playerId, 'Tinkeroid Special', `Selected ${specialId} for Round ${game.roundNumber}`);
      log(`Player ${player.name} (Tinkeroids) selected special ${specialId} for round ${game.roundNumber}`, 'game');

      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

      // 선택 완료 후 라운드 턴 시작
      helperStartNewRoundTurn(io, game);
    });

    socket.on('use_special_action', ({ gameId, actionId }) => {
      const game = games.get(gameId); if (!game || game.hasDoneMainAction) return;
      // 보너스 선택 단계에서는 특수 액션 사용 불가
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (player.usedSpecialActions.includes(actionId)) return;

      if (actionId === 'academy-qic') {
        const rightAcademyCount = getAcademyRightCount(game, playerId);
        if (rightAcademyCount >= 1) {
          if (player.faction === 'bal_tak') {
            player.credits = (player.credits ?? 0) + 4;
            addGameLog(game, playerId, 'Academy (Right)', '4 C (Special Action)', undefined);
          } else {
            grantQic(game, playerId, 1);
            addGameLog(game, playerId, 'Academy (Right)', '1 QIC (Special Action)', undefined);
          }
          player.usedSpecialActions.push(actionId);
          game.hasDoneMainAction = true;
        }
      }
      // 글린 기본 특수 액션: 라운드당 1회 +2 Nav (다음 행동에 적용, 메인 액션 소모 안 함)
      if (actionId === 'gleens-2nav' && player.faction === 'gleens') {
        player.gleensNavBonusActive = true;
        player.usedSpecialActions.push(actionId);
        addGameLog(game, playerId, 'Gleens: Special', '+2 Nav (next action)', undefined);
      }
      // 스페이스 자이언트: 매 라운드 1회 2테라포밍 단계 획득 (보너스 1TF 타일과 동일하게 메인 액션 소모 안 함)
      if (actionId === 'space_giants-2tf' && player.faction === 'space_giants') {
        if (!player.usedSpecialActions) player.usedSpecialActions = [];
        player.usedSpecialActions.push(actionId);
        player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
        addGameLog(game, playerId, 'Space Giants: Special', '+2 Terraform steps', undefined);
        log(`Player ${player.name} (Space Giants) used special: +2 TF (Total: ${player.pendingTerraformSteps})`, 'game');
      }

      // 팅커로이드: 라운드 시작 시 고른 Special 1회 사용
      const tinkeroidIds = ['tinkeroid-1tf-mine', 'tinkeroid-1qic', 'tinkeroid-4power', 'tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
      if (player.faction === 'tinkeroids' && tinkeroidIds.includes(actionId) && player.tinkeroidRoundSpecialId === actionId && !player.usedSpecialActions.includes('tinkeroid-special')) {
        if (!player.usedSpecialActions) player.usedSpecialActions = [];
        player.usedSpecialActions.push('tinkeroid-special');
        if (actionId === 'tinkeroid-1tf-mine') {
          player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
          addGameLog(game, playerId, 'Tinkeroid: Special', '1 TF + Build Mine (bonus tile)', undefined);
          log(`Player ${player.name} (Tinkeroid) used special: +1 TF`, 'game');
        } else if (actionId === 'tinkeroid-1qic') {
          grantQic(game, playerId, 1);
          addGameLog(game, playerId, 'Tinkeroid: Special', '1 QIC', undefined);
        } else if (actionId === 'tinkeroid-4power') {
          player.power1 = (player.power1 || 0) + 4;
          addGameLog(game, playerId, 'Tinkeroid: Special', '4 Power', undefined);
        } else if (actionId === 'tinkeroid-3k') {
          player.knowledge = (player.knowledge ?? 0) + 3;
          addGameLog(game, playerId, 'Tinkeroid: Special', '3 Knowledge', undefined);
        } else if (actionId === 'tinkeroid-2qic') {
          grantQic(game, playerId, 2);
          addGameLog(game, playerId, 'Tinkeroid: Special', '2 QIC', undefined);
        } else if (actionId === 'tinkeroid-3tf-mine') {
          player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
          addGameLog(game, playerId, 'Tinkeroid: Special', '3 TF + Build Mine', undefined);
          log(`Player ${player.name} (Tinkeroid) used special: +3 TF`, 'game');
        }
      }

      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 팅커로이드: 라운드 시작 시 고른 Special 액션 확정 (한 옵션만 남으면 자동 지정됨)
    socket.on('tinkeroid_choose_special', ({ gameId, actionId }: { gameId: string; actionId: string }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingTinkeroidSpecialChoice;
      if (!pending || pending.playerId !== playerId) return;
      const player = game.players[playerId];
      if (player.faction !== 'tinkeroids') return;
      if (!pending.options.includes(actionId)) return;

      const chosen = player.tinkeroidsChosenSpecialIds ?? [];
      player.tinkeroidRoundSpecialId = actionId;
      player.tinkeroidsChosenSpecialIds = [...chosen, actionId];
      game.pendingTinkeroidSpecialChoice = null;
      addGameLog(game, playerId, 'Tinkeroid: Round Special', `Round ${game.roundNumber}: ${actionId}`, undefined);
      log(`Tinkeroid: ${player.name} chose special for round ${game.roundNumber}: ${actionId}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 엠바스(Ambas): 의회 건설 후 Special — 의회와 광산 위치 교체 (라운드당 1회). 배치지 변경이므로 RM7·다카니안 의회 보너스 미적용.
    socket.on('ambas_swap_pi_mine', ({ gameId, mineTileId }: { gameId: string; mineTileId: string }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
      if (player.faction !== 'ambas') return;
      if (player.usedSpecialActions?.includes('ambas-swap-pi-mine')) return;

      const piTile = game.map.find(t => t.ownerId === playerId && t.structure === 'planetary_institute');
      const mineTile = game.map.find(t => t.id === mineTileId && t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine'));
      if (!piTile || !mineTile) return;

      const prevPI = piTile.structure;
      const prevMine = mineTile.structure;
      piTile.structure = prevMine;
      mineTile.structure = prevPI;
      if (!player.usedSpecialActions) player.usedSpecialActions = [];
      player.usedSpecialActions.push('ambas-swap-pi-mine');
      game.hasDoneMainAction = true;
      addGameLog(game, playerId, 'Ambas: Special', 'PI ↔ Mine 위치 교체', mineTileId);
      log(`Player ${player.name} (Ambas) swapped PI with Mine`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 매안(Bescods) Special: 가장 낮은 트랙 중 하나 +1 (라운드당 1회, 비용 없음)
    socket.on('bescods_advance_lowest_track', ({ gameId, trackId }: { gameId: string; trackId: ResearchTrack }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
      if (player.faction !== 'bescods') return;
      if (player.usedSpecialActions?.includes('bescods-advance-lowest')) return;

      const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
      if (!tracks.includes(trackId)) return;
      const levels = tracks.map(t => player.research?.[t] ?? 0);
      const minLevel = Math.min(...levels);
      const currentLevel = player.research?.[trackId] ?? 0;
      if (currentLevel !== minLevel || currentLevel >= 5) return;
      if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;

      saveActionStartState(game, playerId);
      if (!player.usedSpecialActions) player.usedSpecialActions = [];
      player.usedSpecialActions.push('bescods-advance-lowest');
      player.research[trackId] = currentLevel + 1;
      const newLevel = player.research[trackId];
      applyTrackLevelBonus(game, playerId, player, trackId, newLevel);
      applyRoundMissionScore(game, playerId, 'research_track');
      addGameLog(game, playerId, 'Bescods/매안: Special', `가장 낮은 트랙 +1 → ${trackId} Lv.${newLevel}`, undefined);
      log(`Player ${player.name} (Bescods) advanced lowest track ${trackId} to Lv.${newLevel}`, 'game');
      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 모웨이드(Moweyip) Special: 의회 보유 시 링 놓기 — 본인 건물 중 링 없는 것 하나에 링 배치 (+2 파워 수신/연방)
    socket.on('moweyip_place_ring', ({ gameId, tileId }: { gameId: string; tileId: string }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
      if (player.faction !== 'moweyip') return;
      if (player.usedSpecialActions?.includes('moweyip-place-ring')) return;
      if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return;

      const tile = game.map.find(t => t.id === tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship');
      if (!tile || tile.moweyipRing) return;

      tile.moweyipRing = true;
      if (!player.usedSpecialActions) player.usedSpecialActions = [];
      player.usedSpecialActions.push('moweyip-place-ring');
      game.hasDoneMainAction = true;
      addGameLog(game, playerId, 'Moweyip: Special', `링 놓기 → ${tile.structure} (+2 파워)`, tileId);
      log(`Player ${player.name} (Moweyip) placed ring on ${tile.structure}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 파이락(Firaks) Special: 의회 보유 시 연구소 1개→교역소 다운그레이드 + 아무 트랙 1칸 (라운드당 1회)
    socket.on('firaks_downgrade', ({ gameId, tileId, trackId }: { gameId: string; tileId: string; trackId: ResearchTrack }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const player = game.players[playerId];
      if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
      if (player.faction !== 'firaks') return;
      if (player.usedSpecialActions?.includes('firaks-downgrade')) return;
      if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return;

      const tile = game.map.find(t => t.id === tileId && t.ownerId === playerId && t.structure === 'research_lab');
      if (!tile) return;

      const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
      if (!tracks.includes(trackId)) return;
      const currentLevel = player.research?.[trackId] ?? 0;
      if (currentLevel >= 5) return;
      if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;

      saveActionStartState(game, playerId);
      tile.structure = 'trading_station';
      if (!player.usedSpecialActions) player.usedSpecialActions = [];
      player.usedSpecialActions.push('firaks-downgrade');
      player.research[trackId] = currentLevel + 1;
      const newLevel = player.research[trackId];
      applyTrackLevelBonus(game, playerId, player, trackId, newLevel);
      applyRoundMissionScore(game, playerId, 'research_track');
      addGameLog(game, playerId, 'Firaks: Downgrade', `Lab→TS, ${trackId} Lv.${newLevel}`, tileId);
      log(`Player ${player.name} (Firaks) downgraded Lab to TS and advanced ${trackId} to Lv.${newLevel}`, 'game');
      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // ---------- 연방 구현 ----------
    socket.on('federation_toggle_mode', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      if (game.hasDoneMainAction) return;
      if (game.pendingFederationReward) return;

      if (game.federationMode?.playerId === playerId) {
        game.federationMode = null;
        game.federationPreview = null;
      } else {
        if (!game.federationPool) {
          game.federationPool = {};
          FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
        }
        if (!game.satellites) game.satellites = {};
        game.federationMode = { playerId, selectedHexIds: [], selectedPlanetIds: [], selectedSpaceStationHexIds: [] };
        game.federationPreview = computeFederationPreview(game, playerId);
      }
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('federation_toggle_hex', ({ gameId, tileId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.federationMode || game.federationMode.playerId !== playerId) return;
      if (game.pendingFederationReward) return;

      const tile = game.map.find(t => t.id === tileId);
      if (!tile) return;

      const satellites = game.satellites || {};
      if (isEmptyHex(tile)) {
        const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
        if (onTile.includes(playerId)) return; // 내 위성 있는 공간은 선택 불가
        const idx = game.federationMode.selectedHexIds.indexOf(tileId);
        if (idx >= 0) {
          game.federationMode.selectedHexIds.splice(idx, 1);
        } else {
          // 하이브 2회째 이후: 새 빈칸은 기존 연방 또는 현재 선택과 인접해야 함
          const player = game.players[playerId];
          const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
          if (player.faction === 'ivits' && fedHexes.length > 0) {
            const neighbors = getNeighbors(game.map, tile).map(n => n.id);
            const allowed = [...game.federationMode.selectedHexIds, ...(game.federationMode.selectedPlanetIds ?? []), ...(game.federationMode.selectedSpaceStationHexIds ?? []), ...fedHexes];
            if (!neighbors.some(id => allowed.includes(id))) return;
          }
          game.federationMode.selectedHexIds.push(tileId);
        }
      } else if ((tile.type === 'space' || tile.type === 'deep_space') && tile.spaceStation?.ownerId === playerId) {
        const arr = game.federationMode.selectedSpaceStationHexIds ?? [];
        const idx = arr.indexOf(tileId);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(tileId);
        game.federationMode.selectedSpaceStationHexIds = arr;
      } else if (isPlanetHex(tile)) {
        if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') {
          const arr = game.federationMode.selectedPlanetIds ?? [];
          const idx = arr.indexOf(tileId);
          if (idx >= 0) arr.splice(idx, 1);
          else arr.push(tileId);
          game.federationMode.selectedPlanetIds = arr;
        } else {
          const component = getPlanetConnectedComponent(game, tileId);
          const power = getFederationBuildingPower(game, playerId, component);
          const requiredPower = getFederationRequiredPower(game, playerId);
          if (power >= requiredPower) {
            game.federationMode = null;
            game.federationPreview = null;
            game.pendingFederationReward = { playerId, selectedHexIds: [], spentTokens: 0 };
          }
        }
      }
      game.federationPreview = computeFederationPreview(game, playerId);
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('federation_complete', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.federationMode || game.federationMode.playerId !== playerId) return;
      if (game.pendingFederationReward) return;

      const selectedHexIds = [...game.federationMode.selectedHexIds];
      const selectedPlanetIds = [...(game.federationMode.selectedPlanetIds ?? [])];
      const selectedSpaceStationHexIds = [...(game.federationMode.selectedSpaceStationHexIds ?? [])];
      const numEmpty = selectedHexIds.length;
      const player = game.players[playerId];
      const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
      const planetIds = getFederationPlanetIdsFromSelectedEmpties(game, selectedHexIds);
      selectedPlanetIds.forEach(id => {
        const component = getPlanetConnectedComponent(game, id);
        component.forEach(pid => planetIds.add(pid));
      });
      const allHexIds = [...fedHexes, ...selectedHexIds, ...selectedSpaceStationHexIds];
      const power = getFederationBuildingPower(game, playerId, planetIds, allHexIds);
      const requiredPower = getFederationRequiredPower(game, playerId);
      if (power < requiredPower) {
        log(`Federation complete rejected: building power ${power} < ${requiredPower}`, 'game');
        io.to(gameId).emit('game_error', { message: `연방에 포함된 내 건물·우주정거장 파워가 ${requiredPower} 이상이어야 합니다. (위성=0, 우주정거장=1)` });
        return;
      }
      const isIvits = player.faction === 'ivits';
      if (isIvits) {
        if (player.qic < numEmpty) {
          log(`Federation complete rejected (Ivits): need ${numEmpty} QIC, have ${player.qic}`, 'game');
          io.to(gameId).emit('game_error', { message: `QIC가 부족합니다. (필요: ${numEmpty}, 보유: ${player.qic})` });
          return;
        }
        player.qic -= numEmpty;
      } else {
        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
        if (totalPower < numEmpty) {
          log(`Federation complete rejected: need ${numEmpty} power tokens, have ${totalPower}`, 'game');
          io.to(gameId).emit('game_error', { message: `파워 토큰이 부족합니다. (필요: ${numEmpty}, 보유: ${totalPower})` });
          return;
        }
        if (!spendPowerTokens(player, numEmpty)) {
          io.to(gameId).emit('game_error', { message: '파워 토큰 소비에 실패했습니다.' });
          return;
        }
      }
      game.federationMode = null;
      game.federationPreview = null;
      game.pendingFederationReward = { playerId, selectedHexIds, spentTokens: numEmpty };
      addGameLog(game, playerId, 'Federation', `Formed federation (${numEmpty} satellites, ${power} power${isIvits ? ', QIC cost' : ''})`);
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('federation_select_reward', ({ gameId, rewardId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.pendingFederationReward || game.pendingFederationReward.playerId !== playerId) return;

      const player = game.players[playerId];
      const byShip = game.spaceshipFederationByShip || {};
      const shipRewardIds = Object.values(byShip);
      const isSpaceshipReward = shipRewardIds.includes(rewardId) && !isSpaceshipFederationRewardTaken(game, rewardId);
      if (isSpaceshipReward) {
        const shipTypeForReward = Object.entries(byShip).find(([, id]) => id === rewardId)?.[0];
        const enteredTileIds = player.spaceshipsEntered ?? [];
        const hasEnteredThisShip = shipTypeForReward && game.map.some(t => t.type === shipTypeForReward && enteredTileIds.includes(t.id));
        if (!hasEnteredThisShip) {
          io.to(gameId).emit('game_error', { message: '해당 우주선에 입장한 플레이어만 그 우주선 연방을 선택할 수 있습니다.' });
          return;
        }
      }

      if (!isSpaceshipReward) {
        if (!game.federationPool) {
          game.federationPool = {};
          FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
        }
        const pool = game.federationPool;
        if (pool[rewardId] == null || pool[rewardId] < 1) {
          io.to(gameId).emit('game_error', { message: '해당 연방 보상을 선택할 수 없습니다.' });
          return;
        }
      }

      let rewardLabel: string;
      if (isSpaceshipReward) {
        const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);
        if (!shipReward) return;
        rewardLabel = shipReward.label;
      } else {
        const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
        if (!reward) return;
        rewardLabel = reward.label;
        addScore(game, playerId, reward.vp, 'other', { source: '연방 ' + rewardLabel });
        if ('ore' in reward && reward.ore) player.ore += reward.ore;
        if ('credits' in reward && reward.credits) player.credits += reward.credits;
        if ('knowledge' in reward && reward.knowledge) player.knowledge += reward.knowledge;
        if ('qic' in reward && reward.qic) grantQic(game, playerId, reward.qic);
        if ('powerTokens' in reward && reward.powerTokens) {
          player.power1 = (player.power1 || 0) + reward.powerTokens;
        }
        game.federationPool![rewardId] -= 1;
      }

      if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
        player.federations = getFederationEntries(player);
      }
      player.federations.push({ rewardId, isGreen: true });

      const { selectedHexIds } = game.pendingFederationReward;
      if (!game.satellites) game.satellites = {};
      for (const hexId of selectedHexIds) {
        const existing = game.satellites[hexId];
        if (Array.isArray(existing)) {
          if (!existing.includes(playerId)) existing.push(playerId);
        } else if (existing) {
          game.satellites[hexId] = [existing, playerId];
        } else {
          game.satellites[hexId] = [playerId];
        }
      }
      if (!game.playerFederationHexes) game.playerFederationHexes = {};
      if (!game.playerFederationHexes[playerId]) game.playerFederationHexes[playerId] = [];
      game.playerFederationHexes[playerId].push(...selectedHexIds);
      addGameLog(game, playerId, 'Federation', `Took reward: ${rewardLabel}`);
      game.pendingFederationReward = null;

      if (isSpaceshipReward) {
        switch (rewardId) {
          case 'ship-fed-tech':
            game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
            game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
            addGameLog(game, playerId, 'Spaceship Fed', 'Tech 1 (choose tile + track)', undefined);
            break;
          case 'ship-fed-4vp4k':
            addScore(game, playerId, 4, 'spaceships', { shipTileId: (game.pendingFederationReward as any)?.shipTileId ?? '' });
            player.knowledge = (player.knowledge || 0) + 4;
            break;
          case 'ship-fed-4vp1q2o':
            addScore(game, playerId, 4, 'spaceships', { shipTileId: (game.pendingFederationReward as any)?.shipTileId ?? '' });
            grantQic(game, playerId, 1);
            player.ore = (player.ore || 0) + 2;
            break;
          case 'ship-fed-8vp8c':
            addScore(game, playerId, 8, 'spaceships', { shipTileId: (game.pendingFederationReward as any)?.shipTileId ?? '' });
            player.credits = (player.credits || 0) + 8;
            break;
          case 'ship-fed-mine-free':
            game.pendingSpaceshipFedMine = { playerId };
            addGameLog(game, playerId, 'Spaceship Fed', 'Mine 1 free (no Nav) — choose planet', undefined);
            break;
          case 'ship-fed-3tf-mine':
            player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
            player.spaceshipFed3TfMineFree = true;
            addGameLog(game, playerId, 'Spaceship Fed', '3 TF + free terraform & mine', undefined);
            break;
          case 'ship-fed-12vp':
            addScore(game, playerId, 12, 'spaceships', { shipTileId: (game.pendingFederationReward as any)?.shipTileId ?? '' });
            break;
          case 'ship-fed-7vp3p2t':
            addScore(game, playerId, 7, 'spaceships', { shipTileId: (game.pendingFederationReward as any)?.shipTileId ?? '' });
            if (player.faction === 'taklons') chargePowerTaklons(player, 3, true);
            else chargePower(player, 3);
            player.power1 = (player.power1 || 0) + 2;
            break;
          default:
            break;
        }
      }

      game.hasDoneMainAction = true;
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    // 게임 시작 시 모든 라운드 미션을 미리 랜덤 선택
    function initializeRoundMissions(game: GaiaGameState) {
      const availableMissions = [...ROUND_MISSION_POOL].sort(() => Math.random() - 0.5);
      const selectedMissions: ScoringTile[] = [];
      const usedIds: string[] = [];

      // 6개 라운드에 대해 미션 선택
      for (let i = 0; i < 6; i++) {
        // 사용 가능한 미션 중 선택 (같은 ID는 한 번만 사용)
        let selected: ScoringTile | null = null;
        for (const mission of availableMissions) {
          if (!usedIds.includes(mission.id)) {
            selected = mission;
            usedIds.push(mission.id);
            break;
          }
        }

        // 만약 모든 미션이 사용되었다면 (큰건물 미션이 2개라서 가능), 풀에서 다시 선택
        if (!selected) {
          const remainingMissions = ROUND_MISSION_POOL.filter(m => !usedIds.includes(m.id));
          if (remainingMissions.length > 0) {
            selected = remainingMissions[Math.floor(Math.random() * remainingMissions.length)];
            usedIds.push(selected.id);
          } else {
            // 정말 모든 미션이 사용되었다면 랜덤 선택 (큰건물 미션 중복 허용)
            selected = ROUND_MISSION_POOL[Math.floor(Math.random() * ROUND_MISSION_POOL.length)];
          }
        }

        selectedMissions.push(selected);
        log(`Round ${i + 1} mission: ${selected.condition} (${selected.vp} VP)`, 'game');
      }

      game.roundScoringTiles = selectedMissions;
      game.usedRoundMissions = usedIds;
    }


    function triggerIncomePhase(game: GaiaGameState) {
      helperTriggerIncomePhase(io, game);
    }

    /** 아이타 의회 처리 또는 가이아포머 복귀 후 다음 단계 (테란 의회 큐 또는 액션 단계 시작) */
    function proceedAfterItarsGaiaformerOrTerran(game: GaiaGameState) {
      helperProceedAfterItarsGaiaformerOrTerran(io, game);
    }

    function finishAfterGaiaformerPhase(game: GaiaGameState) {
      helperFinishAfterGaiaformerPhase(io, game);
    }

    socket.on('end_turn', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      // 보너스 선택 단계에서는 턴 종료 불가 (보너스 선택만 가능)
      if (game.currentPhase !== 'main') return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      // 가이아 프로젝트(보너스/TF Mars) 대기 중에는 턴 종료 불가 → 배치 또는 건너뛰기 먼저
      if (game.pendingTFMarsGaiaProject?.playerId === playerId) {
        log(`Player ${playerId} cannot end turn while Gaia Project (place or skip) is pending.`, 'game');
        return;
      }
      // 기술 타일 선택(트랙 올리기) 또는 우주선 기술 타일 보상 트랙 진행을 같은 턴에 끝내야 함
      if (game.pendingTechTileSelection?.playerId === playerId) {
        log(`Player ${playerId} cannot end turn: choose a tech tile and advance track first.`, 'game');
        return;
      }
      if (game.pendingShipTechTrackAdvance?.playerId === playerId) {
        log(`Player ${playerId} cannot end turn: choose a track to advance (ship tech reward) first.`, 'game');
        return;
      }
      if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
        log(`Player ${playerId} cannot end turn: choose a track to advance (advanced tech reward) first.`, 'game');
        return;
      }
      if (!game.hasDoneMainAction) {
        log(`Player ${playerId} tried to end turn without a main action.`, 'game');
        return;
      }

      game.hasDoneMainAction = false;
      const prevPlayerIndex = game.currentPlayerIndex;
      const prevPlayerId = game.turnOrder[prevPlayerIndex];
      if (game.players[prevPlayerId]) game.players[prevPlayerId].tempRangeBonus = false;
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
      while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
        game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
        if (Object.values(game.players).every(p => p.hasPassed)) break;
      }

      // 다음 플레이어의 턴 시작 상태 저장 (Reset 시 복원용, 우주선 액션 포함)
      const newCurrentPlayerId = game.turnOrder[game.currentPlayerIndex];
      if (newCurrentPlayerId) {
        if (!game.turnStartState) game.turnStartState = {};
        game.turnStartState[newCurrentPlayerId] = {
          playerState: JSON.parse(JSON.stringify(game.players[newCurrentPlayerId])),
          mapState: JSON.parse(JSON.stringify(game.map)),
          spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
          gameLogLength: game.gameLog?.length || 0,
        };
      }

      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

      executeBotTurnIfNeeded(io, game).catch(err => {
        log(`Bot turn execution error (end_turn): ${err}`, 'error');
      });
    });

    socket.on('reset_turn', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
      if (!game.turnStartState || !game.turnStartState[playerId]) {
        log(`No turn start state found for player ${playerId}`, 'game');
        return;
      }

      const savedState = game.turnStartState[playerId];

      // 플레이어 상태 완전 복원 (깊은 복사)
      const player = game.players[playerId];
      const savedPlayer = savedState.playerState;

      // 모든 리소스 복원
      player.ore = savedPlayer.ore;
      player.knowledge = savedPlayer.knowledge;
      player.credits = savedPlayer.credits;
      player.qic = savedPlayer.qic;
      player.power1 = savedPlayer.power1;
      player.power2 = savedPlayer.power2;
      player.power3 = savedPlayer.power3;
      player.score = savedPlayer.score;
      player.ships = savedPlayer.ships;
      player.gaiaformers = savedPlayer.gaiaformers;
      player.gaiaformerPower = savedPlayer.gaiaformerPower;

      // 연구 레벨 복원
      if (savedPlayer.research) {
        player.research = JSON.parse(JSON.stringify(savedPlayer.research));
      }

      // 기술 타일 복원
      player.techTiles = savedPlayer.techTiles ? [...savedPlayer.techTiles] : [];
      player.usedTechActions = savedPlayer.usedTechActions ? [...savedPlayer.usedTechActions] : [];
      player.usedSpecialActions = savedPlayer.usedSpecialActions ? [...savedPlayer.usedSpecialActions] : [];

      // 보너스 타일 및 specialAction 상태 복원
      player.bonusTile = savedPlayer.bonusTile;
      player.usedBonusAction = savedPlayer.usedBonusAction;
      player.rangeBonusActive = savedPlayer.rangeBonusActive ?? false;
      player.tempRangeBonus = savedPlayer.tempRangeBonus ?? false;
      player.gleensNavBonusActive = savedPlayer.gleensNavBonusActive ?? false;
      player.brainStoneBowl = savedPlayer.brainStoneBowl;
      player.brainStoneInGaia = savedPlayer.brainStoneInGaia ?? false;
      player.itarsPendingBowl1Tokens = savedPlayer.itarsPendingBowl1Tokens ?? 0;
      player.pendingTerraformSteps = savedPlayer.pendingTerraformSteps ?? 0;
      player.tinkeroidRoundSpecialId = savedPlayer.tinkeroidRoundSpecialId;
      player.tinkeroidsChosenSpecialIds = savedPlayer.tinkeroidsChosenSpecialIds ? [...savedPlayer.tinkeroidsChosenSpecialIds] : undefined;

      // 가이아 포머 관련 복원
      player.pendingGaiaformerTiles = savedPlayer.pendingGaiaformerTiles ? [...(savedPlayer.pendingGaiaformerTiles || [])] : [];
      player.gaiaformerPlacedThisRound = savedPlayer.gaiaformerPlacedThisRound ? [...savedPlayer.gaiaformerPlacedThisRound] : [];
      player.balTakGaiaformersUsedForQic = savedPlayer.balTakGaiaformersUsedForQic ?? 0;

      // 우주선 입장 목록 복원 (Reset 후 다시 입장 가능하도록)
      player.spaceshipsEntered = savedPlayer.spaceshipsEntered ? [...savedPlayer.spaceshipsEntered] : [];

      // 맵 상태 복원 (깊은 복사)
      game.map = JSON.parse(JSON.stringify(savedState.mapState));

      // 우주선 상태 복원 (Reset 시 우주선 액션을 다시 사용 가능하도록)
      if (savedState.spaceshipsState) {
        game.spaceships = JSON.parse(JSON.stringify(savedState.spaceshipsState));
        // 복원된 객체에 usedActionIndices가 없을 수 있으므로 보정
        if (game.spaceships) {
          for (const sid of Object.keys(game.spaceships)) {
            const ship = game.spaceships[sid];
            if (ship && !Array.isArray(ship.usedActionIndices)) {
              ship.usedActionIndices = [];
            }
          }
        }
      } else {
        // 저장된 상태에 없으면 현재 플레이어가 탑승한 우주선만 액션 초기화 (Reset 후 액션 다시 사용 가능)
        game.spaceships = game.spaceships || {};
        for (const sid of Object.keys(game.spaceships)) {
          const ship = game.spaceships[sid];
          if (ship?.occupants?.includes(playerId)) {
            ship.usedActionIndices = [];
            ship.actionsUsed = 0;
          }
        }
        for (const t of game.map) {
          if (t.type === 'ship_twilight' || t.type === 'ship_rebellion' || t.type === 'ship_tf_mars' || t.type === 'ship_eclipse') {
            if (!game.spaceships[t.id]) {
              game.spaceships[t.id] = { unlocked: false, occupants: [], usedActionIndices: [] };
            }
          }
        }
      }

      // 게임 로그 복원 (현재 턴의 로그 제거)
      if (game.gameLog && savedState.gameLogLength < game.gameLog.length) {
        game.gameLog = game.gameLog.slice(0, savedState.gameLogLength);
      }

      // 메인 액션 상태 리셋
      game.hasDoneMainAction = false;

      // 이번 턴에 설정된 게임 글로벌 pending 초기화 (보너스 가이아, 이클립스 소행성, 기술 타일 선택 등)
      if (game.pendingTFMarsGaiaProject?.playerId === playerId) game.pendingTFMarsGaiaProject = null;
      if (game.pendingEclipseAsteroidMine?.playerId === playerId) game.pendingEclipseAsteroidMine = null;
      if (game.pendingEclipseResearch?.playerId === playerId) game.pendingEclipseResearch = null;
      if (game.pendingTwilightFederation?.playerId === playerId) game.pendingTwilightFederation = null;
      if (game.pendingTechTileSelection?.playerId === playerId) {
        game.pendingTechTileSelection = null;
        game.availableShipTechTileIds = undefined;
      }

      // 파워 액션 리셋 (현재 라운드의 파워 액션만)
      game.powerActions.forEach(a => {
        // 현재 플레이어가 사용한 액션만 리셋
        // 실제로는 게임 로그를 확인해야 하지만, 간단하게 모든 액션을 리셋
        a.isUsed = false;
      });

      log(`Player ${player.name} reset their turn`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('select_income_item', ({ gameId, itemId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return;

      const player = game.players[playerId];
      const item = game.pendingIncomeOrder.incomeItems.find(i => i.id === itemId);
      if (!item) return;

      // Undo용: 적용 직전 파워 스냅샷 저장
      const snap = { p1: player.power1 ?? 0, p2: player.power2 ?? 0, p3: player.power3 ?? 0 };
      if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];
      game.pendingIncomeOrder.powerBeforeSnapshots.push(snap);

      // 수익 적용: 파워는 미리보기와 동일(applyPowerIncome), 토큰은 1그릇에만 추가
      if (item.type === 'power') {
        applyPowerIncome(player, item.amount);
      } else {
        player.power1 = (player.power1 || 0) + item.amount;
      }

      game.pendingIncomeOrder.appliedItems.push(item);
      game.pendingIncomeOrder.incomeItems = game.pendingIncomeOrder.incomeItems.filter(i => i.id !== itemId);

      log(`Player ${player.name} selected income: ${item.amount} ${item.type}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    /** 수익 항목 전부 한 번에 받기: 파워는 1그릇 추가 후 charge(amount), 토큰은 1그릇에만 추가. 적용 직전마다 스냅샷 저장 → Undo 시 복원 */
    /** 수익 항목 전부 한 번에 받기: 파워 토큰/충전 순서 최적화 시뮬레이션 적용 */
    socket.on('select_all_income_items', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return;
      const player = game.players[playerId];
      const items = [...game.pendingIncomeOrder.incomeItems];
      if (items.length === 0) return;

      if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];
      const applied: typeof items = [];

      // --- Simulation for Optimal Order ---
      // 1. Generate all permutations of items (or feasible subset if too many - though usually small < 10)
      // Since items are usually condensed (e.g. "4 Power Charge", "1 Token"), the count is small.
      // Even if spread out, max income items usually < 10. permutations of 10 is 3.6M, a bit high for realtime.
      // But typically it's just a few distinct groups: Tokens and Charges.
      // Actually, within same type (e.g. 2 tokens vs 1 token), order doesn't matter.
      // Order ONLY matters between 'tokens' and 'power' types.
      // So we can simplify: we just need to decide the interleaving of Token items and Power items.
      // Wait, user said "1 token -> 4 charge -> 1 token" might be optimal.
      // So we should try to treat them as individual steps if they are separate items.
      // If items list is large (>8), we fallback to a heuristic (Tokens first, then Charge).

      let bestOrder = [...items];
      if (items.length <= 8) {
        const permutations = (arr: typeof items): (typeof items)[] => {
          if (arr.length <= 1) return [arr];
          const result: (typeof items)[] = [];
          for (let i = 0; i < arr.length; i++) {
            const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
            const subPerms = permutations(rest);
            for (const sub of subPerms) {
              result.push([arr[i], ...sub]);
            }
          }
          return result;
        };

        const allPerms = permutations(items);
        let bestState = { p1: -1, p2: -1, p3: -1 };

        // Helper to simulate
        const simulate = (p1: number, p2: number, p3: number, order: typeof items) => {
          let cp1 = p1, cp2 = p2, cp3 = p3;
          for (const item of order) {
            if (item.type === 'tokens') {
              cp1 += item.amount;
            } else if (item.type === 'power') {
              let rem = item.amount;
              const from1 = Math.min(rem, cp1);
              cp1 -= from1; cp2 += from1; rem -= from1;
              const from2 = Math.min(rem, cp2);
              cp2 -= from2; cp3 += from2;
            }
          }
          return { p1: cp1, p2: cp2, p3: cp3 };
        };

        // Evaluate all
        for (const order of allPerms) {
          const finalState = simulate(player.power1 || 0, player.power2 || 0, player.power3 || 0, order);

          // Compare: 3rd bowl max > 2nd bowl max > 1st bowl max
          let isBetter = false;
          if (bestState.p3 === -1) isBetter = true;
          else if (finalState.p3 > bestState.p3) isBetter = true;
          else if (finalState.p3 === bestState.p3) {
            if (finalState.p2 > bestState.p2) isBetter = true;
            else if (finalState.p2 === bestState.p2) {
              if (finalState.p1 > bestState.p1) isBetter = true;
            }
          }

          if (isBetter) {
            bestState = finalState;
            bestOrder = order;
          }
        }
      } else {
        // Fallback heuristic: Tokens first (usually better to fill bowl 1 before charge)
        bestOrder = items.sort((a, b) => (a.type === 'tokens' ? -1 : 1));
      }

      // Apply best order
      for (const item of bestOrder) {
        game.pendingIncomeOrder.powerBeforeSnapshots.push({ p1: player.power1 ?? 0, p2: player.power2 ?? 0, p3: player.power3 ?? 0 });
        if (item.type === 'tokens') {
          player.power1 = (player.power1 || 0) + item.amount;
        } else if (item.type === 'power') {
          applyPowerIncome(player, item.amount);
        }
        applied.push(item);
      }

      game.pendingIncomeOrder.appliedItems.push(...applied);
      game.pendingIncomeOrder.incomeItems = [];
      log(`Player ${player.name} auto-received all income (Optimal Order): ${items.length} items`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('undo_income_item', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return;
      if (game.pendingIncomeOrder.appliedItems.length === 0) return;

      const player = game.players[playerId];
      const lastItem = game.pendingIncomeOrder.appliedItems.pop()!;
      const snapshots = game.pendingIncomeOrder.powerBeforeSnapshots;
      if (snapshots && snapshots.length > 0) {
        const before = snapshots.pop()!;
        player.power1 = before.p1;
        player.power2 = before.p2;
        player.power3 = before.p3;
      }

      game.pendingIncomeOrder.incomeItems.push(lastItem);

      log(`Player ${player.name} undone income: ${lastItem.amount} ${lastItem.type}`, 'game');
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    /** 테란 의회: 가이아포머 토큰 수만큼 해택 선택 (4→QIC/K, 3→O, 1→C). 소비한 토큰만큼 2그릇에서 차감 */
    socket.on('terran_council_confirm_benefits', ({ gameId, qic = 0, knowledge = 0, ore = 0, credits = 0 }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      const pending = game.pendingTerranCouncilBenefit;
      if (!pending || pending.playerId !== playerId) return;
      const player = game.players[playerId];
      const totalCost = qic * 4 + knowledge * 4 + ore * 3 + credits * 1;
      if (totalCost > pending.tokenCount || totalCost < 0) {
        io.to(gameId).emit('game_error', { message: 'Terran council: invalid benefit total (4=QIC/K, 3=O, 1=C).' });
        return;
      }
      const p2 = player.power2 ?? 0;
      if (p2 < totalCost) {
        io.to(gameId).emit('game_error', { message: 'Not enough tokens in bowl 2.' });
        return;
      }
      player.power2 = p2 - totalCost;
      grantQic(game, playerId, qic);
      player.knowledge = (player.knowledge ?? 0) + knowledge;
      player.ore = (player.ore ?? 0) + ore;
      player.credits = (player.credits ?? 0) + credits;
      addGameLog(game, playerId, 'Terran Council', `${pending.tokenCount} tokens → +${qic}Q +${knowledge}K +${ore}O +${credits}C`);
      game.pendingTerranCouncilBenefit = null;
      const queue = game.terranCouncilQueue ?? [];
      if (queue.length > 0) {
        game.pendingTerranCouncilBenefit = queue[0];
        game.terranCouncilQueue = queue.slice(1);
      } else {
        game.terranCouncilQueue = [];
        finishAfterGaiaformerPhase(game);
      }
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
    });

    socket.on('finish_income_selection', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return;
      if (game.pendingIncomeOrder.incomeItems.length > 0) {
        log(`Player ${playerId} tried to finish but has remaining income items`, 'game');
        return; // 아직 남은 아이템이 있으면 완료 불가
      }

      const player = game.players[playerId];

      // 저장된 수익 정보 제거
      delete (player as any).pendingIncomeItems;

      log(`Player ${player.name} finished income selection`, 'game');
      const finishedPlayerId = game.pendingIncomeOrder.playerId;
      game.pendingIncomeOrder = null;

      // 게임 상태 먼저 업데이트
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

      // 수익 선택이 필요한 다음 플레이어(턴 순서)만 찾아서 대기시킴 (수익 재적용 없음)
      setTimeout(() => triggerIncomePhase(game), 100);
    });

    // 파워 교환 제안 수락/거부 (타클론: brainFirst, piAddFirst 옵션)
    socket.on('respond_power_offer', ({ gameId, offerId, accept, brainFirst, piAddFirst }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

      if (!game.pendingPowerOffers) return;

      const offerIndex = game.pendingPowerOffers.findIndex(o => o.id === offerId && o.targetPlayerId === playerId);
      if (offerIndex === -1) return;

      const offer = game.pendingPowerOffers[offerIndex];
      if (offer.responded) return; // 이미 응답함

      offer.responded = true;
      const targetPlayer = game.players[playerId];

      if (accept) {
        addScore(game, playerId, -offer.vpCost, 'powerReceived');
        const isTaklons = targetPlayer.faction === 'taklons';
        const hasPI = isTaklons && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        const brainFirstVal = isTaklons ? (brainFirst !== false) : true; // 타클론 기본 브레인 우선

        if (isTaklons) {
          if (hasPI && piAddFirst === true) {
            chargePowerTaklons(targetPlayer, 1, brainFirstVal);
            targetPlayer.power1 = (targetPlayer.power1 || 0) + 1;
            chargePowerTaklons(targetPlayer, offer.amount, brainFirstVal);
            targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
          } else if (hasPI && piAddFirst === false) {
            chargePowerTaklons(targetPlayer, offer.amount, brainFirstVal);
            targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
            chargePowerTaklons(targetPlayer, 1, brainFirstVal);
            targetPlayer.power1 = (targetPlayer.power1 || 0) + 1;
          } else {
            chargePowerTaklons(targetPlayer, offer.amount, brainFirstVal);
            targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
          }
        } else {
          chargePower(targetPlayer, offer.amount);
          targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
        }

        const sourcePlayer = game.players[offer.sourcePlayerId];
        addGameLog(game, playerId, 'Received Power', `+${offer.amount}P from ${sourcePlayer.name} (-${offer.vpCost}VP)`, offer.tileId);
        log(`Player ${targetPlayer.name} accepted power: +${offer.amount}P, -${offer.vpCost}VP`, 'game');
      } else {
        log(`Player ${targetPlayer.name} declined power offer`, 'game');
      }

      // 응답한 제안 제거
      game.pendingPowerOffers.splice(offerIndex, 1);

      // 모든 제안이 응답되었으면 배열 정리
      if (game.pendingPowerOffers.every(o => o.responded)) {
        game.pendingPowerOffers = [];
      }

      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

      executeBotTurnIfNeeded(io, game).catch(err => {
        log(`Bot turn execution error (respond_power_offer): ${err}`, 'error');
      });
    });

    // 파워 제안 일괄 수락 (자동 받기): 토큰 이동 후 파워 추가로 최대한 수용, 큰 제안 먼저 처리
    socket.on('accept_all_power_offers', ({ gameId }) => {
      const game = games.get(gameId); if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
      if (!game.pendingPowerOffers) return;

      const myOffers = game.pendingPowerOffers.filter(
        o => o.targetPlayerId === playerId && !o.responded
      );
      // 큰 파워 먼저 받기 (공간 있을 때 큰 것을 받고, 토큰 이동으로 공간 확보 후 작은 것)
      myOffers.sort((a, b) => b.amount - a.amount);

      const targetPlayer = game.players[playerId];
      const isTaklons = targetPlayer.faction === 'taklons';
      for (const offer of myOffers) {
        if (offer.vpCost > (targetPlayer.score || 0)) continue; // VP 부족 시 스킵
        offer.responded = true;
        addScore(game, playerId, -offer.vpCost, 'powerReceived');
        if (isTaklons) {
          chargePowerTaklons(targetPlayer, offer.amount, true); // 일괄 수락 시 브레인 우선
          targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
        } else {
          chargePower(targetPlayer, offer.amount);
          targetPlayer.power1 = (targetPlayer.power1 || 0) + offer.amount;
        }
        const sourcePlayer = game.players[offer.sourcePlayerId];
        addGameLog(game, playerId, 'Received Power', `+${offer.amount}P from ${sourcePlayer?.name} (-${offer.vpCost}VP)`, offer.tileId);
      }
      game.pendingPowerOffers = game.pendingPowerOffers.filter(o => !o.responded);
      if (game.pendingPowerOffers.length === 0) game.pendingPowerOffers = [];
      clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

      executeBotTurnIfNeeded(io, game).catch(err => {
        log(`Bot turn execution error (accept_all_power_offers): ${err}`, 'error');
      });
    });

    socket.on('pass_round', ({ gameId, newBonusTileId }) => {
      const game = games.get(gameId);
      if (!game) return;
      const playerId = socketToPlayerMap.get(socket.id);
      if (!playerId) return;

      executePassRound(io, game, playerId, newBonusTileId);
    });




    socket.on('disconnect', () => {
      const playerId = socketToPlayerMap.get(socket.id);
      if (playerId) {
        const gameId = playerGameMap.get(playerId);
        if (gameId) {
          const game = games.get(gameId);
          if (game && game.players[playerId]) {
            log(`Player ${game.players[playerId].name} disconnected`, 'game');
          }
        }
        socketToPlayerMap.delete(socket.id);
      }
    });
  });

  return io;
}

export function saveActionStartState(game: ServerGameState, playerId: string) {
}

export function executeBuildMine(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, useGaiaformer?: boolean): boolean {
  if (!game || game.hasDoneMainAction) return false;
  if (game.currentPhase !== 'main') return false;

  // Note: playerId is passed as argument, so we check if it matches current player
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

  saveActionStartState(game, playerId);

  const player = game.players[playerId];
  const tile = game.map.find(t => t.id === tileId);
  if (!tile) return false;
  const faction = FACTIONS.find(f => f.id === player.faction);
  if (!faction) return false;

  // Spaceship Fed Mine
  if (game.pendingSpaceshipFedMine?.playerId === playerId) {
    const unbuildable = ['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
    if (unbuildable.includes(tile.type) || tile.structure !== null) return false;
    if (tile.type === 'asteroid') return false;
    if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
    game.pendingSpaceshipFedMine = null;
    const geodensTypesBefore = getPlayerPlanetTypesForGeodens(game, playerId);
    const rm7Qualify = qualifiesForNewSectorRoundMission(game, playerId, tileId);
    tile.structure = 'mine';
    tile.ownerId = playerId;
    applyRoundMissionScore(game, playerId, 'build_mine');
    if (rm7Qualify) applyRoundMissionScore(game, playerId, 'new_sector');
    if (tile.type === 'gaia') applyRoundMissionScore(game, playerId, 'build_gaia');
    applyAdvancedTechTileEffect(game, playerId, 'build_mine');
    createPowerOffers(game, tile, playerId);
    applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBefore);
    addGameLog(game, playerId, 'Spaceship Fed', 'Mine 1 free (no Nav)', tileId);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  const freeMine = !!player.nextMineFreeFromShipTech || !!player.spaceshipFed3TfMineFree;

  // Lantids Parasitic
  if (player.faction === 'lantids' && tile.structure != null && tile.ownerId !== playerId && tile.ownerId != null && !tile.parasiticMine) {
    if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
    const mineOre = freeMine ? 0 : 1, mineCredits = freeMine ? 0 : 2;
    if ((player.ore ?? 0) < mineOre || (player.credits ?? 0) < mineCredits) return false;
    const playerTiles = game.map.filter(t => (t.ownerId === playerId || t.parasiticMine?.ownerId === playerId) && (t.structure != null || t.parasiticMine));
    if (playerTiles.length === 0) return false;
    let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
    if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
    if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
    if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
    const minDist = Math.min(...playerTiles.map(t => getDistance(t, tile)));
    const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
    if ((player.qic ?? 0) < neededQIC) return false;
    player.ore = (player.ore ?? 0) - mineOre;
    player.credits = (player.credits ?? 0) - mineCredits;
    player.qic = (player.qic ?? 0) - neededQIC;
    const rm7QualifyParasitic = qualifiesForNewSectorRoundMission(game, playerId, tileId);
    tile.parasiticMine = { ownerId: playerId };
    applyRoundMissionScore(game, playerId, 'build_mine');
    if (rm7QualifyParasitic) applyRoundMissionScore(game, playerId, 'new_sector');
    applyAdvancedTechTileEffect(game, playerId, 'build_mine');
    createPowerOffers(game, tile, playerId);
    const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
    if (hasPI) {
      player.knowledge = (player.knowledge || 0) + 2;
      addGameLog(game, playerId, 'Lantida Council', '+2 Knowledge (parasitic build with PI)', tileId);
    }
    game.hasDoneMainAction = true;
    addGameLog(game, playerId, 'Built Parasitic Mine', `1O, 2C (Lantida)`, tileId);
    log(`Player ${player.name} built parasitic mine on ${tileId}`, 'game');
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  if (tile.structure !== null) return false;
  if (freeMine) {
    player.nextMineFreeFromShipTech = false;
    if (player.spaceshipFed3TfMineFree) player.spaceshipFed3TfMineFree = false;
  }

  const unbuildableTypes = ['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
  if (unbuildableTypes.includes(tile.type)) return false;

  // Asteroid
  if (tile.type === 'asteroid') {
    let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
    if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
    if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
    if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
    const rangeTiles = getPlayerRangeTiles(game, playerId);
    if (rangeTiles.length === 0) return false;
    const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
    const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
    if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
    if (getEffectiveGaiaformers(player) <= 0) return false;
    if ((player.qic ?? 0) < neededQIC) return false;

    player.gaiaformers = Math.max(0, (player.gaiaformers || 0) - 1);
    player.qic = (player.qic ?? 0) - neededQIC;

    const geodensTypesBeforeAsteroid = getPlayerPlanetTypesForGeodens(game, playerId);
    const rm7QualifyAsteroid = qualifiesForNewSectorRoundMission(game, playerId, tileId);
    tile.structure = 'mine';
    tile.ownerId = playerId;
    addGameLog(game, playerId, 'Built Mine on Asteroid', `Free (Used 1 Gaiaformer, ${player.gaiaformers} remaining)`, tileId);
    applyRoundMissionScore(game, playerId, 'build_mine');
    if (rm7QualifyAsteroid) applyRoundMissionScore(game, playerId, 'new_sector');
    applyAdvancedTechTileEffect(game, playerId, 'build_mine');
    createPowerOffers(game, tile, playerId);
    applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeAsteroid);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  // Gaia Planet (Matured)
  if (tile.type === 'gaia' && player.pendingGaiaformerTiles?.includes(tileId)) {
    if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
    const mineOre = freeMine ? 0 : 1, mineCredits = freeMine ? 0 : 2;
    if ((player.ore ?? 0) < mineOre || (player.credits ?? 0) < mineCredits) return false;
    player.ore = (player.ore ?? 0) - mineOre;
    player.credits = (player.credits ?? 0) - mineCredits;
    player.pendingGaiaformerTiles = player.pendingGaiaformerTiles.filter(id => id !== tileId);
    const geodensTypesBeforeGaia = getPlayerPlanetTypesForGeodens(game, playerId);
    const rm7QualifyGaia1 = qualifiesForNewSectorRoundMission(game, playerId, tileId);
    tile.structure = 'mine';
    tile.ownerId = playerId;
    tile.hasGaiaformer = false;
    player.gaiaformers = (player.gaiaformers || 0) + 1;
    addGameLog(game, playerId, 'Built Mine on Gaia Planet', '1O, 2C (Gaiaformed, Gaiaformer recovered)', tileId);
    applyRoundMissionScore(game, playerId, 'build_mine');
    if (rm7QualifyGaia1) applyRoundMissionScore(game, playerId, 'new_sector');
    applyRoundMissionScore(game, playerId, 'build_gaia');
    applyAdvancedTechTileEffect(game, playerId, 'build_mine');
    createPowerOffers(game, tile, playerId);
    applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeGaia);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  // Transdim + Gaiaformer
  if (tile.type === 'transdim') {
    if (!tile.hasGaiaformer) return false;
    // We only allow if it was matured (usually handled by gaia type check above, but keeping for safety if type didn't change yet)
    // Actually original code checked pendingGaiaformerTiles.
    if (!player.pendingGaiaformerTiles?.includes(tileId)) return false;

    if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
    const mineOre = freeMine ? 0 : 1, mineCredits = freeMine ? 0 : 2;
    if ((player.ore ?? 0) < mineOre || (player.credits ?? 0) < mineCredits) return false;
    player.ore = (player.ore ?? 0) - mineOre;
    player.credits = (player.credits ?? 0) - mineCredits;
    player.pendingGaiaformerTiles = player.pendingGaiaformerTiles.filter(id => id !== tileId);
    const geodensTypesBeforeTransdim = getPlayerPlanetTypesForGeodens(game, playerId);
    const rm7QualifyGaia2 = qualifiesForNewSectorRoundMission(game, playerId, tileId);
    tile.structure = 'mine';
    tile.ownerId = playerId;
    tile.type = 'gaia';
    tile.hasGaiaformer = false;
    player.gaiaformers = (player.gaiaformers || 0) + 1;
    addGameLog(game, playerId, 'Built Mine on Gaia Planet', '1O, 2C (Gaiaformed, Gaiaformer recovered)', tileId);
    applyRoundMissionScore(game, playerId, 'build_mine');
    if (rm7QualifyGaia2) applyRoundMissionScore(game, playerId, 'new_sector');
    applyRoundMissionScore(game, playerId, 'build_gaia');
    applyAdvancedTechTileEffect(game, playerId, 'build_mine');
    createPowerOffers(game, tile, playerId);
    applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeTransdim);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  // Standard Build
  let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
  if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
  if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
  if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
  const rangeTiles = getPlayerRangeTiles(game, playerId);
  if (rangeTiles.length === 0) return false;

  const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
  const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

  let terraformCost = 0;
  let terraformSteps = 0;
  const pendingTerraformSteps = player.pendingTerraformSteps || 0;
  const standardMineOre = freeMine ? 0 : 1, standardMineCredits = freeMine ? 0 : 2;

  if (tile.type === 'gaia') {
    const gaiaBaseQic = 1;
    const isGleens = player.faction === 'gleens';
    const useOreForGaia = isGleens && (player.ore ?? 0) >= (standardMineOre + 1) && (player.credits ?? 0) >= standardMineCredits && (player.qic ?? 0) >= neededQIC;
    const useQicForGaia = (player.ore ?? 0) >= standardMineOre && (player.credits ?? 0) >= standardMineCredits && (player.qic ?? 0) >= (neededQIC + gaiaBaseQic);
    if (!useOreForGaia && !useQicForGaia) return false;
    if (useOreForGaia) {
      player.ore = (player.ore ?? 0) - (standardMineOre + 1); player.credits = (player.credits ?? 0) - standardMineCredits; player.qic = (player.qic ?? 0) - neededQIC;
    } else {
      player.ore = (player.ore ?? 0) - standardMineOre; player.credits = (player.credits ?? 0) - standardMineCredits; player.qic = (player.qic ?? 0) - (neededQIC + gaiaBaseQic);
    }
    terraformSteps = 0;
  } else {
    terraformSteps = getTerraformStepsForFaction(game, player.faction!, tile.type);
    const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
    const actualSteps = terraformSteps - discountSteps;
    terraformCost = player.spaceshipFed3TfMineFree ? 0 : actualSteps * getTerraformCost(player.research.terraforming);

    if ((player.ore ?? 0) < (terraformCost + standardMineOre) || (player.credits ?? 0) < standardMineCredits || (player.qic ?? 0) < neededQIC) return false;
    player.ore = (player.ore ?? 0) - (terraformCost + standardMineOre); player.credits = (player.credits ?? 0) - standardMineCredits; player.qic = (player.qic ?? 0) - neededQIC;
    player.pendingTerraformSteps = Math.max(0, pendingTerraformSteps - discountSteps);
  }

  if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
  const geodensTypesBefore = getPlayerPlanetTypesForGeodens(game, playerId);
  const hadStructureInThisSector = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === tile.sector);
  const hadStructureInOuter = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector >= 20 && t.sector < 30);
  const isNewSector = !hadStructureInThisSector;
  const isNewOuterSector = (tile.sector >= 20 && tile.sector < 30) && !hadStructureInOuter;
  const darkaniansPiNewSectorBonus = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && (isNewSector || isNewOuterSector);
  const rm7QualifyMine = qualifiesForNewSectorRoundMission(game, playerId, tileId);

  tile.structure = 'mine'; tile.ownerId = playerId;

  if (darkaniansPiNewSectorBonus) {
    player.knowledge = (player.knowledge ?? 0) + 1;
    player.credits = (player.credits ?? 0) + 2;
    addGameLog(game, playerId, 'Darkanians PI', 'New sector / new outer sector: +1K, +2C', tileId);
  }

  if (tile.type === 'proto') {
    player.score += 6;
    addGameLog(game, playerId, 'Built Mine on Proto', `+6 VP (3 terraforming required)`, tileId);
  }

  if (tile.type === 'gaia' && player.techTiles.includes('tech-gaia-3vp')) {
    player.score += 3;
    addGameLog(game, playerId, 'Tech Tile Bonus', `Gaia Planet: +3 VP`, tileId);
  }
  if (tile.type === 'gaia' && player.faction === 'gleens') {
    player.score += 2;
    addGameLog(game, playerId, 'Gleens: Gaia building', '+2 VP', tileId);
  }

  applyRoundMissionScore(game, playerId, 'build_mine');
  if (rm7QualifyMine) applyRoundMissionScore(game, playerId, 'new_sector');
  if (tile.type === 'gaia') {
    applyRoundMissionScore(game, playerId, 'build_gaia');
  }
  if (terraformSteps > 0) {
    for (let i = 0; i < terraformSteps; i++) {
      applyRoundMissionScore(game, playerId, 'terraform_step');
      applyAdvancedTechTileEffect(game, playerId, 'terraform');
    }
  }
  applyAdvancedTechTileEffect(game, playerId, 'build_mine');
  if (neededQIC > 0) {
    applyAdvancedTechTileEffect(game, playerId, 'qic_action');
  }

  const costDetails = `1O, 2C${neededQIC > 0 ? `, ${neededQIC}QIC` : ''}${terraformCost > 0 ? `, ${terraformCost}O terraform` : ''}`;
  addGameLog(game, playerId, 'Built Mine', `on ${tile.type} (${costDetails})`, tileId);

  createPowerOffers(game, tile, playerId);
  applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBefore);

  game.hasDoneMainAction = true;
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
  return true;
}

export function executeUpgradeStructure(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  tileId: string,
  target: StructureType | 'academy_left' | 'academy_right'
): boolean {
  if (!game || game.hasDoneMainAction) return false;
  if (game.currentPhase !== 'main') return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

  const player = game.players[playerId];
  const tile = game.map.find(t => t.id === tileId);
  if (!tile || tile.ownerId !== playerId) return false;
  if (tile.structure === 'lost_planet_mine') return false;

  saveActionStartState(game, playerId);

  if (tile.structure === 'mine' && target === 'trading_station') {
    if (getStructureCount(game, playerId, 'trading_station') >= BUILDING_LIMITS.trading_station) return false;
    const hasNearby = hasNearbyPlayersForDiscount(game, tile, playerId);
    const creditCost = hasNearby ? 3 : 6;
    if ((player.ore ?? 0) < 2 || (player.credits ?? 0) < creditCost) return false;
    player.ore = (player.ore ?? 0) - 2; player.credits = (player.credits ?? 0) - creditCost; tile.structure = 'trading_station'; game.hasDoneMainAction = true;
    applyRoundMissionScore(game, playerId, 'build_trading_station');
    applyAdvancedTechTileEffect(game, playerId, 'build_ts');
    addGameLog(game, playerId, 'Upgraded to Trading Station', `2O, ${creditCost}C${hasNearby ? ' (discounted)' : ''}`, tileId);
    createPowerOffers(game, tile, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  } else if (tile.structure === 'trading_station' && target === 'research_lab') {
    if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return false;
    if ((player.ore ?? 0) < 3 || (player.credits ?? 0) < 5) return false;
    player.ore = (player.ore ?? 0) - 3; player.credits = (player.credits ?? 0) - 5; tile.structure = 'research_lab'; game.hasDoneMainAction = true;
    applyRoundMissionScore(game, playerId, 'build_research_lab');
    addGameLog(game, playerId, 'Upgraded to Research Lab', '3O, 5C', tileId);
    createPowerOffers(game, tile, playerId);
    game.pendingTechTileSelection = { playerId, tileId, structureType: 'research_lab' };
    game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  } else if (tile.structure === 'trading_station' && target === 'planetary_institute') {
    if (player.faction === 'bescods') return false;
    if (getStructureCount(game, playerId, 'planetary_institute') >= BUILDING_LIMITS.planetary_institute) return false;
    if ((player.ore ?? 0) < 4 || (player.credits ?? 0) < 6) return false;
    player.ore = (player.ore ?? 0) - 4; player.credits = (player.credits ?? 0) - 6; tile.structure = 'planetary_institute'; game.hasDoneMainAction = true;
    if (player.faction === 'hadsch_hallas' && !player.hadschHallasPIActions?.length) {
      player.hadschHallasPIActions = [
        { id: 'hh-4c-1qic', costCredits: 4, label: '4C→1QIC', isUsed: false },
        { id: 'hh-4c-1k', costCredits: 4, label: '4C→1K', isUsed: false },
        { id: 'hh-3c-1o', costCredits: 3, label: '3C→1O', isUsed: false },
      ];
      log(`Player ${player.name} (Hadsch Hallas) gained PI free actions: 4C→1QIC, 4C→1K, 3C→1O`, 'game');
    }
    if (player.faction === 'space_giants') {
      game.pendingTechTileSelection = { playerId: playerId, tileId, structureType: 'space_giants_pi' };
      game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
      addGameLog(game, playerId, 'Space Giants: PI built', 'Choose 1 tech tile + track', tileId);
    }
    applyRoundMissionScore(game, playerId, 'build_big_building');
    addGameLog(game, playerId, 'Upgraded to Planetary Institute', '4O, 6C', tileId);
    createPowerOffers(game, tile, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  } else if (tile.structure === 'research_lab' && target === 'planetary_institute' && player.faction === 'bescods') {
    if (getStructureCount(game, playerId, 'planetary_institute') >= BUILDING_LIMITS.planetary_institute) return false;
    if ((player.ore ?? 0) < 4 || (player.credits ?? 0) < 6) return false;
    player.ore = (player.ore ?? 0) - 4; player.credits = (player.credits ?? 0) - 6; tile.structure = 'planetary_institute'; game.hasDoneMainAction = true;
    applyRoundMissionScore(game, playerId, 'build_big_building');
    addGameLog(game, playerId, 'Upgraded to Planetary Institute (Bescods/매안)', '4O, 6C', tileId);
    createPowerOffers(game, tile, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  } else if (tile.structure === 'trading_station' && (target === 'academy_left' || target === 'academy_right') && player.faction === 'bescods') {
    const academyTotal = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
    if (academyTotal >= BUILDING_LIMITS.academy) return false;
    const leftCount = getAcademyLeftCount(game, playerId);
    const rightCount = getAcademyRightCount(game, playerId);
    if (target === 'academy_left' && leftCount >= 1) return false;
    if (target === 'academy_right' && rightCount >= 1) return false;
    if ((player.ore ?? 0) < 6 || (player.credits ?? 0) < 6) return false;
    player.ore = (player.ore ?? 0) - 6; player.credits = (player.credits ?? 0) - 6;
    tile.structure = 'academy';
    tile.academyType = target === 'academy_left' ? 'left' : 'right';
    game.hasDoneMainAction = true;
    applyRoundMissionScore(game, playerId, 'build_big_building');
    addGameLog(game, playerId, 'Upgraded to Academy (Bescods/매안)', target === 'academy_left' ? '6O, 6C (2K 수익)' : '6O, 6C (1QIC 액션)', tileId);
    createPowerOffers(game, tile, playerId);
    game.pendingTechTileSelection = { playerId, tileId, structureType: 'academy' };
    game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  } else if (tile.structure === 'research_lab' && (target === 'academy_left' || target === 'academy_right')) {
    if (player.faction === 'bescods') return false;
    const academyTotal = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
    if (academyTotal >= BUILDING_LIMITS.academy) return false;
    const leftCount = getAcademyLeftCount(game, playerId);
    const rightCount = getAcademyRightCount(game, playerId);
    if (target === 'academy_left' && leftCount >= 1) return false;
    if (target === 'academy_right' && rightCount >= 1) return false;
    if ((player.ore ?? 0) < 6 || (player.credits ?? 0) < 6) return false;
    player.ore = (player.ore ?? 0) - 6; player.credits = (player.credits ?? 0) - 6;
    tile.structure = 'academy';
    tile.academyType = target === 'academy_left' ? 'left' : 'right';
    game.hasDoneMainAction = true;
    applyRoundMissionScore(game, playerId, 'build_big_building');
    addGameLog(game, playerId, 'Upgraded to Academy', target === 'academy_left' ? '6O, 6C (2K 수익)' : '6O, 6C (1QIC 액션)', tileId);
    createPowerOffers(game, tile, playerId);
    game.pendingTechTileSelection = { playerId, tileId, structureType: 'academy' };
    game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  return false;
}

export function executeSelectFaction(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  factionId: string,
  turnOrder?: number
): boolean {
  const player = game.players[playerId];
  if (!player) return false;

  const requestedFaction = FACTIONS.find(f => f.id === factionId);
  if (!requestedFaction) return false;

  // Check if faction or color is already taken by another player
  const alreadyTaken = Object.entries(game.players).some(([id, p]) => {
    if (id === playerId || !p.faction) return false;
    if (p.faction === factionId) return true;

    const otherFaction = FACTIONS.find(f => f.id === p.faction);
    return otherFaction?.color === requestedFaction.color;
  });

  if (alreadyTaken) {
    log(`Collision: Faction ${factionId} or its color is already taken.`, 'game');
    return false;
  }

  // Check if turn order is already taken
  if (turnOrder !== undefined) {
    const turnOrderTaken = Object.entries(game.players).some(([id, p]) => {
      if (id === playerId) return false;
      return (p as any).selectedTurnOrder === turnOrder;
    });

    if (turnOrderTaken) {
      log(`Collision: Turn order ${turnOrder} is already taken.`, 'game');
      return false;
    }

    (player as any).selectedTurnOrder = turnOrder;
  }

  player.faction = factionId;

  // Apply starting specs
  const faction = FACTIONS.find(f => f.id === factionId);
  if (faction) {
    log(`Applying starting specs for ${faction.name}`, 'game');

    // Resources (글린: 시작 QIC는 광물로)
    player.ore = faction.startingResources.ore;
    player.knowledge = faction.startingResources.knowledge;
    player.credits = faction.startingResources.credits;
    if (factionId === 'gleens' && (faction.startingResources.qic ?? 0) > 0) {
      player.ore = (player.ore ?? 0) + (faction.startingResources.qic ?? 0);
      player.qic = 0;
    } else {
      player.qic = faction.startingResources.qic;
    }
    // 개발 중: 테스트 모드일 때 자원 10O 15C 8K 20QIC 추가 (글린은 QIC→광물)
    if (game.isTestMode) {
      player.ore += 10;
      player.credits += 15;
      player.knowledge += 8;
      grantQic(game, playerId, 20);
    }

    // Power Bowls (타클론: 브레인 스톤은 그릇1에)
    player.power1 = faction.startingPower.bowl1;
    player.power2 = faction.startingPower.bowl2;
    player.power3 = faction.startingPower.bowl3;
    if (factionId === 'taklons') {
      player.brainStoneBowl = 1;
      player.brainStoneInGaia = false;
    }

    // Techs
    if (faction.startingTech) {
      Object.entries(faction.startingTech).forEach(([track, level]) => {
        const lvl = level as number;
        if (player.research) {
          player.research[track as ResearchTrack] = Math.max(player.research[track as ResearchTrack] || 0, lvl);

          // Apply immediate setup bonuses for starting tech (글린: QIC→광물)
          if (lvl >= 1) {
            if (track === 'terraforming') player.ore += 2;
            if (track === 'navigation') grantQic(game, playerId, 1);
            if (track === 'artificialIntelligence') grantQic(game, playerId, 1);
            // 가이아 프로젝트 1단계: 가이아 포머 1개 (테란 등)
            if (track === 'gaiaProject' && lvl === 1) {
              player.gaiaformers = (player.gaiaformers || 0) + 1;
              log(`Player ${player.name} gained 1 Gaiaformer from starting tech (Gaia Project level 1)`, 'game');
            }
          }
        }
      });
    }
  }


  // 모든 플레이어가 종족 선택을 마쳤다면 턴 순서 확정 및 단계 전환
  const allHaveFaction = Object.values(game.players).every(p => p.faction != null);
  if (allHaveFaction && game.currentPhase === 'factionSelect') {
    log(`All players selected faction. Finalizing turn order and moving to startingMines.`, 'game');

    // 1. 선택한 사람들 & 안 한 사람들 분류
    const playersWithOrder = Object.values(game.players)
      .filter(p => (p as any).selectedTurnOrder !== undefined)
      .map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p)!, order: (p as any).selectedTurnOrder }));

    const takenOrders = new Set(playersWithOrder.map(x => x.order));
    const playersWithoutOrder = Object.keys(game.players).filter(id => !playersWithOrder.find(p => p.id === id));

    // 2. 남은 순서 할당
    const numPlayers = Object.keys(game.players).length;
    const availableOrders = Array.from({ length: numPlayers }, (_, i) => i + 1).filter(o => !takenOrders.has(o));

    const finalOrders = [...playersWithOrder];
    playersWithoutOrder.forEach((id, index) => {
      if (availableOrders[index] !== undefined) {
        finalOrders.push({ id, order: availableOrders[index] });
      }
    });

    // 3. 정렬 및 적용
    finalOrders.sort((a, b) => a.order - b.order);
    game.turnOrder = finalOrders.map(x => x.id);

    game.currentPhase = 'startingMines';
    (game as any).startingMineSequence = buildStartingMineSequence(game);
    log(`Turn order finalized: ${game.turnOrder.join(', ')}`, 'game');
  }

  // 시작 광산 단계에서 종족을 고르면 "지금 배치할 사람"으로 턴 동기화 (1번=하이브, 2번=테란 → 2번 턴으로)
  if (game.currentPhase === 'startingMines' && game.turnOrder?.length) {
    const seq = buildStartingMineSequence(game);
    const total = Object.values(game.players).reduce((s, p) => s + (p.startingMinesPlaced || 0), 0);
    if (total < seq.length) {
      const idx = game.turnOrder.indexOf(seq[total]);
      if (idx >= 0) game.currentPlayerIndex = idx;
    }
  }

  log(`Player ${player.name} selected faction ${factionId}. State: ${JSON.stringify(player)}`, 'game');
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

  executeBotTurnIfNeeded(io, game).catch(err => {
    log(`Bot turn execution error (SelectFaction): ${err}`, 'error');
  });

  return true;
}

export function executePlaceStartingMine(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  tileId: string,
  factionId?: string
): string | null {
  if (game.currentPhase !== 'startingMines') return '지금은 시작 광산 배치 단계가 아닙니다.';

  const player = game.players[playerId];
  if (!player) return '플레이어를 찾을 수 없습니다.';

  // 종족이 아직 선택되지 않았으면 선택
  if (!player.faction && factionId) {
    const success = executeSelectFaction(io, game, playerId, factionId);
    if (!success) return '종족을 선택할 수 없습니다.';
  }

  const faction = FACTIONS.find(f => f.id === player.faction);
  if (!faction) return '종족을 먼저 선택하세요.';

  // Get faction-specific starting mines count (default 2)
  const maxStartingMines = faction.startingMines ?? 2;
  // Get faction-specific starting structure (default 'mine')
  const startingStructure = faction.startingStructure ?? 'mine';

  // 룰: 턴 순서(하이브·확장4 제외) 1개씩 → 역순 1개씩 → 제노스 1개 → 확장 4종족 각 1개 → 하이브 의회
  const snakingSequence: string[] = (game as any).startingMineSequence ?? buildStartingMineSequence(game);

  const totalMinesPlaced = Object.values(game.players).reduce((sum, p) => sum + p.startingMinesPlaced, 0);

  if (totalMinesPlaced >= snakingSequence.length) return '모든 시작 건물을 이미 배치했습니다.';

  const expectedPlayerId = snakingSequence[totalMinesPlaced];
  // 항상 "지금 배치할 사람"으로 턴 표시 동기화
  const expectedIndex = game.turnOrder.indexOf(expectedPlayerId);
  if (expectedIndex >= 0) game.currentPlayerIndex = expectedIndex;

  if (playerId !== expectedPlayerId) {
    log(`Wait for turn! Expected ${expectedPlayerId}, but got ${playerId}`, 'game');
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return `지금은 다른 플레이어의 차례입니다.`;
  }

  if (player.startingMinesPlaced >= maxStartingMines) return '이미 시작 건물을 모두 배치했습니다.';

  const tile = game.map.find(t => t.id === tileId);
  if (!tile || tile.structure !== null) return '해당 타일에 배치할 수 없습니다.';

  if (tile.type !== faction.homePlanet) return `${faction.name}은(는) ${faction.homePlanet} 행성에만 배치할 수 있습니다.`;

  tile.structure = startingStructure;
  tile.ownerId = playerId;
  player.startingMinesPlaced++;

  const structureName = startingStructure === 'planetary_institute' ? 'PI' : 'mine';
  log(`Player ${player.name} (${faction.name}) placed ${structureName} #${player.startingMinesPlaced}. Total: ${totalMinesPlaced + 1}`, 'game');

  const newTotal = totalMinesPlaced + 1;
  if (newTotal >= snakingSequence.length) {
    log(`All starting structures placed. Checking if all factions are selected.`, 'game');
    delete (game as any).startingMineSequence;
    const allHaveFaction = Object.values(game.players).every(p => p.faction !== null);
    if (allHaveFaction) {
      const numPlayers = Object.keys(game.players).length;
      const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);
      game.availableBonusTiles = shuffledBonusTiles.slice(0, numPlayers + 3);
      game.currentPlayerIndex = game.turnOrder.length - 1;
      game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];
      game.currentPhase = 'bonusSelection';
      log(`All factions selected. Moving to bonus selection phase.`, 'game');
    } else {
      game.currentPhase = 'factionSelect';
      log(`Moving to faction selection phase.`, 'game');
    }
  } else {
    const nextPlayerId = snakingSequence[newTotal];
    game.currentPlayerIndex = game.turnOrder.indexOf(nextPlayerId);
  }

  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

  executeBotTurnIfNeeded(io, game).catch(err => {
    log(`Bot turn execution error (PlaceStartingMine): ${err}`, 'error');
  });

  return null;
}

export function executeSelectBonus(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  bonusTileId: string
): boolean {
  if (game.currentPhase !== 'bonusSelection') return false;
  if (game.pendingBonusSelection !== playerId) return false;

  const tileIndex = game.availableBonusTiles.findIndex(t => t.id === bonusTileId);
  if (tileIndex === -1) return false;

  const player = game.players[playerId];
  player.bonusTile = bonusTileId;
  game.availableBonusTiles.splice(tileIndex, 1);

  log(`Player ${player.name} selected bonus tile: ${bonusTileId}`, 'game');

  // Move to next player (reverse order)
  game.currentPlayerIndex--;
  if (game.currentPlayerIndex < 0) {
    log(`All bonus tiles selected. Moving to main phase.`, 'game');
    game.currentPhase = 'main';
    game.roundNumber = 1;
    (game as any).incomePhaseAppliedThisRound = false;
    game.currentPlayerIndex = 0;
    game.pendingBonusSelection = null;
    for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);

    const firstPlayerId = game.turnOrder[0];
    if (firstPlayerId) {
      if (!game.turnStartState) game.turnStartState = {};
      game.turnStartState[firstPlayerId] = {
        playerState: JSON.parse(JSON.stringify(game.players[firstPlayerId])),
        mapState: JSON.parse(JSON.stringify(game.map)),
        spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
        gameLogLength: game.gameLog?.length || 0,
      };
    }

    helperTriggerIncomePhase(io, game);
  } else {
    game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];
  }

  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

  // 보너스 선택이 완료되고 수익 단계로 진입하는 경우: helperStartNewRoundTurn에서 executeBotTurnIfNeeded를 호출하므로 여기서는 호출하지 않음
  // 다음 보너스 선택 플레이어로 넘어가는 경우에만 호출
  if (game.pendingBonusSelection) {
    executeBotTurnIfNeeded(io, game).catch(err => {
      log(`Bot turn execution error (SelectBonus): ${err}`, 'error');
    });
  }

  return true;
}

export function executeAdvanceTech(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  trackId: ResearchTrack
): boolean {
  if (!game || game.currentPhase !== 'main') return false;

  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

  const player = game.players[playerId];
  const track = trackId as ResearchTrack;
  const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

  const pendingShipTech = game.pendingShipTechTrackAdvance;
  if (pendingShipTech?.playerId === playerId) {
    if (!tracks.includes(track) || player.research[track] >= 5) return false;
    if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
    const newLevel = (player.research[track] ?? 0) + 1;
    if (newLevel === 5 && countGreenFederations(player) < 1) return false;
    saveActionStartState(game, playerId);
    game.pendingShipTechTrackAdvance = null;
    if (newLevel === 5) spendGreenFederation(player);
    player.research[track]++;
    applyTrackLevelBonus(game, playerId, player, track, newLevel);
    applyRoundMissionScore(game, playerId, 'research_track');
    addGameLog(game, playerId, 'Ship Tech: Advanced track', `${track} → Lv.${newLevel}`);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  const pendingAdvTech = game.pendingAdvancedTechTrackAdvance;
  if (pendingAdvTech?.playerId === playerId) {
    if (!tracks.includes(track) || player.research[track] >= 5) return false;
    if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
    const newLevel = (player.research[track] ?? 0) + 1;
    if (newLevel === 5 && countGreenFederations(player) < 1) return false;
    saveActionStartState(game, playerId);
    game.pendingAdvancedTechTrackAdvance = null;
    if (newLevel === 5) spendGreenFederation(player);
    player.research[track]++;
    applyTrackLevelBonus(game, playerId, player, track, newLevel);
    applyRoundMissionScore(game, playerId, 'research_track');
    addGameLog(game, playerId, 'Advanced Tech: Advanced track', `${track} → Lv.${newLevel}`);
    game.hasDoneMainAction = true;
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;
  }

  if (game.hasDoneMainAction) return false;

  saveActionStartState(game, playerId);

  if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
  if ((player.knowledge ?? 0) < 4 || player.research[track] >= 5) return false;
  const newLevel = (player.research[track] ?? 0) + 1;
  if (newLevel === 5 && countGreenFederations(player) < 1) return false;

  const knowledgeBefore = player.knowledge;
  player.knowledge = (player.knowledge ?? 0) - 4;
  if (newLevel === 5) spendGreenFederation(player);
  player.research[track]++;
  applyTrackLevelBonus(game, playerId, player, track, newLevel);
  log(`Player ${player.name} advanced ${track} to Lv.${newLevel}: knowledge ${knowledgeBefore} → ${player.knowledge} (-4)`, 'game');
  applyRoundMissionScore(game, playerId, 'research_track');
  applyAdvancedTechTileEffect(game, playerId, 'research');
  addGameLog(game, playerId, 'Advanced Research', `${track} to level ${newLevel} (4K)`);
  game.hasDoneMainAction = true;
  clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
  return true;
}

// Helper functions for executePassRound (Rewritten to avoid collision if they exist hiddenly)
// Rewrites removed as originals are available at top level.

export function executePassRound(
  io: SocketIOServer,
  game: ServerGameState,
  playerId: string,
  newBonusTileId?: string
): boolean {
  if (!game) return false;

  if (game.currentPhase !== 'main') return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
  if (game.hasDoneMainAction) {
    return false;
  }

  const player = game.players[playerId];
  if (!player) return false;

  // 6라운드 처리
  if (game.roundNumber === 6) {
    if (player.bonusTile) {
      const currentBonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
      if (currentBonusTile?.passBonus) {
        const playerStructures = game.map.filter(t => t.ownerId === playerId);
        let count = 0;

        switch (currentBonusTile.passBonus.type) {
          case 'big_building':
            count = playerStructures.filter(t =>
              t.structure === 'academy' || t.structure === 'planetary_institute'
            ).length;
            break;
          case 'mine':
            count = getMineCountForPassAndBonuses(game, playerId);
            break;
          case 'trading_station':
            count = playerStructures.filter(t => t.structure === 'trading_station').length;
            break;
          case 'research_lab':
            count = playerStructures.filter(t => t.structure === 'research_lab').length;
            break;
          case 'gaiaformer':
            count = 0;
            break;
          case 'planet_type': {
            const planetTypes = new Set(
              playerStructures
                .filter(t => t.type !== 'space' && t.type !== 'deep_space')
                .map(t => t.type)
            );
            if (player.virtualMineAsteroid) planetTypes.add('asteroid');
            if (player.virtualMineProto) planetTypes.add('proto');
            if (playerStructures.some(t => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');
            count = planetTypes.size;
            break;
          }
          case 'gaia':
            count = playerStructures.filter(t => t.type === 'gaia').length;
            break;
          case 'bridge_sector':
            const bridgeSectors = new Set(
              playerStructures
                .filter(t => t.sector >= 11 && t.sector <= 18)
                .map(t => t.sector)
            );
            count = bridgeSectors.size;
            break;
        }

        const vpGained = count * currentBonusTile.passBonus.vp;
        addScore(game, playerId, vpGained, 'bonusTilePass', { round: 6 });
        log(`Player ${player.name} gained ${vpGained} VP from pass bonus (${count} x ${currentBonusTile.passBonus.vp} for ${currentBonusTile.passBonus.type})`, 'game');
      }
    }

    applyAdvancedTechTilePassEffect(game, playerId);

    player.hasPassed = true;
    if (!game.passingOrder.includes(playerId)) {
      game.passingOrder.push(playerId);
    }
    game.hasDoneMainAction = false;

    // Check if all passed
    if (Object.values(game.players).every(p => p.hasPassed)) {
      applyFinalMissionScoring(game);
      // Research Track End Bonus
      for (const pid of game.turnOrder) {
        const p = game.players[pid];
        if (!p?.research) continue;
        let researchBonus = 0;
        for (const track of RESEARCH_TRACKS) {
          const level = p.research[track.id] ?? 0;
          if (level >= 5) researchBonus += RESEARCH_TRACK_END_BONUS[5] ?? 12;
          else if (level >= 4) researchBonus += RESEARCH_TRACK_END_BONUS[4] ?? 8;
          else if (level >= 3) researchBonus += RESEARCH_TRACK_END_BONUS[3] ?? 4;
        }
        if (researchBonus > 0) addScore(game, pid, researchBonus, 'researchTracks');
      }
      for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);
      game.currentPhase = 'gameEnd';
      clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
      return true;
    }

    // Next player
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
    while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
    }
    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
    return true;

  } else {
    // Rounds 1-5
    if (!newBonusTileId) return false;
    const newTileIndex = game.availableBonusTiles.findIndex(t => t.id === newBonusTileId);
    if (newTileIndex === -1) return false;

    // Calculate pass bonus
    if (player.bonusTile) {
      const currentBonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
      if (currentBonusTile?.passBonus) {
        const playerStructures = game.map.filter(t => t.ownerId === playerId);
        let count = 0;

        switch (currentBonusTile.passBonus.type) {
          case 'big_building':
            count = playerStructures.filter(t =>
              t.structure === 'academy' || t.structure === 'planetary_institute'
            ).length;
            break;
          case 'mine':
            count = getMineCountForPassAndBonuses(game, playerId);
            break;
          case 'trading_station':
            count = playerStructures.filter(t => t.structure === 'trading_station').length;
            break;
          case 'research_lab':
            count = playerStructures.filter(t => t.structure === 'research_lab').length;
            break;
          case 'gaiaformer':
            count = 0;
            break;
          case 'planet_type': {
            const planetTypes = new Set(
              playerStructures
                .filter(t => t.type !== 'space' && t.type !== 'deep_space')
                .map(t => t.type)
            );
            if (player.virtualMineAsteroid) planetTypes.add('asteroid');
            if (player.virtualMineProto) planetTypes.add('proto');
            if (playerStructures.some(t => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');
            count = planetTypes.size;
            break;
          }
          case 'gaia':
            count = playerStructures.filter(t => t.type === 'gaia').length;
            break;
          case 'bridge_sector':
            const bridgeSectors = new Set(
              playerStructures
                .filter(t => t.sector >= 11 && t.sector <= 18)
                .map(t => t.sector)
            );
            count = bridgeSectors.size;
            break;
        }
        const vpGained = count * currentBonusTile.passBonus.vp;
        addScore(game, playerId, vpGained, 'bonusTilePass', { round: game.roundNumber });
        log(`Player ${player.name} gained ${vpGained} VP from pass bonus (${count} x ${currentBonusTile.passBonus.vp} for ${currentBonusTile.passBonus.type})`, 'game');
      }

      applyAdvancedTechTilePassEffect(game, playerId);

      const oldTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
      if (oldTile) {
        game.availableBonusTiles.push(oldTile);
      }
    }

    player.bonusTile = newBonusTileId;
    game.availableBonusTiles.splice(newTileIndex, 1);
    player.usedBonusAction = false;
    log(`Player ${player.name} selected new bonus tile: ${newBonusTileId}`, 'game');

    player.hasPassed = true;
    if (!game.passingOrder.includes(playerId)) {
      game.passingOrder.push(playerId);
    }
    game.hasDoneMainAction = false;

    if (Object.values(game.players).every(p => p.hasPassed)) {
      game.roundNumber++;
      (game as any).incomePhaseAppliedThisRound = false;
      game.powerActions.forEach(a => a.isUsed = false);
      Object.values(game.players).forEach(p => {
        if (p.hadschHallasPIActions) p.hadschHallasPIActions.forEach(a => { a.isUsed = false; });
        p.usedIvitsSpaceStationThisRound = false;
        if (p.faction === 'bal_tak') p.balTakGaiaformersUsedForQic = 0;
      });
      if (game.spaceships) {
        Object.keys(game.spaceships).forEach(id => {
          game.spaceships![id].actionsUsed = 0;
          game.spaceships![id].usedActionIndices = [];
        });
      }

      game.turnOrder = [...game.passingOrder];
      game.passingOrder = [];
      game.currentPlayerIndex = 0;

      // Gaiaformer maturation logic
      Object.entries(game.players).forEach(([pId, player]) => {
        const placed = player.gaiaformerPlacedThisRound ?? [];
        if (placed.length === 0) {
          player.gaiaformerPlacedThisRound = [];
          return;
        }
        if (!player.pendingGaiaformerTiles) player.pendingGaiaformerTiles = [];
        placed.forEach(tileId => {
          const t = game.map.find(m => m.id === tileId);
          if (t && t.type === 'transdim' && t.hasGaiaformer && !t.structure) {
            t.type = 'gaia';
            if (!player.pendingGaiaformerTiles!.includes(tileId)) {
              player.pendingGaiaformerTiles!.push(tileId);
              log(`Player ${player.name}: gaiaformer matured on ${tileId} (now buildable)`, 'game');
            }
          }
        });
        player.gaiaformerPlacedThisRound = [];
      });

      helperTriggerIncomePhase(io, game);
    } else {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
      while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
        game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
      }
    }

    const newCurrentId = game.turnOrder[game.currentPlayerIndex];
    if (newCurrentId) {
      if (!game.turnStartState) game.turnStartState = {};
      game.turnStartState[newCurrentId] = {
        playerState: JSON.parse(JSON.stringify(game.players[newCurrentId])),
        mapState: JSON.parse(JSON.stringify(game.map)),
        spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
        gameLogLength: game.gameLog?.length || 0,
      };
    }

    clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

    // Trigger bot turn if next player is a bot
    executeBotTurnIfNeeded(io, game).catch(err => {
      log(`Bot turn execution error: ${err}`, 'error');
    });

    return true;
  }
}

// ========== Bot-accessible exported functions ==========

/** Bot용: 파워 액션 실행 (테라포밍 스텝 등). hasDoneMainAction 설정하지 않음 (free action). */
export function executeUsePowerAction(
  io: SocketIOServer, game: ServerGameState,
  playerId: string, actionId: string
): boolean {
  if (!game || game.hasDoneMainAction) return false;
  const action = game.powerActions.find(a => a.id === actionId);
  if (!action || action.isUsed) return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

  const player = game.players[playerId];
  const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
  const powerCost = action.costType === 'power' ? (hasNevlasPI ? Math.ceil(action.cost as number / 2) : action.cost as number) : 0;
  if (action.costType === 'power' && (player.power3 ?? 0) < powerCost) return false;
  if (action.costType === 'qic' && (player.qic ?? 0) < action.cost) return false;

  if (action.costType === 'power') {
    player.power3 = (player.power3 ?? 0) - powerCost;
    player.power1 = (player.power1 ?? 0) + powerCost;
  } else {
    player.qic = (player.qic ?? 0) - action.cost;
  }

  if (actionId === 'gain-3-knowledge') player.knowledge += 3;
  if (actionId === 'gain-2-knowledge') player.knowledge += 2;
  if (actionId === 'gain-2-ore') player.ore += 2;
  if (actionId === 'gain-7-credits') player.credits += 7;
  if (actionId === 'gain-2-tokens') player.power1 += 2;
  if (actionId === 'gain-1-step') {
    player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
  }
  if (actionId === 'gain-2-steps') {
    player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
  }

  action.isUsed = true;
  clampPlayerResources(game);
  io.to(game.id).emit('game_updated', game);
  return true;
}

/** Bot용: 하이브(Ivits) 우주정거장 배치. 메인 액션 소모. */
export function executePlaceIvitsSpaceStation(
  io: SocketIOServer, game: ServerGameState,
  playerId: string, tileId: string
): boolean {
  if (!game || game.currentPhase !== 'main') return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
  if (game.hasDoneMainAction) return false;

  const player = game.players[playerId];
  if (player.faction !== 'ivits') return false;
  if (player.usedIvitsSpaceStationThisRound) return false;

  const tile = game.map.find(t => t.id === tileId);
  if (!tile) return false;
  if (tile.type !== 'space' && tile.type !== 'deep_space') return false;
  if (tile.structure !== null || tile.spaceStation) return false;
  const satellites = (game as any).satellites || {};
  const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
  if (onTile.includes(playerId)) return false;

  const rangeTiles = getPlayerRangeTiles(game, playerId);
  if (rangeTiles.length === 0) return false;
  let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
  const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
  const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
  if (player.qic < neededQIC) return false;

  saveActionStartState(game, playerId);
  player.qic -= neededQIC;
  tile.spaceStation = { ownerId: playerId };
  player.usedIvitsSpaceStationThisRound = true;
  game.hasDoneMainAction = true;
  addGameLog(game, playerId, 'Ivits: Space Station (Bot)', neededQIC ? `${neededQIC} QIC (range)` : 'Placed', tileId);
  clampPlayerResources(game);
  io.to(game.id).emit('game_updated', game);
  return true;
}

/** Bot용: 우주선 액션 실행. TF Mars 3번(3C→1삽), Eclipse 3번(6C→소행성 광산) 등. */
export function executeUseShipAction(
  io: SocketIOServer, game: ServerGameState,
  playerId: string, shipTileId: string, actionIndex: number,
  targetTileId?: string
): boolean {
  if (!game || game.currentPhase !== 'main') return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

  const player = game.players[playerId];
  const shipTile = game.map.find(t => t.id === shipTileId);
  if (!shipTile) return false;
  const shipState = game.spaceships?.[shipTileId];
  if (!shipState || !shipState.occupants.includes(playerId)) return false;
  const usedIndices = shipState.usedActionIndices ?? [];
  if (usedIndices.includes(actionIndex) || usedIndices.length >= 3) return false;

  // TF Mars 액션3: 3C → 1 테라포밍 스텝 (free action)
  if (shipTile.type === 'ship_tf_mars' && actionIndex === 3) {
    if (player.credits < 3) return false;
    player.credits -= 3;
    player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
    shipState.usedActionIndices = [...usedIndices, actionIndex];
    shipState.actionsUsed = shipState.usedActionIndices.length;
    addGameLog(game, playerId, 'TF Mars: 3C → 1 TF (Bot)', '', shipTileId);
    clampPlayerResources(game);
    io.to(game.id).emit('game_updated', game);
    return true;
  }

  // Eclipse 액션3: 6C → 소행성 광산 (pendingEclipseAsteroidMine 설정)
  if (shipTile.type === 'ship_eclipse' && actionIndex === 3) {
    if (game.hasDoneMainAction) return false;
    if (player.credits < 6) return false;
    player.credits -= 6;
    shipState.usedActionIndices = [...usedIndices, actionIndex];
    shipState.actionsUsed = shipState.usedActionIndices.length;
    game.pendingEclipseAsteroidMine = { playerId, shipTileId };
    addGameLog(game, playerId, 'Eclipse: 6C → Asteroid mine (Bot)', '(select tile)', shipTileId);
    clampPlayerResources(game);
    io.to(game.id).emit('game_updated', game);
    return true;
  }

  return false;
}

/** Bot용: 수익 단계 파워/토큰 자동 선택. select_all_income_items + finish_income_selection 재현. */
export function executeBotIncomeSelection(
  io: SocketIOServer, game: ServerGameState,
  playerId: string
): boolean {
  if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return false;

  const player = game.players[playerId];
  const items = [...game.pendingIncomeOrder.incomeItems];

  if (items.length === 0) {
    delete (player as any).pendingIncomeItems;
    game.pendingIncomeOrder = null;
    clampPlayerResources(game);
    io.to(game.id).emit('game_updated', game);
    setTimeout(() => helperTriggerIncomePhase(io, game), 100);
    return true;
  }

  if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];

  // 최적 순서 시뮬레이션
  let bestOrder = [...items];
  if (items.length <= 8) {
    const perms = (arr: typeof items): (typeof items)[] => {
      if (arr.length <= 1) return [arr];
      const result: (typeof items)[] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const sub of perms(rest)) result.push([arr[i], ...sub]);
      }
      return result;
    };
    const allPerms = perms(items);
    let bestP3 = -1, bestP2 = -1, bestP1 = -1;
    for (const order of allPerms) {
      let cp1 = player.power1 || 0, cp2 = player.power2 || 0, cp3 = player.power3 || 0;
      for (const item of order) {
        if (item.type === 'tokens') { cp1 += item.amount; }
        else { let r = item.amount; const f1 = Math.min(r, cp1); cp1 -= f1; cp2 += f1; r -= f1; const f2 = Math.min(r, cp2); cp2 -= f2; cp3 += f2; }
      }
      if (bestP3 === -1 || cp3 > bestP3 || (cp3 === bestP3 && cp2 > bestP2) || (cp3 === bestP3 && cp2 === bestP2 && cp1 > bestP1)) {
        bestP3 = cp3; bestP2 = cp2; bestP1 = cp1; bestOrder = order;
      }
    }
  } else {
    bestOrder = items.sort((a, b) => (a.type === 'tokens' ? -1 : 1));
  }

  for (const item of bestOrder) {
    game.pendingIncomeOrder.powerBeforeSnapshots.push({ p1: player.power1 ?? 0, p2: player.power2 ?? 0, p3: player.power3 ?? 0 });
    if (item.type === 'tokens') { player.power1 = (player.power1 || 0) + item.amount; }
    else { applyPowerIncome(player, item.amount); }
  }

  game.pendingIncomeOrder.appliedItems.push(...bestOrder);
  game.pendingIncomeOrder.incomeItems = [];
  delete (player as any).pendingIncomeItems;
  log(`Bot ${player.name} auto-received all income: ${items.length} items`, 'game');
  game.pendingIncomeOrder = null;
  clampPlayerResources(game);
  io.to(game.id).emit('game_updated', game);
  setTimeout(() => helperTriggerIncomePhase(io, game), 100);
  return true;
}

/** Bot용: 턴 종료 (서버의 end_turn 소켓 핸들러와 동일 로직). executeBotTurnIfNeeded는 호출하지 않음 (botHandler에서 처리). */
export function executeEndTurn(
  io: SocketIOServer, game: ServerGameState,
  playerId: string
): boolean {
  if (!game || game.currentPhase !== 'main') return false;
  if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
  if (!game.hasDoneMainAction) return false;

  // 대기 중인 후속 선택이 있으면 턴 종료 불가
  if (game.pendingTFMarsGaiaProject?.playerId === playerId) return false;
  if (game.pendingTechTileSelection?.playerId === playerId) return false;
  if (game.pendingShipTechTrackAdvance?.playerId === playerId) return false;
  if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) return false;

  game.hasDoneMainAction = false;
  const prevPlayerId = game.turnOrder[game.currentPlayerIndex];
  if (game.players[prevPlayerId]) game.players[prevPlayerId].tempRangeBonus = false;

  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
  while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
    if (Object.values(game.players).every(p => p.hasPassed)) break;
  }

  // 다음 플레이어의 턴 시작 상태 저장 (Reset 시 복원용)
  const newCurrentPlayerId = game.turnOrder[game.currentPlayerIndex];
  if (newCurrentPlayerId) {
    if (!game.turnStartState) game.turnStartState = {};
    game.turnStartState[newCurrentPlayerId] = {
      playerState: JSON.parse(JSON.stringify(game.players[newCurrentPlayerId])),
      mapState: JSON.parse(JSON.stringify(game.map)),
      spaceshipsState: game.spaceships ? JSON.parse(JSON.stringify(game.spaceships)) : undefined,
      gameLogLength: game.gameLog?.length || 0,
    };
  }

  clampPlayerResources(game);
  io.to(game.id).emit('game_updated', game);
  return true;
}

/** Bot용: pendingTechTileSelection 자동 처리. 트랙 타일 중 진행 가능한 첫 번째를 선택. */
export function executeBotSelectTechTile(
  io: SocketIOServer, game: ServerGameState,
  playerId: string
): boolean {
  if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return false;

  const player = game.players[playerId];
  const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];

  // 1. 트랙 타일 시도: 진행 가능한 트랙에 남은 타일이 있으면 선택
  for (const track of tracks) {
    if (player.research[track] >= 5) continue;
    const arr = game.techTilesByTrack?.[track];
    const tiles = Array.isArray(arr) ? arr : (arr ? [arr] : []);
    for (const tile of tiles) {
      if (!tile || !(tile as any).id) continue;
      const techTileId = (tile as any).id as string;
      if (player.techTiles.includes(techTileId)) continue;
      // 이 타일+트랙 조합 유효 → select_tech_tile 소켓과 동일 로직
      const isAdvanced = techTileId.startsWith('adv-');
      const newLevel = (player.research[track] ?? 0) + 1;
      const greenNeeded = (isAdvanced ? 1 : 0) + (newLevel === 5 ? 1 : 0);
      if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) continue;

      // 유효! 적용
      for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
      player.research[track]++;
      applyTrackLevelBonus(game, playerId, player, track, newLevel);
      applyRoundMissionScore(game, playerId, 'research_track');
      if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
      const tilesCast = tiles as (typeof tile | null)[];
      const idx = tilesCast.indexOf(tile);
      if (idx !== -1) tilesCast[idx] = null;
      addGameLog(game, playerId, 'Bot: Gained Tech Tile', `${techTileId}, ${track} → Lv.${newLevel}`);
      log(`Bot ${player.name} gained tech tile ${techTileId} and advanced ${track} to level ${newLevel}`, 'game');
      game.pendingTechTileSelection = null;
      game.availableShipTechTileIds = undefined;
      clampPlayerResources(game);
      io.to(game.id).emit('game_updated', game);
      return true;
    }
  }

  // 2. 풀 타일 시도: 진행 가능한 트랙 아무거나 + 풀의 첫 번째 타일
  if (game.techTilesPool) {
    for (let pi = 0; pi < game.techTilesPool.length; pi++) {
      const poolTile = game.techTilesPool[pi];
      if (!poolTile || !(poolTile as any).id) continue;
      const techTileId = (poolTile as any).id as string;
      if (player.techTiles.includes(techTileId)) continue;
      // 진행 가능한 트랙 아무거나 찾기
      for (const track of tracks) {
        if (player.research[track] >= 5) continue;
        const newLevel = (player.research[track] ?? 0) + 1;
        const greenNeeded = newLevel === 5 ? 1 : 0;
        if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) continue;
        for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
        player.research[track]++;
        applyTrackLevelBonus(game, playerId, player, track, newLevel);
        applyRoundMissionScore(game, playerId, 'research_track');
        if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
        (game.techTilesPool as (typeof poolTile | null)[])[pi] = null;
        addGameLog(game, playerId, 'Bot: Gained Tech Tile', `${techTileId} from pool, ${track} → Lv.${newLevel}`);
        log(`Bot ${player.name} gained pool tech tile ${techTileId} and advanced ${track} to level ${newLevel}`, 'game');
        game.pendingTechTileSelection = null;
        game.availableShipTechTileIds = undefined;
        clampPlayerResources(game);
        io.to(game.id).emit('game_updated', game);
        return true;
      }
    }
  }

  // 진행 가능한 조합이 없으면 강제 해제 (무한 대기 방지)
  log(`Bot ${player.name} could not find valid tech tile selection, clearing pending state`, 'game');
  game.pendingTechTileSelection = null;
  game.availableShipTechTileIds = undefined;
  clampPlayerResources(game);
  io.to(game.id).emit('game_updated', game);
  return true;
}

