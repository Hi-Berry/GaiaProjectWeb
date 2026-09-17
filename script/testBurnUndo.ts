/**
 * 프리액션 번(2그릇 2개 → 3그릇 1개) 뒤 Undo가 그릇을 정확히 되돌리는지 실제 서버로 확인.
 * 사용자 제보(2026-09-17): 0/4/1에서 2개 태우고 Undo Undo 하면 0/2/2에서 멈춘다는 이야기.
 * 시나리오 A: 0/4/1 → 번 1회(0/2/2) → undo 1 → 0/4/1 기대
 * 시나리오 B: 0/4/1 → 번 2회(0/0/3) → undo 1 → undo 1 → 0/4/1 기대(중간 0/2/2)
 * 시나리오 C: 0/4/1 → 번 2회 → undo steps=2 → 0/4/1 기대
 * 사용: 1) PORT=5107 node dist/index.cjs   2) URL=http://localhost:5107 npx tsx script/testBurnUndo.ts
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
			socket.emit('create_game', { playerName: 'BurnTester' }, (res: any) => {
				if (!res?.gameId) done(false, 'create_game 실패');
				gameId = res.gameId; me = res.playerId ?? '';
				socket.emit('auto_setup_test', { gameId, selfPlay: false });
			});
		});
	});
});
socket.on('game_error', (e: any) => console.log('game_error:', e?.message));
setInterval(() => { if (last) act(last); }, 900);
socket.on('game_updated', (game: any) => { last = game; if (!game?.players) return; if (!me) me = Object.keys(game.players).find((id) => game.players[id]?.name === 'BurnTester') ?? ''; act(game); });

async function scenario() {
	const set = async () => { await emitWait('debug_set_resources', { gameId, resources: { power1: 0, power2: 4, power3: 1 } }, 800); await emitWait('accept_all_power_offers', { gameId }, 300); };
	const stackLen = () => (last?.freeActionUndoStack?.length ?? 'n/a');
	const results: string[] = [];
	// A
	await set(); const a0 = bowls(last);
	await emitWait('burn_power', { gameId }); const a1 = bowls(last);
	await emitWait('undo_free_action', { gameId, steps: 1 }); const a2 = bowls(last);
	results.push(`A) ${a0} → 번1 ${a1} → undo1 ${a2}  ${a2 === '0/4/1' ? 'OK' : 'FAIL'}`);
	// B
	await set(); const b0 = bowls(last);
	await emitWait('burn_power', { gameId }); const b1 = bowls(last);
	await emitWait('burn_power', { gameId }); const b2 = bowls(last); const st2 = stackLen();
	await emitWait('undo_free_action', { gameId, steps: 1 }); const b3 = bowls(last);
	await emitWait('undo_free_action', { gameId, steps: 1 }); const b4 = bowls(last);
	results.push(`B) ${b0} → 번1 ${b1} → 번2 ${b2}(stack ${st2}) → undo1 ${b3} → undo1 ${b4}  ${b4 === '0/4/1' ? 'OK' : 'FAIL'}`);
	// C
	await set(); const c0 = bowls(last);
	await emitWait('burn_power', { gameId }); await emitWait('burn_power', { gameId }); const c2 = bowls(last);
	await emitWait('undo_free_action', { gameId, steps: 2 }); const c3 = bowls(last);
	results.push(`C) ${c0} → 번2 ${c2} → undo(steps=2) ${c3}  ${c3 === '0/4/1' ? 'OK' : 'FAIL'}`);
	const ok = results.every((r) => r.endsWith('OK'));
	done(ok, results.join('\n'));
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
setTimeout(() => done(false, '타임아웃(90s)'), 90_000);
