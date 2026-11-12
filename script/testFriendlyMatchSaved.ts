/**
 * 친선전 여부가 게임 기록 파일에 저장되는지 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-11-12): "친선전 여부 저장하고 통계에서 빼 줘."
 *   ① 친선전으로 연 사람 4인 판 → 저장 파일에 friendlyMatch: true
 *   ② 일반 판 → friendlyMatch 키 없음
 *   ③ 통계 사이트 loadGames 가 ①을 빼고 ②는 넣는다
 * 테스트로 생긴 저장 파일은 끝나면 지운다(통계 오염 방지).
 *
 * 사용: 서버를 5050에 띄운 뒤(로컬 저장 모드) npx tsx script/testFriendlyMatchSaved.ts   (exit 2 = 다시 실행)
 */
import fs from 'fs';
import path from 'path';
import { io, type Socket } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';
// @ts-ignore — .mjs
import { loadGames, DATA_DIR } from '../stats-site/lib/common.mjs';

const URL = process.env.URL ?? 'http://localhost:5050';
const call = (s: Socket, ev: string, p: any) => new Promise<any>((res) => s.emit(ev, p, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const made: string[] = [];
const cleanup = () => { for (const f of made) try { fs.rmSync(f); } catch { /* 없음 */ } };
setTimeout(() => { console.log('RETRY 시간 초과'); cleanup(); process.exit(2); }, 240_000);

async function playOne(friendly: boolean): Promise<string | null> {
	const ss = [0, 1, 2, 3].map(() => io(URL, { transports: ['websocket'] }));
	await Promise.all(ss.map((s) => new Promise((r) => s.on('connect', r as any))));
	const c = await call(ss[0], 'create_game', { playerName: '친' });
	const gameId = c.gameId; const ids = [c.playerId];
	for (const [i, nm] of ['선', '테', '스'].entries()) ids.push((await call(ss[i + 1], 'join_game', { gameId, playerName: nm })).playerId);
	if (friendly) { const r = await call(ss[0], 'set_friendly_match', { gameId, friendlyMatch: true }); if (!r?.ok) { console.log('친선전 설정 실패', r); return null; } }
	ss[0].emit('auto_setup_test', { gameId, selfPlay: false });
	for (let i = 0; i < 400; i++) {
		const g = (await call(ss[0], 'get_game', { gameId })).game;
		if (g.currentPhase === 'main' && !g.pendingIncomeOrder) break;
		const cur = g.turnOrder?.[g.currentPlayerIndex]; const k = ids.indexOf(cur);
		if (k >= 0 && g.currentPhase === 'startingMines') {
			const home = FACTIONS.find((f: any) => f.id === g.players[cur].faction)?.homePlanet;
			const t = g.map.find((x: any) => !x.ownerId && x.type === home);
			if (t) ss[k].emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[cur].faction });
		} else if (k >= 0 && g.currentPhase === 'bonusSelection') {
			const b = g.availableBonusTiles?.[0]; if (b) ss[k].emit('select_bonus_tile', { gameId, bonusTileId: b.id ?? b });
		}
		for (const [j, pid] of ids.entries()) if (g.pendingIncomeOrder?.playerId === pid) { ss[j].emit('select_all_income_items', { gameId }); await sleep(80); ss[j].emit('finish_income_selection', { gameId }); }
		await sleep(300);
	}
	await call(ss[0], 'admin_force_end_game', { gameId, adminCode: '0011' });
	for (let i = 0; i < 30; i++) {
		const f = fs.readdirSync(DATA_DIR).find((x: string) => x.endsWith(`_${gameId}.json`));
		if (f) { const full = path.join(DATA_DIR, f); made.push(full); ss.forEach((s) => s.close()); return full; }
		await sleep(300);
	}
	ss.forEach((s) => s.close());
	return null;
}

(async () => {
	const fFriendly = await playOne(true);
	const fNormal = await playOne(false);
	if (!fFriendly || !fNormal) { console.log('RETRY 저장 파일이 안 생김(로컬 저장 모드인지 확인)'); cleanup(); process.exit(2); }
	const a = JSON.parse(fs.readFileSync(fFriendly, 'utf8')); const b = JSON.parse(fs.readFileSync(fNormal, 'utf8'));
	check(a.friendlyMatch === true, `① 친선전 판 저장 파일: friendlyMatch=${a.friendlyMatch}`);
	check(!('friendlyMatch' in b), `② 일반 판 저장 파일: friendlyMatch 키 ${'friendlyMatch' in b ? '있음' : '없음'}`);
	const files = new Set(loadGames().map((x: any) => x.file));
	check(!files.has(path.basename(fFriendly)) && files.has(path.basename(fNormal)), `③ 통계 로더: 친선전 ${files.has(path.basename(fFriendly)) ? '포함' : '제외'} · 일반 ${files.has(path.basename(fNormal)) ? '포함' : '제외'}`);
	cleanup();
	console.log(bad === 0 ? '\n전부 통과 (테스트 저장 파일 삭제함)' : `\n${bad}건 실패`);
	process.exit(bad === 0 ? 0 : 1);
})();
