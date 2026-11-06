/**
 * [사용자 2026-11-06] 끝난 게임 리플레이 — 저장된 게임 기록(human-games 페이로드)만으로 한 수씩 맵·플레이어 상태를 다시 쌓는다.
 *
 * 게임 엔진을 다시 돌리는 게 아니라 '기록 재생'이다:
 *  - 맵: 최종 맵에서 건물·포머·위성 등을 걷어낸 빈 맵(가이아로 바뀐 칸은 차원변형 행성으로 되돌림)에서 시작해,
 *        gameLog의 tileId/fedHexes를 따라 건물을 하나씩 올린다.
 *  - 플레이어: actionJournal의 playerAfter(그 수 직후 자원·트랙·타일·점수)를 시각 기준으로 가져오고,
 *        gameLog의 snap(행위자 자원·점수)으로 덮는다.
 * 롤백으로 취소된 행동(rolledBack)은 건너뛴다.
 */
import {
  ALL_ADVANCED_TECH_TILES, ALL_BONUS_TILES, ALL_TECH_TILES, INITIAL_POWER_ACTIONS, ROUND_MISSION_POOL,
  createInitialPlayerState,
  type GaiaGameState, type HexTile, type PlayerState, type ResearchTrack, type ScoringTile, type TechTile,
} from './gameConfig';

type Snap = { vp: number; c: number; o: number; k: number; q: number; p1: number; p2: number; p3: number; bs?: number };

export type ReplayLogEntry = {
  seq?: number;
  timestamp: number;
  playerId: string;
  playerName: string;
  action: string;
  details?: string;
  tileId?: string;
  round?: number;
  snap?: Snap;
  fedHexes?: string[];
  rolledBack?: boolean;
};

type JournalPlayer = {
  name: string;
  score: number;
  faction: string | null;
  research?: Partial<Record<ResearchTrack, number>>;
  bonusTile?: string | null;
  resources?: { ore?: number; qic?: number; credits?: number; knowledge?: number; power1?: number; power2?: number; power3?: number };
  techTiles?: string[];
  federations?: unknown[];
};

export type ReplayPayload = {
  gameId: string;
  createdAt?: number | string;
  completedAt?: string;
  map: HexTile[];
  players: Record<string, { name: string; faction: string | null; score: number; rank?: number; research?: Record<string, number>; techTiles?: string[]; bonusTile?: string | null; resources?: JournalPlayer['resources']; scoreBreakdown?: unknown }>;
  turnOrder?: string[];
  gameLog?: ReplayLogEntry[];
  actionJournal?: Array<{ timestamp: number; playerId: string; playerBefore?: JournalPlayer; playerAfter?: JournalPlayer; scoreAfter?: number }>;
  satellites?: Record<string, string[]>;
  playerFederationHexes?: Record<string, string[]>;
};

export type ReplayPlayer = {
  name: string;
  faction: string | null;
  score: number;
  ore: number; credits: number; knowledge: number; qic: number;
  power1: number; power2: number; power3: number;
  research: Record<ResearchTrack, number>;
  techTiles: string[];
  bonusTile: string | null;
  federationCount: number;
};

export type ReplayFrame = {
  /** 0 = 아무것도 안 한 시작 상태, i = 로그 i번째(1-based) 직후 */
  index: number;
  entry: ReplayLogEntry | null;
  round: number;
  map: HexTile[];
  satellites: Record<string, string[]>;
  federationHexes: Record<string, string[]>;
  spaceships: Record<string, { unlocked: boolean; occupants: string[] }>;
  players: Record<string, ReplayPlayer>;
};

const TRACKS: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

const EMPTY_RESEARCH: Record<ResearchTrack, number> = {
  terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0,
};

/** 최종 맵 → 시작 맵: 건물·포머·위성 표시를 걷어내고, 가이아 프로젝트로 바뀐 칸은 차원변형(transdim)으로 되돌린다. */
export function buildInitialMap(finalMap: HexTile[]): HexTile[] {
  return finalMap.map(t => {
    const base: HexTile = { ...t, structure: null, ownerId: null };
    delete base.hasGaiaformer;
    delete base.gaiaformerOwnerId;
    delete base.destroyedGaiaformer;
    delete base.academyType;
    delete base.parasiticMine;
    delete base.spaceStation;
    delete base.moweyipRing;
    if (t.isGaiaformed) base.type = 'transdim';
    base.isGaiaformed = t.isGaiaformed == null ? t.isGaiaformed : false;
    return base;
  });
}

const UPGRADE_RE = /^Upgraded to (Trading Station|Research Lab|Academy|Planetary Institute)/;
const UPGRADE_TARGET: Record<string, HexTile['structure']> = {
  'Trading Station': 'trading_station',
  'Research Lab': 'research_lab',
  'Academy': 'academy',
  'Planetary Institute': 'planetary_institute',
};
/** 광산을 새로 짓는 행동 (tileId = 지은 칸) */
const MINE_RE = /^(Placed Starting Mine|Built Mine|Built Mine on Asteroid|Built Mine on Proto|Eclipse: Built mine on asteroid|Spaceship Fed)$/;

/** 로그 한 줄을 맵 상태에 적용. map은 이 함수 안에서 바뀐 칸만 새 객체로 교체(이전 프레임과 공유). */
function applyEntry(
  e: ReplayLogEntry,
  map: HexTile[],
  idx: Map<string, number>,
  finalById: Map<string, HexTile>,
  finalSatellites: Record<string, string[]>,
  satellites: Record<string, string[]>,
  fedHexes: Record<string, string[]>,
  spaceships: Record<string, { unlocked: boolean; occupants: string[] }>,
): void {
  const pid = e.playerId;
  const i = e.tileId != null ? idx.get(e.tileId) : undefined;
  const cur = i != null ? map[i] : undefined;
  const put = (patch: Partial<HexTile>) => { if (i != null) map[i] = { ...map[i], ...patch }; };
  const a = e.action;

  if (cur) {
    if (MINE_RE.test(a)) {
      const patch: Partial<HexTile> = { structure: 'mine', ownerId: pid };
      // 포머가 있던 차원변형 행성에 광산 = 가이아 행성이 된 것
      if (cur.type === 'transdim') { patch.type = 'gaia'; patch.isGaiaformed = true; }
      if (cur.hasGaiaformer) { patch.hasGaiaformer = false; patch.gaiaformerOwnerId = undefined; }
      if (/Gaiaformer/.test(e.details ?? '') && cur.type === 'asteroid') patch.destroyedGaiaformer = true;
      put(patch);
    } else if (a === 'Placed Starting Planetary Institute') {
      put({ structure: 'planetary_institute', ownerId: pid });
    } else if (UPGRADE_RE.test(a)) {
      const target = UPGRADE_TARGET[UPGRADE_RE.exec(a)![1]];
      const patch: Partial<HexTile> = { structure: target, ownerId: cur.ownerId ?? pid };
      if (target === 'academy') {
        const d = e.details ?? '';
        patch.academyType = /QIC/.test(d) ? 'right' : /2K/.test(d) ? 'left' : finalById.get(cur.id)?.academyType ?? 'left';
      }
      put(patch);
    } else if (a === 'Rebellion: Mine → TS' || a === 'Firaks: Downgrade') {
      put({ structure: 'trading_station' });
    } else if (a === 'Twilight: TS → Research Lab') {
      put({ structure: 'research_lab' });
    } else if (a === 'Built Parasitic Mine') {
      put({ parasiticMine: { ownerId: pid } });
    } else if (a === 'Placed Gaiaformer') {
      put({ hasGaiaformer: true, gaiaformerOwnerId: pid });
    } else if (/^Ivits: Space Station/.test(a)) {
      put({ spaceStation: { ownerId: pid } });
    } else if (/^Lost Planet/.test(a)) {
      put({ structure: 'lost_planet_mine', ownerId: pid });
    } else if (/Moweyip.*Special/.test(a)) {
      put({ moweyipRing: true });
    } else if (a === 'Ambas: Special') {
      // 클릭한 광산 ↔ 기존 의회 위치 교환
      const piIdx = map.findIndex(t => t.ownerId === pid && t.structure === 'planetary_institute');
      if (piIdx >= 0 && piIdx !== i) map[piIdx] = { ...map[piIdx], structure: 'mine' };
      put({ structure: 'planetary_institute' });
    } else if (a === 'Entered Ship' && cur.type?.startsWith('ship_')) {
      const s = spaceships[cur.id] ?? { unlocked: true, occupants: [] };
      if (!s.occupants.includes(pid)) spaceships[cur.id] = { unlocked: true, occupants: [...s.occupants, pid] };
    }
  }

  if (e.fedHexes?.length) {
    const set = new Set(fedHexes[pid] ?? []);
    for (const h of e.fedHexes) {
      set.add(h);
      // 위성은 최종 기록에 그 사람 위성이 있는 칸만 (건물 칸·우주정거장 칸은 위성이 아님)
      if (finalSatellites[h]?.includes(pid) && !(satellites[h] ?? []).includes(pid)) {
        satellites[h] = [...(satellites[h] ?? []), pid];
      }
    }
    fedHexes[pid] = Array.from(set);
  }
}

function playerFromJournal(p: JournalPlayer | undefined, fallback: { name: string; faction: string | null }): ReplayPlayer {
  const r = p?.resources ?? {};
  return {
    name: p?.name ?? fallback.name,
    faction: p?.faction ?? fallback.faction,
    score: p?.score ?? 10,
    ore: r.ore ?? 0, credits: r.credits ?? 0, knowledge: r.knowledge ?? 0, qic: r.qic ?? 0,
    power1: r.power1 ?? 0, power2: r.power2 ?? 0, power3: r.power3 ?? 0,
    research: { ...EMPTY_RESEARCH, ...(p?.research ?? {}) } as Record<ResearchTrack, number>,
    techTiles: p?.techTiles ?? [],
    bonusTile: p?.bonusTile ?? null,
    federationCount: p?.federations?.length ?? 0,
  };
}

/** 페이로드 → 프레임 배열 (frames[0] = 시작, frames[i] = 로그 i개 적용 후) */
export function buildReplayFrames(payload: ReplayPayload): ReplayFrame[] {
  const log = (payload.gameLog ?? []).filter(e => !e.rolledBack);
  const finalById = new Map(payload.map.map(t => [t.id, t]));
  const finalSatellites = payload.satellites ?? {};
  const playerIds = Object.keys(payload.players);
  const journal = [...(payload.actionJournal ?? [])].sort((a, b) => a.timestamp - b.timestamp);

  let map = buildInitialMap(payload.map);
  const idx = new Map(map.map((t, i) => [t.id, i]));
  let satellites: Record<string, string[]> = {};
  let fedHexes: Record<string, string[]> = {};
  let spaceships: Record<string, { unlocked: boolean; occupants: string[] }> = {};
  let jPtr = 0;
  // 첫 기록 전 상태 = 그 사람의 첫 저널 항목 직전 상태(종족 고르기 전엔 비어 있을 수 있음)
  const latest: Record<string, JournalPlayer | undefined> = {};
  for (const j of journal) if (!(j.playerId in latest) && j.playerBefore) latest[j.playerId] = j.playerBefore;
  let players: Record<string, ReplayPlayer> = Object.fromEntries(
    playerIds.map(id => [id, playerFromJournal(latest[id], payload.players[id])]),
  );

  const frames: ReplayFrame[] = [{
    index: 0, entry: null, round: 0, map, satellites, federationHexes: fedHexes, spaceships, players,
  }];

  log.forEach((e, n) => {
    map = [...map];
    satellites = { ...satellites };
    fedHexes = { ...fedHexes };
    spaceships = { ...spaceships };
    // 새 라운드 = 가이아 단계를 지남 → 포머가 놓인 차원변형 행성은 가이아 행성으로 성숙
    if ((e.round ?? 0) > frames[n].round) {
      map = map.map(t => (t.type === 'transdim' && t.hasGaiaformer) ? { ...t, type: 'gaia', isGaiaformed: true } : t);
    }
    applyEntry(e, map, idx, finalById, finalSatellites, satellites, fedHexes, spaceships);

    // 이 시각까지의 저널(사람별 최신 상태)
    while (jPtr < journal.length && journal[jPtr].timestamp <= e.timestamp) {
      const j = journal[jPtr++];
      if (j.playerAfter) latest[j.playerId] = j.playerAfter;
    }
    players = Object.fromEntries(playerIds.map(id => {
      const p = playerFromJournal(latest[id], payload.players[id]);
      return [id, p];
    }));
    // 행위자는 그 로그 줄의 스냅샷이 가장 정확하다
    if (e.snap && players[e.playerId]) {
      const s = e.snap;
      players[e.playerId] = {
        ...players[e.playerId],
        score: s.vp, credits: s.c, ore: s.o, knowledge: s.k, qic: s.q, power1: s.p1, power2: s.p2, power3: s.p3,
      };
    }

    frames.push({
      index: n + 1, entry: e, round: e.round ?? frames[n].round,
      map, satellites, federationHexes: fedHexes, spaceships, players,
    });
  });
  return frames;
}

/* ───────────────────────── 게임 화면 전체 복원 (리플레이 관전 방) ───────────────────────── */

/** 보드 설정(게임 내내 고정). 새 기록엔 boardSetup이 저장되고(정확), 예전 기록은 로그에서 추정한다. */
export type BoardSetup = {
  roundMissionIds: (string | null)[]; // 1~6라운드
  finalMissionIds: string[];
  techByTrack: Partial<Record<ResearchTrack, string | null>>;
  techPool: (string | null)[];
  advancedByTrack: Partial<Record<ResearchTrack, string | null>>;
  extraAdvanced: string | null;
  extraAdvancedCondition?: '25vp' | '3ships';
  economyVariant: 'power' | 'vp';
  bonusTileIds: string[];
  /** 기록에서 정확히 못 정한 항목 (화면 안내용) */
  guessed: string[];
};

export type SavedBoardSetup = Partial<Omit<BoardSetup, 'guessed'>>;

/** 진행 중/끝난 게임 객체에서 보드 설정을 뽑는다 (게임 기록 저장용 — 리플레이가 추정 없이 복원).
 *  일반 기술 타일은 4장 다 가져가면 칸이 비어 종류를 잃으므로, 만들 때 기억해 둔 값(initial)을 우선한다. */
export function boardSetupFromGame(game: GaiaGameState, initial?: Pick<SavedBoardSetup, 'techByTrack' | 'techPool'>): SavedBoardSetup {
  const firstId = (arr?: (TechTile | null)[]) => arr?.find(t => t)?.id ?? null;
  const techByTrack: Partial<Record<ResearchTrack, string | null>> = {};
  for (const tr of TRACKS) techByTrack[tr] = initial?.techByTrack?.[tr] ?? firstId(game.techTilesByTrack?.[tr]);
  const pool = game.techTilesPool ?? [];
  const techPool = [0, 1, 2].map(g => initial?.techPool?.[g] ?? firstId(pool.slice(g * 4, g * 4 + 4)));
  const advancedByTrack: Partial<Record<ResearchTrack, string | null>> = {};
  for (const tr of TRACKS) advancedByTrack[tr] = game.advancedTechTilesByTrack?.[tr]?.id ?? null;
  const bonus = new Set<string>((game.availableBonusTiles ?? []).map(t => t.id));
  for (const p of Object.values(game.players ?? {})) if (p.bonusTile) bonus.add(p.bonusTile);
  return {
    roundMissionIds: (game.roundScoringTiles ?? []).map(t => t?.id || null),
    finalMissionIds: game.finalMissionIds ?? [],
    techByTrack, techPool, advancedByTrack,
    extraAdvanced: game.extraAdvancedTechTile?.id ?? null,
    extraAdvancedCondition: game.extraAdvancedTechCondition,
    economyVariant: game.economyVariant ?? 'power',
    bonusTileIds: Array.from(bonus),
  };
}

const ROUND_TEXT_RE = /\(\+(\d+)VP Round ([^)]+)\)/g;

function inferRoundMissions(log: ReplayLogEntry[]): (string | null)[] {
  const out: (string | null)[] = [null, null, null, null, null, null];
  for (let r = 1; r <= 6; r++) {
    const votes = new Map<string, number>();
    for (const e of log) {
      if (e.round !== r) continue;
      const texts: [number, string][] = [];
      for (const m of Array.from((e.details ?? '').matchAll(ROUND_TEXT_RE))) texts.push([Number(m[1]), m[2].trim()]);
      if (/^Round /.test(e.action) && e.action !== 'Round Start') {
        const vp = /\+(\d+)VP/.exec(e.details ?? '');
        if (vp) texts.push([Number(vp[1]), e.action.replace(/^Round /, '').trim()]);
      }
      for (const [vp, cond] of texts) {
        const cands = ROUND_MISSION_POOL.filter(t => t.condition.toLowerCase() === cond.toLowerCase());
        if (!cands.length) continue;
        // 같은 조건이 점수만 다른 경우(가이아 3/4점, 교역소 3/4점): 한 번에 받은 점수로 구분. 테라포밍은 단계당이라 배수.
        const pick = cands.find(t => t.vp === vp) ?? cands.find(t => vp % t.vp === 0) ?? cands[0];
        votes.set(pick.id, (votes.get(pick.id) ?? 0) + 1);
      }
    }
    let best: string | null = null, n = 0;
    votes.forEach((v, id) => { if (v > n) { best = id; n = v; } });
    out[r - 1] = best;
  }
  return out;
}

export function inferBoardSetup(payload: ReplayPayload & { boardSetup?: SavedBoardSetup }): BoardSetup {
  const log = (payload.gameLog ?? []).filter(e => !e.rolledBack);
  const saved = payload.boardSetup ?? {};
  const guessed: string[] = [];

  // 라운드·최종 미션
  let roundMissionIds = saved.roundMissionIds;
  if (!roundMissionIds) {
    roundMissionIds = inferRoundMissions(log);
    guessed.push('라운드 미션(점수 문구로 추정, 아무도 점수를 못 낸 라운드는 비어 있음)');
  }
  const finalMissionIds = saved.finalMissionIds
    ?? Array.from(new Set(log.filter(e => e.action === 'Final Mission' && e.tileId).map(e => e.tileId!))).slice(0, 2);

  // 기술 타일 배치: 일반 타일을 받으며 올린 트랙이 늘 같으면 그 트랙 타일, 여러 트랙이면 하단 풀 타일
  let techByTrack = saved.techByTrack;
  let techPool = saved.techPool;
  if (!techByTrack || !techPool) {
    const tracksOf = new Map<string, Set<string>>();
    for (const e of log) {
      if (e.action !== 'Gained Tech Tile' || !e.tileId || !ALL_TECH_TILES.some(t => t.id === e.tileId)) continue;
      const tr = /^(\w+) →/.exec(e.details ?? '')?.[1];
      if (!tr || !TRACKS.includes(tr as ResearchTrack)) continue;
      if (!tracksOf.has(e.tileId)) tracksOf.set(e.tileId, new Set());
      tracksOf.get(e.tileId)!.add(tr);
    }
    techByTrack = {};
    const pool: string[] = [];
    tracksOf.forEach((set, id) => {
      if (set.size === 1) {
        const tr = Array.from(set)[0] as ResearchTrack;
        if (!techByTrack![tr]) techByTrack![tr] = id; else pool.push(id);
      } else pool.push(id);
    });
    // 남은 칸이 하나뿐이면 남은 타일로 확정
    const unseen = ALL_TECH_TILES.map(t => t.id).filter(id => !tracksOf.has(id));
    const emptyTracks = TRACKS.filter(t => !techByTrack![t]);
    if (emptyTracks.length === 1 && pool.length === 3 && unseen.length === 1) techByTrack[emptyTracks[0]] = unseen[0];
    else if (emptyTracks.length === 0 && pool.length === 2 && unseen.length === 1) pool.push(unseen[0]);
    techPool = [...pool.slice(0, 3)];
    while (techPool.length < 3) techPool.push(null);
    if (TRACKS.some(t => !techByTrack![t]) || techPool.some(x => !x)) guessed.push('아무도 안 가져간 기술 타일 자리(빈칸)');
  }

  // 고급 기술: 가져간 직후 올린 트랙을 그 타일 자리로 본다
  let advancedByTrack = saved.advancedByTrack;
  let extraAdvanced = saved.extraAdvanced ?? null;
  if (!advancedByTrack) {
    advancedByTrack = {};
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (!e.tileId?.startsWith('adv-') || !/Advanced Tech Tile/.test(e.action)) continue;
      const next = log.slice(i + 1, i + 4).find(x => x.playerId === e.playerId && /Advanced track/.test(x.action));
      const tr = next ? /^(\w+) →/.exec(next.details ?? '')?.[1] as ResearchTrack | undefined : undefined;
      if (tr && TRACKS.includes(tr) && !advancedByTrack[tr]) advancedByTrack[tr] = e.tileId;
      else if (!extraAdvanced) extraAdvanced = e.tileId;
    }
    guessed.push('아무도 안 가져간 고급 기술 타일(빈칸)');
  }

  // 경제 트랙 변형: 점수형에서만 'Economy Track Reward +1 VP'가 찍힌다
  const economyVariant = saved.economyVariant ?? (log.some(e => e.action === 'Economy Track Reward') ? 'vp' : 'power');

  // 이 판의 부스터: 저널·패스 로그에 나온 것 전부
  let bonusTileIds = saved.bonusTileIds;
  if (!bonusTileIds) {
    const ids = new Set<string>();
    for (const j of payload.actionJournal ?? []) if (j.playerAfter?.bonusTile) ids.add(j.playerAfter.bonusTile);
    for (const e of log) for (const m of Array.from((e.details ?? '').matchAll(/bon-[\w-]+/g))) ids.add(m[0]);
    bonusTileIds = Array.from(ids);
  }

  return {
    roundMissionIds, finalMissionIds, techByTrack, techPool, advancedByTrack, extraAdvanced,
    extraAdvancedCondition: saved.extraAdvancedCondition, economyVariant, bonusTileIds, guessed,
  };
}

const POWER_ACTION_BY_TEXT: [RegExp, string][] = [
  [/^\+3 Knowledge/, 'gain-3-knowledge'], [/^\+2 Terraform steps/, 'gain-2-steps'], [/^\+2 Ore/, 'gain-2-ore'],
  [/^\+7 Credits/, 'gain-7-credits'], [/^\+2 Knowledge/, 'gain-2-knowledge'], [/^\+1 Terraform step/, 'gain-1-step'],
  [/^\+2 Power tokens/, 'gain-2-tokens'],
];

export type ReplayInfo = {
  sourceGameId: string;
  index: number;
  total: number;
  completedAt?: string;
  guessed: string[];
  finalScores: { name: string; score: number }[];
};

/** 프레임 하나 → 게임 화면이 그대로 그릴 수 있는 전체 게임 상태 (리플레이 관전 방 전용, 보기 전용) */
export function buildReplayGameState(
  payload: ReplayPayload,
  frames: ReplayFrame[],
  index: number,
  setup: BoardSetup,
  roomId: string,
): GaiaGameState & { replay: ReplayInfo } {
  const frame = frames[Math.max(0, Math.min(index, frames.length - 1))];
  const isLast = frame.index === frames.length - 1;
  const log = frames.slice(1, frame.index + 1).map(f => f.entry!);
  const round = frame.round;
  const thisRound = log.filter(e => (e.round ?? 0) === round);
  const turnOrder = payload.turnOrder ?? Object.keys(payload.players);

  // 이번 라운드 패스 순서 (마지막 라운드는 'Selected Bonus'가 details 없이 찍힌다)
  const passingOrder: string[] = [];
  if (round >= 1) for (const e of thisRound) if (e.action === 'Selected Bonus' && !passingOrder.includes(e.playerId)) passingOrder.push(e.playerId);

  // 기술 타일 스택: 일반 타일은 4장씩 — 가져간 만큼 비운다
  const takenCount = new Map<string, number>();
  for (const e of log) {
    if (/Gained Tech Tile/.test(e.action) && e.tileId) takenCount.set(e.tileId, (takenCount.get(e.tileId) ?? 0) + 1);
  }
  const stack = (id: string | null | undefined): (TechTile | null)[] => {
    const t = id ? ALL_TECH_TILES.find(x => x.id === id) : undefined;
    if (!t) return [null, null, null, null];
    const left = Math.max(0, 4 - (takenCount.get(t.id) ?? 0));
    return Array.from({ length: 4 }, (_, i) => (i < left ? { ...t } : null));
  };
  const techTilesByTrack: GaiaGameState['techTilesByTrack'] = {};
  for (const tr of TRACKS) techTilesByTrack[tr] = stack(setup.techByTrack[tr]);
  const techTilesPool = setup.techPool.flatMap(id => stack(id));
  const advancedTechTilesByTrack: GaiaGameState['advancedTechTilesByTrack'] = {};
  for (const tr of TRACKS) {
    const t = ALL_ADVANCED_TECH_TILES.find(x => x.id === setup.advancedByTrack[tr]);
    if (t) advancedTechTilesByTrack[tr] = t;
  }

  // 이번 라운드에 쓴 파워 액션
  const powerActions = INITIAL_POWER_ACTIONS.map(a => ({ ...a }));
  for (const e of thisRound) {
    if (e.action !== 'Power Action') continue;
    const id = POWER_ACTION_BY_TEXT.find(([re]) => re.test(e.details ?? ''))?.[1];
    const pa = powerActions.find(a => a.id === id);
    if (pa && !pa.isUsed) { pa.isUsed = true; pa.usedByPlayerId = e.playerId; pa.usedByPlayerName = e.playerName; }
  }

  const players: Record<string, PlayerState> = {};
  for (const [id, fp] of Object.entries(frame.players)) {
    const base = createInitialPlayerState(fp.name);
    const mine = frame.map.filter(t => t.ownerId === id);
    const gaiaLv = fp.research.gaiaProject ?? 0;
    const destroyed = mine.filter(t => t.destroyedGaiaformer).length;
    const usedThisRound = (re: RegExp) => thisRound.some(e => e.playerId === id && re.test(e.action));
    const artifacts = Array.from(new Set(log.filter(e => e.playerId === id && e.tileId?.startsWith('art-')).map(e => e.tileId!)));
    const shipsEntered = Object.entries(frame.spaceships).filter(([, s]) => s.occupants.includes(id)).map(([k]) => k);
    players[id] = {
      ...base,
      faction: fp.faction,
      score: isLast ? payload.players[id]?.score ?? fp.score : fp.score,
      // 마지막 수 = 게임 종료 화면: 저장된 실제 최종 점수 내역으로 종료 점수표를 그린다
      ...(isLast && payload.players[id]?.scoreBreakdown ? { scoreBreakdown: payload.players[id].scoreBreakdown } : {}),
      ore: fp.ore, credits: fp.credits, knowledge: fp.knowledge, qic: fp.qic,
      power1: fp.power1, power2: fp.power2, power3: fp.power3,
      research: fp.research,
      techTiles: fp.techTiles,
      bonusTile: fp.bonusTile,
      federations: (latestFederations(payload, id, frame.entry?.timestamp ?? 0) ?? []) as PlayerState['federations'],
      hasPassed: passingOrder.includes(id),
      startingMinesPlaced: mine.filter(t => t.structure === 'mine').length,
      // 포머 수: 가이아 트랙 1/3/4단계에서 1개씩 (소행성에 써서 없어진 것 포함 표시)
      gaiaformers: Math.max(0, (gaiaLv >= 1 ? 1 : 0) + (gaiaLv >= 3 ? 1 : 0) + (gaiaLv >= 4 ? 1 : 0) - destroyed),
      destroyedGaiaformers: destroyed,
      pendingGaiaformerTiles: frame.map.filter(t => t.hasGaiaformer && t.gaiaformerOwnerId === id).map(t => t.id),
      usedTechActions: thisRound.filter(e => e.playerId === id && e.action === 'Used Tech Action' && e.tileId).map(e => e.tileId!),
      usedBonusAction: usedThisRound(/^Bonus Action/),
      artifacts,
      spaceshipsEntered: shipsEntered,
    } as PlayerState;
  }

  const roundScoringTiles: ScoringTile[] = setup.roundMissionIds.map(id =>
    ROUND_MISSION_POOL.find(t => t.id === id) ?? { id: '', label: '?', condition: '?', vp: 0 });
  const held = new Set(Object.values(players).map(p => p.bonusTile).filter(Boolean) as string[]);
  const availableBonusTiles = ALL_BONUS_TILES.filter(t => setup.bonusTileIds.includes(t.id) && !held.has(t.id));
  const actor = frame.entry?.playerId;
  const shipTiles = frame.map.filter(t => t.type?.startsWith('ship_')).map(t => t.id);
  const spaceships: NonNullable<GaiaGameState['spaceships']> = {};
  for (const id of shipTiles) spaceships[id] = { unlocked: true, occupants: frame.spaceships[id]?.occupants ?? [] };

  return {
    id: roomId,
    hostId: turnOrder[0],
    maxPlayers: turnOrder.length,
    players,
    map: frame.map,
    currentPhase: isLast ? 'gameEnd' : round === 0 ? 'startingMines' : 'main',
    roundNumber: round,
    finalMissionIds: setup.finalMissionIds,
    finalMissionScoresApplied: isLast,
    currentPlayerIndex: actor ? Math.max(0, turnOrder.indexOf(actor)) : 0,
    turnOrder,
    botPlayerIds: [],
    isTestMode: false,
    hasDoneMainAction: false,
    powerActions,
    availableBonusTiles,
    roundScoringTiles,
    finalScoringTiles: [],
    usedRoundMissions: [],
    techTilesByTrack,
    advancedTechTilesByTrack,
    extraAdvancedTechTile: ALL_ADVANCED_TECH_TILES.find(t => t.id === setup.extraAdvanced),
    extraAdvancedTechCondition: setup.extraAdvancedCondition,
    techTilesPool,
    passingOrder,
    pendingBonusSelection: null,
    gameLog: log as GaiaGameState['gameLog'],
    economyVariant: setup.economyVariant,
    satellites: frame.satellites,
    playerFederationHexes: frame.federationHexes,
    spaceships,
    replay: {
      sourceGameId: payload.gameId,
      index: frame.index,
      total: frames.length - 1,
      completedAt: payload.completedAt,
      guessed: setup.guessed,
      finalScores: Object.values(payload.players).map(p => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score),
    },
  } as GaiaGameState & { replay: ReplayInfo };
}

function latestFederations(payload: ReplayPayload, playerId: string, ts: number): unknown[] | undefined {
  let out: unknown[] | undefined;
  for (const j of payload.actionJournal ?? []) {
    if (j.playerId !== playerId || j.timestamp > ts) continue;
    if (j.playerAfter?.federations) out = j.playerAfter.federations;
  }
  return out;
}
