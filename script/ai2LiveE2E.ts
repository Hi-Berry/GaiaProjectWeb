/**
 * [ai2 실전 2026-10-14] 실제 서버 흐름 끝까지: 개발서버에 소켓으로 붙어 봇 4명 게임을 만들고, 한 좌석만 ai2 플래그
 * (headToHead B = { ai2: true })로 botHandler → ai2LiveDecide 경로를 타게 한다. 게임 끝 점수·좌석을 출력.
 *  사용: 개발서버(PORT=5055) 기동 후  URL=http://localhost:5055 npx tsx script/ai2LiveE2E.ts
 *  서버 로그의 'Bot … [AI2]' 줄로 결정 시간·폴백 여부 확인.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:5055';
const s = io(URL, { transports: ['websocket'] });
const call = (ev: string, p: any) => new Promise<any>(res => s.emit(ev, p, (r: any) => res(r)));
s.on('connect', async () => {
	await call('admin_set_mcts_time_ms', { timeMs: 400 });
	await call('admin_set_bot_delay_ms', { delayMs: 0 });
	const c = await call('create_game', { playerName: 'E2E' });
	const gameId = c.gameId;
	const pos = Number(process.env.AI2_POS ?? 1);
	s.emit('auto_setup_test', { gameId, selfPlay: true, headToHead: { bPositions: [pos], A: { label: 'bot', flags: {} }, B: { label: 'ai2', flags: { ai2: true } } } });
	console.log('game', gameId, 'ai2 좌석 위치', pos);
	const t0 = Date.now(); let lastR = 0;
	const tick = setInterval(async () => {
		const g = (await call('get_game', { gameId }))?.game;
		if (!g) return;
		if (g.roundNumber !== lastR) { lastR = g.roundNumber; console.log(`R${g.roundNumber} · ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
		if (g.currentPhase === 'gameEnd') {
			clearInterval(tick);
			for (const id of g.turnOrder) { const p = g.players[id]; console.log(`  ${id === g.turnOrder[pos] ? '★ai2' : ' bot'} ${p.faction} ${p.score}`); }
			console.log(`끝 · ${((Date.now() - t0) / 1000).toFixed(0)}s`); process.exit(0);
		}
		if (Date.now() - t0 > 40 * 60 * 1000) { console.log('시간 초과', g.currentPhase, 'R' + g.roundNumber); process.exit(1); }
	}, 5000);
});
