/**
 * 관전자 목록 — 재연결 뒤 옛 연결이 늦게 끊겨도 목록에서 빠지지 않는지(실서버).
 *
 * 사용자 제보(2026-10-03): "관전자가 채팅방 들어와서 채팅하고 있는데 채팅창 목록에 없다. 몇 분 뒤에는 뜬다."
 *   원인: 같은 관전 id 의 새 연결이 붙어 있는데, 서버가 옛 연결 끊김을 뒤늦게 처리하며 목록에서 뺐다.
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testSpectatorListReconnect.ts
 */
import { io } from 'socket.io-client';

const U = process.env.URL ?? 'http://localhost:5050';
const P = io(U, { transports: ['websocket'] });
const emit = (s: any, ev: string, p: any) => new Promise<any>((r) => s.emit(ev, p, (x: any) => r(x)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last: any = null;
const got: string[] = [];
P.on('game_updated', (g: any) => { last = g; });
P.on('chat_message', (m: any) => got.push(`${m.name}: ${m.text}`));
const listed = (id: string) => (last?.connectedSpectators ?? []).includes(id);
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 30000);

P.on('connect', async () => {
	const r = await emit(P, 'create_game', { playerName: '방장' });
	const gameId = r.gameId;

	// 재연결: 옛 연결 A → 새 연결 B(같은 관전 id) → A 가 뒤늦게 끊김
	const A = io(U, { transports: ['websocket'] }); await new Promise((x) => A.on('connect', x));
	const id = (await emit(A, 'watch_game', { gameId, name: '관전자K' })).spectatorId;
	const B = io(U, { transports: ['websocket'] }); await new Promise((x) => B.on('connect', x));
	await emit(B, 'rejoin_game', { gameId, playerId: id });
	await sleep(400);
	check(listed(id), '새 연결로 재접속한 뒤 목록에 있다');
	A.close(); await sleep(600);
	check(listed(id) && B.connected, '옛 연결이 뒤늦게 끊겨도 목록에 남는다 (새 연결로 보고 있으므로)');
	B.emit('send_chat', { gameId, text: '보고 있어요' }); await sleep(400);
	check(got.includes('관전자K: 보고 있어요') && listed(id), '채팅하는 동안에도 목록에 보인다');

	// 정말로 나가면(마지막 연결까지 끊기면) 빠져야 한다
	B.close(); await sleep(600);
	check(!listed(id), '마지막 연결까지 끊기면 목록에서 빠진다');

	// 탭 두 개: 하나를 닫아도 남고, 둘 다 닫으면 빠진다
	const T1 = io(U, { transports: ['websocket'] }); await new Promise((x) => T1.on('connect', x));
	const id2 = (await emit(T1, 'watch_game', { gameId, name: '탭두개' })).spectatorId;
	const T2 = io(U, { transports: ['websocket'] }); await new Promise((x) => T2.on('connect', x));
	await emit(T2, 'watch_game', { gameId, name: '탭두개', spectatorId: id2 });
	await sleep(400);
	T1.close(); await sleep(600);
	check(listed(id2), '탭 두 개 중 하나를 닫아도 목록에 남는다');
	T2.close(); await sleep(600);
	check(!listed(id2), '둘 다 닫으면 목록에서 빠진다');

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	P.close(); process.exit(bad === 0 ? 0 : 1);
});
