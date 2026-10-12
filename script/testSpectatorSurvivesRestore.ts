/**
 * 리셋·프리액션 되돌리기·롤백 뒤에도 관전자가 남는지 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-10-11): "운영자 아이디(하이)로 모바일 관전하면 예상 점수가 뜨다가 시간이 좀 지나면 안 보인다."
 *   관전자 명단·이름·접속 목록이 게임 객체에 있어, 되돌리기가 '턴 시작 때 찍어 둔 판'으로 바꿔 끼우면
 *   그 턴이 시작된 뒤 들어온 관전자가 통째로 사라졌다. 이름이 없으니 예상 점수가 숨고, 관전자 목록에서 빠지고,
 *   채팅 금지가 '이 방의 관전자가 아닙니다'로 거부됐다.
 *
 * 사람 1 + 봇 3. 내 메인 차례가 시작된 '뒤에' 관전자 '하이'가 들어온다.
 *   ① 광산 → Reset 뒤에도 이름·허용 명단·접속 목록 유지
 *   ② Reset 뒤 플레이어가 그 관전자를 채팅 금지할 수 있다
 *   ③ 프리액션(1O→1C) → 되돌리기 뒤에도 유지
 *   ④ 롤백(다른 사람 없음 → 즉시 실행) 뒤에도 유지
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testSpectatorSurvivesRestore.ts   (exit 2 = 다시 실행)
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS, getDistance, HOME_PLANETS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const S = io(URL, { transports: ['websocket'] });
const call = (s: Socket, ev: string, p: any) => new Promise<any>((res) => s.emit(ev, p, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 180_000);
let gameId = '', me = '', sid = '';
const get = async () => (await call(A, 'get_game', { gameId })).game;
const present = (g: any) => g.spectatorNames?.[sid] === '하이' && !!g.spectatorIds?.includes(sid) && !!(g.connectedSpectators ?? []).includes(sid);
const describe = (g: any) => `이름 ${JSON.stringify(g.spectatorNames?.[sid] ?? null)} · 허용 명단 ${!!g.spectatorIds?.includes(sid)} · 접속 목록 ${!!(g.connectedSpectators ?? []).includes(sid)}`;

A.on('connect', async () => {
	await call(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await call(A, 'admin_set_bot_delay_ms', { delayMs: 150 });
	const c = await call(A, 'create_game', { playerName: 'Host' }); gameId = c.gameId; me = c.playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });
	let g: any = null;
	for (let i = 0; i < 300; i++) {
		g = await get();
		if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me && !g.pendingIncomeOrder) break;
		if (g.turnOrder?.[g.currentPlayerIndex] === me) {
			if (g.currentPhase === 'startingMines') {
				const home = FACTIONS.find((f: any) => f.id === g.players[me].faction)?.homePlanet;
				const t = g.map.find((x: any) => !x.ownerId && x.type === home);
				if (t) A.emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[me].faction });
			} else if (g.currentPhase === 'bonusSelection') {
				const b = g.availableBonusTiles?.[0]; if (b) A.emit('select_bonus_tile', { gameId, bonusTileId: b.id ?? b });
			}
		}
		await sleep(300);
	}
	if (!(g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me)) { console.log('RETRY 내 차례가 안 왔다'); process.exit(2); }
	await call(A, 'admin_set_bot_delay_ms', { delayMs: 60_000 });

	// 내 턴이 시작된 '뒤에' 관전자 입장
	sid = (await call(S, 'watch_game', { gameId, name: '하이' })).spectatorId;
	await sleep(300);
	check(present(await get()), `관전 입장 직후: ${describe(await get())}`);

	// ① 광산 → Reset
	g = await get();
	const mine = g.map.filter((t: any) => t.ownerId === me && t.structure);
	const cands = g.map.filter((t: any) => !t.ownerId && HOME_PLANETS.includes(t.type) && mine.some((m: any) => getDistance(m, t) <= 1));
	let built = false;
	for (const t of cands) { A.emit('build_mine', { gameId, tileId: t.id }); await sleep(500); g = await get(); if (g.map.find((x: any) => x.id === t.id)?.ownerId === me) { built = true; break; } }
	if (!built) { console.log('RETRY 지을 칸이 없다'); process.exit(2); }
	A.emit('reset_turn', { gameId }); await sleep(600);
	g = await get();
	check(!g.hasDoneMainAction && present(g), `① 광산 → Reset 뒤: ${describe(g)}`);

	// ② Reset 뒤 채팅 금지
	const blk = await call(A, 'set_spectator_chat_block', { gameId, spectatorId: sid, blocked: true });
	check(!!blk?.ok, `② Reset 뒤 그 관전자를 채팅 금지할 수 있다 (${JSON.stringify(blk)})`);
	await call(A, 'set_spectator_chat_block', { gameId, spectatorId: sid, blocked: false });

	// ③ 프리액션 → 되돌리기
	const ore = g.players[me].ore;
	A.emit('convert_resource', { gameId, type: '1ore-to-1credit' }); await sleep(500);
	g = await get();
	const converted = g.players[me].ore === ore - 1;
	A.emit('undo_free_action', { gameId, steps: 1 }); await sleep(600);
	g = await get();
	check(converted && g.players[me].ore === ore && present(g), `③ 프리액션(1O→1C) → 되돌리기 뒤: ${describe(g)} (광석 ${ore}→${converted ? ore - 1 : '?'}→${g.players[me].ore})`);

	// ④ 롤백 — 내 턴 시작 이전의 줄로
	const live = (g.gameLog || []).filter((e: any) => !e.rolledBack && typeof e.seq === 'number');
	const target = live[Math.max(0, live.length - 3)];
	const rb = await call(A, 'request_rollback', { gameId, seq: target.seq, reason: { code: 'otherAction' } });
	if (rb?.error) { console.log('RETRY 롤백 거부:', rb.error); process.exit(2); }
	await sleep(800);
	g = await get();
	check(present(g), `④ 롤백 뒤: ${describe(g)}`);

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	process.exit(bad === 0 ? 0 : 1);
});
