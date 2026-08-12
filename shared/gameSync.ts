/**
 * Socket.IO 게임 상태 동기화 프로토콜.
 *
 * 서버는 전체 상태를 기준으로 델타를 만들고, 클라이언트는 revision이 연속일 때만 적용한다.
 * revision이 어긋나거나 적용에 실패하면 sync_game으로 전체 상태를 다시 받아 복구한다.
 */
export const GAME_SYNC_PROTOCOL = 1;
export const GAME_LOG_TAIL_SIZE = 40;

export interface GameStateDelta {
  set?: Record<string, unknown>;
  remove?: string[];
  map?: {
    replace?: unknown[];
    updates?: Array<{ index: number; value: unknown }>;
  };
  players?: {
    set?: Record<string, unknown>;
    remove?: string[];
  };
}

export interface GameDeltaMessage {
  gameId: string;
  baseRevision: number;
  revision: number;
  delta: GameStateDelta;
}

export interface GameSyncMessage {
  gameId: string;
  revision: number;
  game: Record<string, unknown>;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 클라이언트에 공개할 JSON 상태를 만든다.
 * - 서버 전용 non-enumerable 필드는 JSON 왕복에서 자동 제외된다.
 * - Undo 스냅샷 본문은 클라이언트가 개수만 사용하므로 빈 문자열 배열로 경량화한다.
 * - broadcast=true면 gameLog 꼬리만 보내고, false면 입장/복구용 전체 로그를 보낸다.
 */
export function buildClientGameState(
  game: unknown,
  broadcast: boolean,
): Record<string, unknown> {
  const out = jsonClone((game ?? {}) as Record<string, unknown>);
  const undo = out.freeActionUndoStack;
  if (Array.isArray(undo)) {
    out.freeActionUndoStack = Array(undo.length).fill("");
  }

  const logs = Array.isArray(out.gameLog) ? out.gameLog : [];
  if (broadcast) {
    const start = Math.max(0, logs.length - GAME_LOG_TAIL_SIZE);
    out.gameLog = start > 0 ? logs.slice(start) : logs;
    out.gameLogStart = start;
    out.gameLogLen = logs.length;
  } else {
    delete out.gameLogStart;
    delete out.gameLogLen;
  }
  return out;
}

/** JSON으로 전달된 델타를 불변 방식으로 적용한다. */
export function applyGameStateDelta(
  base: Record<string, unknown>,
  delta: GameStateDelta,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };

  if (delta.set) {
    for (const [key, value] of Object.entries(delta.set)) next[key] = value;
  }
  if (delta.remove) {
    for (const key of delta.remove) delete next[key];
  }

  if (delta.map?.replace) {
    next.map = delta.map.replace;
  } else if (delta.map?.updates?.length) {
    if (!Array.isArray(next.map)) throw new Error("delta map base missing");
    const map = [...next.map];
    for (const { index, value } of delta.map.updates) {
      if (!Number.isInteger(index) || index < 0 || index >= map.length) {
        throw new Error(`delta map index out of range: ${index}`);
      }
      map[index] = value;
    }
    next.map = map;
  }

  if (delta.players) {
    const current = next.players;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("delta players base missing");
    }
    const players = { ...(current as Record<string, unknown>) };
    if (delta.players.set) {
      for (const [id, value] of Object.entries(delta.players.set)) players[id] = value;
    }
    if (delta.players.remove) {
      for (const id of delta.players.remove) delete players[id];
    }
    next.players = players;
  }

  return next;
}
