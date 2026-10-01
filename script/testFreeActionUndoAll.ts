/**
 * 프리액션 번(2그릇 2개 → 3그릇 1개)과 Undo / Undo All — 실서버 확인.
 * 사용자 질문(2026-10-01): "프리액션 2그릇에 있는 거 째서 3그릇 보내는 것 정상적으로 UNDO, UNDO ALL 되고 있을까?"
 * 화면의 Undo = undo_free_action steps 1, Undo All = steps = 되돌리기 칸 수 (Game.tsx faUndoDepth).
 * 기존 testBurnUndo.ts(A~C: 번 1·2회, Undo·Undo All)에 더해 실패한 번·변환, 섞인 순서, 깊은 Undo All 을 본다.
 * 사용: 서버를 띄운 뒤 URL=http://localhost:5050 npx tsx script/testFreeActionUndoAll.ts
 */
import { io } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5107';
const socket = io(URL, { transports: ['websocket'] });
let gameId = '', me = '', lastTile = '', pickedBonus = false, fueled = false, started = false;
let last: any = null;
const done = (ok: boolean, msg: string) => { console.log(msg); socket.close(); process.exit(ok ? 0 : 1); };
const bowls = (g: any) => { const p = g.players[me]; return `${p.power1}/${p.power2}/${p.power3}`; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emitWait = async (ev: string, payload: any, ms = 700) => { socket.emit(ev, payload); await wait(ms); };

socket.on('connect', () => {
	socket.emit('admin_set_mcts_time_ms', { timeMs: 50 }, () => {
		socket.emit('admin_set_bot_delay_ms', { delayMs: 0 }, () => {
			socket.emit('create_game', { playerName: 'UndoAllTester' }, (res: any) => {
				if (!res?.gameId) done(false, 'create_game 실패');
				gameId = res.gameId; me = res.playerId ?? '';
				socket.emit('auto_setup_test', { gameId, selfPlay: false });
			});
		});
	});
});
socket.on('game_error', (e: any) => console.log('game_error:', e?.message));
setInterval(() => { if (last) act(last); }, 900);
socket.on('game_updated', (game: any) => { last = game; if (!game?.players) return; if (!me) me = Object.keys(game.players).find((id) => game.players[id]?.name === 'UndoAllTester') ?? ''; act(game); });

async function scenario() {
	const stack = () => (last?.freeActionUndoStack?.length ?? 0);
	const res = (g: any) => { const p = g.players[me]; return { b: `${p.power1}/${p.power2}/${p.power3}`, o: p.ore, c: p.credits, k: p.knowledge, log: (g.gameLogLen ?? g.gameLog?.length ?? 0) }; };
	const set = async (p1: number, p2: number, p3: number) => {
		// 이전 시나리오의 되돌리기 칸을 비운 뒤 그릇을 맞춘다(스택이 섞이지 않게)
		if (stack() > 0) await emitWait('undo_free_action', { gameId, steps: stack() }, 600);
		await emitWait('debug_set_resources', { gameId, resources: { power1: p1, power2: p2, power3: p3 } }, 700);
	};
	const out: string[] = []; let bad = 0;
	const ck = (ok: boolean, msg: string) => { if (!ok) bad++; out.push(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
	console.log('종족:', last.players[me].faction);

	// D) 성공한 번 뒤에 실패한 번 — 되돌리기 칸이 늘면 안 된다
	await set(0, 2, 1);
	await emitWait('burn_power', { gameId }); const d1 = res(last).b; const ds1 = stack();
	await emitWait('burn_power', { gameId }); const d2 = res(last).b; const ds2 = stack();
	await emitWait('undo_free_action', { gameId, steps: 1 }); const d3 = res(last).b;
	ck(d1 === '0/0/2' && d2 === '0/0/2', `D) 0/2/1 → 번 ${d1} → 두 번째 번(토큰 부족) ${d2}`);
	ck(ds2 === ds1, `D) 실패한 번은 되돌리기 칸을 늘리지 않는다 (번 후 ${ds1}칸 → 실패 후 ${ds2}칸)`);
	ck(d3 === '0/2/1', `D) Undo 한 번에 원래대로 (${d3})`);

	// E) 처음부터 못 하는 번
	await set(0, 1, 1); const es0 = stack();
	await emitWait('burn_power', { gameId }); const es1 = stack();
	ck(es1 === es0, `E) 0/1/1 에서 번(불가) — 되돌리기 칸 ${es0} → ${es1}`);

	// F) 번 2번 + 3파워→광석 변환 → Undo All
	await set(0, 4, 3); const f0 = res(last);
	await emitWait('burn_power', { gameId }); await emitWait('burn_power', { gameId });
	await emitWait('convert_resource', { gameId, type: '3power-to-1ore' }); const f1 = res(last); const fs = stack();
	await emitWait('undo_free_action', { gameId, steps: fs }); const f2 = res(last);
	// 되돌리면 서버가 'Undo Free Action' 한 줄을 일부러 남긴다(되돌린 행동은 지워지고 이 한 줄만 는다)
	const lastLog = (last.gameLog ?? []).at(-1);
	ck(f1.b !== f0.b && f1.o === f0.o + 1, `F) 번2 + 변환: ${f0.b} 광석${f0.o} → ${f1.b} 광석${f1.o} (칸 ${fs})`);
	ck(f2.b === f0.b && f2.o === f0.o && f2.c === f0.c, `F) Undo All → ${f2.b} 광석${f2.o} 크레딧${f2.c} (기대 ${f0.b}·${f0.o}·${f0.c})`);
	ck(f2.log === f0.log + 1 && lastLog?.action === 'Undo Free Action', `F) 로그: 번·변환 줄은 사라지고 'Undo Free Action' 한 줄만 남는다 (${f0.log}→${f2.log}줄, 마지막 "${lastLog?.action}: ${lastLog?.details}")`);

	// G) 번 3번 → Undo All
	await set(0, 6, 0); const g0 = res(last).b;
	for (let i = 0; i < 3; i++) await emitWait('burn_power', { gameId });
	const g1 = res(last).b; const gs = stack();
	await emitWait('undo_free_action', { gameId, steps: gs }); const g2 = res(last).b;
	ck(g1 === '0/0/3' && g2 === g0, `G) ${g0} → 번3 ${g1}(칸 ${gs}) → Undo All ${g2}`);

	// H) 실패한 변환도 칸을 늘리면 안 된다
	await set(0, 0, 1); const hs0 = stack();
	await emitWait('convert_resource', { gameId, type: '3power-to-1ore' }); const hs1 = stack();
	ck(hs1 === hs0, `H) 3그릇 1개로 3파워→광석(불가) — 되돌리기 칸 ${hs0} → ${hs1}`);

	done(bad === 0, out.join('\n') + (bad === 0 ? '\n\n전부 통과' : `\n\n${bad}건 실패`));
}

function act(game: any) {
	if (game.currentPhase === 'startingMines' && game.turnOrder?.[game.currentPlayerIndex] === me) {
		const fac = game.players[me]?.faction; const homeType = FACTIONS.find((f: any) => f.id === fac)?.homePlanet;
		const home = (game.map || []).find((t: any) => !t.ownerId && t.type === homeType);
		if (home && lastTile !== home.id) { lastTile = home.id; socket.emit('place_starting_mine', { gameId, tileId: home.id, factionId: fac }); }
	}
	if (game.currentPhase === 'bonusSelection' && game.turnOrder?.[game.currentPlayerIndex] === me && !pickedBonus) {
		const tile = (game.availableBonusTiles || [])[0];
		if (tile) { pickedBonus = true; socket.emit('select_bonus_tile', { gameId, bonusTileId: tile.id ?? tile }); }
	}
	const myTurn = game.turnOrder?.[game.currentPlayerIndex] === me && game.currentPhase === 'main';
	if (myTurn && !started) {
		started = true;
		(async () => { if (!fueled) { fueled = true; await emitWait('toggle_test_mode', { gameId }, 800); } await emitWait('accept_all_power_offers', { gameId }, 500); await scenario(); })();
	}
}
setTimeout(() => { console.log('RETRY 타임아웃(90s) — 준비 단계에서 멈춘 판(도구가 못 모는 종족 선택 등)'); process.exit(2); }, 90_000);
