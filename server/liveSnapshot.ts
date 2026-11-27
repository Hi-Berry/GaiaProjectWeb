/**
 * [사용자 2026-11-28 "render 서버가 갑자기 재부팅" → 진행 중 게임 저장·복원]
 * Render 무료 서버는 예고 없이 재시작될 수 있고(문서: "Render might restart a Free web service at any time"),
 * 게임은 서버 메모리에만 있어 그때마다 진행 중인 판이 통째로 사라졌다(11/28 01:15 예비 3).
 * 서버 디스크도 재시작 때 지워지므로 서버 밖(Supabase 표 live_games)에 게임당 한 줄을 덮어써 둔다.
 *
 *   live_games(game_id text primary key, server_id text, saved_at timestamptz, state text)  — RLS 켬(서비스 키만 접근)
 *   state = gzip(JSON) → base64. Map/Set은 표식으로 감싸 되살린다. 타이머 같은 직렬화 불가 값은 버린다.
 *
 * 이 파일은 저장소 입출력과 인코딩만 맡는다. 무엇을 담고 어떻게 되살릴지는 gameState.ts(게임 밖 상태를 가진 쪽)가 정한다.
 * 켜짐: Supabase 키가 있고 운영 모드(NODE_ENV=production)일 때. LIVE_SNAPSHOT=on 이면 개발 모드에서도, off 면 항상 끔.
 */
import zlib from 'zlib';
import os from 'os';
import { log } from './index';

const TABLE = 'live_games';

export function liveSnapshotEnabled(): boolean {
	const flag = (process.env.LIVE_SNAPSHOT || '').toLowerCase();
	if (flag === 'off') return false;
	if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
	return flag === 'on' || process.env.NODE_ENV === 'production';
}

/** 이 서버의 이름 — 같은 표를 여러 서버(메인·예비 1~5)가 같이 쓰므로 자기 판만 되살린다.
 *  Render는 서비스마다 RENDER_SERVICE_ID를 자동으로 넣는다(재시작·재배포에도 그대로). 그 외는 호스트 이름+포트. */
export function liveServerId(): string {
	return process.env.LIVE_SNAPSHOT_SERVER_ID
		|| process.env.RENDER_SERVICE_ID
		|| `${os.hostname()}:${process.env.PORT || '5000'}`;
}

function restBase(): string {
	return `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${TABLE}`;
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
	const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY);
	return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
}

// ── 인코딩 ─────────────────────────────────────────────────────────────
function replacer(this: any, _k: string, v: any): any {
	if (v instanceof Map) return { __t: 'Map', v: Array.from(v.entries()) };
	if (v instanceof Set) return { __t: 'Set', v: Array.from(v.values()) };
	if (Buffer.isBuffer(v)) return { __t: 'Buf', v: v.toString('base64') };
	if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data) && this?.[_k] && Buffer.isBuffer(this[_k])) {
		return { __t: 'Buf', v: Buffer.from(v.data).toString('base64') }; // Buffer.toJSON 이 먼저 불린 경우
	}
	if (typeof v === 'function') return undefined;
	const ctor = v && typeof v === 'object' ? v.constructor?.name : '';
	if (ctor === 'Timeout' || ctor === 'Immediate' || ctor === 'Socket' || ctor === 'Server') return undefined; // 타이머·소켓은 버린다
	return v;
}
function reviver(_k: string, v: any): any {
	if (v && typeof v === 'object' && typeof v.__t === 'string') {
		if (v.__t === 'Map') return new Map(v.v);
		if (v.__t === 'Set') return new Set(v.v);
		if (v.__t === 'Buf') return Buffer.from(v.v, 'base64');
	}
	return v;
}
export function encodeSnapshot(obj: unknown): string {
	return zlib.gzipSync(Buffer.from(JSON.stringify(obj, replacer), 'utf8'), { level: 6 }).toString('base64');
}
export function decodeSnapshot<T = any>(state: string): T {
	return JSON.parse(zlib.gunzipSync(Buffer.from(state, 'base64')).toString('utf8'), reviver) as T;
}

// ── 저장소 입출력 ──────────────────────────────────────────────────────
export async function upsertLiveGame(gameId: string, state: string): Promise<void> {
	const res = await fetch(`${restBase()}?on_conflict=game_id`, {
		method: 'POST',
		headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
		body: JSON.stringify({ game_id: gameId, server_id: liveServerId(), saved_at: new Date().toISOString(), state }),
	});
	if (!res.ok) throw new Error(`live_games upsert ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export async function deleteLiveGame(gameId: string): Promise<void> {
	const res = await fetch(`${restBase()}?game_id=eq.${encodeURIComponent(gameId)}`, { method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }) });
	if (!res.ok) throw new Error(`live_games delete ${res.status}`);
}

export type LiveRow = { game_id: string; saved_at: string; state: string };

/** 이 서버의 판 한 개(재접속 요청이 온 게임) — 없으면 null */
export async function fetchLiveGame(gameId: string): Promise<LiveRow | null> {
	const url = `${restBase()}?game_id=eq.${encodeURIComponent(gameId)}&server_id=eq.${encodeURIComponent(liveServerId())}&select=game_id,saved_at,state`;
	const res = await fetch(url, { headers: headers() });
	if (!res.ok) throw new Error(`live_games select ${res.status}`);
	const rows = (await res.json()) as LiveRow[];
	return rows[0] ?? null;
}

/** 이 서버의 판 전부 */
export async function fetchLiveGamesForServer(): Promise<LiveRow[]> {
	const url = `${restBase()}?server_id=eq.${encodeURIComponent(liveServerId())}&select=game_id,saved_at,state`;
	const res = await fetch(url, { headers: headers() });
	if (!res.ok) throw new Error(`live_games select ${res.status}`);
	return (await res.json()) as LiveRow[];
}

export function logLive(msg: string, level: 'system' | 'error' = 'system', gameId?: string) {
	log(`[LIVE-SNAPSHOT] ${msg}`, level, gameId);
}
