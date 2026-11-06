/**
 * [사용자 2026-11-06] 끝난 게임 리플레이용 기록 제공.
 *  GET /api/replay/list      — 이 서버의 data/human-games 에 있는 게임 목록(최근순)
 * 기록 재생 로직은 shared/replay.ts.
 *
 * 리플레이 관전 방: 'replay_open'으로 기록을 읽어 숨은 관전 전용 방을 만들고, 'replay_seek'으로 몇 번째 수를
 * 보일지 바꾼다. 방은 실제 게임 화면(Game.tsx)이 그대로 그리도록 매 수의 전체 게임 상태로 채운다.
 * 방엔 좌석(플레이어 소켓)이 없어 아무도 행동할 수 없고, 게임 목록·상태 집계·기록 저장에서 빠진다(game.replay).
 */
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { normalizeSupabaseProjectUrl, normalizeSupabaseTableName } from './humanGameLogger';
import { buildReplayFrames, buildReplayGameState, inferBoardSetup, type BoardSetup, type ReplayFrame, type ReplayPayload } from '@shared/replay';

const DATA_DIR = path.join(process.cwd(), 'data', 'human-games');
const GAME_ID_RE = /^[a-z0-9]{4,16}$/i;

function findLocalFile(gameId: string): string | null {
  if (!fs.existsSync(DATA_DIR)) return null;
  const f = fs.readdirSync(DATA_DIR).find(n => n.endsWith(`_${gameId}.json`));
  return f ? path.join(DATA_DIR, f) : null;
}

async function loadPayload(gameId: string): Promise<unknown | null> {
  const local = findLocalFile(gameId);
  if (local) return JSON.parse(fs.readFileSync(local, 'utf8'));
  return fetchFromSupabase(gameId);
}

async function fetchFromSupabase(gameId: string): Promise<unknown | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const table = normalizeSupabaseTableName(process.env.HUMAN_LOG_SUPABASE_TABLE || 'human_game_sessions');
  const endpoint = `${normalizeSupabaseProjectUrl(url)}/rest/v1/${table}?game_id=eq.${encodeURIComponent(gameId)}&select=payload&limit=1`;
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json() as Array<{ payload?: unknown }>;
  return rows[0]?.payload ?? null;
}

export function registerReplayRoutes(app: Express) {
  app.get('/api/replay/list', (_req, res) => {
    if (!fs.existsSync(DATA_DIR)) { res.json([]); return; }
    const files = fs.readdirSync(DATA_DIR).filter(n => n.endsWith('.json')).sort().reverse().slice(0, 200);
    const out = [];
    for (const f of files) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (!g.gameLog?.length) continue;
        const players = Object.values(g.players ?? {}) as Array<{ name: string; faction: string | null; score: number }>;
        out.push({
          gameId: g.gameId, completedAt: g.completedAt ?? f.slice(0, 10),
          players: players.sort((a, b) => b.score - a.score).map(p => ({ name: p.name, faction: p.faction, score: p.score })),
        });
      } catch { /* 깨진 파일은 건너뜀 */ }
    }
    res.json(out);
  });
}

type ReplayRoom = { payload: ReplayPayload; frames: ReplayFrame[]; setup: BoardSetup; lastUsed: number };
const replayRooms = new Map<string, ReplayRoom>();
const REPLAY_IDLE_MS = 2 * 60 * 60 * 1000; // 2시간 안 보면 방 정리

type ReplayDeps = {
  games: Map<string, any>;
  emitGameUpdated: (io: any, game: any) => void;
  generateGameId: () => string;
  carrySpectatorSession: (live: any, next: any) => void;
};

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function registerReplaySocket(io: any, socket: any, deps: ReplayDeps) {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      replayRooms.forEach((room, id) => {
        if (now - room.lastUsed > REPLAY_IDLE_MS) { replayRooms.delete(id); deps.games.delete(id); }
      });
    }, 10 * 60 * 1000);
    sweepTimer.unref?.();
  }

  const show = (roomId: string, index: number) => {
    const room = replayRooms.get(roomId);
    if (!room) return false;
    room.lastUsed = Date.now();
    const next = buildReplayGameState(room.payload, room.frames, index, room.setup, roomId);
    const live = deps.games.get(roomId);
    if (live) deps.carrySpectatorSession(live, next);
    deps.games.set(roomId, next);
    deps.emitGameUpdated(io, next);
    return true;
  };

  socket.on('replay_open', async ({ gameId }: { gameId: string }, cb?: (r: { roomId?: string; error?: string }) => void) => {
    if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) { cb?.({ error: '게임 ID가 올바르지 않습니다' }); return; }
    try {
      const payload = await loadPayload(gameId) as ReplayPayload | null;
      if (!payload?.gameLog?.length || !payload.map?.length) { cb?.({ error: '게임 기록을 찾지 못했습니다' }); return; }
      let roomId = deps.generateGameId();
      while (deps.games.has(roomId)) roomId = deps.generateGameId();
      replayRooms.set(roomId, { payload, frames: buildReplayFrames(payload), setup: inferBoardSetup(payload), lastUsed: Date.now() });
      show(roomId, 0);
      cb?.({ roomId });
    } catch (err) {
      cb?.({ error: String(err) });
    }
  });

  /** index: 그 수로 이동. roundStep(+1/-1)+from: from 기준 다음/이전 라운드 첫 수로 이동 */
  socket.on('replay_seek', ({ roomId, index, roundStep, from }: { roomId: string; index?: number; roundStep?: number; from?: number }, cb?: (r: { index: number }) => void) => {
    const room = typeof roomId === 'string' ? replayRooms.get(roomId) : undefined;
    if (!room) return;
    if (roundStep && Number.isFinite(from)) {
      const f = room.frames;
      const starts = f.map((x, i) => (i > 0 && x.round !== f[i - 1].round ? i : -1)).filter(i => i > 0);
      const target = roundStep > 0
        ? starts.find(i => i > from!) ?? f.length - 1
        : [...starts].reverse().find(i => i < from!) ?? 0;
      show(roomId, target);
      cb?.({ index: target });
      return;
    }
    if (Number.isFinite(index)) show(roomId, Math.floor(index!));
  });
}
