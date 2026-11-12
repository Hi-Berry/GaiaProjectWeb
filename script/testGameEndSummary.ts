/**
 * 종료 화면 요약(사용 시간 · 롤백 · 뱃지) — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-11-12): "종료 화면에 이번 게임 사용한 시간 및 롤백도 요약 화면에 띄워 주고,
 *   누군가 뱃지를 획득하면 제일 위에 '축하합니다. 무슨 뱃지를 획득하셨습니다'로 표시해 줘."
 *
 * 사람 4명(봇 없음) → 시작 배치·보너스까지 진행 → 1라운드에서 각자 몇 초씩 생각한 뒤 패스 대신 관리자 강제 종료.
 *   ① gameEndSummary 가 생기고 시작 ≤ 종료, 4명 모두 사용 시간 > 0, 합이 총 시간을 넘지 않는다
 *   ② 롤백 집계가 4명 키로 실린다(이 판은 0회)
 *   ③ 뱃지: 사람 4인 판이라 판정이 돈다 — 강제 종료 직후 아무도 우주선에 안 들어갔으니 1위에게 '우주선 안 들어가고 승리'가 있다
 *   ④ 봇이 낀 판(사람 1 + 봇 3)은 뱃지를 싣지 않는다(기록 사이트 제출 조건과 같음)
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testGameEndSummary.ts   (exit 2 = 다시 실행)
 */
import { io, type Socket } from 'socket.io-client';
import fs from 'fs';
import path from 'path';
import { FACTIONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const socks = [0, 1, 2, 3].map(() => io(URL, { transports: ['websocket'] }));
const call = (s: Socket, ev: string, p: any) => new Promise<any>((res) => s.emit(ev, p, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 180_000);

async function driveSetup(gameId: string, ids: string[], ss: Socket[]) {
	const get = async () => (await call(ss[0], 'get_game', { gameId })).game;
	for (let i = 0; i < 400; i++) {
		const g = await get();
		if (g.currentPhase === 'main' && !g.pendingIncomeOrder) return g;
		const cur = g.turnOrder?.[g.currentPlayerIndex];
		const k = ids.indexOf(cur);
		if (k >= 0) {
			if (g.currentPhase === 'startingMines') {
				const home = FACTIONS.find((f: any) => f.id === g.players[cur].faction)?.homePlanet;
				const t = g.map.find((x: any) => !x.ownerId && x.type === home);
				if (t) ss[k].emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[cur].faction });
			} else if (g.currentPhase === 'bonusSelection') {
				const b = g.availableBonusTiles?.[0]; if (b) ss[k].emit('select_bonus_tile', { gameId, bonusTileId: b.id ?? b });
			}
		}
		for (const [j, pid] of ids.entries()) if (g.pendingIncomeOrder?.playerId === pid) { ss[j].emit('select_all_income_items', { gameId }); await sleep(80); ss[j].emit('finish_income_selection', { gameId }); }
		await sleep(300);
	}
	return null;
}

socks[0].on('connect', async () => {
	await call(socks[0], 'admin_set_mcts_time_ms', { timeMs: 50 });
	await call(socks[0], 'admin_set_bot_delay_ms', { delayMs: 150 });

	// ── 사람 4명 ──
	const c = await call(socks[0], 'create_game', { playerName: '가' });
	const gameId = c.gameId; const ids = [c.playerId];
	for (const [i, nm] of ['나', '다', '라'].entries()) ids.push((await call(socks[i + 1], 'join_game', { gameId, playerName: nm })).playerId);
	socks[0].emit('auto_setup_test', { gameId, selfPlay: false });
	let g = await driveSetup(gameId, ids, socks);
	if (!g) { console.log('RETRY 메인 단계까지 못 감'); process.exit(2); }
	if ((g.botPlayerIds ?? []).length) { console.log('RETRY 봇이 끼었다', g.botPlayerIds); process.exit(2); }
	await sleep(2500); // 첫 차례 사람이 '생각하는' 시간
	await call(socks[0], 'admin_force_end_game', { gameId, adminCode: '0011' });
	await sleep(600);
	g = (await call(socks[0], 'get_game', { gameId })).game;
	const s = g.gameEndSummary;
	const total = s ? s.endedAt - s.startedAt : 0;
	const sum = s ? Object.values(s.playerTimeMs as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
	const times = s ? ids.map((id) => `${g.players[id].name} ${(s.playerTimeMs[id] / 1000).toFixed(1)}s`).join(' · ') : '';
	check(g.currentPhase === 'gameEnd' && !!s && s.startedAt <= s.endedAt && ids.every((id) => (s.playerTimeMs?.[id] ?? 0) > 0) && sum <= total + 1,
		`① 요약 생성 · 총 ${(total / 1000).toFixed(1)}s · 사람별 ${times} (합 ${(sum / 1000).toFixed(1)}s)`);
	check(!!s && ids.every((id) => (s.rollbacks?.[id] ?? 0) === 0 || id in s.rollbacks) && s.adminRollbacks === 0,
		`② 롤백 집계: ${JSON.stringify(s?.rollbacks)} · GM ${s?.adminRollbacks}`);
	const top = Math.max(...ids.map((id) => g.players[id].score ?? 0));
	const winners = ids.filter((id) => (g.players[id].score ?? 0) === top).map((id) => g.players[id].name);
	const noShip = (s?.badges ?? []).filter((b: any) => b.badgeId === 'no-ship-win');
	check(noShip.length > 0 && noShip.every((b: any) => winners.includes(b.playerName) && ids.includes(b.playerId)),
		`③ 뱃지: ${(s?.badges ?? []).map((b: any) => `${b.playerName}「${b.badgeName}」`).join(', ') || '(없음)'} (1위 ${winners.join(',')})`);

	// ── 사람 1 + 봇 3 ──
	const solo = io(URL, { transports: ['websocket'] });
	await new Promise((r) => solo.on('connect', r as any));
	const c2 = await call(solo, 'create_game', { playerName: 'Solo' });
	solo.emit('auto_setup_test', { gameId: c2.gameId, selfPlay: false });
	const g2a = await driveSetup(c2.gameId, [c2.playerId], [solo]);
	if (!g2a) { console.log('RETRY 봇 판이 메인까지 못 감'); process.exit(2); }
	await call(solo, 'admin_force_end_game', { gameId: c2.gameId, adminCode: '0011' });
	await sleep(600);
	const g2 = (await call(solo, 'get_game', { gameId: c2.gameId })).game;
	check(!!g2.gameEndSummary && (g2.gameEndSummary.badges ?? []).length === 0, `④ 봇이 낀 판: 요약 ${!!g2.gameEndSummary} · 뱃지 ${(g2.gameEndSummary?.badges ?? []).length}개`);

	// 테스트 판 저장 파일은 지운다 — 로컬 서버는 data/human-games 에 저장해 통계에 '가나다라'가 섞인다
	await sleep(800);
	const dir = path.join(process.cwd(), 'data', 'human-games');
	for (const f of fs.readdirSync(dir)) if (f.endsWith(`_${gameId}.json`) || f.endsWith(`_${c2.gameId}.json`)) fs.rmSync(path.join(dir, f));
	console.log(`\nGAME ${gameId}`);
	console.log(bad === 0 ? '전부 통과' : `${bad}건 실패`);
	process.exit(bad === 0 ? 0 : 1);
});
