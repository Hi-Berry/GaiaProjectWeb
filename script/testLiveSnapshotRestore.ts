/**
 * 진행 중 게임 저장·복원(server/liveSnapshot.ts + gameState LIVE 블록) 실제 서버 재시작 테스트.
 *
 * 사용자 요청(2026-11-28): Render 무료 서버가 예고 없이 재시작돼 진행 중 판이 사라짐 → Supabase에 저장해 두고 재시작 뒤 이어하기.
 *
 *  1단계(save):   서버 A에 사람 1 + 봇 3 판을 만들고(좌석 비번 포함) 진행시킨 뒤 상태를 파일에 적는다.
 *  (사이에 서버 A를 SIGTERM으로 끄고 서버 B를 띄운다 — 종료 신호 때 저장)
 *  2단계(restore): 서버 B에 같은 좌석 ID로 재접속 → 게임이 되살아났는지, 라운드·점수·로그·채팅 안내·비번 이어하기 확인.
 *  3단계(cleanup): 방장이 방을 지우면 표의 줄도 지워지는지(다음 저장 주기) 확인.
 *
 * 서버 환경변수: LIVE_SNAPSHOT=on LIVE_SNAPSHOT_SERVER_ID=test-local LIVE_SNAPSHOT_FLUSH_MS=3000 SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
 * 사용: STEP=save|restore|cleanup URL=http://localhost:5297 STATE=/tmp/x.json npx tsx script/testLiveSnapshotRestore.ts
 */
import { io } from 'socket.io-client';
import * as fs from 'fs';

const URL = process.env.URL || 'http://localhost:5297';
const STATE = process.env.STATE || './live-snapshot-test.json';
const STEP = process.env.STEP || 'save';
const s = io(URL, { transports: ['websocket'] });
const call = (ev: string, p: any) => new Promise<any>(res => { s.emit(ev, p, (r: any) => res(r)); setTimeout(() => res({ error: 'timeout' }), 20000); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const summary = (g: any) => ({
	phase: g.currentPhase, round: g.roundNumber, cur: g.turnOrder?.[g.currentPlayerIndex],
	scores: Object.fromEntries(Object.entries(g.players).map(([id, p]: any) => [id, p.score])),
	logLen: g.gameLog?.length ?? 0, lastLog: g.gameLog?.at(-1)?.action ?? null,
});

s.on('connect', async () => {
	if (STEP === 'save') {
		const c = await call('create_game', { playerName: '저장테스트', password: 'pw-live' });
		const { gameId, playerId } = c;
		s.emit('auto_setup_test', { gameId });
		await sleep(15000); // 봇이 몇 수 두게
		const g = (await call('get_game', { gameId })).game;
		const sum = summary(g);
		console.log('저장 전 상태', gameId, JSON.stringify(sum));
		check(g.currentPhase !== 'lobby', `판이 시작됨 (${g.currentPhase})`);
		await sleep(5000); // 저장 주기(3초) 한 번 이상
		fs.writeFileSync(STATE, JSON.stringify({ gameId, playerId, sum: summary((await call('get_game', { gameId })).game) }));
	} else if (STEP === 'restore') {
		const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
		const r = await call('rejoin_game', { gameId: saved.gameId, playerId: saved.playerId });
		check(!r.error && !!r.game, `재시작 뒤 같은 좌석으로 재접속 (${r.error ?? 'ok'})`);
		if (r.game) {
			const now = summary(r.game);
			console.log('되살린 상태', JSON.stringify(now));
			check(now.phase === saved.sum.phase && now.round === saved.sum.round, `단계·라운드 그대로 (${now.phase} R${now.round})`);
			check(JSON.stringify(now.scores) === JSON.stringify(saved.sum.scores), '점수 그대로');
			check(now.logLen >= saved.sum.logLen - 1, `게임 로그 이어짐 (${saved.sum.logLen} → ${now.logLen})`);
			check(!!r.game.players[saved.playerId], '내 좌석 있음');
			const chat = await call('get_chat_history', { gameId: saved.gameId });
			const msgs = chat?.messages ?? chat?.history ?? r.game.chatMessages ?? [];
			check(JSON.stringify(msgs).includes('서버가 다시 시작되어'), '채팅에 재시작 안내');
		}
		const s2 = io(URL, { transports: ['websocket'] });
		await new Promise(r => s2.on('connect', r as any));
		const ar: any = await new Promise(res => { s2.emit('account_rejoin', { gameId: saved.gameId, playerName: '저장테스트', password: 'pw-live' }, res); setTimeout(() => res({ error: 'timeout' }), 10000); });
		check(ar?.playerId === saved.playerId, `다른 기기에서 이름·비번 이어하기 (${ar?.error ?? ar?.playerId})`);
		s2.close();
		await sleep(8000);
		const g2 = (await call('get_game', { gameId: saved.gameId })).game;
		console.log('복원 8초 뒤', JSON.stringify(summary(g2)));
	} else if (STEP === 'cleanup') {
		const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
		await call('rejoin_game', { gameId: saved.gameId, playerId: saved.playerId });
		const d = await call('delete_game', { gameId: saved.gameId, playerId: saved.playerId });
		check(!d?.error, `방 삭제 (${d?.error ?? 'ok'})`);
	}
	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	setTimeout(() => process.exit(bad === 0 ? 0 : 1), 100);
});
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 120000);
