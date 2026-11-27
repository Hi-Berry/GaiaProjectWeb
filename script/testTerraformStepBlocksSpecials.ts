/**
 * 삽(테라포밍 스텝) 대기 중 다른 메인 액션 차단 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-11-23): "삽 액션 누르고 광산 안 짓고 모웨이드 링 누르기 액션도 눌러지는 거 같은데?"
 *   보너스 타일 삽·스페이스 자이언트 2TF·팅커 삽은 hasDoneMainAction을 세우지 않는다(광산을 이어 짓는 창).
 *   그 창에서 막는 가드가 파워/특수/보너스 액션에만 있어, 전용 경로(링 놓기·엠바스 교체·매안 트랙·파이락·
 *   하이브 정거장·기술 액션·우주선 액션·인공물·업그레이드·연구)가 뚫려 있었다. 이제 terraformStepsBlockAction 하나로 막는다.
 *
 * 판을 '보너스 삽 타일을 든 사람 차례'로 만들어 보너스 삽을 쓴 뒤, 같은 가드를 타는 입구들을 눌러 본다.
 * (종족 전용 입구는 그 종족이 아니면 가드 앞에서 조용히 무시될 수 있어, 종족과 무관한 입구로 가드 자체를 확인한다.)
 *
 * 사용: 서버를 띄운 뒤 URL=http://localhost:포트 npx tsx script/testTerraformStepBlocksSpecials.ts
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
const TILE = 'bon-2c-terraform';
const MSG = '테라포밍 스텝 사용 중입니다. 광산 건설만 가능합니다.';
let gameId = '', aId = '', bId = '';
let lastA: any = null, driving = true;
const passedR = new Set<string>(); const placed = new Set<string>(); const picked = new Set<string>(); const incomeKey: Record<string, string> = {};
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>((res) => s.emit(ev, p, (r: T) => res(r)));
const finish = () => { console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); A.close(); B.close(); process.exit(bad === 0 ? 0 : 1); };
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
	} else if (g.currentPhase === 'main' && g.players[me]?.bonusTile !== TILE && !passedR.has(`${me}:${g.roundNumber}`)
		&& [aId, bId].some(id => g.players[id]?.bonusTile === TILE) && !g.pendingTurnEndPlayerId) {
		// 삽 타일이 없는 사람은 바로 패스해 차례를 넘긴다(메인 차례에서 멈추지 않게)
		const t = (g.availableBonusTiles || [])[0];
		if (t) { passedR.add(`${me}:${g.roundNumber}`); sock.emit('pass_round', { gameId, newBonusTileId: t.id ?? t }); }
	} else if (g.currentPhase === 'bonusSelection' && !picked.has(me)) {
		// 삽 보너스 타일을 우선 집는다
		const tiles = g.availableBonusTiles || [];
		const t = tiles.find((x: any) => (x.id ?? x) === TILE) ?? tiles[0];
		if (t) { picked.add(me); sock.emit('select_bonus_tile', { gameId, bonusTileId: t.id ?? t }); }
	}
}
A.on('game_updated', (g: any) => { lastA = g; drive(A, aId, g); });
B.on('game_updated', (g: any) => { drive(B, bId, g); });
setInterval(() => { if (lastA) { drive(A, aId, lastA); drive(B, bId, lastA); } }, 600);

const nextError = (s: Socket, ms = 700) => new Promise<string | null>((res) => {
	const on = (e: any) => { clearTimeout(t); res(e?.message ?? String(e)); };
	const t = setTimeout(() => { s.off('game_error', on); res(null); }, ms);
	s.once('game_error', on);
});

A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 4000 });
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' }); gameId = r.gameId; aId = r.playerId;
	bId = (await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' })).playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });

	// 삽 타일을 든 사람(알파·베타)의 메인 차례를 기다린다
	const holder = () => [aId, bId].find(id => lastA?.players?.[id]?.bonusTile === TILE);
	const ready = () => lastA?.currentPhase === 'main' && holder() && lastA.turnOrder?.[lastA.currentPlayerIndex] === holder() && !lastA.pendingIncomeOrder && !lastA.pendingTurnEndPlayerId && !lastA.hasDoneMainAction;
	const t0 = Date.now(); while (!ready() && Date.now() - t0 < 120_000) {
		if (lastA?.currentPhase === 'main' && !holder()) { console.log('RETRY 이번 판엔 삽 보너스 타일이 없다'); process.exit(2); }
		if (process.env.DEBUG && Date.now() % 3000 < 220) console.log('wait', lastA?.currentPhase, lastA?.roundNumber, lastA?.turnOrder?.[lastA?.currentPlayerIndex], [aId, bId].map(id => lastA?.players?.[id]?.bonusTile), lastA?.hasDoneMainAction, !!lastA?.pendingIncomeOrder, lastA?.pendingTurnEndPlayerId);
		await sleep(200);
	}
	if (!ready()) { console.log('RETRY 삽 타일을 든 사람 차례가 오지 않았다'); process.exit(2); }
	driving = false;
	const me = holder()!;
	const cur = me === aId ? A : B;
	console.log(`차례: ${me === aId ? 'Alpha' : 'Beta'} (${lastA.players[me].faction})`);

	cur.emit('use_bonus_action', { gameId });
	await sleep(700);
	check((lastA.players[me].pendingTerraformSteps ?? 0) === 1 && !lastA.hasDoneMainAction, '보너스 삽 사용 → 스텝 1 보유, 메인 액션은 아직 안 씀');

	const myMine = (lastA.map || []).find((t: any) => t.ownerId === me && t.structure === 'mine');
	const tries: Array<[string, any]> = [
		['upgrade_structure', { gameId, tileId: myMine?.id, target: 'trading_station' }],
		['advance_tech', { gameId, trackId: 'economy' }],
		['use_tech_action', { gameId, tileId: 'tech-act-4p' }],
		['use_ship_action', { gameId, shipTileId: 'none', actionIndex: 0 }],
		['take_twilight_artifact', { gameId, artifactId: 'none' }],
		['place_ivits_space_station', { gameId, tileId: 'none' }],
		['firaks_downgrade', { gameId, tileId: 'none', trackId: 'economy' }],
	];
	for (const [ev, p] of tries) {
		const err = nextError(cur); cur.emit(ev, p);
		const m = await err;
		check(m === MSG, `${ev} → "${m}"`);
	}
	check((lastA.players[me].pendingTerraformSteps ?? 0) === 1 && !lastA.hasDoneMainAction, '막힌 뒤에도 스텝 1·메인 액션 미사용 그대로');
	finish();
});
