/**
 * 사람 게임 기록 압축 저장(payload_gz) 테스트 — 가짜 Supabase(PostgREST 흉내) 서버로 확인한다. 실제 Supabase는 건드리지 않는다.
 * 사용자 요청(2026-11-28): Supabase 무료 DB 0.5GB 초과 → 기록을 gzip 압축본으로 저장.
 *  ① 표에 payload_gz 칸이 있을 때: 압축본만 저장(payload 비움), 풀면 원본과 같음
 *  ② 칸이 없을 때(PGRST204): 예전처럼 jsonb payload로 다시 보냄
 *  ③ 읽기(decodeHumanSessionRow): 압축본·예전 줄 둘 다
 *  ④ scripts/fetchSupabaseGames.mjs 가 두 형식을 받아 같은 파일로 저장
 * 사용: PORT=5393 npx tsx script/testSupabaseCompressedLogs.ts
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { uploadToSupabase, decodeHumanSessionRow } from '../server/humanGameLogger';

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const rows = new Map<string, any>();
let hasGzColumn = true;
const srv = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => body += c);
	req.on('end', () => {
		const u = new URL(req.url!, 'http://x');
		if (req.method === 'POST') {
			const row = JSON.parse(body);
			if (!hasGzColumn && 'payload_gz' in row) { res.writeHead(400); res.end(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'payload_gz' column of 'human_game_sessions' in the schema cache" })); return; }
			if (row.payload === null && !hasGzColumn) { res.writeHead(400); res.end('null value in column "payload"'); return; }
			rows.set(row.game_id, row); res.writeHead(201); res.end(); return;
		}
		const id = u.searchParams.get('game_id')?.replace(/^eq\./, '');
		const list = id ? [rows.get(id)].filter(Boolean) : [...rows.values()].map(r => ({ game_id: r.game_id, completed_at: r.completed_at }));
		res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(list));
	});
});

const fake = (id: string): any => ({ gameId: id, completedAt: '2026-11-28T00:00:00.000Z', players: { a: { name: '가', score: 150 } }, gameLog: Array.from({ length: 300 }, (_, i) => ({ action: '광산 건설', i })), actionJournal: Array.from({ length: 800 }, (_, i) => ({ type: 'build_mine', hex: i % 37, note: '반복 많은 기록' })) });

srv.listen(0, async () => {
	const port = (srv.address() as any).port;
	process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

	const a = fake('gzrow001');
	await uploadToSupabase(a);
	const ra = rows.get('gzrow001');
	check(ra?.payload === null && typeof ra?.payload_gz === 'string', '① 칸 있음 → 압축본만 저장, payload 비움');
	check(JSON.stringify(decodeHumanSessionRow(ra)) === JSON.stringify(a), '① 압축본을 풀면 원본과 같음');
	console.log(`     크기: 원본 ${JSON.stringify(a).length}B → 압축본 ${ra.payload_gz.length}B`);

	hasGzColumn = false;
	const b = fake('oldrow01');
	await uploadToSupabase(b);
	const rb = rows.get('oldrow01');
	check(!!rb?.payload && !('payload_gz' in rb), '② 칸 없음 → 예전처럼 jsonb payload로 저장');
	check(JSON.stringify(decodeHumanSessionRow(rb)) === JSON.stringify(b), '③ 예전 줄도 그대로 읽힘');
	check(decodeHumanSessionRow(undefined) === null && decodeHumanSessionRow({ payload: null, payload_gz: null }) === null, '③ 빈 줄은 null');

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gzlogs-'));
	await promisify(execFile)(process.execPath, [path.resolve('scripts/fetchSupabaseGames.mjs')], { cwd: tmp, env: { ...process.env } }); // 비동기 — 가짜 서버가 같은 프로세스에서 응답해야 함
	const out = path.join(tmp, 'data', 'human-games');
	const fa = fs.readdirSync(out).find(f => f.includes('gzrow001')), fb = fs.readdirSync(out).find(f => f.includes('oldrow01'));
	check(!!fa && JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, fa!), 'utf8'))) === JSON.stringify(a), '④ 받기 스크립트: 압축본 → 원본 파일');
	check(!!fb && JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, fb!), 'utf8'))) === JSON.stringify(b), '④ 받기 스크립트: 예전 줄 → 원본 파일');
	fs.rmSync(tmp, { recursive: true, force: true });

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	setTimeout(() => process.exit(bad === 0 ? 0 : 1), 50);
});
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 60000);
