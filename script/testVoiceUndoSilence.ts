/**
 * 되돌린 액션은 읽지 않는지 실제 서버로 확인한다.
 *
 * 사용자 관찰(2026-08-21): 파워 액션으로 테라포밍 1을 얻고 Undo(reset_turn)하면
 *   결과적으로 하지 않은 액션인데 음성은 이미 나간 뒤였다. 서버는 reset_turn에서 그 턴의
 *   로그 줄을 지우므로, 클라이언트가 '되돌릴 수 없게 된 줄'만 읽으면 이 문제가 사라진다.
 *   그 판정(turnMark 최대값보다 앞선 seq만 읽기)이 실제로 동작하는지 여기서 확인한다.
 *
 * 사용: 1) PORT=5104 node dist/index.cjs   2) npx tsx script/testVoiceUndoSilence.ts
 */
import { io } from 'socket.io-client';
import { actionParts } from '../client/src/lib/speech';
import { FACTIONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5104';
const socket = io(URL, { transports: ['websocket'] });

let gameId = '';
let me = '';
let mark = 0;
let phase = '';
const announced: string[] = [];      // 실제로 읽혔을 문구
const everSeen: string[] = [];       // 로그에 한 번이라도 나타난 파워 액션 줄
let lastTry = 0;
let fueled = false;
let phase2 = false;
let fueled2 = false;
let endedTurn = false;
let pickedBonus = false;
let didReset = false;
let powerSeenInLog = false;
let lastTile = '';

const done = (ok: boolean, msg: string) => {
	console.log(msg);
	console.log(`읽힌 안내 ${announced.length}건: ${announced.slice(-6).join(' | ') || '(없음)'}`);
	socket.close();
	process.exit(ok ? 0 : 1);
};

socket.on('connect', () => {
	socket.emit('admin_set_mcts_time_ms', { timeMs: 50 }, () => {
		socket.emit('admin_set_bot_delay_ms', { delayMs: 0 }, () => {
			socket.emit('create_game', { playerName: 'UndoTester' }, (res: any) => {
				if (!res?.gameId) done(false, 'create_game 실패');
				gameId = res.gameId;
				me = res.playerId ?? '';
				// selfPlay=false → 내 좌석은 사람으로 남고 나머지는 봇
				socket.emit('auto_setup_test', { gameId, selfPlay: false });
			});
		});
	});
});

socket.on('game_error', (e: any) => console.log('game_error:', e?.message));
let last: any = null;
setInterval(() => { if (last) act(last); }, 900);

socket.on('game_updated', (game: any) => {
	last = game;
	if (!game?.gameLog || !game.players) return;
	phase = game.currentPhase;
	if (!me) me = Object.keys(game.players).find((id) => game.players[id]?.name === 'UndoTester') ?? '';

	// 클라이언트와 같은 판정 — 되돌릴 수 없게 된 줄만 읽는다
	const marks = Object.values((game.turnMark ?? {}) as Record<string, number>);
	const commitSeq = game.currentPhase === 'gameEnd' || !marks.length ? null : Math.max(...marks);
	let doneIdx = mark;
	for (const e of game.gameLog.slice(mark)) {
		if (commitSeq !== null && typeof e.seq === 'number' && e.seq > commitSeq) break;
		doneIdx++;
		const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
		// 누구의 안내인지 함께 적는다 — 봇도 파워 액션을 쓰므로 문구만으론 내 것과 못 가른다
		if (parts) announced.push((e.playerId === me ? '[나] ' : '[봇] ') + parts.join(' '));
	}
	mark = doneIdx;

	// 로그에 파워 액션이 실제로 붙었는지(=액션이 서버에 반영됐는지) 확인
	for (const e of game.gameLog) {
		if (e.playerId === me && /^Power Action/.test(e.action ?? '')) {
			powerSeenInLog = true;
			if (!everSeen.includes(e.details)) everSeen.push(e.details);
		}
	}

	// 시작 집 배치 단계 — 내 종족의 홈 행성 아무 빈 칸에 놓는다(봇은 알아서 놓는다)
	if (game.currentPhase === 'startingMines' && game.turnOrder?.[game.currentPlayerIndex] === me ) {
		// 타일의 행성 종류 필드는 type이다(planetType 아님). 내 홈 행성 칸을 고른다.
		const fac = game.players[me]?.faction;
		const homeType = FACTIONS.find((f: any) => f.id === fac)?.homePlanet;
		const home = (game.map || []).find((t: any) => !t.ownerId && t.type === homeType);
				// 집은 사람당 2개 이상 놓는다 → 같은 칸을 두 번 보내지 않게만 막고 매 턴 보낸다
		if (home && lastTile !== home.id) { lastTile = home.id; socket.emit('place_starting_mine', { gameId, tileId: home.id, factionId: fac }); }
	}

	act(game);
});

function act(game: any) {
	// 보너스 타일 선택 단계 — 남은 것 중 첫 번째를 집는다
	if (game.currentPhase === 'bonusSelection' && game.turnOrder?.[game.currentPlayerIndex] === me && !pickedBonus) {
		const tile = (game.availableBonusTiles || [])[0];
		if (tile) { pickedBonus = true; socket.emit('select_bonus_tile', { gameId, bonusTileId: tile.id ?? tile }); }
	}

	const myTurn = game.turnOrder?.[game.currentPlayerIndex] === me && game.currentPhase === 'main';
	// 수입/파워 수락 처리가 끝날 때까지 상태 갱신마다 재시도한다(한 번에 안 붙는 게 정상 흐름)
	if (myTurn && !powerSeenInLog && !didReset && !phase2 && Date.now() - lastTry > 1200) {
		lastTry = Date.now();
		// 시작 직후엔 3그릇 파워가 0이라 어떤 파워 액션도 못 쓴다 → 개발서버 테스트 모드로 파워만 채운다.
		// debug_set_resources는 상태를 방송하지 않을 수 있어 '한 번만' 켜고 곧바로 액션을 시도한다
		// (재시도마다 toggle하면 테스트 모드가 껐다 켜졌다 한다).
		if (!fueled) { fueled = true; socket.emit('toggle_test_mode', { gameId }); return; }
		// 봇 건설로 온 파워 수락 대기가 있으면 메인 액션이 막힌다("수입/파워 처리가 진행 중") → 먼저 정리
		socket.emit('accept_all_power_offers', { gameId });
		// 자원 주입은 멱등(power3=12로 고정)이라 매 재시도마다 보내고 곧이어 액션을 시도한다
		socket.emit('debug_set_resources', { gameId, resources: { power3: 12 } });
		setTimeout(() => {
			const avail = (last?.powerActions || []).filter((a: any) => !a.isUsed).sort((a: any, b: any) => (a.cost ?? 9) - (b.cost ?? 9));
			if (avail.length) socket.emit('use_power_action', { gameId, actionId: avail[0].id });
		}, 300);
	}
	if (myTurn && powerSeenInLog && !didReset) {
		didReset = true;
		setTimeout(() => {
			socket.emit('reset_turn', { gameId });
			setTimeout(() => {
				const spokenAfterReset = announced.some((a) => a.startsWith('[나] ') && a.includes('파워 액션'));
				console.log(`1) 되돌린 파워 액션이 읽혔나: ${spokenAfterReset} ${spokenAfterReset ? '(실패)' : '(정상)'}`);
				if (spokenAfterReset) done(false, '실패: 되돌린 액션이 읽혔다');
				// 2단계: 이번엔 되돌리지 않고 턴을 넘긴다 → 넘어간 뒤에는 읽혀야 한다(보류가 영구 무음이면 안 됨)
				phase2 = true;
				powerSeenInLog = false;
			}, 3000);
		}, 800);
	}
	if (myTurn && phase2 && !endedTurn && powerSeenInLog) {
		endedTurn = true;
		socket.emit('end_turn', { gameId });
		setTimeout(() => {
			const spoken = announced.some((a) => a.startsWith('[나] ') && a.includes('파워 액션'));
			if (!spoken) {
				// 실패 진단 — 이 세 줄이 실제 off-by-one(내 seq == 다음 턴 표시)을 잡았다
				console.log('진단 · turnMark=', JSON.stringify(last?.turnMark));
				console.log('진단 · 내 로그 꼬리=', (last?.gameLog ?? []).filter((e: any) => e.playerId === me).slice(-3).map((e: any) => `${e.action}@seq${e.seq}`).join(' | '));
			}
			console.log(`2) 턴을 넘긴 뒤 그 액션이 읽혔나: ${spoken} ${spoken ? '(정상)' : '(실패)'}`);
			done(spoken, spoken ? 'OK: 되돌리면 무음, 턴을 넘기면 읽는다' : '실패: 턴을 넘겼는데도 안 읽혔다');
		}, 4000);
	}
	if (myTurn && phase2 && !endedTurn && !powerSeenInLog && Date.now() - lastTry > 1200) {
		lastTry = Date.now();
		// reset_turn이 턴 시작 스냅샷(파워 채우기 전)으로 복원했으므로 다시 채운다
		if (!fueled2) { fueled2 = true; if (!game.isTestMode) socket.emit('toggle_test_mode', { gameId }); return; }
		socket.emit('accept_all_power_offers', { gameId });
		socket.emit('debug_set_resources', { gameId, resources: { power3: 12 } });
		setTimeout(() => {
			const avail = (last?.powerActions || []).filter((a: any) => !a.isUsed).sort((a: any, b: any) => (a.cost ?? 9) - (b.cost ?? 9));
			if (avail.length) socket.emit('use_power_action', { gameId, actionId: avail[0].id });
		}, 300);
	}
}

setTimeout(() => done(false, `시간 초과 (phase=${phase}, 파워붙음=${powerSeenInLog}, 되돌림=${didReset})`), 90000);
