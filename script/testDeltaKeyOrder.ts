/**
 * 델타 전송: 새 최상위 키가 생겨도 판 전체가 아니라 델타로 가는지 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-10-05): "광산 지을 때 전체 상태 보내는 것도 고쳐 줘."
 *   서버는 델타를 적용한 결과가 실제 상태와 '글자까지' 같은지 비교해, 다르면 판 전체를 보냈다.
 *   광산을 지으면 queuedPowerOffers 같은 새 키가 생기는데, 델타를 적용하면 그 키가 맨 뒤에 붙어
 *   내용은 같고 순서만 달라도 불일치로 판정 → 매번 판 전체(약 50KB, 델타는 약 7KB)를 보냈다.
 *
 * 확인:
 *   ① 광산 짓기·리셋을 반복하는 동안 구독자(상대 플레이어)는 game_sync(판 전체) 없이 game_delta 만 받는다
 *   ② 받은 델타를 차례로 적용한 상태가 서버의 최신 전체 상태와 내용이 같다(키 순서 무시)
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testDeltaKeyOrder.ts
 *   (사람 메인 차례가 안 오거나 지을 칸이 없으면 exit 2 = 다시 실행)
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS, getDistance, HOME_PLANETS, getTerraformStepsForFaction } from '@shared/gameConfig';
import { applyGameStateDelta, GAME_SYNC_PROTOCOL } from '@shared/gameSync';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
let gameId = '', aId = '', bId = '', lastA: any = null, lastB: any = null, driving = true;
const placed = new Set<string>(); const picked = new Set<string>(); const incomeKey: Record<string, string> = {};
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>((res) => s.emit(ev, p, (r: T) => res(r)));
const sortKeys = (v: any): any => Array.isArray(v) ? v.map(sortKeys)
	: (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 150_000);

function drive(sock: Socket, me: string, g: any) {
	if (!driving || !g?.players) return;
	if (g.pendingIncomeOrder?.playerId === me) {
		const k = JSON.stringify(g.pendingIncomeOrder.incomeItems ?? []);
		if (incomeKey[me] !== k) { incomeKey[me] = k; sock.emit('select_all_income_items', { gameId }); setTimeout(() => sock.emit('finish_income_selection', { gameId }), 120); }
		return;
	}
	if (g.turnOrder?.[g.currentPlayerIndex] !== me) return;
	if (g.currentPhase === 'startingMines') {
		const home = FACTIONS.find((f: any) => f.id === g.players[me]?.faction)?.homePlanet;
		const t = (g.map || []).find((x: any) => !x.ownerId && x.type === home && !placed.has(x.id));
		if (t) { placed.add(t.id); sock.emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[me]?.faction }); }
	} else if (g.currentPhase === 'bonusSelection' && !picked.has(me)) {
		const t = (g.availableBonusTiles || [])[0];
		if (t) { picked.add(me); sock.emit('select_bonus_tile', { gameId, bonusTileId: t.id ?? t }); }
	}
}
A.on('game_updated', (g: any) => { lastA = g; drive(A, aId, g); });
B.on('game_updated', (g: any) => { lastB = g; drive(B, bId, g); });
setInterval(() => { if (lastA) drive(A, aId, lastA); if (lastB) drive(B, bId, lastB); }, 600);

A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 4000 });
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' }); gameId = r.gameId; aId = r.playerId;
	bId = (await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' })).playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });

	const isHumanTurn = () => lastA?.currentPhase === 'main' && [aId, bId].includes(lastA.turnOrder?.[lastA.currentPlayerIndex]) && !lastA.pendingIncomeOrder && !lastA.pendingTurnEndPlayerId;
	const t0 = Date.now(); while (!isHumanTurn() && Date.now() - t0 < 120_000) await sleep(200);
	if (!isHumanTurn()) { console.log('RETRY 사람 메인 차례가 오지 않았다'); process.exit(2); }
	driving = false;
	const curId = lastA.turnOrder[lastA.currentPlayerIndex];
	const [cur, sub] = curId === aId ? [A, B] : [B, A];
	const g = lastA; const me = g.players[curId];
	const mine = g.map.filter((t: any) => t.ownerId === curId && t.structure);
	const cands = g.map.filter((t: any) => !t.ownerId && HOME_PLANETS.includes(t.type) && mine.some((m: any) => getDistance(m, t) <= 1))
		.sort((a: any, b: any) => getTerraformStepsForFaction(g, me.faction, a.type) - getTerraformStepsForFaction(g, me.faction, b.type));

	// 상대(구독자)를 실제 화면처럼 델타 구독시킨다
	const syncRes: any = await emit(sub, 'sync_game', { gameId, protocol: GAME_SYNC_PROTOCOL });
	let state: any = syncRes.game; let revision = syncRes.revision;
	let fulls = 0, deltas = 0, deltaBytes = 0;
	sub.on('game_delta', (m: any) => { deltas++; deltaBytes += JSON.stringify(m).length; if (m.baseRevision === revision) { state = applyGameStateDelta(state, m.delta); revision = m.revision; } });
	sub.on('game_sync', (m: any) => { fulls++; state = m.game; revision = m.revision; });

	// 짓기·리셋이 서버에 실제로 반영됐는지는 행동한 쪽이 받는 전체 상태(game_updated)로 확인한다
	const curLast = () => (curId === aId ? lastA : lastB);
	const owned = (tileId: string) => curLast()?.map?.find((t: any) => t.id === tileId)?.ownerId === curId;
	const until = async (pred: () => boolean, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(20); } return false; };

	// 지을 수 있는 칸 찾기(거절되면 다음 칸)
	let target: any = null;
	for (const c of cands) {
		cur.emit('build_mine', { gameId, tileId: c.id });
		if (await until(() => owned(c.id), 1200)) { target = c; break; }
	}
	if (!target) { console.log('RETRY 지을 칸이 없다'); process.exit(2); }
	let steps = 1;
	cur.emit('reset_turn', { gameId }); if (await until(() => !owned(target.id))) steps++;
	for (let i = 0; i < 3; i++) {
		cur.emit('build_mine', { gameId, tileId: target.id }); if (await until(() => owned(target.id))) steps++;
		cur.emit('reset_turn', { gameId }); if (await until(() => !owned(target.id))) steps++;
	}
	cur.emit('build_mine', { gameId, tileId: target.id }); if (await until(() => owned(target.id))) steps++;
	await sleep(300);
	if (steps !== 9) { console.log(`RETRY 짓기·리셋 9단계 중 ${steps}단계만 반영됐다`); process.exit(2); }

	check(fulls === 0 && deltas >= 8, `① 광산 짓기·리셋 ${deltas}번 동안 판 전체 ${fulls}번 (델타 평균 ${deltas ? Math.round(deltaBytes / deltas) : 0}B)`);
	const fresh: any = await emit(sub, 'sync_game', { gameId, protocol: GAME_SYNC_PROTOCOL });
	// gameLogStart·gameLogLen 은 실시간 전송(로그 꼬리)에만 붙는 위치 정보 — 전체 동기화 응답엔 설계상 없다(gameSync.ts)
	for (const k of ['gameLogStart', 'gameLogLen']) { delete state[k]; delete fresh.game[k]; }
	const same = JSON.stringify(sortKeys(state)) === JSON.stringify(sortKeys(fresh.game));
	if (!same) {
		const keys = new Set([...Object.keys(state), ...Object.keys(fresh.game)]);
		const diff = [...keys].filter((k) => JSON.stringify(sortKeys(state[k])) !== JSON.stringify(sortKeys(fresh.game[k])));
		console.log('  다른 항목:', diff.map((k) => `${k}(${JSON.stringify(state[k])?.slice(0, 60)} vs ${JSON.stringify(fresh.game[k])?.slice(0, 60)})`).join(' | '));
	}
	check(same, `② 델타를 적용한 상태가 서버 최신 상태와 같다 (rev ${revision} / 서버 ${fresh.revision})`);

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	A.close(); B.close(); process.exit(bad === 0 ? 0 : 1);
});
