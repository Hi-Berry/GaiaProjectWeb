import type { Game, Ctx } from 'boardgame.io';

export const PLAYER_COUNT = 4;

export type ResearchTrack = 'terraforming' | 'navigation' | 'artificialIntelligence' | 'gaiaProject' | 'economy' | 'science';

export const RESEARCH_TRACKS: { id: ResearchTrack; name: string; color: string }[] = [
  { id: 'terraforming', name: 'Terraforming', color: '#5D4037' },
  { id: 'navigation', name: 'Navigation', color: '#2E5EAA' },
  { id: 'artificialIntelligence', name: 'AI', color: '#4CAF50' },
  { id: 'gaiaProject', name: 'Gaia Project', color: '#9C27B0' },
  { id: 'economy', name: 'Economy', color: '#FF9800' },
  { id: 'science', name: 'Science', color: '#00BCD4' },
];

export interface PlayerState {
  name: string;
  faction: string | null;
  /** 종족 선택 시 고른 라운드 턴 순서 (1..N) */
  selectedTurnOrder?: number;
  ore: number;
  knowledge: number;
  credits: number;
  qic: number;
  power1: number;
  power2: number;
  power3: number;
  score: number;
  ships: number;
  research: Record<ResearchTrack, number>;
  startingMinesPlaced: number;
  hasPassed: boolean;
  techTiles: string[];
  usedTechActions: string[];
  usedSpecialActions: string[];
  bonusTile: string | null;
  usedBonusAction: boolean;
  gaiaformers?: number; // 보유한 가이아 포머 개수
  destroyedGaiaformers?: number; // 소행성 건설 등에 사용되어 영구 파괴된 개수
  gaiaformerPower?: number; // 가이아 포머 구역에 있는 파워 토큰
  pendingGaiaformerTiles?: string[]; // 건설 가능한 가이아(성숙) 타일 ID들 (이번 라운드 배치 제외)
  gaiaformerPlacedThisRound?: string[]; // 이번 라운드에 가이아포머 배치한 타일 ID (다음 라운드에 성숙)
  pendingTerraformSteps?: number; // 사용 가능한 테라포밍 단계 (파워 액션이나 보너스 타일로 획득)
  pendingIncomeOrder?: {
    power: number;
    tokens: number;
    playerId: string;
  } | null; // 수익 단계에서 파워/토큰 수익 순서 선택 대기
  spaceshipsEntered?: string[]; // 입장한 우주선 타일 ID (최대 3개)
  tempRangeBonus?: boolean; // 트왈라잇 액션3: +3 거리 (이번 턴만)
  rangeBonusActive?: boolean; // 보너스 타일 +3 거리 사용 대기 (다음 행동에 적용)
  /** 글린 기본 특수 액션: 라운드당 1회 +2 Nav (다음 행동에 적용) */
  gleensNavBonusActive?: boolean;
  navigationBonus?: number; // 우주선 기술 타일 등으로 인한 영구 Nav +N (거리 계산에만 사용)
  nextMineFreeFromShipTech?: boolean; // 우주선 기술 2TF+Mine: 다음 광산 1개 비용 무료
  /** 획득한 연방 보상: rewardId + 초록(미사용)/빨강(사용). 12점 연방은 획득 시 빨강. 트랙 5단계·고급 기술 타일 획득 시 초록 1개 소모 */
  federations?: FederationEntry[];
  /** 트왈라잇 인공물 ID 목록 (수익/가상 광산 등 적용) */
  artifacts?: string[];
  /** 인공물 8: 소행성 유형 가상 광산 1개 (O 생산 없음, 2VP/광산·광산당1점·행성유형수 등에 포함) */
  virtualMineAsteroid?: boolean;
  /** 인공물 9: 원시행성 유형 가상 광산 1개 (동일) */
  virtualMineProto?: boolean;
  /** 하드쉬 할라 의회(PI) 보너스: 4C→1QIC, 4C→1K, 3C→1O (의회 건설 후 매 라운드 사용 가능) */
  hadschHallasPIActions?: { id: string; costCredits: number; label: string; isUsed: boolean }[];
  /** 하이브(이비츠): 이번 라운드에 우주정거장 사용 여부 (라운드당 1회) */
  usedIvitsSpaceStationThisRound?: boolean;
  /** 발타크: 1포머→1QIC 프리 액션으로 사용해 다음 라운드까지 잠긴 포머 수 (라운드 시작 시 0으로 복귀) */
  balTakGaiaformersUsedForQic?: number;
  /** 타클론 브레인 스톤: 1|2|3 = 해당 그릇에 있음, 수용 시 3파워 가치. 사용 시 1그릇으로 이동 */
  brainStoneBowl?: 1 | 2 | 3;
  /** 타클론: 우주선 입장 시 브레인 스톤이 가이아 영역으로 가 다음 라운드까지 사용 불가 */
  brainStoneInGaia?: boolean;
  /** 타클론: 브레인 스톤을 연방 위성/인공물 등 토큰 비용으로 써버려 영구 소멸한 상태(복귀 없음). 사용자 요청 2026-06-29 */
  brainStoneSpent?: boolean;
  /** 타클론: 파워 소비 시 브레인 스톤 우선 사용 선호(전역 토글, 기본 true=큰 파워는 브레인 우선). false면 일반토큰 우선(브레인 보존). */
  taklonsBrainPriority?: boolean;
  /** 아이타: 2그릇 태울 때 "사라지는" 1토큰을 가이아포머 공간처럼 보관, 다음 라운드에 1그릇으로 복귀 */
  /** 팅커로이드: 게임 중 이미 선택한 Special 액션 ID (각 1회만 선택 가능) */
  tinkeroidsChosenSpecialIds?: string[];
  /** 팅커로이드: 이번 라운드에 사용할 Special 액션 ID (라운드 시작 시 선택) */
  tinkeroidRoundSpecialId?: string;
  /** 고급 기술 타일로 덮인 일반 기술 타일 ID (덮인 타일은 수입·액션·큰건물값 등 미적용) */
  coveredTechTiles?: string[];
  /** 우주선 연방 "3 TF + 테라포밍·광산 무료": 다음 광산 1개는 TF·광산 비용 무료 (pendingTerraformSteps 3과 함께 부여) */
  spaceshipFed3TfMineFree?: boolean;
  /** 게임 종료 시 점수 breakdown (라운드미션/보너스패스/기술타일/최종미션/파워수신/우주선/연구트랙) */
  scoreBreakdown?: ScoreBreakdown;
  /**
   * 라운드별 "수입 단계"에서 실제로 획득한 수입 합계.
   * - ore/credits/knowledge/qic: 즉시 추가된 자원(글린 QIC→광물 전환 등 반영)
   * - powerCharge: 파워 충전량(그릇 이동량 합)
   * - powerTokens: 파워 토큰 추가량(예: base/bonus/pi 토큰, 인공물 등으로 bowl에 직접 추가)
   *
   * tune/self-play에서 6라운드 수입을 안정 지표로 쓰기 위함.
   */
  roundIncomeTotals?: Record<number, { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number }>;
  /** 종족 비딩 낙찰 VP (게임 중 score에는 반영하지 않음, 종료 시에만 차감) */
  factionBidVp?: number;
  /** 현재 종족 경매 라운드에서 해당 플레이어가 마지막으로 부른 입찰가 (라운드 시작 시 초기화) */
  factionAuctionLastBid?: number;
}

/** 게임 종료 시 플레이어별 점수 내역 (왜 이 점수인지 정리) */
export interface ScoreBreakdown {
  /** 라운드 미션: 라운드별 획득 VP */
  roundMissions: { round: number; vp: number }[];
  /** 보너스 타일 패스 보너스: 라운드별 */
  bonusTilePass: { round: number; vp: number; tileId?: string }[];
  /** 기술 타일로 얻은 VP (타일 ID별) */
  techTiles: { tileId: string; vp: number }[];
  /** 최종 미션 합계 */
  finalMissions: number;
  /** 최종 미션 개별 상세 내역 (미션 ID별 점수) */
  finalMissionDetails: { missionId: string; vp: number }[];
  /** 파워 수신으로 지불한 VP (표시 시 마이너스) */
  powerReceived: number;
  /** 우주선 액션별 획득 VP (shipType+actionIndex로 액션 이미지 1/3 슬라이스 렌더) */
  spaceships: { shipTileId: string; vp: number; shipType?: string; actionIndex?: number }[];
  /** 게임 종료 연구 트랙 보너스 (3단계 4점, 4단계 8점, 5단계 12점) */
  researchTracks: number;
  /** 게임 종료 시 남은 자원 (O+C+QIC+K) 합 3당 1 VP */
  remainingResources: number;
  /** 기타 (연방 보상 VP 등) */
  other: { source: string; vp: number }[];
}

/** 연구 트랙 게임 종료 보너스: 3단계 4점, 4단계 8점, 5단계 12점 (트랙별 해당 단계 도달 시) */
export const RESEARCH_TRACK_END_BONUS: Record<number, number> = { 3: 4, 4: 8, 5: 12 };

/** [룰 2026-07-11 사용자 확정] 종료 잔여자원 정산 시 파워 자동 환산:
 *  2그릇을 전부 번(2토큰→1개 3그릇행) → 3그릇 전체를 크레딧으로(기본 1C, 네뷸라 의회 보유 시 2C,
 *  타클론 브레인스톤은 3C — 2그릇에 있으면 일반토큰 1개를 번 비용으로 쓰고 이동) 후 합산. /3은 호출부에서.
 *  (기존엔 파워 미포함 → 플레이어가 패스 전 수동 변환 노가다를 해야 했음) */
export function endgameLeftoverUnits(game: GaiaGameState, pid: string, p: PlayerState): number {
	let sum = (p.ore ?? 0) + (p.credits ?? 0) + (p.qic ?? 0) + (p.knowledge ?? 0);
	const hasPI = game.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute');
	const rate = (p.faction === 'nevlas' && hasPI) ? 2 : 1;
	let n2 = p.power2 ?? 0;
	const n3 = p.power3 ?? 0;
	let brainC = 0;
	// !brainStoneInGaia: 우주선 입장으로 브레인이 가이아 영역에 있으면(:9699 — brainStoneBowl은 안 지워짐)
	// 이번 라운드엔 쓸 수 없으므로 환산 대상이 아니다. 다른 브레인 사용처(1B→3C, 번, 파워지불)와 동일한 가드.
	// (잠재 버그였음: R6 우주선 입장 후 종료 시 부당 +3유닛 → 최대 +1VP. 실측 571판 중 발생 0건)
	if (p.faction === 'taklons' && !p.brainStoneInGaia) {
		if (p.brainStoneBowl === 3) brainC = 3;
		else if (p.brainStoneBowl === 2 && n2 >= 1) { brainC = 3; n2 -= 1; } // 이동 번 비용: 일반토큰 1개
	}
	sum += (n3 + Math.floor(n2 / 2)) * rate + brainC;
	return sum;
}

/** [숨은 관전 아이디, 사용자 요청] 이 이름으로 관전에 들어오면 채팅창 "(관전자 : …)" 목록에 뜨지 않는다.
 *  개발/운영자가 진행 중인 게임을 들여다볼 때 플레이어에게 관전 사실을 안 알리기 위한 용도.
 *  관전(watch_game)에만 적용 — 좌석에 앉는 플레이어는 숨길 수 없다(게임 참가자라 항상 보여야 함).
 *  이름 비교는 trim 후 정확일치(' --- '도 숨김). 서버는 이 이름을 game 객체에 저장하지 않는다(gameState.ts hiddenSpectatorIds).
 *  참고: 이 상태로 채팅을 보내면 이름이 없어 일반 '관전자'로 표시된다 — 목록엔 없는데 발언이 있으면 존재는 드러난다. */
export const HIDDEN_SPECTATOR_NAME = '---';
export function isHiddenSpectatorName(name?: string | null): boolean {
  return (name ?? '').trim() === HIDDEN_SPECTATOR_NAME;
}

export type PlanetType =
  | 'terra' | 'oxide' | 'volcanic' | 'desert'
  | 'swamp' | 'titanium' | 'ice' | 'transdim'
  | 'gaia' | 'space' | 'deep_space' | 'asteroid'
  | 'lost_fleet_ship' | 'ship_rebellion' | 'ship_twilight' | 'ship_tf_mars' | 'ship_eclipse'
  | 'proto'
  | 'lost_planet';  // 거리 5 잊혀진 행성 (행성유형 다양성에만 사용)

export type StructureType =
  | 'mine' | 'trading_station' | 'research_lab'
  | 'planetary_institute' | 'academy' | 'ship'
  | 'lost_planet_mine'  // 거리 5 보상 잊혀진 행성: O 없음, 광산 보너스/패스/행성유형 포함, 업그레이드 불가
  | null;

/** 란티다 기생 광산: 다른 플레이어 건물이 있는 행성에 테라포밍 없이 지은 광산 (업그레이드 불가, 연방·광산 건설 이벤트에는 포함, 가이아/행성유형당에는 미포함) */
export interface ParasiticMine {
  ownerId: string;
}

/** 건물 개수 상한 (모든 종족 동일): 의회 1, 아카데미 2, 교역소 4, 연구소 3, 광산 8 */
export const BUILDING_LIMITS = {
  planetary_institute: 1,
  academy: 2,
  trading_station: 4,
  research_lab: 3,
  mine: 8,
} as const;

export interface HexTile {
  id: string;
  q: number;
  r: number;
  type: PlanetType;
  sector: number;
  rotation?: number; // Sector rotation (0-5)
  structure: StructureType;
  ownerId: string | null;
  hasGaiaformer?: boolean; // 가이아 포머가 설치되어 있는지
  gaiaformerOwnerId?: string; // 가이아 포머를 설치한 플레이어 ID (즉시 성숙 등 건물이 없을 때 확인용)
  destroyedGaiaformer?: boolean; // 소행성 등에 설치되어 파괴되었는지 여부 (빨간 원 표시용)
  /** 아카데미: 'left' = 수익 2K, 'right' = Special 액션 1QIC (없으면 기존 호환용 left) */
  academyType?: 'left' | 'right';
  /** 란티다 기생 광산 (이 타일에 다른 플레이어 건물이 있고, 란티다가 기생 광산을 지은 경우) */
  parasiticMine?: ParasiticMine;
  /** 하이브(이비츠) 우주정거장: 빈 공간(space/deep_space)에만 설치, 연방 시 1파워, 거리 기준점 */
  spaceStation?: { ownerId: string };
  /** 모웨이드 의회 Special: 링이 놓인 건물 → 파워 수신/연방 시 +2 */
  moweyipRing?: boolean;
  isGaiaformed?: boolean; // 가이아 프로젝트를 통해 변환된 행성인지 여부
}

export interface PowerAction {
  id: string;
  cost: number;
  costType: 'power' | 'qic';
  isUsed: boolean;
  /** 이미 사용된 경우: 사용한 플레이어 (표시용) */
  usedByPlayerId?: string;
  usedByPlayerName?: string;
  label: string;
}

export interface TechTile {
  id: string;
  label: string;
  description: string;
  image?: string;
  isAdvanced?: boolean;
  specialAction?: string | null;
}

export interface BonusTile {
  id: string;
  label: string;
  description: string;
  income: {
    ore?: number;
    credits?: number;
    knowledge?: number;
    qic?: number;
    power?: number;
    powerTokens?: number; // Add tokens to bowl 1
  };
  passBonus?: {
    type: 'big_building' | 'mine' | 'trading_station' | 'research_lab' | 'gaiaformer' | 'planet_type' | 'gaia' | 'bridge_sector';
    vp: number;
  };
  specialAction?: 'terraform_step' | 'gaia_project' | 'range_3' | null;
}

export const ALL_BONUS_TILES: BonusTile[] = [
  // 1. 2돈 + 테라포밍 1단계 액션
  {
    id: 'bon-2c-terraform',
    label: '2C | ACT: TF',
    description: 'Income: 2 Credits. Action: Perform 1 terraforming step (once per round).',
    income: { credits: 2 },
    specialAction: 'terraform_step'
  },
  // 2. 2돈 + 1QIC
  {
    id: 'bon-2c-1q',
    label: '2C | 1Q',
    description: 'Income: 2 Credits and 1 QIC.',
    income: { credits: 2, qic: 1 }
  },
  // 3. 1광물 + 1단계에 토큰 2개 추가
  {
    id: 'bon-1o-2tokens',
    label: '1O | +2 Tokens',
    description: 'Income: 1 Ore and add 2 Power tokens to Bowl I.',
    income: { ore: 1, powerTokens: 2 }
  },
  // 4. 4돈 + 패스 시 가이아 행성당 1점
  {
    id: 'bon-4c-gaia',
    label: '4C | 1VP/Gaia',
    description: 'Income: 4 Credits. Pass: 1 VP per Gaia planet you colonized.',
    income: { credits: 4 },
    passBonus: { type: 'gaia', vp: 1 }
  },
  // 5. 1광물 + 1지식
  {
    id: 'bon-1o-1k',
    label: '1O | 1K',
    description: 'Income: 1 Ore and 1 Knowledge.',
    income: { ore: 1, knowledge: 1 }
  },
  // 6. 1지식 + 패스 시 연구소당 3점
  {
    id: 'bon-1k-lab',
    label: '1K | 3VP/Lab',
    description: 'Income: 1 Knowledge. Pass: 3 VP per Research Lab.',
    income: { knowledge: 1 },
    passBonus: { type: 'research_lab', vp: 3 }
  },
  // 7. 2파워 + 3거리 추가 액션
  {
    id: 'bon-2pw-range3',
    label: '2P | ACT: +3 Range',
    description: 'Income: 2 Power. Action: +3 range for building, Gaia Project, ship movement, or asteroid colonization.',
    income: { power: 2 },
    specialAction: 'range_3'
  },
  // 8. 1광물 + 패스 시 교역소당 2점
  {
    id: 'bon-1o-ts',
    label: '1O | 2VP/TS',
    description: 'Income: 1 Ore. Pass: 2 VP per Trading Station.',
    income: { ore: 1 },
    passBonus: { type: 'trading_station', vp: 2 }
  },
  // 9. 4pw + 패스 시 큰 건물당 4점 (아카데미/행성학회)
  {
    id: 'bon-4pw-bigbuilding',
    label: '4P | 4VP/Big',
    description: 'Income: 4 Power. Pass: 4 VP per Academy or Planetary Institute.',
    income: { power: 4 },
    passBonus: { type: 'big_building', vp: 4 }
  },
  // 10. 1광물 + 패스 시 광산당 1점
  {
    id: 'bon-1o-mine',
    label: '1O | 1VP/Mine',
    description: 'Income: 1 Ore. Pass: 1 VP per Mine.',
    income: { ore: 1 },
    passBonus: { type: 'mine', vp: 1 }
  },
  // 11. 3돈 + 패스 시 외곽 브릿지 섹터당 2점
  {
    id: 'bon-3c-bridge',
    label: '3C | 2VP/Bridge',
    description: 'Income: 3 Credits. Pass: 2 VP per outer bridge sector with your structure.',
    income: { credits: 3 },
    passBonus: { type: 'bridge_sector', vp: 2 }
  },
  // 12. 2파워 + 가이아 프로젝트 액션
  {
    id: 'bon-2pw-gaiaproject',
    label: '2P | ACT: GP',
    description: 'Income: 2 Power. Action: Start Gaia Project on a Transdim planet (once per round).',
    income: { power: 2 },
    specialAction: 'gaia_project'
  },
  // 13. 1광물 + 패스 시 행성 유형당 1점
  {
    id: 'bon-1o-planettype',
    label: '1O | 1VP/Type',
    description: 'Income: 1 Ore. Pass: 1 VP per different planet type you colonized.',
    income: { ore: 1 },
    passBonus: { type: 'planet_type', vp: 1 }
  },

  // 14. 1광물 + 패스 시 남은 가이아포머당 3점
  {
    id: 'bon-1o-gaiaformer',
    label: '1O | 3VP/GF',
    description: 'Income: 1 Ore. Pass: 3 VP per remaining Gaiaformer.',
    income: { ore: 1 },
    passBonus: { type: 'gaiaformer', vp: 3 }
  },







];

export interface ScoringTile {
  id: string;
  label: string;
  condition: string;
  vp: number;
  triggerType?: 'build_mine' | 'build_trading_station' | 'build_research_lab' | 'build_big_building' | 'federation' | 'new_sector' | 'new_planet_type' | 'build_gaia' | 'research_track' | 'terraform_step';
}

// Round Mission Pool - 매 라운드마다 랜덤으로 선택
export const ROUND_MISSION_POOL: ScoringTile[] = [
  { id: 'rs1', label: 'RS1', condition: 'Big Building', vp: 5, triggerType: 'build_big_building' }, // 큰건물 지을때마다 5점 (1)
  { id: 'rs2', label: 'RS2', condition: 'Mine', vp: 2, triggerType: 'build_mine' }, // 광산 지을때마다 2점
  { id: 'rs3', label: 'RS3', condition: 'Big Building', vp: 5, triggerType: 'build_big_building' }, // 큰건물 지을때마다 5점 (2)
  { id: 'rs4', label: 'RS4', condition: 'Gaia Planet', vp: 3, triggerType: 'build_gaia' }, // 가이아 행성에 지으면 3점
  { id: 'rs5', label: 'RS5', condition: 'Gaia Planet', vp: 4, triggerType: 'build_gaia' }, // 가이아 행성에 지으면 4점
  { id: 'rs6', label: 'RS6', condition: 'Research Track', vp: 2, triggerType: 'research_track' }, // 연구 트랙 올릴때마다 2점
  { id: 'rs7', label: 'RS7', condition: 'Trading Station', vp: 4, triggerType: 'build_trading_station' }, // 교역소 지을때마다 4점
  { id: 'rs8', label: 'RS8', condition: 'Federation', vp: 5, triggerType: 'federation' }, // 연방 선언하면 5점
  { id: 'rs9', label: 'RS9', condition: 'Trading Station', vp: 3, triggerType: 'build_trading_station' }, // 교역소 지을때마다 3점
  { id: 'rs10', label: 'RS10', condition: 'Terraform Step', vp: 2, triggerType: 'terraform_step' }, // 테라포밍 할때마다 단계당 2점
  { id: 'rs11', label: 'RS11', condition: 'New Sector/Bridge', vp: 3, triggerType: 'new_sector' }, // 새로운 섹션 또는 브릿지 색션에 지으면 3점
  { id: 'rs12', label: 'RS12', condition: 'Research Lab', vp: 4, triggerType: 'build_research_lab' }, // 연구소 지을때마다 4점
  { id: 'rs13', label: 'RS13', condition: 'New Planet Type', vp: 3, triggerType: 'new_planet_type' }, // 새로운 행성 유형에 지으면 3점
];

/** 최종미션 ID 목록 (매 게임 9개 중 2개 랜덤 선택). 6라운드 종료 시 1/2/3등 18/12/6점, 동점 시 합산 후 인원수로 나눔 */
export const FINAL_MISSION_IDS = [
  'fm_total_structures',
  'fm_federation_buildings',
  'fm_sectors',
  'fm_outer_sectors',
  'fm_gaia_planets',
  'fm_satellites',
  'fm_pi_academy_distance',
  'fm_planet_types',
  'fm_asteroid_buildings',
] as const;

export const FINAL_MISSION_LABELS: Record<string, string> = {
  fm_gaia_planets: '가이아 행성 수',
  fm_satellites: '위성 수',
  fm_planet_types: '행성 유형 수',
  fm_sectors: '섹터 수',
  fm_federation_buildings: '연방 건물 수',
  fm_total_structures: '총 건물 수',
  fm_outer_sectors: '외각 섹터 수',
  fm_pi_academy_distance: '의회-아카데미 거리',
  fm_asteroid_buildings: '소행성 건물 수',
};

export interface BotActionForFeedback {
  id: string;
  timestamp: number;
  playerId: string;
  playerName: string;
  actionType: string;
  params?: any;
  preActions?: any[];
  source?: string;
  roundNumber: number;
  phase: GaiaGameState['currentPhase'];
}

export interface GaiaGameState {
  id: string;
  hostId?: string;
  maxPlayers?: number;
  players: Record<string, PlayerState>;
  map: HexTile[];
  currentPhase: 'lobby' | 'setup' | 'factionSelect' | 'factionBidding' | 'startingMines' | 'main' | 'bonusSelection' | 'gameEnd';
  roundNumber: number;
  /** 최종미션: 이번 게임에 적용된 2개 미션 ID (9개 중 랜덤 2개) */
  finalMissionIds?: string[];
  /** 최종미션 점수 적용 여부 (6라운드 종료 시 1회만 적용) */
  finalMissionScoresApplied?: boolean;
  currentPlayerIndex: number;
  turnOrder: string[];
  /** AI 봇 플레이어 ID 목록 */
  botPlayerIds?: string[];
  /** 사용자가 AI 수를 평가할 때 기준으로 삼는 최근 봇 액션들 */
  botActionsForFeedback?: BotActionForFeedback[];
  /** 하위 호환/빠른 접근용 최근 봇 액션 */
  lastBotActionForFeedback?: BotActionForFeedback | null;
  /** 방장이 수동으로 추가한 로컬 플레이어 ID (봇 제외) */
  hostAddedPlayerIds?: string[];

  isTestMode: boolean;
  hasDoneMainAction: boolean;
  powerActions: PowerAction[];
  availableBonusTiles: BonusTile[];
  roundScoringTiles: ScoringTile[];
  finalScoringTiles: ScoringTile[];
  usedRoundMissions: string[]; // 사용된 라운드 미션 ID 추적
  /** 일반 기술 타일: 트랙당 (플레이어 수)개. 한 플레이어가 가져가도 다른 플레이어는 남은 복사본을 가져갈 수 있음. */
  techTilesByTrack: Partial<Record<ResearchTrack, (TechTile | null)[]>>;
  advancedTechTilesByTrack: Partial<Record<ResearchTrack, TechTile>>;
  /** 7번째 고급 타일: 하단 풀 오른쪽 슬롯. 획득 조건은 extraAdvancedTechCondition으로 매 판 랜덤 */
  extraAdvancedTechTile?: TechTile;
  /** 7번째 고급 타일 획득 조건: 25vp = 25 VP 이상, 3ships = 우주선 3개 입장 */
  extraAdvancedTechCondition?: '25vp' | '3ships';
  techTilesPool: (TechTile | null)[];
  passingOrder: string[];
  pendingBonusSelection: string | null; // Player ID waiting to select bonus tile
  nextRoundBonusTiles?: Record<string, string>; // Player ID -> Bonus Tile ID for next round
  pendingTechTileSelection?: { playerId: string; tileId: string; structureType: 'research_lab' | 'academy' | 'rebellion_gain' | 'itars_pi_exchange' | 'space_giants_pi' } | null; // 기술 타일 선택 대기
  /** 기술 타일 선택 시 선택 가능한 우주선 전용 타일 ID (입장한 우주선 기준) */
  availableShipTechTileIds?: string[];
  /** 게임마다 랜덤: 우주선 타입 → 우주선 전용 기술 타일 ID (없으면 SHIP_TECH_BY_SHIP 사용) */
  shipTechByShip?: Record<string, string>;
  /** 우주선 전용 기술 타일 수량 풀: techId -> 남은 수량 (각 4개씩) */
  shipTechPool?: Record<string, number>;
  pendingIncomeOrder?: {
    playerId: string;
    incomeItems: Array<{ type: 'power' | 'tokens'; amount: number; id: string }>;
    appliedItems: Array<{ type: 'power' | 'tokens'; amount: number; id: string }>;
    /** Undo 시 파워 복원용: 적용 직전 (p1,p2,p3[,bs]) 스냅샷. appliedItems[i] 적용 전 상태가 powerBeforeSnapshots[i] */
    powerBeforeSnapshots?: Array<{ p1: number; p2: number; p3: number; bs?: 1 | 2 | 3 }>;
  } | null; // 수익 단계에서 파워/토큰 수익 개별 선택 대기
  gameLog?: Array<{ timestamp: number; playerId: string; playerName: string; action: string; details?: string; tileId?: string; aiFeedbackActionId?: string; subLogs?: Array<{ playerId: string; playerName: string; text: string }>; passInfo?: { returnedTileId?: string; tookTileId?: string; bonusVp?: number; advTiles?: Array<{ tileId: string; vp: number }> }; snap?: { vp: number; c: number; o: number; k: number; q: number; p1: number; p2: number; p3: number; bs?: number }; base?: { vp: number; c: number; o: number; k: number; q: number; p1: number; p2: number; p3: number; bs?: number }; round?: number; seq?: number }>; // 게임 액션 로그 (snap=이 로그 시점 행위자 점수/자원 스냅샷, 클릭 시 직전 대비 변동량 표시용; round=발생 라운드, 라운드 점프용)
  /** 플레이어 채팅 (최근 N개만 유지). 재접속/관전 시 히스토리 복원용으로 게임 상태에 보관 */
  chatMessages?: Array<{ id: string; senderId: string; name: string; faction?: string | null; isSpectator?: boolean; text: string; ts: number }>;
  economyVariant?: 'power' | 'vp'; // 경제 트랙 변형: 'power' = 파워 수익, 'vp' = 점수 수익
  turnStartState?: Record<string, {
    playerState: PlayerState;
    mapState: HexTile[];
    spaceshipsState?: Record<string, { unlocked: boolean; occupants: string[]; actionsUsed?: number; usedActionIndices?: number[]; usedActionBy?: Record<number, string> }>;
    gameLogLength: number;
    gameLogState?: NonNullable<GaiaGameState['gameLog']>;
    gameLogSnapshotAt?: number;
    humanActionJournalLength?: number;
    humanActionJournalState?: any[];
    /** 전체 게임 상태 스냅샷 (기술 타일 풀, 트랙 등 복구용) */
    fullGameState?: any;
  }>; // 각 플레이어의 턴 시작 시점 상태 저장 (액션 시작 시점으로 업데이트됨)
  pendingPowerOffers?: Array<{
    id: string;
    targetPlayerId: string;
    sourcePlayerId: string;
    amount: number;
    vpCost: number;
    tileId: string;
    responded: boolean;
  }>; // 파워 교환 제안 대기
  /** 턴 종료는 눌렀지만 파워 수락/거절 응답 대기 때문에 다음 턴으로 아직 넘기지 못한 플레이어 ID */
  pendingTurnEndPlayerId?: string;
  /** 우주선: 맵 타일 ID -> { 잠금해제 여부, 입장한 플레이어 ID 순서, 이번 라운드 사용한 액션 번호(1,2,3) 목록 } */
  spaceships?: Record<string, { unlocked: boolean; occupants: string[]; actionsUsed?: number; usedActionIndices?: number[]; usedActionBy?: Record<number, string> }>;
  /** 트왈라잇 액션1: 연방 해택 재수령 선택 대기 (보유 연방 중 하나 선택 = federation reward id) */
  pendingTwilightFederation?: { playerId: string; shipTileId: string; fromArtifact?: boolean } | null;
  /** 트왈라잇 액션2: 2O+3P로 TS→연구소 업그레이드 시 기술 타일 선택은 기존 pendingTechTileSelection 사용 */
  /** TF Mars 액션2: 포밍 보너스 타일과 동일 = 가이아 프로젝트 액션 1회 (Transdim에 가이아포머 배치) */
  pendingTFMarsGaiaProject?: { playerId: string; shipTileId: string } | null;
  /** Eclipse 액션2: 2K+3P 지불 후 올릴 연구 트랙 선택 대기 */
  pendingEclipseResearch?: {
    playerId: string; shipTileId: string;
    /** [취소 정확도 2026-08-07] 지불 직전 스냅샷 — 종족별 지불 경로(타클론 브레인/네블라 토큰환산)를 그대로 되돌리기 위함 */
    pre?: { knowledge: number; power1: number; power2: number; power3: number; brainStoneBowl?: number };
  } | null;
  /** Eclipse 액션3: 6C 지불 후 소행성 광산 건설할 타일 선택 대기 */
  pendingEclipseAsteroidMine?: { playerId: string; shipTileId: string } | null;
  /** 우주선 기술 타일 3개 중 하나 획득 시: 하단 풀 3개처럼 6개 트랙 중 원하는 트랙 1칸 진행 선택 대기 */
  pendingShipTechTrackAdvance?: { playerId: string; fromItars?: boolean } | null;
  /** 고급 기술 타일 획득 시: 덮을 일반 타일 선택 대기 → 선택 후 pendingAdvancedTechTrackAdvance로 트랙 1칸 선택 */
  /** fromItarsExchange: 아이타 의회(가이아 토큰 4개) 교환에서 온 고급 타일 — 후속 트랙 전진이 메인 액션을 소모하면 안 됨 */
  pendingAdvancedTechCover?: { playerId: string; advancedTileId: string; trackId?: ResearchTrack; fromItarsExchange?: boolean } | null;
  /** 고급 기술 타일 획득 후: 원하는 트랙 1칸 진행 선택 대기 (우주선/풀 타일과 동일) */
  pendingAdvancedTechTrackAdvance?: { playerId: string; fromItarsExchange?: boolean } | null;
  /** 거리 5 보상 잊혀진 행성: 해당 플레이어가 빈 우주 타일을 클릭해 특수 광산 배치 대기 */
  pendingLostPlanet?: { playerId: string } | null;
  /** 우주선 기술 타일 "2TF+Mine" 획득 후 남은 광산 건설 대기 */
  pendingShipTechMine?: { playerId: string } | null;

  /** 트왈라잇 인공물: 4칸 슬롯 (매 게임 4개 랜덤 배치, 가져가면 null) */
  twilightArtifactSlots?: (string | null)[];

  /** 연방: 타입별 남은 개수 (각 3개씩) */
  federationPool?: Record<string, number>;
  /** 우주선 연방: 우주선 타입별로 8종 중 서로 다른 1개씩 랜덤 배치 (ship_twilight, ship_rebellion, ship_tf_mars, ship_eclipse). 누군가 가져가면 해당 우주선은 없음 */
  spaceshipFederationByShip?: Record<string, string>;
  /** 연방: 테라포밍 5단계에 놓인 연방 보상 ID (매 게임 랜덤 1종) */
  federationOnTerraforming5?: string;
  /** 연방: 타일 ID -> 해당 타일에 위성을 둔 플레이어 ID 목록 (한 빈칸에 여러 플레이어 가능) */
  satellites?: Record<string, string[]>;
  /** 연방 구현 모드: 빈공간(위성)·내 건물 행성·내 우주정거장 칸 선택 중. 빈공간만 위성/QIC 소모, 건물/우주정거장은 연방 계산 기준점만 */
  federationMode?: { playerId: string; selectedHexIds: string[]; selectedPlanetIds?: string[]; selectedSpaceStationHexIds?: string[]; toggleSeq?: number } | null;
  /** 연방 모드에서 클릭할 때마다 서버가 채우는 미리보기: 포함될 건물·파워·필요 파워 */
  federationPreview?: { power: number; requiredPower: number; items: Array<{ tileId: string; label: string; power: number }>; connected?: boolean } | null;
  /** 연방 완료 후 보상 선택 대기 (선택된 빈공간 수 = 소모한 파워토큰 수) */
  pendingFederationReward?: { playerId: string; selectedHexIds: string[]; selectedPlanetIds?: string[]; selectedSpaceStationHexIds?: string[]; spentTokens: number } | null;
  /** 우주선 연방 "광산 1개 무료 (Nav 무시)" 보상: 빈 행성 클릭 시 무료 광산 배치 대기 */
  pendingSpaceshipFedMine?: { playerId: string } | null;
  /** 우주선 연방 "3 TF + 테라포밍·광산 무료": 남은 TF 단계 후 무료 광산 1개 배치 대기 */
  pendingSpaceshipFed3TfMine?: { playerId: string; stepsRemaining: number } | null;
  /** 연방에 포함된 빈공간 타일 ID (플레이어별). 하이브 2회째 이후 연방 시 인접 허용용 */
  playerFederationHexes?: Record<string, string[]>;

  /** 테란 의회: 가이아포머 토큰 복귀 후 해택 선택 (토큰 수만큼 4→QIC/K, 3→O, 1→C 교환) */
  pendingTerranCouncilBenefit?: { playerId: string; tokenCount: number } | null;
  /** 테란 의회: 대기 중인 다른 테란 플레이어들 (순서대로 처리) */
  terranCouncilQueue?: { playerId: string; tokenCount: number }[];
  /** 아이타 의회: 가이아포머 공간 토큰 4개당 기술 타일 1개 교환 선택 대기 (그만 두면 나머지 1그릇 복귀) */
  pendingItarsGaiaformerExchange?: { playerId: string; tokensRemaining: number } | null;
  /** 아이타 의회: 기술 타일 선택 완료 후 남은 토큰 수 (다음 교환 묻기 또는 1그릇 복귀용) */
  itarsGaiaformerRemainingAfterTech?: number;
  /** 아이타 의회 처리 후 진행: 테란 의회 큐 (같은 라운드에 테란+아이타 둘 다 있을 때) */
  terranCouncilQueueAfterItars?: { playerId: string; tokenCount: number }[];
  /** 확장: 모웨이드용 7색상 중 3테라포밍으로 정해진 3개 (나머지 4개는 1테라포밍) */
  moweyipThreeStepPlanets?: PlanetType[];
  /** 확장: 팅커로이드용 7색상 중 3테라포밍으로 정해진 3개 (나머지 4개는 1테라포밍) */
  tinkeroidsThreeStepPlanets?: PlanetType[];
  /** 팅커로이드: 라운드 시작 시 Special 1개 선택 대기 (옵션 1개면 자동 지정) */
  pendingTinkeroidSpecialChoice?: { playerId: string; round: number; options: string[] } | null;
  /** 구버전 Undo용 전체 게임 상태 스냅샷. freeActionUndoStack으로 대체됨. */
  freeActionUndoState?: string;
  /** Free Action 단계별 Undo 스냅샷 스택(최신이 끝). */
  freeActionUndoStack?: string[];

  /** 로비에서 호스트가 켠 경우에만 start_game 시 종족 비딩 단계로 진입 */
  useFactionBidding?: boolean;
  /** 친선전: 켜면 게임 종료 시 기록(점수) 사이트에 자동 저장하지 않음. 방 전체에 표시. */
  friendlyMatch?: boolean;
  /** 이 서버가 AI 봇 추가/Auto Setup을 허용하는지(env AI_BOTS_ENABLED). false면 로비에서 봇 추가·Auto Setup 버튼 숨김. */
  aiBotsAllowed?: boolean;
  /** [롤백 투표] 호스트가 특정 지점 롤백을 요청하면 세팅 — 다른 사람 전원(사람) 동의 시 실행. 봇은 자동 승인. */
  pendingRollback?: {
    requesterId: string;
    requesterName: string;
    seq: number;        // 되돌릴 턴 시작 스냅샷의 seq
    label: string;      // 예: "R3 · 사보르 턴 시작"
    turnsBack: number;  // 몇 턴 전으로 되돌리는지
    undoneCount: number;// 되돌려 사라질 로그(행동) 수
    undoneActions: string[]; // 되돌릴 행동 요약(최근 몇 개, "이름: 액션")
    required: string[]; // 승인이 필요한 사람 playerId 목록
    approvals: string[];// 승인한 playerId 목록
  } | null;
  /** 종족 비딩 진행 상태 (factionBidding 단계에서만) */
  factionBidding?: FactionBiddingState | null;
}

/** 종족 비딩(경매) 서버 상태 */
export interface FactionBiddingState {
  phase: 'bidding' | 'pick';
  /** 아직 배정되지 않은 종족 ID (이번 판 풀) */
  remainingFactionIds: string[];
  /** 경매 참가자 순서 (턴 순서 기준) */
  auctionBaseOrder: string[];
  /** 현재 라운드 경매에 남은 플레이어 */
  inAuction: string[];
  /** 현재 입찰 차례 (bidding 단계) */
  currentBidderId: string | null;
  currentHighBid: number;
  leaderId: string | null;
  /** pick 단계: 낙찰자 */
  pickPlayerId: string | null;
  pendingWinningBid: number;
}

/** 연방 1개: rewardId + 초록(5단계/고급타일 획득에 사용 가능) 또는 빨강(이미 사용). 12점 연방은 획득 시 빨강 */
export interface FederationEntry {
  rewardId: string;
  isGreen: boolean;
  /** 테라포밍 5단계 보상으로 받은 연방(선언 아님) — 하이브 누적 요구파워 계산에서 제외용 */
  fromTrack5?: boolean;
}

/** 12점 연방 ID: 획득 시 바로 빨강이라 5단계/고급 타일 획득에 사용 불가 */
export const FEDERATION_12VP_ID = 'fed-12vp';

/** 연방 보상 타입 (id -> 남은 개수는 game.federationPool) */
export const FEDERATION_REWARDS = [
  { id: 'fed-7vp-6c', label: '7 VP 6C', vp: 7, credits: 6 },
  { id: 'fed-7vp-2o', label: '7 VP 2O', vp: 7, ore: 2 },
  { id: 'fed-8vp-2token', label: '8 VP 2 Token', vp: 8, powerTokens: 2 },
  { id: 'fed-6vp-2k', label: '6 VP 2K', vp: 6, knowledge: 2 },
  { id: 'fed-8vp-1q', label: '8 VP 1 QIC', vp: 8, qic: 1 },
  { id: 'fed-12vp', label: '12 VP', vp: 12 },
] as const;

/** 우주선 전용 연방 보상 (8종 중 매 게임 1개 랜덤 배치, 수량 1개) */
export const SPACESHIP_FEDERATION_REWARDS = [
  { id: 'ship-fed-4vp4k', label: '4VP 4K', vp: 4, knowledge: 4 },
  { id: 'ship-fed-8vp8c', label: '8 VP 8C', vp: 8, credits: 8 },
  { id: 'ship-fed-3tf-mine', label: 'Free Mine (3 Terraform)', vp: 0 },
  { id: 'ship-fed-4vp1q2o', label: '4 VP 1Q 2O', vp: 4, qic: 1, ore: 2 },
  { id: 'ship-fed-tech', label: 'Tech Tile', vp: 0 },
  { id: 'ship-fed-7vp3p2t', label: '7 VP +2Tokens', vp: 7, powerTokens: 2 },
  { id: 'ship-fed-12vp', label: '12 VP', vp: 12 },
  { id: 'ship-fed-mine-free', label: 'Free Mine (Nav ignore)', vp: 0 },
] as const;

/** 글린 전용 의회 보상 연방. 일반/우주선 연방 이미지 번호를 유지하기 위해 별도 ID로 관리 */
export const GLEENS_FEDERATION_REWARD = { id: 'gleens-fed-1o1k2c', label: '1O 1K 2C', vp: 0, ore: 1, knowledge: 1, credits: 2 } as const;

/** 플레이어 연방 배열 정규화 (레거시 string[] → FederationEntry[]) */
export function getFederationEntries(player: { federations?: string[] | FederationEntry[] } | null): FederationEntry[] {
  if (!player?.federations?.length) return [];
  const raw = player.federations;
  if (typeof raw[0] === 'string') {
    return (raw as string[]).map((id: string) => ({ rewardId: id, isGreen: id !== FEDERATION_12VP_ID }));
  }
  return raw as FederationEntry[];
}

/** 초록 연방 개수 (5단계/고급 타일 획득에 사용 가능) */
export function countGreenFederations(player: { federations?: string[] | FederationEntry[] } | null): number {
  return getFederationEntries(player).filter((e) => e.isGreen).length;
}

/** 해당 기술 타일이 고급 타일에 의해 덮여 비활성인지 (덮인 타일은 수입·액션·큰건물값 미적용) */
export function isTechTileCovered(player: { coveredTechTiles?: string[] } | null, tileId: string): boolean {
  return player?.coveredTechTiles?.includes(tileId) ?? false;
}

/** 초록 연방 1개 소모(빨강으로 변경). 성공 시 true, 없으면 false. 레거시 string[]이면 정규화 후 소모 */
export function spendGreenFederation(player: { federations?: string[] | FederationEntry[] }): boolean {
  if (!Array.isArray(player.federations) || !player.federations.length) return false;
  if (typeof (player.federations as any)[0] === 'string') {
    (player as { federations: FederationEntry[] }).federations = getFederationEntries(player);
  }
  const arr = (player as { federations: FederationEntry[] }).federations;
  const idx = arr.findIndex((e) => e.isGreen);
  if (idx === -1) return false;
  arr[idx].isGreen = false;
  return true;
}

/** Twilight artifacts (4 random per game, take for 6 power 1→2→3) */
export const ARTIFACTS = [
  { id: 'art-vp-science', label: 'Science×3 VP', description: 'Once: VP = Science track level × 3.', effect: 'vp_science_x3' },
  { id: 'art-7vp-virtual-proto', label: '7VP+Virtual mine (proto)', description: 'Once: 7 VP. Virtual mine on proto (same).', effect: '7vp_virtual_mine_proto' },
  { id: 'art-vp-gaia', label: 'Gaia×3 VP', description: 'Once: VP = Gaia track level × 3.', effect: 'vp_gaia_x3' },
  { id: 'art-fed-once', label: 'Federation reward once', description: 'Once: Gain one federation reward again (Twilight action 1).', effect: 'federation_once' },
  { id: 'art-imm-2o5c', label: '2O 5C', description: 'Once: 2 Ore, 5 Credits.', effect: 'imm_2o5c' },
  { id: 'art-7vp-virtual-asteroid', label: '7VP+Virtual mine (asteroid)', description: 'Once: 7 VP. Virtual mine on asteroid (no O, counts for 2VP/mine, 1VP/mine, planet types).', effect: '7vp_virtual_mine_asteroid' },
  { id: 'art-vp-planet-types', label: '3+Planet types VP', description: 'Once: VP = 3 + (planet types you have).', effect: 'vp_3_planet_types' },
  { id: 'art-imm-3k1q', label: '3K 1Q', description: 'Once: 3 Knowledge, 1 QIC.', effect: 'imm_3k1q' },
  { id: 'art-vp-tracks3', label: 'Tracks≥3 ×3 VP', description: 'Once: VP = (tracks at level ≥3) × 3.', effect: 'vp_tracks3_x3' },
  { id: 'art-income-1k1o', label: 'Income: 1K 1O', description: 'Income: 1 Knowledge, 1 Ore.', incomeK: 1, incomeO: 1 },
  { id: 'art-imm-3o3c', label: '3O 3C', description: 'Once: 3 Ore, 3 Credits.', effect: 'imm_3o3c' },
  { id: 'art-vp-bridge', label: '3VP/Bridge section', description: 'Once: 3 VP per bridge section with at least 1 of your buildings.', effect: 'vp_bridge_sector_x3' },
  { id: 'art-income-2p3', label: 'Income: 2 to bowl 3', description: 'Income: 2 Power to bowl 3.', incomePower3: 2 },
] as const;
export type ArtifactId = typeof ARTIFACTS[number]['id'];



export const PLANET_COLORS: Record<PlanetType, string> = {
  lost_planet: '#78909C', // Lost Planet (블루-그레이) - 잊혀진 행성  
  terra: '#3B5998',    // Terra (블루) - 더 진한 블루
  oxide: '#E65100',    // Oxide (오렌지) - 원래 주황색 땅
  volcanic: '#B71C1C', // Volcanic (레드) - 원래 빨간색 땅 (용암)
  desert: '#F9A825',   // Desert (옐로우) - 모래색 옐로우
  swamp: '#4E342E',    // Swamp (브라운) - 더 어두운 갈색
  titanium: '#424242', // Titanium (그레이) - 금속성 회색
  ice: '#B3E5FC',      // Ice (라이트 블루) - 얼음 느낌 하늘색
  transdim: '#6A1B9A', // Transdim (퍼플) - 신비로운 보라
  gaia: '#2E7D32',     // Gaia (그린) - 깊은 초록
  space: '#0D1117',    // Space - 우주 공간
  deep_space: '#010409', // Deep Space - 더 어두운 우주
  asteroid: '#AB47BC', // Asteroid (퍼플-핑크) - 소행성대
  lost_fleet_ship: '#CFD8DC', // Lost Fleet Ship - 은색
  ship_rebellion: '#D32F2F',  // Rebellion Ship - 붉은색
  ship_twilight: '#7B1FA2',   // Twilight Ship - 보라색
  ship_tf_mars: '#E64A19',    // TF Mars Ship - 주황색
  ship_eclipse: '#1976D2',    // Eclipse Ship - 파란색
  proto: '#00E5FF',           // Proto (밝은 청록색) - Space Giants 메인 색상
};

export const SECTOR_COLORS: Record<number, string> = {
  1: '#1a1f2c', 2: '#2c1a1f', 3: '#1f2c1a', 4: '#1a2c2c', 5: '#2c2c1a',
  6: '#251a2c', 7: '#1a2c25', 8: '#2c251a', 9: '#1a1a2c', 10: '#2c1a1a',
  20: '#121212', // Internal
  11: '#1e1b25', 12: '#251b1e', 13: '#1b251e', 14: '#1e251b',
  15: '#25211b', 16: '#1b2125', 17: '#211b25', 18: '#1b1e25',
};

export const STRUCTURE_SYMBOLS: Record<string, string> = {
  mine: 'M',
  trading_station: 'TS',
  research_lab: 'RL',
  planetary_institute: 'PI',
  academy: 'AC',
};

export const INITIAL_POWER_ACTIONS: PowerAction[] = [
  { id: 'gain-3-knowledge', cost: 7, costType: 'power', isUsed: false, label: '3K' },
  { id: 'gain-2-steps', cost: 5, costType: 'power', isUsed: false, label: '2 Steps' },
  { id: 'gain-2-ore', cost: 4, costType: 'power', isUsed: false, label: '2O' },
  { id: 'gain-7-credits', cost: 4, costType: 'power', isUsed: false, label: '7C' },
  { id: 'gain-2-knowledge', cost: 4, costType: 'power', isUsed: false, label: '2K' },
  { id: 'gain-1-step', cost: 3, costType: 'power', isUsed: false, label: '1 Step' },
  { id: 'gain-2-tokens', cost: 3, costType: 'power', isUsed: false, label: '2 Tokens' },
];

export const ALL_TECH_TILES: TechTile[] = [
  { id: 'tech-inc-1o-1p', label: 'INC: 1O, 1P', description: 'Income Phase: Gain 1 Ore and 1 Power Charge.', image: '/tech/TechTile_B2.png' },
  { id: 'tech-inc-4c', label: 'INC: 4C', description: 'Income Phase: Gain 4 Credits.', image: '/tech/TechTile_B1.png' },
  { id: 'tech-inc-1k-1c', label: 'INC: 1K, 1C', description: 'Income Phase: Gain 1 Knowledge and 1 Credit.', image: '/tech/TechTile_B7.png' },
  { id: 'tech-imm-7vp', label: '7VP', description: 'Gain 7 VP immediately. One-time bonus.', image: '/tech/TechTile_B8.png' },
  { id: 'tech-imm-1k-planet', label: '1K/Type', description: 'Gain 1 Knowledge for each planet type you have colonized.', image: '/tech/TechTile_B3.png' },
  { id: 'tech-imm-1o-1q', label: '1O, 1Q', description: 'Gain 1 Ore and 1 QIC immediately.', image: '/tech/TechTile_B4.png' },
  { id: 'tech-gaia-3vp', label: 'Gaia: +3VP', description: 'When you build a Mine on a Gaia Planet, gain 3 VP.', image: '/tech/TechTile_B6.png' },
  { id: 'tech-big-4str', label: 'Big: 4Str', description: 'Your Planetary Institute and Academies count as 4 strength for Federations.', image: '/tech/TechTile_B5.png' },
  { id: 'tech-act-4p', label: 'ACT: 4P', description: 'Action: Gain 4 Power. (Use once per round)', specialAction: '4power', image: '/tech/TechTile_B9.png' },
];

/** 우주선 전용 기술 타일 (해당 우주선 입장 시에만 선택 가능) */
export const SHIP_TECH_TILES: TechTile[] = [
  { id: 'ship-tech-nav+1', label: 'Ship: Nav+1', description: 'Permanent +1 to Navigation (range).', isAdvanced: true, image: '/tech/TechTile_B12.png' },
  { id: 'ship-tech-1o3k', label: 'Ship: 1O 3K', description: 'Immediately gain 1 Ore and 3 Knowledge.', isAdvanced: true, image: '/tech/TechTile_B11.png' },
  { id: 'ship-tech-2tf-mine', label: 'Ship: 2TF+Mine', description: '2 terraform steps then build 1 mine for free (no ore/credits).', isAdvanced: true, image: '/tech/TechTile_B10.png' },
];

/** 우주선 타입별 전용 기술 타일 ID (각 우주선 1개씩) */
export const SHIP_TECH_BY_SHIP: Record<string, string> = {
  ship_rebellion: 'ship-tech-nav+1',
  ship_tf_mars: 'ship-tech-1o3k',
  ship_eclipse: 'ship-tech-2tf-mine',
};

export const BRIDGE_SPECS: { sideA: PlanetType[], sideB: PlanetType[] }[] = [
  { sideA: ['asteroid'], sideB: ['asteroid', 'proto'] },
  { sideA: ['transdim', 'proto'], sideB: ['asteroid'] },
  { sideA: ['transdim', 'asteroid'], sideB: ['asteroid'] },
  { sideA: ['asteroid'], sideB: ['asteroid', 'proto'] },
  { sideA: ['proto'], sideB: ['proto', 'asteroid'] },
  { sideA: ['asteroid', 'asteroid'], sideB: ['proto'] },
  { sideA: ['asteroid'], sideB: ['transdim'] },
  { sideA: ['proto'], sideB: ['asteroid'] },
];

export const ALL_ADVANCED_TECH_TILES: TechTile[] = [
  // 1. 액션으로 자원 얻기 (3개)
  { id: 'adv-act-3k', label: 'ACT: 3K', description: 'Action: Gain 3 Knowledge.', isAdvanced: true, specialAction: '3knowledge', image: '/tech/TechTile_A1.png' },
  { id: 'adv-act-3o', label: 'ACT: 3O', description: 'Action: Gain 3 Ore.', isAdvanced: true, specialAction: '3ore', image: '/tech/TechTile_A13.png' },
  { id: 'adv-act-1q-5c', label: 'ACT: 1Q+5C', description: 'Action: Gain 1 QIC and 5 Credits.', isAdvanced: true, specialAction: '1qic_5credits', image: '/tech/TechTile_A8.png' },

  // 2. 액션마다 점수 얻기 (5개)
  { id: 'adv-vp-build-mine', label: '3VP/Mine Built', description: 'Gain 3VP each time you build a mine.', isAdvanced: true, image: '/tech/TechTile_A11.png' },
  { id: 'adv-vp-build-ts', label: '3VP/TS Built', description: 'Gain 3VP each time you build a trading station.', isAdvanced: true, image: '/tech/TechTile_A12.png' },
  { id: 'adv-vp-research', label: '2VP/Research', description: 'Gain 2VP each time you advance on a research track.', isAdvanced: true, image: '/tech/TechTile_A9.png' },
  { id: 'adv-vp-terraform', label: '2VP/Terraform', description: 'Gain 2VP for each terraforming step.', isAdvanced: true, image: '/tech/TechTile_A20.png' },
  { id: 'adv-vp-qic-action', label: '4VP/QIC Action', description: 'Gain 4VP each time you take a QIC action.', isAdvanced: true, image: '/tech/TechTile_A19.png' },

  // 3. 일시불 자원 (1개)
  { id: 'adv-imm-1o-sector', label: '1O/Sector', description: 'Immediately gain 1 Ore for each sector you occupy.', isAdvanced: true, image: '/tech/TechTile_A15.png' },

  // 4. 일시불 점수 (7개)
  { id: 'adv-imm-4vp-ts', label: '4VP/TS', description: 'Immediately gain 4VP for each trading station (counted after upgrade if taken with Lab).', isAdvanced: true, image: '/tech/TechTile_A6.png' },
  { id: 'adv-imm-2vp-mine', label: '2VP/Mine', description: 'Immediately gain 2VP for each mine.', isAdvanced: true, image: '/tech/TechTile_A2.png' },
  { id: 'adv-imm-2vp-sector', label: '2VP/Sector', description: 'Immediately gain 2VP for each sector you occupy.', isAdvanced: true, image: '/tech/TechTile_A3.png' },
  { id: 'adv-imm-4vp-outer', label: '4VP/Outer', description: 'Immediately gain 4VP for each outer sector (C-sectors) you occupy.', isAdvanced: true, image: '/tech/TechTile_A21.png' },
  { id: 'adv-imm-6vp-big', label: '6VP/Big Bldg', description: 'Immediately gain 6VP for each big building (PI & Academy).', isAdvanced: true, image: '/tech/TechTile_A16.png' },
  { id: 'adv-imm-2vp-gaia', label: '2VP/Gaia', description: 'Immediately gain 2VP for each Gaia planet you occupy.', isAdvanced: true, image: '/tech/TechTile_A14.png' },
  { id: 'adv-imm-5vp-fed', label: '5VP/Federation', description: 'Immediately gain 5VP for each federation.', isAdvanced: true, image: '/tech/TechTile_A4.png' },

  // 5. 패스 시 점수 (5개)
  { id: 'adv-pass-1vp-type', label: 'Pass:1VP/Type', description: 'When passing: Gain 1VP for each planet type you colonized.', isAdvanced: true, image: '/tech/TechTile_A10.png' },
  { id: 'adv-pass-3vp-lab', label: 'Pass:3VP/Lab', description: 'When passing: Gain 3VP for each research lab.', isAdvanced: true, image: '/tech/TechTile_A7.png' },
  { id: 'adv-pass-3vp-fed', label: 'Pass:3VP/Fed', description: 'When passing: Gain 3VP for each federation.', isAdvanced: true, image: '/tech/TechTile_A5.png' },
  { id: 'adv-pass-2vp-asteroid', label: 'Pass:2VP/Asteroid', description: 'When passing: Gain 2VP for each asteroid you occupy.', isAdvanced: true, image: '/tech/TechTile_A18.png' },
  { id: 'adv-pass-2vp-outer', label: 'Pass:2VP/Outer', description: 'When passing: Gain 2VP for each outer sector (C-sectors) you occupy.', isAdvanced: true, image: '/tech/TechTile_A17.png' },
];

export interface Faction {
  id: string;
  name: string;
  homePlanet: PlanetType;
  color: string;
  startingTech: Partial<Record<ResearchTrack, number>>;
  startingResources: { ore: number; knowledge: number; credits: number; qic: number };
  startingPower: { bowl1: number; bowl2: number; bowl3: number };
  // Special faction abilities
  startingMines?: number; // Default 2, some factions start with 1
  startingStructure?: 'mine' | 'planetary_institute'; // Default 'mine', Tinkeroids/Hivs start with PI
  baseIncome?: {
    ore?: number;      // Default 1
    knowledge?: number; // Default 1
    credits?: number;  // e.g. Hadsch Hallas +3C
    qic?: number;     // e.g. Ivits (하이브) +1 QIC
    powerTokens?: number; // Some factions get extra tokens
  };
  /** Planetary Institute(의회) 수익: 종족마다 상이 */
  piIncome?: {
    power?: number;    // 3그릇으로 이동
    tokens?: number;   // 1그릇에 추가
    ore?: number;
    qic?: number;
  };
}

export const FACTIONS: Faction[] = [
  {
    id: 'terran', name: 'Terrans', homePlanet: 'terra', color: PLANET_COLORS.terra,
    startingTech: { gaiaProject: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 4, bowl3: 0 },
    baseIncome: { ore: 1, knowledge: 1 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'lantids', name: 'Lantids', homePlanet: 'terra', color: PLANET_COLORS.terra,
    startingTech: {},
    startingResources: { ore: 4, knowledge: 3, credits: 13, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 0, bowl3: 0 },
    baseIncome: { ore: 1, knowledge: 1, powerTokens: 1 },
    piIncome: { power: 4 }
  },
  {
    id: 'hadsch_hallas', name: 'Hadsch Hallas', homePlanet: 'volcanic', color: PLANET_COLORS.volcanic,
    startingTech: { economy: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    baseIncome: { credits: 3 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'ivits', name: 'Ivits', homePlanet: 'volcanic', color: PLANET_COLORS.volcanic,
    startingTech: {},
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 2, bowl3: 0 },
    startingMines: 1,
    startingStructure: 'planetary_institute',
    piIncome: { power: 4, tokens: 1, qic: 1 }
  },
  {
    id: 'geodens', name: 'Geodens', homePlanet: 'oxide', color: PLANET_COLORS.oxide,
    startingTech: { terraforming: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'bal_tak', name: "Bal T'aks", homePlanet: 'oxide', color: PLANET_COLORS.oxide,
    startingTech: { gaiaProject: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 0 },
    startingPower: { bowl1: 2, bowl2: 2, bowl3: 0 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'xenos', name: 'Xenos', homePlanet: 'desert', color: PLANET_COLORS.desert,
    startingTech: { artificialIntelligence: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    startingMines: 3,
    piIncome: { power: 4, qic: 1 }
  },
  {
    id: 'gleens', name: 'Gleens', homePlanet: 'desert', color: PLANET_COLORS.desert,
    startingTech: { navigation: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 0 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    piIncome: { power: 4, ore: 1 }
  },
  {
    id: 'taklons', name: 'Taklons', homePlanet: 'swamp', color: PLANET_COLORS.swamp,
    startingTech: {},
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'ambas', name: 'Ambas', homePlanet: 'swamp', color: PLANET_COLORS.swamp,
    startingTech: { navigation: 1 },
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    baseIncome: { ore: 2, knowledge: 1 },
    piIncome: { power: 4, tokens: 2 }
  },
  {
    id: 'bescods', name: 'Bescods', homePlanet: 'titanium', color: PLANET_COLORS.titanium,
    startingTech: {},
    startingResources: { ore: 4, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    baseIncome: { ore: 1, knowledge: 0 },
    piIncome: { power: 4, tokens: 2 }
  },
  {
    id: 'firaks', name: 'Firaks', homePlanet: 'titanium', color: PLANET_COLORS.titanium,
    startingTech: {},
    startingResources: { ore: 3, knowledge: 2, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    baseIncome: { ore: 1, knowledge: 2 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'itars', name: 'Itars', homePlanet: 'ice', color: PLANET_COLORS.ice,
    startingTech: {},
    startingResources: { ore: 5, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 4, bowl3: 0 },
    baseIncome: { ore: 1, knowledge: 1, powerTokens: 1 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'nevlas', name: 'Nevlas', homePlanet: 'ice', color: PLANET_COLORS.ice,
    startingTech: { science: 1 },
    startingResources: { ore: 4, knowledge: 2, credits: 15, qic: 1 },
    startingPower: { bowl1: 2, bowl2: 4, bowl3: 0 },
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'moweyip', name: 'Moweyds', homePlanet: 'proto', color: PLANET_COLORS.proto,
    startingTech: { gaiaProject: 1 },
    startingResources: { ore: 6, knowledge: 5, credits: 15, qic: 2 },
    startingPower: { bowl1: 4, bowl2: 4, bowl3: 0 },
    startingMines: 1,
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'space_giants', name: 'Space Giants', homePlanet: 'proto', color: PLANET_COLORS.proto,
    startingTech: { navigation: 1 },
    startingResources: { ore: 6, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 4, bowl3: 0 },
    startingMines: 1,
    piIncome: { power: 6, tokens: 1 }
  },
  {
    id: 'tinkeroids', name: 'Tinkeroids', homePlanet: 'asteroid', color: PLANET_COLORS.asteroid,
    startingTech: { science: 1 },
    startingResources: { ore: 4, knowledge: 2, credits: 15, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 2, bowl3: 0 },
    startingMines: 1,
    startingStructure: 'planetary_institute',
    piIncome: { power: 4, tokens: 1 }
  },
  {
    id: 'darkanians', name: 'Darkanians', homePlanet: 'asteroid', color: PLANET_COLORS.asteroid,
    startingTech: { navigation: 1, economy: 1 },
    startingResources: { ore: 7, knowledge: 3, credits: 15, qic: 1 },
    startingPower: { bowl1: 4, bowl2: 2, bowl3: 0 },
    startingMines: 1,
    piIncome: { power: 4, tokens: 1 }
  },
];

export const STRUCTURE_INCOME = {
  mine: [1, 1, 0, 1, 1, 1, 1, 1], // Mine slots 1-8
  trading_station: [3, 4, 4, 5],
  research_lab: [1, 1, 1],
  academy: { left: 2, right: 0 }, // Left: 2K, Right: Action
};

export function getRange(navLevel: number): number {
  if (navLevel >= 5) return 4;
  if (navLevel >= 4) return 3;
  if (navLevel >= 2) return 2;
  return 1;
}

/** 표시/비용용 유효 기본 거리 (Nav + Nav보너스 + 3거리/글린+2 보너스 반영) */
export function getEffectiveBaseRange(player: { research?: { navigation?: number }; navigationBonus?: number; tempRangeBonus?: boolean; rangeBonusActive?: boolean; gleensNavBonusActive?: boolean } | null): number {
  if (!player) return 0;
  let r = getRange(player.research?.navigation ?? 0) + (player.navigationBonus ?? 0);
  if (player.tempRangeBonus) r += 3;
  if (player.rangeBonusActive) r += 3;
  if (player.gleensNavBonusActive) r += 2;
  return r;
}

export function getTerraformCost(tfLevel: number): number {
  if (tfLevel >= 3) return 1;
  if (tfLevel >= 2) return 2;
  return 3;
}

// 경제 트랙 수익 타입
export type EconomyIncome = {
  credits: number;
  ore: number;
  power: number;
  vp?: number;
};

// 경제 트랙 수익 - 파워 변형 (옵션 A)
export const ECONOMY_INCOME_POWER: EconomyIncome[] = [
  { credits: 0, ore: 0, power: 0 }, // L0
  { credits: 2, ore: 0, power: 1 }, // L1
  { credits: 2, ore: 1, power: 2 }, // L2
  { credits: 2, ore: 1, power: 3 }, // L3
  { credits: 2, ore: 2, power: 2 }, // L4
  { credits: 0, ore: 0, power: 0 }, // L5 (즉시 보상이므로 수익 없음)
];

// 경제 트랙 수익 - 점수 변형 (옵션 B)
export const ECONOMY_INCOME_VP: EconomyIncome[] = [
  { credits: 0, ore: 0, power: 0 }, // L0
  { credits: 2, ore: 0, power: 1 }, // L1
  { credits: 2, ore: 1, power: 2 }, // L2
  { credits: 3, ore: 1, power: 0, vp: 1 }, // L3
  { credits: 4, ore: 2, power: 0, vp: 1 }, // L4
  { credits: 0, ore: 0, power: 0 }, // L5 (즉시 보상이므로 수익 없음)
];

// 기본값 (하위 호환성)
export const ECONOMY_INCOME = ECONOMY_INCOME_POWER;

/** 다음 라운드 수익 단계에서 얻게 될 자원 예상치 (UI 미리보기용) */
export function getNextRoundIncomePreview(
  playerId: string,
  game: GaiaGameState,
  options: { excludeBonusTiles?: boolean } = {}
): { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number } {
  const player = game.players[playerId];
  if (!player?.faction) return { ore: 0, credits: 0, knowledge: 0, qic: 0, powerCharge: 0, powerTokens: 0 };
  const faction = FACTIONS.find(f => f.id === player.faction);
  const result = { ore: 0, credits: 0, knowledge: 0, qic: 0, powerCharge: 0, powerTokens: 0 };
  const structures = game.map.filter(t => t.ownerId === playerId);
  const parasiticMineCount = game.map.filter(t => t.parasiticMine?.ownerId === playerId).length;

  const baseOre = faction?.baseIncome?.ore ?? 1;
  const baseKnowledge = faction?.baseIncome?.knowledge ?? 1;
  const baseCredits = faction?.baseIncome?.credits ?? 0;
  const baseQic = faction?.baseIncome?.qic ?? 0;
  const basePowerTokens = faction?.baseIncome?.powerTokens ?? 0;
  result.ore += baseOre;
  result.knowledge += baseKnowledge;
  result.credits += baseCredits;
  result.qic += baseQic;
  result.powerTokens += basePowerTokens;

  const mineCount = structures.filter(t => t.structure === 'mine').length + parasiticMineCount;
  for (let i = 0; i < mineCount && i < STRUCTURE_INCOME.mine.length; i++) {
    result.ore += STRUCTURE_INCOME.mine[i];
  }
  const tsCount = structures.filter(t => t.structure === 'trading_station').length;
  for (let i = 0; i < tsCount && i < STRUCTURE_INCOME.trading_station.length; i++) {
    if (player.faction === 'bescods') result.knowledge += 1;
    else result.credits += STRUCTURE_INCOME.trading_station[i];
  }
  const labCount = structures.filter(t => t.structure === 'research_lab').length;
  if (player.faction === 'bescods') {
    if (labCount > 0) {
      const labCredits = [3, 4, 5];
      for (let i = 0; i < labCount && i < labCredits.length; i++) result.credits += labCredits[i];
    }
  } else {
    if (labCount > 0) {
      if (player.faction === 'nevlas') result.powerCharge += 2 * labCount;
      else result.knowledge += labCount;
    }
  }
  const leftAcademyCount = structures.filter(t => t.structure === 'academy' && t.academyType === 'left').length;
  if (leftAcademyCount > 0) {
    // 아이타 지식 아카데미는 3K (server/gameState.ts 실제 지급과 동일)
    const kPerLeft = player.faction === 'itars' ? 3 : STRUCTURE_INCOME.academy.left;
    result.knowledge += kPerLeft * leftAcademyCount; // 보통 1개지만 확장성 고려
  }

  const econLevel = player.research?.economy ?? 0;
  if (econLevel < 5) {
    const economyIncome = game.economyVariant === 'vp' ? ECONOMY_INCOME_VP : ECONOMY_INCOME_POWER;
    const ei = economyIncome[econLevel] ?? economyIncome[0];
    result.credits += ei.credits;
    result.ore += ei.ore;
    if (ei.power) result.powerCharge += ei.power;
  }
  const sciLevel = player.research?.science ?? 0;
  if (sciLevel < 5) result.knowledge += sciLevel;

  if (player.techTiles?.includes('tech-inc-1o-1p') && !isTechTileCovered(player, 'tech-inc-1o-1p')) {
    result.ore += 1;
    result.powerCharge += 1;
  }
  if (player.techTiles?.includes('tech-inc-4c') && !isTechTileCovered(player, 'tech-inc-4c')) result.credits += 4;
  if (player.techTiles?.includes('tech-inc-1k-1c') && !isTechTileCovered(player, 'tech-inc-1k-1c')) {
    result.knowledge += 1;
    result.credits += 1;
  }
  if (player.bonusTile && !options.excludeBonusTiles) {
    const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
    if (bonusTile?.income) {
      if (bonusTile.income.ore) result.ore += bonusTile.income.ore;
      if (bonusTile.income.credits) result.credits += bonusTile.income.credits;
      if (bonusTile.income.knowledge) result.knowledge += bonusTile.income.knowledge;
      if (bonusTile.income.qic) result.qic += bonusTile.income.qic;
      if (bonusTile.income.power) result.powerCharge += bonusTile.income.power;
      if (bonusTile.income.powerTokens) result.powerTokens += bonusTile.income.powerTokens;
    }
  }
  const hasPI = structures.some(t => t.structure === 'planetary_institute');
  if (hasPI && faction?.piIncome) {
    const c = faction.piIncome;
    result.powerCharge += (c.power ?? 0);
    result.powerTokens += (c.tokens ?? 0);
    if (c.ore) result.ore += c.ore;
    if (c.qic) result.qic += c.qic;
  }
  // 트왈라잇 인공물 수익 (서버 income 적용과 동일: art-income-1k1o=1K 1O, art-income-2p3=3그릇에 2파워)
  const arts = player.artifacts ?? [];
  if (arts.includes('art-income-1k1o')) {
    result.knowledge += 1;
    result.ore += 1;
  }
  if (arts.includes('art-income-2p3')) {
    // 3그릇에 토큰 2개를 직접 추가(서버 power3 += 2)하는 효과. '충전(powerCharge)'이 아니라
    // 새 토큰 2개이므로 powerTokens로 집계 (전엔 powerCharge로 잘못 넣어 +2pw로 표시됐음).
    result.powerTokens += 2;
  }
  return result;
}

export function chargePower(player: PlayerState, amount: number) {
  let remaining = amount;
  // Step 1: Bowl 1 -> Bowl 2
  const toMove1 = Math.min(player.power1, remaining);
  player.power1 -= toMove1;
  player.power2 += toMove1;
  remaining -= toMove1;

  if (remaining <= 0) return;

  // Step 2: Bowl 2 -> Bowl 3
  const toMove2 = Math.min(player.power2, remaining);
  player.power2 -= toMove2;
  player.power3 += toMove2;
}

/** 플레이어가 현재 받을 수 있는 최대 파워 양 계산 (Bowl 1 -> 2는 1차지, 2 -> 3은 1차지이므로 (P1 * 2) + P2) */
export function getMaxPowerGain(player: PlayerState): number {
  let p1 = player.power1 ?? 0;
  let p2 = player.power2 ?? 0;

  // 타클론 브레인스톤 처리 (가이아 구역에 있지 않고, 소멸하지 않았을 경우)
  if (player.faction === 'taklons' && !player.brainStoneInGaia && !player.brainStoneSpent) {
    if (player.brainStoneBowl === 1) p1 += 1;
    else if (player.brainStoneBowl === 2) p2 += 1;
  }

  return p1 * 2 + p2;
}

/** 타클론: 파워 수령 시 브레인 스톤 우선 이동 여부를 반영한 캐스케이드. brainStoneInGaia면 일반 chargePower와 동일. */
export function chargePowerTaklons(player: PlayerState, amount: number, brainFirst: boolean) {
  // 브레인 스톤이 가이아 영역에 있거나 영구 소멸했으면 브레인 없는 일반 캐스케이드.
  if (player.brainStoneInGaia || player.brainStoneSpent) {
    chargePower(player, amount);
    return;
  }
  let remaining = amount;

  while (remaining > 0) {
    let p1 = player.power1 ?? 0;
    let p2 = player.power2 ?? 0;
    let p3 = player.power3 ?? 0;
    let brain = player.brainStoneBowl ?? 1;

    // 만약 더 이상 받을 파워가 없다면 (1, 2번 상자가 비어있고 브레인스톤도 없음)
    if (p1 === 0 && p2 === 0 && brain === 3) break;

    let moved = false;

    if (brainFirst) {
      if (brain === 1) {
        player.brainStoneBowl = 2;
        moved = true;
      } else if (p1 > 0) {
        player.power1 = p1 - 1;
        player.power2 = p2 + 1;
        moved = true;
      } else if (brain === 2) {
        player.brainStoneBowl = 3;
        moved = true;
      } else if (p2 > 0) {
        player.power2 = p2 - 1;
        player.power3 = p3 + 1;
        moved = true;
      }
    }
    else {
      if (p1 > 0) {
        player.power1 = p1 - 1;
        player.power2 = p2 + 1;
        moved = true;
      } else if (brain === 1) {
        player.brainStoneBowl = 2;
        moved = true;
      } else if (p2 > 0) {
        player.power2 = p2 - 1;
        player.power3 = p3 + 1;
        moved = true;
      } else if (brain === 2) {
        player.brainStoneBowl = 3;
        moved = true;
      }
    }

    if (!moved) break;
    remaining--;
  }
}

/** 파워 수익(충전): 기존 토큰을 1→2→3으로 이동. 타클론은 브레인 스톤 캐스케이드(chargePowerTaklons) 적용. */
export function applyPowerIncome(player: PlayerState, amount: number): void {
  if (player.faction === 'taklons' && !player.brainStoneInGaia) {
    chargePowerTaklons(player, amount, true);
    return;
  }
  let rem = amount;
  const from1 = Math.min(rem, player.power1 ?? 0);
  player.power1 = (player.power1 ?? 0) - from1;
  player.power2 = (player.power2 ?? 0) + from1;
  rem -= from1;
  const from2 = Math.min(rem, player.power2 ?? 0);
  player.power2 = (player.power2 ?? 0) - from2;
  player.power3 = (player.power3 ?? 0) + from2;
}

export type IncomeOrderItem = { type: 'power' | 'tokens'; amount: number; id: string };

export function simulateIncomeOrder(
  base: Pick<PlayerState, 'faction' | 'power1' | 'power2' | 'power3' | 'brainStoneBowl' | 'brainStoneInGaia'>,
  order: IncomeOrderItem[]
): { p1: number; p2: number; p3: number; brainStoneBowl?: 1 | 2 | 3 } {
  const sim = {
    faction: base.faction,
    power1: base.power1 ?? 0,
    power2: base.power2 ?? 0,
    power3: base.power3 ?? 0,
    brainStoneBowl: base.brainStoneBowl,
    brainStoneInGaia: base.brainStoneInGaia,
  } as PlayerState;
  for (const item of order) {
    if (item.type === 'tokens') {
      sim.power1 = (sim.power1 ?? 0) + item.amount;
    } else {
      applyPowerIncome(sim, item.amount);
    }
  }
  return {
    p1: sim.power1 ?? 0,
    p2: sim.power2 ?? 0,
    p3: sim.power3 ?? 0,
    brainStoneBowl: sim.brainStoneBowl,
  };
}

function compareIncomeBowlTotals(a: { p1: number; p2: number; p3: number }, b: { p1: number; p2: number; p3: number }): number {
  if (a.p3 !== b.p3) return a.p3 - b.p3;
  if (a.p2 !== b.p2) return a.p2 - b.p2;
  return a.p1 - b.p1;
}

/** 수익 항목 적용 순서 최적화 (3그릇 > 2그릇 > 1그릇 우선) */
/**
 * [사용자 요청 2026-08-06] 이미 패스한 플레이어에게 지금 파워 누출(leech)을 받는 것이
 * '최종적으로 아무 의미도 없는' 상태인가 — 그렇다면 물어볼 필요 없이 거절해도 된다.
 *
 * 판정: 다음 라운드 수익(그릇1 토큰 추가 + 파워 수익)만으로도 토큰이 전부 그릇3에 올라간다면,
 *       지금 받아 두든 말든 다음 라운드 시작 시점의 상태가 같다 → 받아봐야 VP만 깎인다.
 *
 * 순서: 토큰을 먼저 받는 순서로 계산한다. 이 순서가 수익이 흡수하는 충전량이 가장 큰
 *       (= 남는 충전 여력이 최소인) 순서이므로, 여기서 여력 0이면 어떤 수익 순서를 골라도
 *       누출이 무의미하다는 결론이 뒤집히지 않는다.
 *
 * 제외: 이타르(가이아 구역 토큰)·타클론(브레인 스톤/의회 토큰)은 충전 여력이 0이어도 수락에
 *       의미가 있을 수 있어 판정하지 않는다(오퍼 생성 단계의 예외와 동일).
 *
 * 가이아 포머 구역 토큰은 고려하지 않는다(사용자 지적): 그 토큰은 그릇 밖에 있어 충전 여력에 잡히지도
 * 않고, 복귀 시점이 '수익 단계가 모두 끝난 뒤'라 수익 파워를 흡수하지도 못한다. 누출을 받든 말든
 * 복귀는 똑같이 일어나므로 판정 결과를 바꾸지 않는다.
 */
export function isPowerLeechPointlessAfterIncome(game: GaiaGameState, playerId: string): boolean {
  const player = game.players[playerId];
  if (!player) return false;
  if (player.faction === 'itars' || player.faction === 'taklons') return false;

  const preview = getNextRoundIncomePreview(playerId, game);
  // 상태창 '예상 수익'과 같은 계산(기본 수익·건물·경제/과학 트랙·수익 기술타일·보너스 타일·의회·인공물).
  // 단 powerTokens 중 트왈라잇 인공물 art-income-2p3의 2개는 그릇1이 아니라 '그릇3에 직접' 올라가므로
  // (서버 income: player.power3 += 2) 충전 여력을 늘리지 않는다 → 여력 계산에서 제외한다.
  const bowl3OnlyTokens = (player.artifacts ?? []).includes('art-income-2p3') ? 2 : 0;
  const bowl1Tokens = Math.max(0, preview.powerTokens - bowl3OnlyTokens);
  const order: IncomeOrderItem[] = [];
  if (bowl1Tokens > 0) order.push({ type: 'tokens', amount: bowl1Tokens, id: 'inc-tokens' });
  if (preview.powerCharge > 0) order.push({ type: 'power', amount: preview.powerCharge, id: 'inc-power' });
  if (order.length === 0) return false; // 파워 수익이 없으면 저절로 찰 일도 없다

  const after = simulateIncomeOrder(player, order);
  return getMaxPowerGain({
    ...player,
    power1: after.p1,
    power2: after.p2,
    power3: after.p3,
    brainStoneBowl: after.brainStoneBowl,
  } as PlayerState) === 0;
}

export function findOptimalIncomeOrder(
  base: Pick<PlayerState, 'faction' | 'power1' | 'power2' | 'power3' | 'brainStoneBowl' | 'brainStoneInGaia'>,
  items: IncomeOrderItem[]
): IncomeOrderItem[] {
  if (items.length === 0) return [];
  if (items.length > 8) {
    return items.slice().sort((a, b) => (a.type === 'tokens' ? -1 : 1));
  }
  const permutations = (arr: IncomeOrderItem[]): IncomeOrderItem[][] => {
    if (arr.length <= 1) return [arr];
    const result: IncomeOrderItem[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const sub of permutations(rest)) {
        result.push([arr[i], ...sub]);
      }
    }
    return result;
  };
  let bestOrder = items;
  let bestState = simulateIncomeOrder(base, items);
  for (const order of permutations(items)) {
    const state = simulateIncomeOrder(base, order);
    if (compareIncomeBowlTotals(state, bestState) > 0) {
      bestState = state;
      bestOrder = order;
    }
  }
  return bestOrder;
}

export function snapshotPlayerPower(player: PlayerState): { p1: number; p2: number; p3: number; bs?: 1 | 2 | 3 } {
  return {
    p1: player.power1 ?? 0,
    p2: player.power2 ?? 0,
    p3: player.power3 ?? 0,
    bs: player.faction === 'taklons' && !player.brainStoneInGaia && !player.brainStoneSpent ? (player.brainStoneBowl ?? 1) : undefined,
  };
}

export function restorePlayerPowerSnapshot(
  player: PlayerState,
  snap: { p1: number; p2: number; p3: number; bs?: 1 | 2 | 3 }
): void {
  player.power1 = snap.p1;
  player.power2 = snap.p2;
  player.power3 = snap.p3;
  if (snap.bs != null && player.faction === 'taklons') {
    player.brainStoneBowl = snap.bs;
  }
}

/**
 * [사용자 2026-08-11] '토큰 N개' 비용(연방 위성·인공물·가이아포밍)을 그릇별로 어떻게 낼지 계획한다.
 * 브레인 스톤은 파워로 낼 땐 3이지만 개수 비용에선 1개다. 그릇은 1→2→3 순으로 비운다(덜 충전된 것부터).
 *
 * - 브레인 우선(taklonsBrainPriority !== false): 브레인은 큰 파워 액션용으로 아껴 두는 설정이므로
 *   토큰 비용에는 쓰지 않는다. 단 일반 토큰이 모자라면 마지막 1개를 충당한다(안 그러면 액션 자체가 불가).
 * - 브레인 보존(false): 어차피 파워로 안 쓸 브레인이라 토큰 비용으로 내보내는 편이 이득일 수 있다.
 *   브레인이 '마지막으로 손대는 그릇'보다 아래 그릇에 있으면 그 그릇 토큰 1개 대신 브레인을 낸다.
 *   예) 6개 필요 · 브레인 1그릇 · 6번째가 2그릇 → 2그릇 토큰을 남기고 브레인을 낸다. 더 충전된 토큰이
 *   남으므로 손해가 없다. 같은 그릇이면 브레인(파워 3)이 더 값지니 그대로 둔다.
 */
export function planTokenSpend(
  player: PlayerState,
  amount: number
): { from1: number; from2: number; from3: number; useBrain: boolean } | null {
  const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
  const hasBrain = player.faction === 'taklons' && player.brainStoneBowl != null
    && !player.brainStoneInGaia && !player.brainStoneSpent;
  if (amount <= 0) return { from1: 0, from2: 0, from3: 0, useBrain: false };
  if (p1 + p2 + p3 + (hasBrain ? 1 : 0) < amount) return null;

  let rem = amount;
  const from1 = Math.min(rem, p1); rem -= from1;
  const from2 = Math.min(rem, p2); rem -= from2;
  const from3 = Math.min(rem, p3); rem -= from3;

  // 일반 토큰만으로 모자람 → 설정과 무관하게 브레인으로 마지막 1개 충당
  if (rem > 0) return { from1, from2, from3, useBrain: true };
  // 충분함 → '브레인 보존'일 때만 아래 그릇 브레인과 맞바꾼다
  if (!hasBrain || player.taklonsBrainPriority !== false) return { from1, from2, from3, useBrain: false };
  const highest = from3 > 0 ? 3 : from2 > 0 ? 2 : from1 > 0 ? 1 : 0;
  if (highest === 0 || (player.brainStoneBowl ?? 1) >= highest) return { from1, from2, from3, useBrain: false };
  if (highest === 3) return { from1, from2, from3: from3 - 1, useBrain: true };
  if (highest === 2) return { from1, from2: from2 - 1, from3, useBrain: true };
  return { from1: from1 - 1, from2, from3, useBrain: true };
}

/** 타클론: 해당 그릇에서 낼 수 있는 파워 값 (브레인 스톤 = 3, 일반 = 1) */
export function getTaklonsBowlPowerValue(player: PlayerState, bowl: 1 | 2 | 3): number {
  if (player.brainStoneInGaia) {
    const c = bowl === 1 ? (player.power1 ?? 0) : bowl === 2 ? (player.power2 ?? 0) : (player.power3 ?? 0);
    return c;
  }
  const count = bowl === 1 ? (player.power1 ?? 0) : bowl === 2 ? (player.power2 ?? 0) : (player.power3 ?? 0);
  const hasBrain = player.brainStoneBowl === bowl;
  return hasBrain ? 3 + count : count;
}

/** 타클론: 그릇에서 powerValue만큼 파워 낼 수 있는지 (브레인 사용 시 1B+일반 = 3+1 등) */
export function canSpendTaklonsPower(player: PlayerState, fromBowl: 1 | 2 | 3, powerValue: number): boolean {
  const count = fromBowl === 1 ? (player.power1 ?? 0) : fromBowl === 2 ? (player.power2 ?? 0) : (player.power3 ?? 0);
  const hasBrain = !player.brainStoneInGaia && player.brainStoneBowl === fromBowl;
  if (hasBrain) {
    if (powerValue <= 3 + count) return true; // 1B + regular tokens
  }
  if (count === 0) return false;
  return count >= powerValue; // no brain or use only regular
}

/** 타클론: 브레인 스톤 없이 해당 그릇의 일반 토큰만으로 powerValue를 낼 수 있는지 */
export function canSpendTaklonsPowerWithoutBrain(player: PlayerState, fromBowl: 1 | 2 | 3, powerValue: number): boolean {
  const count = fromBowl === 1 ? (player.power1 ?? 0) : fromBowl === 2 ? (player.power2 ?? 0) : (player.power3 ?? 0);
  return count >= powerValue;
}

/** 타클론: (B) 프리액션 — 해당 그릇의 브레인 스톤을 포함해 powerValue를 낼 수 있는지 */
export function canTaklonsSpendUsingBrain(player: PlayerState, fromBowl: 1 | 2 | 3, powerValue: number): boolean {
  if (player.faction !== 'taklons' || player.brainStoneInGaia) return false;
  if (player.brainStoneBowl !== fromBowl) return false;
  return canSpendTaklonsPower(player, fromBowl, powerValue);
}

/** 타클론: 그릇에서 powerValue 파워 소비. 사용한 토큰은 그릇1으로.
 * useBrain=true → 브레인 스톤(3그릇값=3) 우선 사용(초과분만 일반토큰), 일반토큰 보존.
 * useBrain=false → 일반토큰만으로 지불(브레인 보존). 단 일반토큰이 부족하면 브레인으로 폴백(액션 가능하게).
 * (브레인은 powerValue가 3 미만이어도 사용 가능 — 2파워에 브레인 쓰면 1 낭비하지만 토큰 2개 보존) */
export function spendTaklonsPower(player: PlayerState, fromBowl: 1 | 2 | 3, powerValue: number, useBrain: boolean): boolean {
  const count = fromBowl === 1 ? (player.power1 ?? 0) : fromBowl === 2 ? (player.power2 ?? 0) : (player.power3 ?? 0);
  const hasBrain = !player.brainStoneInGaia && player.brainStoneBowl === fromBowl;
  const regularEnough = count >= powerValue;
  // 브레인 사용: 명시 선호(useBrain) OR 일반토큰만으론 부족할 때
  const willUseBrain = hasBrain && (useBrain || !regularEnough);

  if (willUseBrain) {
    const fromRegular = Math.max(0, powerValue - 3); // 브레인(3) 초과분만 일반토큰으로
    if (count < fromRegular) return false;
    if (fromBowl === 1) player.power1 = count - fromRegular;
    else if (fromBowl === 2) player.power2 = count - fromRegular;
    else player.power3 = count - fromRegular;
    player.power1 = (player.power1 ?? 0) + fromRegular; // 쓴 일반토큰 → 그릇1
    player.brainStoneBowl = 1;                          // 쓴 브레인 → 그릇1
    return true;
  }

  // 일반토큰만
  if (count < powerValue) return false;
  if (fromBowl === 1) player.power1 = count - powerValue;
  else if (fromBowl === 2) player.power2 = count - powerValue;
  else player.power3 = count - powerValue;
  player.power1 = (player.power1 ?? 0) + powerValue;
  return true;
}




// ... (SECTOR_LAYOUTS, SECTOR_OFFSETS, rotateHex, generateMap remain exactly the same as previous)
export const SECTOR_LAYOUTS: Record<number, { q: number; r: number; type: PlanetType }[]> = {
  0: [ // Map 1
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'transdim' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'terra' }, { q: 1, r: -1, type: 'space' }, { q: 2, r: -1, type: 'oxide' },
    { q: -2, r: 0, type: 'space' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'volcanic' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'swamp' }, { q: 0, r: 1, type: 'space' }, { q: 1, r: 1, type: 'space' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'desert' }, { q: 0, r: 2, type: 'space' }
  ],
  1: [ // Map 2
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'desert' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'ice' }, { q: 1, r: -1, type: 'space' }, { q: 2, r: -1, type: 'transdim' },
    { q: -2, r: 0, type: 'titanium' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'oxide' }, { q: -1, r: 1, type: 'space' }, { q: 0, r: 1, type: 'swamp' }, { q: 1, r: 1, type: 'volcanic' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  2: [ // Map 3
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'titanium' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'ice' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'transdim' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'desert' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'gaia' }, { q: 0, r: 1, type: 'space' }, { q: 1, r: 1, type: 'terra' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  3: [ // Map 4
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'terra' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'swamp' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'titanium' }, { q: -1, r: 0, type: 'volcanic' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'space' }, { q: 0, r: 1, type: 'oxide' }, { q: 1, r: 1, type: 'space' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'ice' }, { q: 0, r: 2, type: 'space' }
  ],
  4: [ // Map 5
    { q: 0, r: -2, type: 'transdim' }, { q: 1, r: -2, type: 'volcanic' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'space' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'ice' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'desert' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'gaia' }, { q: 0, r: 1, type: 'space' }, { q: 1, r: 1, type: 'oxide' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  5: [ // Map 6
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'desert' },
    { q: -1, r: -1, type: 'transdim' }, { q: 0, r: -1, type: 'terra' }, { q: 1, r: -1, type: 'space' }, { q: 2, r: -1, type: 'transdim' },
    { q: -2, r: 0, type: 'space' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'gaia' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'swamp' }, { q: 0, r: 1, type: 'space' }, { q: 1, r: 1, type: 'space' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  6: [ // Map 7
    { q: 0, r: -2, type: 'space' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'swamp' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'gaia' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'space' }, { q: -1, r: 0, type: 'volcanic' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'titanium' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'space' }, { q: 0, r: 1, type: 'gaia' }, { q: 1, r: 1, type: 'space' },
    { q: -2, r: 2, type: 'transdim' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  7: [ // Map 8
    { q: 0, r: -2, type: 'transdim' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'space' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'titanium' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'terra' }, { q: -1, r: 0, type: 'ice' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'space' }, { q: 0, r: 1, type: 'oxide' }, { q: 1, r: 1, type: 'transdim' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'space' }
  ],
  8: [ // Map 9
    { q: 0, r: -2, type: 'ice' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'transdim' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'gaia' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'space' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'oxide' }, { q: -1, r: 1, type: 'space' }, { q: 0, r: 1, type: 'titanium' }, { q: 1, r: 1, type: 'space' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'swamp' }
  ],
  9: [ // Map 10
    { q: 0, r: -2, type: 'transdim' }, { q: 1, r: -2, type: 'space' }, { q: 2, r: -2, type: 'space' },
    { q: -1, r: -1, type: 'transdim' }, { q: 0, r: -1, type: 'space' }, { q: 1, r: -1, type: 'gaia' }, { q: 2, r: -1, type: 'space' },
    { q: -2, r: 0, type: 'space' }, { q: -1, r: 0, type: 'space' }, { q: 0, r: 0, type: 'space' }, { q: 1, r: 0, type: 'space' }, { q: 2, r: 0, type: 'space' },
    { q: -2, r: 1, type: 'space' }, { q: -1, r: 1, type: 'desert' }, { q: 0, r: 1, type: 'space' }, { q: 1, r: 1, type: 'volcanic' },
    { q: -2, r: 2, type: 'space' }, { q: -1, r: 2, type: 'space' }, { q: 0, r: 2, type: 'terra' }
  ],
  10: [{ q: 0, r: 0, type: 'deep_space' }, { q: 1, r: -1, type: 'space' }, { q: -1, r: 1, type: 'asteroid' }],
  11: [{ q: 0, r: 0, type: 'deep_space' }, { q: 1, r: 0, type: 'asteroid' }, { q: -1, r: 0, type: 'space' }],
  12: [{ q: 0, r: 0, type: 'deep_space' }, { q: 0, r: 1, type: 'space' }, { q: 0, r: -1, type: 'asteroid' }],
  13: [{ q: 0, r: 0, type: 'space' }, { q: 1, r: -1, type: 'space' }, { q: 1, r: 0, type: 'transdim' }], // 3-hex Bridge
  20: [{ q: 0, r: 0, type: 'lost_fleet_ship' }],
  22: [{ q: 0, r: 0, type: 'asteroid' }],
  // New Bridge Tiles
  30: [{ q: 0, r: 0, type: 'space' }, { q: 1, r: -1, type: 'space' }, { q: 1, r: 0, type: 'space' }], // C-Triangle
  31: [{ q: 0, r: 0, type: 'asteroid' }], // D-Single
};

export const SECTOR_OFFSETS = [
  // 10 Main Sectors (3-4-3 Cluster, Distance 4 for 2-hex contact)
  { q: 0, r: 0 }, { q: 4, r: -1 }, { q: 8, r: -2 },                // R1
  { q: -1, r: 4 }, { q: 3, r: 3 }, { q: 7, r: 2 }, { q: 11, r: 1 }, // R2
  { q: 2, r: 8 }, { q: 6, r: 7 }, { q: 10, r: 6 }                 // R3
];

function rotateHex(q: number, r: number, rotations: number): { q: number; r: number } {
  let kq = q; let kr = r;
  for (let i = 0; i < rotations; i++) {
    const newQ = -kr;
    const newR = kq + kr;
    kq = newQ;
    kr = newR;
  }
  return { q: kq, r: kr };
}

export function generateMap(): HexTile[] {
  const tiles: HexTile[] = [];
  const occupied = new Set<string>();
  let tileId = 1;

  // 1. Place 10 Main Sectors (Radius 2) with constrained randomization
  const innerPool = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  const outerPool = [4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5);

  const mid1 = innerPool.pop()!;
  const mid2 = innerPool.pop()!;
  const remainingPool = [...innerPool, ...outerPool].sort(() => Math.random() - 0.5);

  const baseLayouts: number[] = [];
  let remIdx = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 5) {
      baseLayouts[i] = i === 4 ? mid1 : mid2;
    } else {
      baseLayouts[i] = remainingPool[remIdx++];
    }
  }

  const mainOffsets = SECTOR_CENTERS.filter(c => c.sector <= 9);

  const motherPlanets: PlanetType[] = ['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice'];

  for (let i = 0; i < 10; i++) {
    const center = mainOffsets[i];
    const layout = SECTOR_LAYOUTS[baseLayouts[i]];

    // Try rotations to avoid adjacent identical mother planets
    let rotation = Math.floor(Math.random() * 6);
    for (let rTry = 0; rTry < 6; rTry++) {
      const currentRotation = (rotation + rTry) % 6;
      let conflict = false;

      // Preview these tiles for adjacency conflicts
      for (const hex of layout) {
        const rotated = rotateHex(hex.q, hex.r, currentRotation);
        const q = center.q + rotated.q;
        const r = center.r + rotated.r;

        if (motherPlanets.includes(hex.type)) {
          // Check against all existing tiles already on the map
          for (const existingTile of tiles) {
            if (existingTile.type === hex.type && getDistance(existingTile, { q, r }) === 1) {
              conflict = true;
              break;
            }
          }
        }
        if (conflict) break;
      }

      if (!conflict) {
        rotation = currentRotation;
        break;
      }
    }

    for (const hex of layout) {
      const rotated = rotateHex(hex.q, hex.r, rotation);
      const q = center.q + rotated.q;
      const r = center.r + rotated.r;
      const key = `${q},${r}`;
      if (!occupied.has(key)) {
        // Sector ID should match layout index (0-9) so Map_B(ID+1) aligns with layout
        tiles.push({ id: `tile-${tileId++}`, q, r, type: hex.type, sector: baseLayouts[i], rotation: rotation, structure: null, ownerId: null, isGaiaformed: false });
        occupied.add(key);
      }
    }
  }

  // 2. Internal Strategic Tiles (10 Single Hexes: 4 Ships, 4 Asteroids, 1 Space, 1 Proto)
  const ships: PlanetType[] = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
  const others: PlanetType[] = ['asteroid', 'asteroid', 'asteroid', 'asteroid', 'space', 'proto'];

  // All 10 strategic junctions in the 3-4-3 layout
  const internalCoords = [
    { q: 4, r: 5 }, { q: 9, r: 4 },                 // Top junctions
    { q: 1, r: 7 }, { q: 6, r: 6 }, { q: 11, r: 5 }, // Middle junctions
    { q: 0, r: 10 }, { q: 5, r: 9 }, { q: 10, r: 8 }, // Bottom row upper junctions
    { q: 2, r: 11 }, { q: 7, r: 10 }                 // Bottom row lower junctions
  ];

  // Strategy: 우주선끼리는 서로 거리 > 3으로 배치한다(규칙). 10개 정션 중 4개를 *모두* 페어와이즈 거리>3인
  // 집합으로 선택한다. (이 좌표들엔 그런 4-조합이 21개 존재 → 항상 가능.)
  // [버그수정 2026-06-18] 기존엔 우주선별 greedy로 놓다가 자리가 없으면 minDist를 3→2→1로 *완화*해서,
  // 앞 배치가 코너로 몰리면 4.5% 확률로 우주선이 거리<=3에 붙어 규칙을 위반했다. → 전역 집합 선택으로 교체.
  const availableCoords = [...internalCoords];
  const remainingOthers = others.sort(() => Math.random() - 0.5);

  let chosenShipCoords: { q: number, r: number }[] | null = null;
  for (let attempt = 0; attempt < 300 && !chosenShipCoords; attempt++) {
    const shuffled = [...internalCoords].sort(() => Math.random() - 0.5);
    const chosen: { q: number, r: number }[] = [];
    for (const c of shuffled) {
      if (chosen.every(p => getDistance(p, c) > 3)) chosen.push(c);
      if (chosen.length === ships.length) break;
    }
    if (chosen.length === ships.length) chosenShipCoords = chosen;
  }
  // 안전장치: 이론상 거의 없지만 못 찾으면 임의 배치(맵 생성 실패 방지). 이때만 규칙이 완화될 수 있다.
  if (!chosenShipCoords) {
    chosenShipCoords = [...internalCoords].sort(() => Math.random() - 0.5).slice(0, ships.length);
  }
  // 선택된 좌표에 우주선 타입을 랜덤 매칭
  const shuffledShipTypes = [...ships].sort(() => Math.random() - 0.5);
  const shipPlacements: { q: number, r: number, type: PlanetType }[] =
    chosenShipCoords.map((coord, i) => ({ ...coord, type: shuffledShipTypes[i] }));
  // 선택된 좌표를 availableCoords에서 제거(나머지는 asteroid/space/proto로 채워짐)
  for (const coord of chosenShipCoords) {
    const idx = availableCoords.findIndex(c => c.q === coord.q && c.r === coord.r);
    if (idx >= 0) availableCoords.splice(idx, 1);
  }

  // Combine placements
  const finalInternalPlacements = [
    ...shipPlacements,
    ...availableCoords.map((coord, i) => ({ ...coord, type: remainingOthers[i] }))
  ];

  finalInternalPlacements.forEach((p, i) => {
    const key = `${p.q},${p.r}`;
    if (!occupied.has(key)) {
      // Internal strategic hexes (sector 90) don't have a background image, using generic space or 100
      tiles.push({ id: `internal-${i}`, q: p.q, r: p.r, type: p.type, sector: 90, structure: null, ownerId: null });
      occupied.add(key);
    }
  });

  // 3. External Bridge Tiles (8 x 3 Hexes = 24 Hexes)
  const bridgeOffsets = SECTOR_CENTERS.filter(c => c.sector >= 11);
  const bridgeRotations = [1, 1, 0, 1, 0, 0, 1, 0];

  // Map files available: Map_B11, Map_O12, Map_B13, Map_B14, Map_O15, Map_O16, Map_B17, Map_O18
  const BRIDGE_LAYOUTS: Record<number, PlanetType[]> = {
    11: ['proto', 'space', 'asteroid'],       // Map_B11
    12: ['asteroid', 'space', 'space'],       // Map_O12
    13: ['transdim', 'asteroid', 'space'],    // Map_B13
    14: ['proto', 'asteroid', 'space'],       // Map_B14 (원시, 소행성, 빈칸)
    15: ['proto', 'asteroid', 'space'],       // Map_O15
    16: ['asteroid', 'asteroid', 'space'],    // Map_O16
    17: ['transdim', 'space', 'space'],       // Map_B17
    18: ['space', 'space', 'asteroid'],       // Map_O18
  };

  bridgeOffsets.forEach((data, i) => {
    const center = { q: data.q, r: data.r };
    const sectorBaseId = 11 + i;
    const planetTypes = BRIDGE_LAYOUTS[sectorBaseId] || ['space', 'space', 'space'];
    const rotation = bridgeRotations[i];

    // Map to a triangle pointing up (1 top, 2 bottom)
    const baseCoords = [
      { q: 0, r: -1 }, // Pos 1 (Top)
      { q: -1, r: 0 }, // Pos 2 (Bottom-Left)
      { q: 0, r: 0 },  // Pos 3 (Bottom-Right) - This is our relative center!
    ];

    baseCoords.forEach((coord, hexIdx) => {
      const rotated = rotateHex(coord.q, coord.r, rotation);
      const q = center.q + rotated.q;
      const r = center.r + rotated.r;
      const key = `${q},${r}`;
      if (!occupied.has(key)) {
        tiles.push({
          id: `bridge-${i}-${hexIdx}`,
          q, r,
          type: planetTypes[hexIdx],
          sector: sectorBaseId,
          rotation: rotation,
          structure: null,
          ownerId: null
        });
        occupied.add(key);
      }
    });
  });

  return tiles;
}

export function createInitialPlayerState(name: string = 'Player'): PlayerState {
  return {
    name,
    faction: null,
    factionBidVp: 0,

    ore: 4,
    knowledge: 2,
    credits: 15,
    qic: 1,
    power1: 4,
    power2: 4,
    power3: 0,
    score: 10,
    ships: 0,
    research: {
      terraforming: 0,
      navigation: 0,
      artificialIntelligence: 0,
      gaiaProject: 0,
      economy: 0,
      science: 0,
    },
    startingMinesPlaced: 0,
    hasPassed: false,
    techTiles: [],
    usedTechActions: [],
    usedSpecialActions: [],
    bonusTile: null,
    usedBonusAction: false,
    gaiaformers: 0,
    destroyedGaiaformers: 0,
    gaiaformerPower: 0,
    pendingGaiaformerTiles: [],
    spaceshipsEntered: [],
  };
}

export const GaiaProjectGame: Game<GaiaGameState> = {
  name: 'gaia-project',

  setup: ({ ctx }): GaiaGameState => {
    const players: Record<string, PlayerState> = {};
    for (let i = 0; i < ctx.numPlayers; i++) {
      // ctx.playerData might be available in some boardgame.io setups, 
      // but here we use a placeholder that can be updated on join.
      players[String(i)] = createInitialPlayerState(`Player ${i + 1}`);
    }


    // Shuffle and select bonus tiles (players + 3 extra)
    const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);
    const numBonusTiles = ctx.numPlayers + 3;

    const gState: GaiaGameState = {
      id: (ctx as any).matchID || 'local',
      players,
      map: generateMap(),
      currentPhase: 'factionSelect',
      roundNumber: 0,
      currentPlayerIndex: 0,
      turnOrder: Array.from({ length: ctx.numPlayers }, (_, i) => String(i)),
      isTestMode: false,
      hasDoneMainAction: false,
      powerActions: [...INITIAL_POWER_ACTIONS],
      availableBonusTiles: shuffledBonusTiles.slice(0, numBonusTiles),
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

    // Randomize Standard Tech Tiles (트랙당 플레이어 수만큼)
    const n = ctx.numPlayers;
    const needed = 6 * n + 3;
    const repeated = Array.from({ length: Math.ceil(needed / ALL_TECH_TILES.length) }, () => [...ALL_TECH_TILES]).flat();
    const shuffledStandard = repeated.sort(() => Math.random() - 0.5).slice(0, needed);
    const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
    tracks.forEach((track, i) => {
      gState.techTilesByTrack[track] = shuffledStandard.slice(i * n, (i + 1) * n);
    });
    gState.techTilesPool = shuffledStandard.slice(6 * n, 6 * n + 3);



    // Randomize Advanced Tech Tiles (choose 6)
    const shuffledAdvanced = [...ALL_ADVANCED_TECH_TILES].sort(() => Math.random() - 0.5);
    tracks.forEach((track, i) => {
      gState.advancedTechTilesByTrack[track] = shuffledAdvanced[i];
    });

    // 게임 시작 시 모든 라운드 미션을 미리 랜덤 선택
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
    }

    gState.roundScoringTiles = selectedMissions;
    gState.usedRoundMissions = usedIds;

    return gState;

  },

  moves: {
    // --- FACTION AND SETUP ---
    selectFaction: ({ G, playerID }, factionId: string) => {
      if (!playerID) return;
      const faction = FACTIONS.find(f => f.id === factionId);
      if (!faction) return;
      if (Object.values(G.players).some(p => p.faction === factionId)) return;

      const player = G.players[playerID];
      player.faction = factionId;

      // Apply starting techs
      if (faction.startingTech) {
        Object.entries(faction.startingTech).forEach(([track, level]) => {
          if (player.research) {
            player.research[track as ResearchTrack] = Math.max(player.research[track as ResearchTrack] || 0, level as number);
          }
        });
      }
    },

    confirmFactionSelection: ({ G, events }) => {
      if (Object.values(G.players).every(p => p.faction !== null)) {
        G.currentPhase = 'startingMines';
        events.setPhase?.('startingMines');
      }
    },

    placeStartingMine: ({ G, playerID }, tileId: string) => {
      if (!playerID) return;
      const player = G.players[playerID];
      if (player.startingMinesPlaced >= 2) return;
      const tile = G.map.find(t => t.id === tileId);
      if (!tile || tile.structure !== null) return;
      const faction = FACTIONS.find(f => f.id === player.faction);
      if (!faction || tile.type !== faction.homePlanet) return;
      tile.structure = 'mine';
      tile.ownerId = playerID;
      player.startingMinesPlaced++;
    },

    confirmStartingMines: ({ G, events }) => {
      if (Object.values(G.players).every(p => p.startingMinesPlaced >= 2)) {
        G.currentPhase = 'main';
        G.roundNumber = 1;
        events.setPhase?.('main');
      }
    },

    // --- MAIN ACTIONS ---
    buildMine: ({ G, playerID }, tileId: string) => {
      if (!playerID || G.hasDoneMainAction) return;
      const player = G.players[playerID];
      const tile = G.map.find(t => t.id === tileId);
      if (!tile || tile.structure !== null) return;
      if (['space', 'deep_space', 'asteroid', 'gas_cloud', 'lost_fleet_ship'].includes(tile.type)) return;

      const navigationRange = 1 + (player.research?.navigation ?? 0);
      const hasReach = G.map.some(t => t.ownerId === playerID && t.structure !== null && getDistance(t, tile) <= navigationRange);
      if (!hasReach && !G.isTestMode) return;

      if (player.ore < 1 || player.credits < 2) return;
      player.ore -= 1;
      player.credits -= 2;
      tile.structure = 'mine';
      tile.ownerId = playerID;
      G.hasDoneMainAction = true;
    },

    upgradeStructure: ({ G, playerID }, { tileId, target }: { tileId: string, target: StructureType }) => {
      if (!playerID || G.hasDoneMainAction) return;
      const player = G.players[playerID];
      const tile = G.map.find(t => t.id === tileId);
      if (!tile || tile.ownerId !== playerID) return;

      if (tile.structure === 'mine' && target === 'trading_station') {
        if (player.ore < 2 || player.credits < 6) return;
        player.ore -= 2; player.credits -= 6;
        tile.structure = 'trading_station';
        G.hasDoneMainAction = true;
      } else if (tile.structure === 'trading_station' && target === 'research_lab') {
        if (player.ore < 3 || player.credits < 5) return;
        player.ore -= 3; player.credits -= 5;
        tile.structure = 'research_lab';
        G.hasDoneMainAction = true;
      } else if (tile.structure === 'trading_station' && target === 'planetary_institute') {
        // User Correction: PI is from Trading Station (4O, 6C)
        if (player.ore < 4 || player.credits < 6) return;
        player.ore -= 4; player.credits -= 6;
        tile.structure = 'planetary_institute';
        G.hasDoneMainAction = true;
      } else if (tile.structure === 'research_lab' && target === 'academy') {
        if (player.ore < 6 || player.credits < 6) return;
        player.ore -= 6; player.credits -= 6;
        tile.structure = 'academy';
        G.hasDoneMainAction = true;
      }
    },

    advanceTech: ({ G, playerID }, trackId: ResearchTrack) => {
      if (!playerID || G.hasDoneMainAction) return;
      const player = G.players[playerID];
      if (player.knowledge < 4) return;
      if (!player.research || player.research[trackId] >= 5) return;

      player.knowledge -= 4;
      player.research[trackId]++;
      G.hasDoneMainAction = true;

      // Instant bonuses
      const newLevel = player.research[trackId];
      if (newLevel === 3) {
        chargePower(player, 3);
      }
      if (trackId === 'navigation' && (newLevel === 1 || newLevel === 3)) {
        player.qic = (player.qic || 0) + 1;
      }
      if (trackId === 'artificialIntelligence') {
        if (newLevel === 1) player.qic = (player.qic || 0) + 1;
        if (newLevel === 2) player.qic = (player.qic || 0) + 1;
        if (newLevel === 3) player.qic = (player.qic || 0) + 2;
        if (newLevel === 4) player.qic = (player.qic || 0) + 2;
        if (newLevel === 5) player.qic = (player.qic || 0) + 4;
      }
      if (trackId === 'terraforming' && (newLevel === 1 || newLevel === 4)) {
        player.ore = (player.ore || 0) + 2;
      }
      if (trackId === 'economy' && newLevel === 5) {
        player.ore = (player.ore || 0) + 3;
        player.credits = (player.credits || 0) + 6;
        chargePower(player, 6);
      }
      if (trackId === 'science' && newLevel === 5) {
        player.knowledge = (player.knowledge || 0) + 9;
      }
    },

    usePowerAction: ({ G, playerID }, actionId: string) => {
      if (!playerID || G.hasDoneMainAction) return;
      const action = G.powerActions.find(a => a.id === actionId);
      if (!action || action.isUsed) return;

      const player = G.players[playerID];
      if (action.costType === 'power') {
        if (player.power3 < action.cost) return;
        player.power3 -= action.cost;
        player.power1 += action.cost;
      } else if (action.costType === 'qic') {
        if (player.qic < action.cost) return;
        player.qic -= action.cost;
      }

      // Simplified rewards
      if (actionId === 'gain-3-knowledge') player.knowledge += 3;
      if (actionId === 'gain-2-ore') player.ore += 2;
      if (actionId === 'gain-7-credits') player.credits += 7;

      action.isUsed = true;
      G.hasDoneMainAction = true;
    },

    // --- FREE ACTIONS ---
    convertResource: ({ G, playerID }, type: string) => {
      if (!playerID) return;
      const player = G.players[playerID];
      if (type === '3power-to-1ore' && player.power3 >= 3) { player.power3 -= 3; player.power1 = (player.power1 || 0) + 3; player.ore += 1; }
      if (type === '4power-to-1qic' && player.power3 >= 4) { player.power3 -= 4; player.power1 = (player.power1 || 0) + 4; player.qic += 1; }
      if (type === '1power-to-1credit' && player.power3 >= 1) { player.power3 -= 1; player.power1 = (player.power1 || 0) + 1; player.credits += 1; }
      if (type === '1knowledge-to-1credit' && player.knowledge >= 1) { player.knowledge -= 1; player.credits += 1; }
    },


    burnPower: ({ G, playerID }) => {
      if (!playerID) return;
      const player = G.players[playerID];
      if (player.power2 >= 2) {
        player.power2 -= 2;
        player.power3 += 1;
      }
    },

    // --- TURN MANAGEMENT ---
    endTurn: ({ G, events }) => {
      if (!G.hasDoneMainAction) return; // Must do main action to end turn (unless passed)
      G.hasDoneMainAction = false;
      events.endTurn();
    },

    passRound: ({ G, playerID, events }) => {
      if (!playerID) return;
      G.players[playerID].hasPassed = true;
      G.hasDoneMainAction = false;
      events.endTurn();
    },

    toggleTestMode: ({ G }) => { G.isTestMode = !G.isTestMode; },
  },

  turn: {
    minMoves: 0,
    maxMoves: undefined,
    onBegin: ({ G, ctx, events }) => {
      // If player already passed, skip them
      if (G.players[ctx.currentPlayer].hasPassed) {
        events.endTurn();
      }
    }
  },

  phases: {
    factionSelect: { start: true, next: 'startingMines' },
    startingMines: { next: 'main' },
    main: {
      onBegin: ({ G }) => {
        // Reset power actions and passed status at start of round
        G.powerActions.forEach(a => a.isUsed = false);
        Object.values(G.players).forEach(p => p.hasPassed = false);
      },
    }
  },

  minPlayers: 1,
  maxPlayers: 4,
};

/** 기본 7색상 행성 (테라포밍 휠, 확장 규칙에서 1/2/3단계 지정에 사용) */
export const HOME_PLANETS: PlanetType[] = ['terra', 'volcanic', 'oxide', 'desert', 'swamp', 'titanium', 'ice'];

export function getTerraformSteps(from: PlanetType, to: PlanetType): number {
  if (from === to) return 0;
  if (!HOME_PLANETS.includes(from) || !HOME_PLANETS.includes(to)) return 0;

  const fromIdx = HOME_PLANETS.indexOf(from);
  const toIdx = HOME_PLANETS.indexOf(to);
  const diff = Math.abs(fromIdx - toIdx);
  return Math.min(diff, 7 - diff);
}

/** 확장 4종족 포함 시: 해당 종족·목표 행성에 대한 테라포밍 단계 수. game은 moweyip/tinkeroids 3-step 설정 필요. */
export function getTerraformStepsForFaction(
  game: { moweyipThreeStepPlanets?: PlanetType[]; tinkeroidsThreeStepPlanets?: PlanetType[] },
  factionId: string,
  to: PlanetType
): number {
  const faction = FACTIONS.find(f => f.id === factionId);
  if (!faction) return getTerraformSteps('terra', to); // fallback

  if (to === 'asteroid') return 0; // 소행성은 테라포밍으로 건설할 수 없으니 여기 오면 안됨 
  if (to === 'proto') return 3;

  // 다카니안: 기본 7색상 모두 1테라포밍
  if (factionId === 'darkanians') {
    if (HOME_PLANETS.includes(to)) return 1;
    return 0;
  }
  // 스페이스 자이언트: 기본 7색상 모두 2테라포밍
  if (factionId === 'space_giants') {
    if (HOME_PLANETS.includes(to)) return 2;
  }
  // 모웨이드: 7색상 중 3개=3단계, 4개=1단계 (게임별 설정). proto=3, asteroid=기본 휠 아님 → 0 또는 유지
  if (factionId === 'moweyip') {
    if (HOME_PLANETS.includes(to)) {
      const three = game.moweyipThreeStepPlanets ?? [];
      return three.includes(to) ? 3 : 1;
    }
  }
  // 팅커로이드: 7색상 중 3개=3단계, 4개=1단계. asteroid=홈 0, proto=3
  if (factionId === 'tinkeroids') {
    if (HOME_PLANETS.includes(to)) {
      const three = game.tinkeroidsThreeStepPlanets ?? [];
      return three.includes(to) ? 3 : 1;
    }
  }

  return getTerraformSteps(faction.homePlanet, to);
}

/** 가이아 행성 건설 시 기본 QIC 비용 (확장 종족 다카니안, 스페이스 자이언트, 팅커로이드는 2QIC, 그 외 1QIC) */
export function getGaiaBaseQic(factionId: string): number {
  if (factionId === 'darkanians' || factionId === 'space_giants' || factionId === 'tinkeroids') {
    return 2;
  }
  return 1;
}

/** 확장: 나머지 종족들의 홈(7색상만)이 3명분 있고 서로 다르면 그 3개, 아니면 랜덤 3개 반환 */
export function computeExpansionThreeStepPlanets(otherHomePlanetsInSeven: PlanetType[]): PlanetType[] {
  const distinct = Array.from(new Set(otherHomePlanetsInSeven.filter(p => HOME_PLANETS.includes(p))));
  if (distinct.length >= 3) {
    const shuffled = distinct.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }
  const remaining = HOME_PLANETS.filter(p => !distinct.includes(p));
  const need = 3 - distinct.length;
  const shuffledRemaining = remaining.slice().sort(() => Math.random() - 0.5);
  return [...distinct, ...shuffledRemaining.slice(0, need)];
}

export function getDistance(a: { q: number, r: number }, b: { q: number, r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

/** 최종미션별 플레이어 수치 (0이면 미표시·0점). 서버/클라이언트 공용 */
export function getFinalMissionValue(game: GaiaGameState, playerId: string, missionId: string): number {
  const map = game.map;
  const player = game.players[playerId];
  if (!player) return 0;

  const mineCount =
    map.filter(t => t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine')).length
    + map.filter(t => t.parasiticMine?.ownerId === playerId).length
    + (player.virtualMineAsteroid ? 1 : 0)
    + (player.virtualMineProto ? 1 : 0);

  switch (missionId) {
    case 'fm_total_structures': {
      const ts = map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
      const lab = map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
      const pi = map.filter(t => t.ownerId === playerId && t.structure === 'planetary_institute').length;
      const academy = map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
      return mineCount + ts + lab + pi + academy;
    }
    case 'fm_federation_buildings': {
      // [버그수정 2026-07-26, 사용자] 이 게임의 연방 의미론(상태창 호버 하이라이트와 동일): 연방 헥스에
      // '인접 연결된 내 노드(건물·기생광산·우주정거장)'는 자동 소속. 기존 정산은 형성 시점 헥스만 세서
      // 나중에 연방 옆에 지은 건물/기생이 하이라이트엔 노랗게 뜨는데 미션 카운트엔 빠지는 불일치.
      // → GameBoard.hoveredFederationHexIds와 같은 BFS 확장으로 통일 (정거장은 연결만, 카운트는 건물·기생).
      const seeds = game.playerFederationHexes?.[playerId] || [];
      if (seeds.length === 0) return 0;
      const byId = new Map(map.map((t: any) => [t.id, t]));
      const byCoord = new Map(map.map((t: any) => [`${t.q},${t.r}`, t]));
      const isNode = (t: any) =>
        (t.ownerId === playerId && t.structure != null && t.structure !== 'ship')
        || t.parasiticMine?.ownerId === playerId
        || t.spaceStation?.ownerId === playerId;
      const seen = new Set<string>(seeds);
      const queue: any[] = [];
      for (const id of seeds) { const t = byId.get(id); if (t && isNode(t)) queue.push(t); }
      for (let i = 0; i < queue.length; i++) {
        for (const { q, r } of getNeighborCoords(queue[i].q, queue[i].r)) {
          const n = byCoord.get(`${q},${r}`);
          if (!n || seen.has(n.id) || !isNode(n)) continue;
          seen.add(n.id); queue.push(n);
        }
      }
      let buildingCount = 0;
      for (const id of Array.from(seen)) {
        const hex = byId.get(id);
        if (!hex) continue;
        if ((hex.ownerId === playerId && hex.structure != null && hex.structure !== 'ship') ||
          hex.parasiticMine?.ownerId === playerId) {
          buildingCount++;
        }
      }
      return buildingCount;
    }
    case 'fm_sectors': {
      const sectors = new Set(map.filter(t => ((t.ownerId === playerId && t.structure != null && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId) && t.sector >= 0 && t.sector <= 9).map(t => t.sector));
      return sectors.size;
    }
    case 'fm_outer_sectors': {
      const outer = new Set(map.filter(t => ((t.ownerId === playerId && t.structure != null && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId) && t.sector >= 11 && t.sector <= 18).map(t => t.sector));
      return outer.size;
    }
    case 'fm_gaia_planets':
      return map.filter(t => (t.type === 'gaia' || t.type === 'transdim') && t.ownerId === playerId && t.structure != null && t.structure !== 'ship').length;
    case 'fm_satellites': {
      // 하이브(Ivits)는 위성 대신 우주정거장을 놓으므로 우주정거장도 위성으로 카운트
      const satCount = Object.values(game.satellites ?? {}).filter(ids => ids.includes(playerId)).length;
      const spaceStationCount = map.filter(t => t.spaceStation?.ownerId === playerId).length;
      return satCount + spaceStationCount;
    }
    case 'fm_pi_academy_distance': {
      const pis = map.filter(t => t.ownerId === playerId && t.structure === 'planetary_institute');
      const academies = map.filter(t => t.ownerId === playerId && t.structure === 'academy');
      if (pis.length === 0 || academies.length === 0) return 0;
      let max = 0;
      for (const pi of pis) {
        for (const ac of academies) {
          const d = getDistance(pi, ac);
          if (d > max) max = d;
        }
      }
      return max;
    }
    case 'fm_planet_types':
      // 행성 유형은 란티다 기생 광산 제외 (1K/Type·패스보너스 등 다른 유형 점수와 일관).
      // 규칙은 getOwnedPlanetTypes 하나로 통일: space/deep_space 제외, lost_planet·가상광산(소행성/원시) 포함.
      return getOwnedPlanetTypes(game, playerId).size;
    case 'fm_asteroid_buildings':
      return map.filter(t => t.type === 'asteroid' && ((t.ownerId === playerId && t.structure != null && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId)).length
        + (player.virtualMineAsteroid ? 1 : 0);
    default:
      return 0;
  }
}

// ============================================================================
// 패스(Pass) 점수 계산 — 서버 정산과 클라 미리보기의 단일 출처(single source of truth).
//   [2026-08-06] 기존엔 server/gameState.ts passRound(라운드6/1-5 두 벌) + applyAdvancedTechTilePassEffect,
//   client Game.tsx passBonusVp/advPassItems가 각자 계산해 미리보기와 정산이 반복적으로 어긋났다
//   (가이아포머 개수·브릿지 섹터 기생광산·행성유형 등). 아래 함수들만 쓰도록 통일.
//   규칙 기준은 '서버 정산' 동작을 그대로 옮긴 것이며, 어긋났던 부분은 서버 쪽을 정답으로 삼는다.
// ============================================================================

/** 이 타일을 플레이어가 '건물'로 점유하는가 (우주선·빈칸 제외. 란티다 기생광산은 미포함) */
export function isOwnedBuilding(t: HexTile, playerId: string): boolean {
  return t.ownerId === playerId && t.structure != null && t.structure !== 'ship';
}

/** 이 타일에서 플레이어가 섹터를 '점유'하는가 — 내 건물 또는 란티다 기생광산 */
export function tileOccupiesSector(t: HexTile, playerId: string): boolean {
  return isOwnedBuilding(t, playerId) || t.parasiticMine?.ownerId === playerId;
}

/** 플레이어가 점유한 [lo,hi] 범위의 '서로 다른 섹터' 수 (기생광산 포함) */
export function countOccupiedSectors(game: GaiaGameState, playerId: string, lo: number, hi: number): number {
  const out = new Set<number>();
  for (const t of game.map) {
    if (t.sector >= lo && t.sector <= hi && tileOccupiesSector(t, playerId)) out.add(t.sector);
  }
  return out.size;
}

/** 외곽(C) 섹터 = 11~18 */
export const OUTER_SECTOR_RANGE = { lo: 11, hi: 18 } as const;

/** 보유 행성 유형 집합. 잊혀진 행성·가상 광산(인공물 소행성/원시) 포함, space/deep_space·기생광산 제외.
 *  (패스 보너스 'planet_type' / 고급타일 adv-pass-1vp-type / 최종미션 fm_planet_types / 기오덴 의회 공용)
 *
 *  [엠바스 스왑 주의] 잊혀진 행성은 원래 빈 우주(space)에 놓이므로 보통 'lost_planet' 하나만 준다.
 *  그런데 엠바스 의회 능력으로 의회 ↔ 광산 위치를 바꾸면 lost_planet_mine이 '진짜 행성 헥스'(예: proto) 위로
 *  옮겨간다. 이때 그 칸은 실제로 그 행성을 점유한 것이므로 '행성 유형'과 'lost_planet'을 둘 다 세야 한다.
 *  (else-if로 두면 스왑 후 유형이 하나 사라져 미션·기오덴·패스 점수가 모두 과소 집계된다.) */
export function getOwnedPlanetTypes(game: GaiaGameState, playerId: string): Set<string> {
  const types = new Set<string>();
  for (const t of game.map) {
    if (!isOwnedBuilding(t, playerId)) continue;
    if (t.structure === 'lost_planet_mine') types.add('lost_planet');
    if (t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
  }
  const player = game.players[playerId];
  if (player?.virtualMineAsteroid) types.add('asteroid');
  if (player?.virtualMineProto) types.add('proto');
  return types;
}

/** 패스/보너스/기술타일용 광산 수: 일반 광산 + 기생광산 + 가상광산(소행성/원시) + 잊혀진 행성 */
export function getMineCountForPassAndBonuses(game: GaiaGameState, playerId: string): number {
  const player = game.players[playerId];
  let n = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine').length;
  n += game.map.filter(t => t.parasiticMine?.ownerId === playerId).length;
  if (player?.virtualMineAsteroid) n += 1;
  if (player?.virtualMineProto) n += 1;
  n += game.map.filter(t => t.ownerId === playerId && t.structure === 'lost_planet_mine').length;
  return n;
}

/** 보너스 타일 'Pass: N VP per Gaiaformer'용: 파괴되지 않고 남아있는 포머 수.
 *  = 개인판 보유(발타크 QIC 잠금분 포함) + 맵에서 가이아포밍 중인 것. (소행성에 쓰여 파괴된 건 제외) */
export function countRemainingGaiaformers(game: GaiaGameState, playerId: string): number {
  const player = game.players[playerId];
  if (!player) return 0;
  const onBoard = player.gaiaformers ?? 0; // 발타크 QIC 잠금분은 gaiaformers에서 차감되지 않으므로 이미 포함됨
  const onMap = game.map.filter(t => t.hasGaiaformer && t.gaiaformerOwnerId === playerId).length;
  return onBoard + onMap;
}

export type PassBonusType = NonNullable<BonusTile['passBonus']>['type'];

/** 보너스 타일 패스 보너스의 '개수'(VP 배수 적용 전) */
export function getPassBonusCount(game: GaiaGameState, playerId: string, type: PassBonusType): number {
  const owned = game.map.filter(t => isOwnedBuilding(t, playerId));
  switch (type) {
    case 'big_building':
      return owned.filter(t => t.structure === 'academy' || t.structure === 'planetary_institute').length;
    case 'mine':
      return getMineCountForPassAndBonuses(game, playerId);
    case 'trading_station':
      return owned.filter(t => t.structure === 'trading_station').length;
    case 'research_lab':
      return owned.filter(t => t.structure === 'research_lab').length;
    case 'gaiaformer':
      return countRemainingGaiaformers(game, playerId);
    case 'planet_type':
      return getOwnedPlanetTypes(game, playerId).size;
    case 'gaia':
      return owned.filter(t => t.type === 'gaia').length;
    case 'bridge_sector':
      return countOccupiedSectors(game, playerId, OUTER_SECTOR_RANGE.lo, OUTER_SECTOR_RANGE.hi);
    default:
      return 0;
  }
}

export interface PassBonusTileResult {
  tileId: string;
  type: PassBonusType;
  /** 개당 VP */
  vpPer: number;
  count: number;
  /** count * vpPer */
  vp: number;
}

/** 현재 보유 보너스 타일의 패스 보너스. 타일이 없거나 패스 보너스가 없으면 null */
export function computeBonusTilePassVp(game: GaiaGameState, playerId: string): PassBonusTileResult | null {
  const player = game.players[playerId];
  if (!player?.bonusTile) return null;
  const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
  if (!tile?.passBonus) return null;
  const count = getPassBonusCount(game, playerId, tile.passBonus.type);
  return { tileId: tile.id, type: tile.passBonus.type, vpPer: tile.passBonus.vp, count, vp: count * tile.passBonus.vp };
}

export interface PassAdvTechResult {
  tileId: string;
  count: number;
  /** 개당 VP */
  vpPer: number;
  /** count * vpPer */
  vp: number;
  /** 로그용 사유 문구 */
  reason: string;
}

/** 고급 기술 타일(adv-pass-*)의 패스 보너스 목록. 보유 순서대로 반환 */
export function computeAdvancedTechPassVp(game: GaiaGameState, playerId: string): PassAdvTechResult[] {
  const player = game.players[playerId];
  const results: PassAdvTechResult[] = [];
  if (!player?.techTiles) return results;
  for (const tileId of player.techTiles) {
    let count: number;
    let vpPer: number;
    let reason: string;
    if (tileId === 'adv-pass-1vp-type') {
      count = getOwnedPlanetTypes(game, playerId).size; vpPer = 1; reason = '1 per planet type';
    } else if (tileId === 'adv-pass-3vp-lab') {
      count = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length; vpPer = 3; reason = '3 per lab';
    } else if (tileId === 'adv-pass-3vp-fed') {
      count = getFederationEntries(player).length; vpPer = 3; reason = '3 per federation';
    } else if (tileId === 'adv-pass-2vp-asteroid') {
      // 인공물 가상광산 소행성도 카운트(상태창/행성유형과 일관)
      count = game.map.filter(t => t.ownerId === playerId && t.type === 'asteroid').length + (player.virtualMineAsteroid ? 1 : 0);
      vpPer = 2; reason = '2 per asteroid';
    } else if (tileId === 'adv-pass-2vp-outer') {
      count = countOccupiedSectors(game, playerId, OUTER_SECTOR_RANGE.lo, OUTER_SECTOR_RANGE.hi); vpPer = 2; reason = '2 per outer sector';
    } else {
      continue;
    }
    results.push({ tileId, count, vpPer, vp: count * vpPer, reason });
  }
  return results;
}

export interface PassScorePreview {
  bonusTile: PassBonusTileResult | null;
  advTiles: PassAdvTechResult[];
  bonusVp: number;
  advVp: number;
  totalVp: number;
}

/** 지금 패스하면 얻는 총 VP (보너스 타일 + 고급 기술 타일). 서버 정산·클라 미리보기 공용 */
export function computePassScorePreview(game: GaiaGameState, playerId: string): PassScorePreview {
  const bonusTile = computeBonusTilePassVp(game, playerId);
  const advTiles = computeAdvancedTechPassVp(game, playerId);
  const bonusVp = bonusTile?.vp ?? 0;
  const advVp = advTiles.reduce((s, a) => s + a.vp, 0);
  return { bonusTile, advTiles, bonusVp, advVp, totalVp: bonusVp + advVp };
}

/** 특정 미션에 대해 특정 플레이어가 획득할 VP 계산 (순위 기반) */
export function getFinalMissionVp(game: { turnOrder: string[]; players: Record<string, any>; map: any[]; satellites?: any; playerFederationHexes?: any }, playerId: string, missionId: string): number {
  return getFinalMissionVpProjected(game, playerId, missionId, null);
}

/** getFinalMissionVp와 동일한 순위/동률 정산에서 내 미션 값만 myValueOverride로 가정했을 때의 VP.
 *  "지금 +N 진행하면 순위 VP가 실제로 오르는가"(추월 가능성) 판정용 — null이면 실제 값 사용. */
export function getFinalMissionVpProjected(game: { turnOrder: string[]; players: Record<string, any>; map: any[]; satellites?: any; playerFederationHexes?: any }, playerId: string, missionId: string, myValueOverride: number | null): number {
  const POINTS = [18, 12, 6];
  const values = game.turnOrder.map(pid => ({
    playerId: pid,
    value: (pid === playerId && myValueOverride != null) ? myValueOverride : getFinalMissionValue(game as any, pid, missionId),
  }));
  const withValue = values.filter(v => v.value > 0).sort((a, b) => b.value - a.value);
  if (withValue.length === 0) return 0;

  let placeIndex = 0;
  while (placeIndex < withValue.length) {
    const group: { playerId: string; value: number }[] = [];
    const firstVal = withValue[placeIndex].value;
    const startPlace = placeIndex;
    while (placeIndex < withValue.length && withValue[placeIndex].value === firstVal) {
      group.push(withValue[placeIndex]);
      placeIndex++;
    }
    const pool = group.reduce((sum, _, i) => sum + (POINTS[startPlace + i] ?? 0), 0);
    const pointsEach = group.length > 0 ? Math.floor((pool * 10) / group.length) / 10 : 0;

    if (group.some(g => g.playerId === playerId)) {
      return pointsEach;
    }
  }
  return 0;
}

/** 인접 헥스 6방향 (거리 1) */
const HEX_NEIGHBORS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;
export function getNeighborCoords(q: number, r: number): Array<{ q: number; r: number }> {
  return HEX_NEIGHBORS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

export function getNeighbors(map: HexTile[], tile: HexTile): HexTile[] {
  const coords = getNeighborCoords(tile.q, tile.r);
  return map.filter(t => coords.some(c => t.q === c.q && t.r === c.r));
}

/** 빈 공간: space/deep_space이고 건물·우주정거장 없음 (잊혀진 행성 있으면 빈공간 아님) */
export function isEmptyHex(tile: HexTile): boolean {
  if (tile.type !== 'space' && tile.type !== 'deep_space') return false;
  if (tile.structure != null || tile.spaceStation) return false;
  return true;
}

/** 행성 타일 (건물 올릴 수 있는 타일, 우주선/소행성 제외한 일반 행성) */
export function isPlanetHex(tile: HexTile): boolean {
  if (tile.structure != null || tile.parasiticMine) return true;
  if (!tile.type) return false;
  const nonPlanet: PlanetType[] = ['space', 'deep_space', 'lost_fleet_ship', 'asteroid'];
  if (tile.type.startsWith('ship_')) return false;
  return !nonPlanet.includes(tile.type);
}

/** 트랙별 기술 타일(단일 또는 배열)에서 첫 번째 사용 가능한 타일 반환 */
export function getFirstTrackTile(byTrack: Partial<Record<ResearchTrack, TechTile | (TechTile | null)[]>> | undefined, trackId: ResearchTrack): TechTile | null {
  const v = byTrack?.[trackId];
  if (!v) return null;
  if (Array.isArray(v)) return (v.find(t => t) as TechTile) ?? null;
  return v as TechTile;
}

/** 타일 ID가 트랙에 있는지 확인 (배열/단일 모두) */
export function findTrackByTileId(byTrack: Partial<Record<ResearchTrack, TechTile | (TechTile | null)[]>> | undefined, tileId: string): ResearchTrack | undefined {
  if (!byTrack) return undefined;
  const entry = Object.entries(byTrack).find(([, val]) => {
    const arr = Array.isArray(val) ? val : (val ? [val] : []);
    return arr.some((t: TechTile | null) => t?.id === tileId);
  });
  return entry?.[0] as ResearchTrack | undefined;
}

/** 교역소 건설 시 거리 2 이내 다른 플레이어 건물이 있으면 3C 할인 (표시/비용 계산용) */
export function hasNearbyPlayersForTradingDiscount(map: HexTile[], tile: HexTile, sourcePlayerId: string): boolean {
  for (const other of map) {
    if (getDistance(tile, other) > 2) continue;
    // 일반 건물 (우주선 제외)
    if (other.structure && other.structure !== 'ship' && other.ownerId && other.ownerId !== sourcePlayerId) return true;
    // 란티다 기생 광산 — 내 행성 위 기생광산이라도 상대 건물이므로 할인 대상 (서버 hasNearbyPlayersForDiscount와 정합)
    const pmOwner = other.parasiticMine?.ownerId;
    if (pmOwner && pmOwner !== sourcePlayerId) return true;
  }
  return false;
}
// Actual Gaia Project sector data - hexagonal sector shape
// Each sector has 19 hexes: center (1) + ring1 (6) + ring2 (12) = 19
// Positions are relative to sector center using axial coordinates
export const SECTOR_HEX_POSITIONS = [
  // Center (pos 0)
  { q: 0, r: 0 },
  // Ring 1 - 6 hexes adjacent to center (pos 1-6)
  { q: 1, r: -1 },  // top-right
  { q: 1, r: 0 },   // right
  { q: 0, r: 1 },   // bottom-right
  { q: -1, r: 1 },  // bottom-left
  { q: -1, r: 0 },  // left
  { q: 0, r: -1 },  // top-left
  // Ring 2 - 12 hexes outer ring (pos 7-18)
  { q: 2, r: -2 },  // top
  { q: 2, r: -1 },  // top-right-1
  { q: 2, r: 0 },   // right-top
  { q: 1, r: 1 },   // right-bottom
  { q: 0, r: 2 },   // bottom-right
  { q: -1, r: 2 },  // bottom
  { q: -2, r: 2 },  // bottom-left
  { q: -2, r: 1 },  // left-bottom
  { q: -2, r: 0 },  // left-top
  { q: -1, r: -1 }, // top-left-1
  { q: 0, r: -2 },  // top-left-2
  { q: 1, r: -2 },  // top-right-2
];

// Sector definitions with actual planet layouts
export const SECTORS: { id: number; planets: { pos: number; type: PlanetType }[] }[] = [
  { id: 1, planets: [{ pos: 18, type: 'transdim' }, { pos: 6, type: 'terra' }, { pos: 8, type: 'volcanic' }, { pos: 9, type: 'oxide' }, { pos: 4, type: 'swamp' }, { pos: 12, type: 'desert' }] },
  { id: 2, planets: [{ pos: 18, type: 'desert' }, { pos: 6, type: 'ice' }, { pos: 8, type: 'transdim' }, { pos: 15, type: 'titanium' }, { pos: 14, type: 'volcanic' }, { pos: 3, type: 'swamp' }, { pos: 10, type: 'oxide' }] },
  { id: 3, planets: [{ pos: 18, type: 'titanium' }, { pos: 1, type: 'ice' }, { pos: 15, type: 'transdim' }, { pos: 9, type: 'desert' }, { pos: 4, type: 'gaia' }, { pos: 10, type: 'terra' }] },
  { id: 4, planets: [{ pos: 7, type: 'terra' }, { pos: 1, type: 'swamp' }, { pos: 15, type: 'titanium' }, { pos: 5, type: 'oxide' }, { pos: 3, type: 'volcanic' }, { pos: 12, type: 'ice' }] },
  { id: 5, planets: [{ pos: 17, type: 'transdim' }, { pos: 18, type: 'oxide' }, { pos: 15, type: 'ice' }, { pos: 9, type: 'desert' }, { pos: 4, type: 'gaia' }, { pos: 10, type: 'volcanic' }] },
  { id: 6, planets: [{ pos: 7, type: 'desert' }, { pos: 16, type: 'transdim' }, { pos: 6, type: 'terra' }, { pos: 8, type: 'transdim' }, { pos: 2, type: 'gaia' }, { pos: 4, type: 'swamp' }] },
  { id: 7, planets: [{ pos: 16, type: 'swamp' }, { pos: 1, type: 'gaia' }, { pos: 5, type: 'oxide' }, { pos: 9, type: 'titanium' }, { pos: 3, type: 'gaia' }, { pos: 13, type: 'transdim' }] },
  { id: 8, planets: [{ pos: 17, type: 'transdim' }, { pos: 1, type: 'titanium' }, { pos: 15, type: 'terra' }, { pos: 5, type: 'ice' }, { pos: 3, type: 'volcanic' }, { pos: 10, type: 'transdim' }] },
  { id: 9, planets: [{ pos: 17, type: 'ice' }, { pos: 16, type: 'transdim' }, { pos: 1, type: 'gaia' }, { pos: 14, type: 'volcanic' }, { pos: 3, type: 'titanium' }, { pos: 11, type: 'swamp' }] },
  { id: 10, planets: [{ pos: 17, type: 'transdim' }, { pos: 16, type: 'transdim' }, { pos: 1, type: 'gaia' }, { pos: 4, type: 'desert' }, { pos: 10, type: 'oxide' }, { pos: 11, type: 'terra' }] },
];

// Consolidated Sector center positions (Matching generateMap logic)
export const SECTOR_CENTERS = [
  // 10 Internal Sectors (Radius 2, 3-4-3 layout)
  { q: 2, r: 4, sector: 0 },   // Row 1
  { q: 7, r: 3, sector: 1 },
  { q: 12, r: 2, sector: 2 },
  { q: -2, r: 9, sector: 3 },  // Row 2
  { q: 3, r: 8, sector: 4 },
  { q: 8, r: 7, sector: 5 },
  { q: 13, r: 6, sector: 6 },
  { q: -1, r: 13, sector: 7 }, // Row 3
  { q: 4, r: 12, sector: 8 },
  { q: 9, r: 11, sector: 9 },
  // External Bridge Sectors 11-18 (Match bridgeOffsets in generateMap)
  // Adjusted: All shifted right (q+1), Top two (11, 12) shifted down (r+1)
  { q: 5, r: 2, sector: 11 },   // Original: 5, 1 -> q+1
  { q: 10, r: 1, sector: 12 },  // Original: 10, 0 -> q+1
  { q: 15, r: 3, sector: 13 },  // Original: 14, 3 -> q+1
  { q: 12, r: 10, sector: 14 },  // Original: 12, 9 -> q+1
  { q: 6, r: 14, sector: 15 },  // Original: 5, 14 -> q+1
  { q: 1, r: 15, sector: 16 },  // Original: 0, 15 -> q+1
  { q: -4, r: 13, sector: 17 }, // Original: -4, 12 -> q+1
  { q: -1, r: 6, sector: 18 },  // Original: -2, 6 -> q+1
];
