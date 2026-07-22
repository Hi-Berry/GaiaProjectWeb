import * as fs from 'fs';
import * as path from 'path';
import type { GaiaGameState, PlayerState } from '@shared/gameConfig';
import { log } from './index';
import { recordDecisionFeatures } from './ai/valueData';

export type HumanActionJournalEntry = {
  id: string;
  timestamp: number;
  gameId: string;
  round: number;
  phase: string;
  playerId: string;
  playerName: string;
  faction?: string | null;
  action: string;
  details?: string;
  tileId?: string;
  scoreBefore?: number;
  scoreAfter?: number;
  playerBefore?: ReturnType<typeof summarizePlayer>;
  playerAfter?: ReturnType<typeof summarizePlayer>;
  candidates?: Array<{ type: string; tileId?: string; trackId?: string; target?: string; actionId?: string }>; // [per-candidate 학습] 결정시점 가능 후보들
};

/**
 * 전체 게임 로그(사람+봇 모든 액션, 전 라운드). `game.gameLog`는 라이브 브로드캐스트 페이로드라
 * 100줄로 캡되어 엔드게임만 남는다 → 봇의 초·중반 액션이 유실된다. 분석(사람 vs 봇 라운드별 대조)을
 * 위해 사람이 낀 게임에 한해 여기 모듈 레벨 저장소에 캡 없이 모아두고, export 때만 꺼내 쓴다.
 * (게임 객체에 붙이지 않으므로 브로드캐스트/UI에는 0 영향.)
 */
export type FullGameLogEntry = {
  timestamp: number;
  round: number;
  phase: string;
  playerId: string;
  playerName: string;
  isBot: boolean;
  action: string;
  details?: string;
  tileId?: string;
};

const fullGameLogs = new Map<string, FullGameLogEntry[]>();
const FULL_LOG_CAP = 4000; // 비정상 성장(버려진 게임 등) 방지용 상한. 6R 4인플은 보통 600~1000.

type HumanGamePayload = {
  version: 1;
  gameId: string;
  createdAt?: number;
  completedAt: string;
  roundNumber: number;
  players: Record<string, ReturnType<typeof summarizePlayer> & { rank: number }>;
  turnOrder: string[];
  gameLog: NonNullable<GaiaGameState['gameLog']>;
  actionJournal: HumanActionJournalEntry[];
  fullGameLog: FullGameLogEntry[];
  // [2026-06-28] 봇/사람 구분 명시. actionJournal은 사람 전용이라 분석엔 충분했지만, self-play 오염 가드와
  // fullGameLog의 isBot 라벨 신뢰를 위해 저장파일에 botPlayerIds를 박는다(런타임엔 있는데 export 누락이던 것).
  botPlayerIds: string[];
  // [2026-06-18] 최종 보드맵. 모방학습 맵-피처의 전제조건: 불투명 journal tileId('internal-N')를
  // 타일 메타(type/sector/위치/인접)로 해석 + 저널 재생으로 결정시점 보드 복원을 가능케 한다.
  // 봇 self-play 로그(final_state)는 이미 map을 저장하는데 human export만 누락이던 비대칭 수정.
  // export 페이로드 전용(게임객체/브로드캐스트/UI 무영향).
  map: GaiaGameState['map'];
};

function summarizePlayer(player?: PlayerState | null) {
  if (!player) return null;
  return {
    name: player.name,
    faction: player.faction,
    score: player.score ?? 0,
    resources: {
      credits: player.credits ?? 0,
      ore: player.ore ?? 0,
      knowledge: player.knowledge ?? 0,
      qic: player.qic ?? 0,
      power1: player.power1 ?? 0,
      power2: player.power2 ?? 0,
      power3: player.power3 ?? 0,
    },
    research: { ...(player.research ?? {}) },
    techTiles: [...(player.techTiles ?? [])],
    federations: player.federations ?? [],
    bonusTile: player.bonusTile,
    // 점수 내역(카테고리별 VP) — 봇 vs 사람 약점 분석에 필수
    scoreBreakdown: player.scoreBreakdown ?? null,
  };
}

export function recordHumanActionFromLog(game: GaiaGameState & {
  id?: string;
  botPlayerIds?: string[];
  turnStartState?: Record<string, any>;
  humanActionJournal?: HumanActionJournalEntry[];
  simulation?: boolean;
}, playerId: string, action: string, details?: string, tileId?: string) {
  if (game.simulation) return;
  if (!game.id) return;
  if (game.botPlayerIds?.includes(playerId)) return;
  if (!['main', 'startingMines', 'bonusSelection', 'factionBidding'].includes(String(game.currentPhase))) return;

  const player = game.players[playerId];
  if (!player) return;
  if (!game.humanActionJournal) game.humanActionJournal = [];

  const startPlayer = game.turnStartState?.[playerId]?.playerState as PlayerState | undefined;
  game.humanActionJournal.push({
    id: `${game.id}-${Date.now()}-${game.humanActionJournal.length}`,
    timestamp: Date.now(),
    gameId: game.id,
    round: game.roundNumber ?? 0,
    phase: String(game.currentPhase),
    playerId,
    playerName: player.name,
    faction: player.faction,
    action,
    details,
    tileId,
    scoreBefore: startPlayer?.score,
    scoreAfter: player.score,
    playerBefore: summarizePlayer(startPlayer),
    playerAfter: summarizePlayer(player),
    candidates: (game.turnStartState?.[playerId] as any)?.humanCandidates, // [per-candidate 학습] 결정시점 가능 후보들
  } as HumanActionJournalEntry);

  // 가치망 학습 데이터: 사람(강한 플레이어)의 결정 시점 상태 + 선택한 수(모방학습용)도 수집
  // (VALUE_NET_COLLECT=1일 때만). 봇 데이터(botHandler)와 합쳐 강한 플레이를 학습.
  recordDecisionFeatures(game as any, playerId, action);
}

/**
 * 사람+봇 모든 액션을 전 라운드 캡 없이 기록(사람이 낀 게임 한정). `recordHumanActionFromLog`와 달리
 * 봇 액션도 남긴다 → export 시 봇의 라운드별 행동을 사람과 같은 보드에서 대조할 수 있다.
 * self-play / head2head(전원 봇)는 기록하지 않는다.
 */
export function recordFullGameLog(game: GaiaGameState & {
  id?: string;
  botPlayerIds?: string[];
  simulation?: boolean;
}, playerId: string, action: string, details?: string, tileId?: string) {
  if (game.simulation) return;
  if (!game.id) return;
  const botIds = game.botPlayerIds ?? [];
  const playerIds = Object.keys(game.players ?? {});
  const hasRealHuman = playerIds.some(id => !botIds.includes(id));
  if (!hasRealHuman) return; // 전원 봇(self-play/h2h) 제외
  const player = game.players[playerId];
  if (!player) return;

  let arr = fullGameLogs.get(game.id);
  if (!arr) { arr = []; fullGameLogs.set(game.id, arr); }
  if (arr.length >= FULL_LOG_CAP) return;
  arr.push({
    timestamp: Date.now(),
    round: game.roundNumber ?? 0,
    phase: String(game.currentPhase ?? ''),
    playerId,
    playerName: player.name,
    isBot: botIds.includes(playerId),
    action,
    details,
    tileId,
  });
}

/** export 시점에 풀 로그를 꺼내고 메모리에서 비운다(게임당 1회). */
function takeFullGameLog(gameId?: string): FullGameLogEntry[] {
  if (!gameId) return [];
  const arr = fullGameLogs.get(gameId) ?? [];
  fullGameLogs.delete(gameId);
  return arr;
}

/** 진행 중 스냅샷용: fullGameLog를 비우지 않고 복사만(반복 다운로드 가능). */
function peekFullGameLog(gameId?: string): FullGameLogEntry[] {
  if (!gameId) return [];
  return [...(fullGameLogs.get(gameId) ?? [])];
}

function buildPayload(game: GaiaGameState & {
  id?: string;
  createdAt?: number;
  humanActionJournal?: HumanActionJournalEntry[];
  botPlayerIds?: string[];
}): HumanGamePayload {
  const rankedIds = Object.keys(game.players).sort((a, b) => (game.players[b].score ?? 0) - (game.players[a].score ?? 0));
  const players: HumanGamePayload['players'] = {};
  rankedIds.forEach((playerId, index) => {
    players[playerId] = {
      ...(summarizePlayer(game.players[playerId])!),
      rank: index + 1,
    };
  });

  return {
    version: 1,
    gameId: game.id ?? 'unknown',
    createdAt: game.createdAt,
    completedAt: new Date().toISOString(),
    roundNumber: game.roundNumber ?? 0,
    players,
    turnOrder: [...(game.turnOrder ?? [])],
    gameLog: game.gameLog ?? [],
    actionJournal: game.humanActionJournal ?? [],
    fullGameLog: takeFullGameLog(game.id),
    botPlayerIds: [...(game.botPlayerIds ?? [])],
    map: game.map ?? [],
  };
}

/**
 * 진행 중(미완료) 게임의 분석용 스냅샷을 최종 저장과 동일한 포맷으로 생성 — 비파괴(fullGameLog peek).
 * 관전자/호스트가 게임 끝나기 전에 다운로드해 버그 분석에 쓰기 위함. buildPayload와 동일 필드 + inProgress 표식.
 */
export function buildLiveSnapshot(game: GaiaGameState & {
  id?: string;
  createdAt?: number;
  humanActionJournal?: HumanActionJournalEntry[];
  botPlayerIds?: string[];
}): HumanGamePayload & { inProgress: true; snapshotAt: string } {
  const rankedIds = Object.keys(game.players).sort((a, b) => (game.players[b].score ?? 0) - (game.players[a].score ?? 0));
  const players: HumanGamePayload['players'] = {};
  rankedIds.forEach((playerId, index) => {
    players[playerId] = { ...(summarizePlayer(game.players[playerId])!), rank: index + 1 };
  });
  const now = new Date().toISOString();
  return {
    version: 1,
    gameId: game.id ?? 'unknown',
    createdAt: game.createdAt,
    completedAt: now, // 진행 중 스냅샷 시각(파일명/정렬용) — 실제 종료 아님(inProgress로 구분)
    roundNumber: game.roundNumber ?? 0,
    players,
    turnOrder: [...(game.turnOrder ?? [])],
    gameLog: game.gameLog ?? [],
    actionJournal: game.humanActionJournal ?? [],
    fullGameLog: peekFullGameLog(game.id),
    botPlayerIds: [...(game.botPlayerIds ?? [])],
    map: game.map ?? [],
    inProgress: true,
    snapshotAt: now,
  };
}

function writeLocalPayload(payload: HumanGamePayload) {
  const dir = path.join(process.cwd(), 'data', 'human-games');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${payload.completedAt.slice(0, 10)}_${payload.gameId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  log(`Human game dataset saved locally: ${filePath}`, 'system', payload.gameId);
}

/** Render env에 /rest/v1 이 붙은 URL이 들어가면 PGRST125(Invalid path)가 납니다. */
export function normalizeSupabaseProjectUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  base = base.replace(/\/rest\/v1\/?$/i, '');
  base = base.replace(/\/auth\/v1\/?$/i, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`SUPABASE_URL must start with https:// (got: ${raw.slice(0, 40)}...)`);
  }
  return base;
}

/** public.human_game_sessions 처럼 넣으면 REST 경로가 깨집니다. */
export function normalizeSupabaseTableName(raw: string): string {
  const name = raw.trim().replace(/^public\./i, '').replace(/^\//, '').replace(/\/$/, '');
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid HUMAN_LOG_SUPABASE_TABLE: ${raw}`);
  }
  return name;
}

function buildHumanSessionsRestUrl(projectUrl: string, tableName: string): string {
  const base = normalizeSupabaseProjectUrl(projectUrl);
  const table = normalizeSupabaseTableName(tableName);
  return `${base}/rest/v1/${table}?on_conflict=game_id`;
}

async function uploadToSupabase(payload: HumanGamePayload) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tableName = process.env.HUMAN_LOG_SUPABASE_TABLE || 'human_game_sessions';
  if (!supabaseUrl || !serviceKey) {
    writeLocalPayload(payload);
    return;
  }

  const endpoint = buildHumanSessionsRestUrl(supabaseUrl, tableName);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      game_id: payload.gameId,
      completed_at: payload.completedAt,
      payload,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Supabase upload failed: ${res.status} ${body} (POST ${endpoint.replace(/\?.*$/, '')})`,
    );
  }
  log(`Human game dataset uploaded to Supabase: ${payload.gameId}`, 'system', payload.gameId);
}

export async function exportHumanGameDataset(game: GaiaGameState & {
  id?: string;
  createdAt?: number;
  botPlayerIds?: string[];
  humanActionJournal?: HumanActionJournalEntry[];
}) {
  if ((game as any).simulation) return;
  // 진짜 사람이 한 명도 없으면(= self-play / head2head 등 봇 전용 게임) 사람 데이터셋에 저장하지 않는다.
  // (러너들이 data/human-games / Supabase 를 오염시키던 문제 수정)
  const playerIds = Object.keys(game.players ?? {});
  const hasRealHuman = playerIds.some(id => !(game.botPlayerIds ?? []).includes(id));
  if (!hasRealHuman) return;
  const payload = buildPayload(game);
  if (payload.actionJournal.length === 0 && payload.gameLog.length === 0) return;

  const storage = (process.env.HUMAN_LOG_STORAGE || '').toLowerCase();
  const hasSupabaseCreds = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (storage === 'supabase' || (hasSupabaseCreds && storage !== 'local')) {
    await uploadToSupabase(payload);
    return;
  }
  writeLocalPayload(payload);
}

// Gaia 종족 id → 점수사이트(PythonAnywhere) 한글 종족명.
// 게임 코드 주석의 한글 라벨(파이락/모웨이드/매안/하이브/란티다/글린/아이타 등) + 점수사이트 RACE_COLORS
// 색상 페어(모행성 색)로 18개 전부 1:1 확정. 추측 아님.
const FACTION_KO: Record<string, string> = {
  terran: '테란', lantids: '란티다',
  hadsch_hallas: '하드쉬', ivits: '하이브',
  geodens: '기오덴', bal_tak: '발타크',
  xenos: '제노스', gleens: '글린',
  taklons: '타클론', ambas: '엠바스',
  bescods: '매안', firaks: '파이락',
  itars: '아이타', nevlas: '네블라',
  moweyip: '모웨이드', space_giants: '스자',
  tinkeroids: '팅커로이드', darkanians: '다카니안',
};

/**
 * 4인 전원 사람게임 종료 시 점수사이트(PythonAnywhere)에 자동 제출.
 * fire-and-forget: 점수사이트가 죽어도 게임엔 영향 없음(예외는 호출부에서 로그만).
 * SCORE_SITE_URL / SCORE_SITE_TOKEN 둘 다 있어야 동작(미설정이면 조용히 스킵).
 */
export async function submitToScoreSite(game: GaiaGameState & {
  id?: string;
  botPlayerIds?: string[];
  simulation?: boolean;
}) {
  if (game.simulation) return;
  const url = process.env.SCORE_SITE_URL;
  const token = process.env.SCORE_SITE_TOKEN;
  if (!url || !token) return; // 미설정이면 조용히 스킵

  const playerIds = Object.keys(game.players ?? {});
  const botIds = new Set(game.botPlayerIds ?? []);
  // 점수사이트는 정확히 4인 게임만 받는다. 봇이 하나라도 끼면 제출하지 않음.
  if (playerIds.length !== 4) return;
  if (playerIds.some(id => botIds.has(id))) return;

  const players = playerIds.map((id) => {
    const p = game.players[id]!;
    const bidding = (p as any).factionBidVp ?? 0;
    const finalScore = p.score ?? 0; // 이 시점 score엔 이미 비딩이 차감돼 있음(= 점수사이트 최종점수)
    const race = FACTION_KO[String(p.faction)];
    // 픽 순서(selectedTurnOrder) 우선, 없으면 종료 시점 turnOrder 인덱스로 대체.
    // 점수사이트 턴/픽 컬럼은 "N턴" 형식이어야 턴순 통계(int(x.replace('턴',''))) 에 집계됨.
    const seat = (p as any).selectedTurnOrder ?? ((game.turnOrder ?? playerIds).indexOf(id) + 1);
    return {
      name: p.name ?? '',
      race,
      bidding,
      start_turn: `${seat}턴`,
      end_score: finalScore + bidding, // 점수사이트: end_score − bidding = 최종점수(=finalScore)로 역산됨
    };
  });

  // 매핑 안 되는 종족이 하나라도 있으면 통계 오염 방지 위해 제출 취소
  const bad = players.find((pl) => !pl.race);
  if (bad) {
    log(`Score site submit skipped: unknown faction mapping (${JSON.stringify(playerIds.map(id => game.players[id]?.faction))})`, 'error', game.id);
    return;
  }

  const endpoint = url.replace(/\/+$/, '') + '/api/submit-game';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gaia-Token': token },
    body: JSON.stringify({ game_id: game.id, players }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Score site submit failed: ${res.status} ${body}`);
  }
  log(`Score submitted to score site: ${game.id}`, 'system', game.id);
}
