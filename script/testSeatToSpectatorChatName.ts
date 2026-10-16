/**
 * 회귀 테스트: 같은 브라우저(같은 소켓)에서 좌석 a로 있다가 이름 b로 관전에 들어오면 채팅이 b로 나가는가.
 *
 * [사용자 제보 2026-10-16] "a로 게임 시작하고 나가서 b로 이름 바꾸고 들어가면 관전자에는 b가 생겼는데 채팅하면 a 이름으로 채팅이 돼"
 *   watch_game이 이 소켓의 좌석 연결(socketToPlayerMap)을 지우지 않았고, send_chat은 좌석 연결을 먼저 본다.
 *
 * 사용: 1) PORT=5121 npx tsx server/index.ts   2) URL=http://localhost:5121 npx tsx script/testSeatToSpectatorChatName.ts
 */
import { io } from 'socket.io-client';

const URL = process.env.URL ?? 'http://localhost:5121';
const me = io(URL, { transports: ['websocket'] });      // a → b로 바꾸는 사람(같은 소켓 유지)
const other = io(URL, { transports: ['websocket'] });   // 방에 남아 채팅을 받는 다른 사람
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const call = (s: any, ev: string, payload: any) => new Promise<any>(r => s.emit(ev, payload, r));

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

const chats: any[] = [];
other.on('chat_message', (m: any) => { if (m.senderId !== 'system') chats.push(m); });
let lastGame: any = null;
other.on('game_updated', (g: any) => { lastGame = g; });

async function lastChatAfterSending(text: string) {
	chats.length = 0;
	me.emit('send_chat', { gameId, text });
	await wait(400);
	return chats.find(c => c.text === text);
}

let gameId = '';
async function main() {
	await Promise.all([new Promise(r => me.on('connect', r)), new Promise(r => other.on('connect', r))]);
	const created = await call(me, 'create_game', { playerName: 'a' });
	gameId = created.gameId;
	const aId = created.playerId;
	const joined = await call(other, 'join_game', { gameId, playerName: 'c' });
	check('방 만들기·참가', !!gameId && !!joined?.playerId);

	console.log('① 좌석 a 상태에서 채팅');
	const c1 = await lastChatAfterSending('from-seat');
	check('a 이름으로 나감', c1?.name === 'a' && c1?.isSpectator === false, JSON.stringify(c1 && { name: c1.name, spec: c1.isSpectator }));

	console.log('\n② 같은 소켓으로 이름 b로 관전에 들어간 뒤 채팅 (제보 상황)');
	const watched = await call(me, 'watch_game', { gameId, name: 'b' });
	await wait(300);
	const c2 = await lastChatAfterSending('from-spectator');
	check('b 이름·관전자로 나감', c2?.name === 'b' && c2?.isSpectator === true, JSON.stringify(c2 && { name: c2.name, spec: c2.isSpectator }));
	const specNames = (lastGame?.connectedSpectators ?? []).map((id: string) => lastGame?.spectatorNames?.[id]);
	check('관전자 목록에 b', specNames.includes('b'), specNames.join(', '));

	console.log('\n③ 다시 좌석 a로 복귀한 뒤 채팅 (반대 방향)');
	await call(me, 'rejoin_game', { gameId, playerId: aId });
	await wait(300);
	const c3 = await lastChatAfterSending('back-to-seat');
	check('a 이름으로 나감', c3?.name === 'a' && c3?.isSpectator === false, JSON.stringify(c3 && { name: c3.name, spec: c3.isSpectator }));
	const specNames2 = (lastGame?.connectedSpectators ?? []).map((id: string) => lastGame?.spectatorNames?.[id]);
	check('관전자 목록에서 b 빠짐', !specNames2.includes('b'), specNames2.join(', ') || '(없음)');
	check('관전 ID는 재접속용으로 유지', (lastGame?.spectatorIds ?? []).includes(watched?.spectatorId));

	console.log('');
	me.close(); other.close();
	if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
	console.log('OK: 좌석↔관전을 바꿔도 채팅 이름이 지금 신원을 따릅니다.');
	process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 15000);
