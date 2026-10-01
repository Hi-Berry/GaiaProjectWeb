/**
 * 관전자 채팅 차단 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-10-01): "관전자들이 익명으로 들어와서 문제. 밖으로 킥하는 게 아니라
 *   차단된 사람은 채팅을 못 하고 채팅창도 못 보게 막아 버려."
 *
 * 방장(플레이어) 1명 + 관전자 둘(S1·S2)로 확인한다.
 *   ① 채팅 기록이 게임 상태·입장 응답에 더는 실리지 않는다(차단자에게도 새지 않게)
 *   ② 차단 전: 관전자 채팅이 모두에게 간다
 *   ③ 플레이어가 S1 차단 → S1 에게 알림, 상태에 차단 표시
 *   ④ 차단 뒤: S1 은 남의 채팅을 못 받고, 보낸 채팅은 아무에게도 안 가고, 기록 요청도 거절
 *   ⑤ S1 이 새로고침(같은 관전 id로 재입장) → 여전히 차단
 *   ⑥ 관전자는 남을 차단할 수 없다
 *   ⑦ 해제 → 다시 받고 보낼 수 있다
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testSpectatorChatBlock.ts
 */
import { io, type Socket } from 'socket.io-client';

const URL = process.env.URL ?? 'http://localhost:5050';
const P = io(URL, { transports: ['websocket'] });
const S1 = io(URL, { transports: ['websocket'] });
const S2 = io(URL, { transports: ['websocket'] });
let gameId = '', pId = '', s1Id = '', s2Id = '';
const got: Record<string, string[]> = { P: [], S1: [], S2: [], S1b: [] };
const blockEvents: Record<string, string[]> = { S1: [], S1b: [] };
let lastP: any = null;
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>((res) => s.emit(ev, p, (r: T) => res(r)));
const finish = () => { console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); [P, S1, S2].forEach((s) => s.close()); process.exit(bad === 0 ? 0 : 1); };
setTimeout(() => { console.log('시간 초과'); bad++; finish(); }, 60_000);

P.on('chat_message', (m: any) => got.P.push(m.text));
S1.on('chat_message', (m: any) => got.S1.push(m.text));
S2.on('chat_message', (m: any) => got.S2.push(m.text));
S1.on('chat_blocked', () => blockEvents.S1.push('blocked'));
S1.on('chat_unblocked', () => blockEvents.S1.push('unblocked'));
let sawChatInState = false;
P.on('game_updated', (g: any) => { lastP = g; if (g && 'chatMessages' in g) sawChatInState = true; });

P.on('connect', async () => {
	const r = await emit<any>(P, 'create_game', { playerName: 'Host' });
	gameId = r.gameId; pId = r.playerId;
	const w1 = await emit<any>(S1, 'watch_game', { gameId, name: '구경꾼1' }); s1Id = w1.spectatorId;
	const w2 = await emit<any>(S2, 'watch_game', { gameId, name: '구경꾼2' }); s2Id = w2.spectatorId;
	await sleep(300);

	// ② 차단 전
	S1.emit('send_chat', { gameId, text: '안녕 1' });
	await sleep(400);
	check(got.P.includes('안녕 1') && got.S2.includes('안녕 1'), `② 차단 전: S1 채팅이 플레이어·S2 에게 간다`);

	// ① 기록은 상태·응답에 안 실린다
	const w3 = await emit<any>(S2, 'watch_game', { gameId, name: '구경꾼2', spectatorId: s2Id });
	check(!('chatMessages' in (w3?.game ?? {})) && !sawChatInState, `① 채팅 기록이 게임 상태·입장 응답에 실리지 않는다`);
	const h1 = await emit<any>(S2, 'get_chat_history', { gameId });
	check(Array.isArray(h1?.messages) && h1.messages.some((m: any) => m.text === '안녕 1'), `① 기록은 따로 요청하면 받는다 (${h1?.messages?.length}줄)`);

	// ⑥ 관전자는 차단 못 한다
	const bad1 = await emit<any>(S2, 'set_spectator_chat_block', { gameId, spectatorId: s1Id, blocked: true });
	check(!!bad1?.error, `⑥ 관전자는 남을 차단할 수 없다 ("${bad1?.error}")`);

	// ③ 플레이어가 S1 차단
	const ok = await emit<any>(P, 'set_spectator_chat_block', { gameId, spectatorId: s1Id, blocked: true });
	await sleep(400);
	check(!!ok?.ok && blockEvents.S1.includes('blocked'), `③ 플레이어가 S1 차단 → S1 에게 차단 알림`);
	check((lastP?.chatBlockedSpectators ?? []).includes(s1Id), `③ 게임 상태에 차단 표시 (${JSON.stringify(lastP?.chatBlockedSpectators)})`);

	// ④ 차단 뒤
	const before = { P: got.P.length, S1: got.S1.length, S2: got.S2.length };
	S2.emit('send_chat', { gameId, text: '구경꾼2 말' });
	P.emit('send_chat', { gameId, text: '방장 말' });
	S1.emit('send_chat', { gameId, text: '도배' });
	await sleep(500);
	check(got.S1.length === before.S1, `④ S1 은 남의 채팅을 못 받는다 (새로 받은 줄 ${got.S1.length - before.S1})`);
	check(got.P.includes('구경꾼2 말') && got.S2.includes('방장 말'), `④ 다른 사람끼리는 그대로 오간다`);
	check(!got.P.includes('도배') && !got.S2.includes('도배'), `④ S1 이 보낸 채팅은 아무에게도 안 간다`);
	const h2 = await emit<any>(S1, 'get_chat_history', { gameId });
	check(h2?.blocked === true && !h2?.messages, `④ S1 의 기록 요청은 거절 (${JSON.stringify(h2)})`);
	const h3 = await emit<any>(P, 'get_chat_history', { gameId });
	check(!h3.messages.some((m: any) => m.text === '도배'), `④ 기록에도 S1 의 차단 후 채팅이 없다`);

	// ⑤ 새로고침 — 같은 관전 id 로 다시 입장(브라우저가 저장해 둔 id 를 보낸다), 이름을 바꿔도
	const S1b = io(URL, { transports: ['websocket'] });
	S1b.on('chat_message', (m: any) => got.S1b.push(m.text));
	S1b.on('chat_blocked', () => blockEvents.S1b.push('blocked'));
	await new Promise((r) => S1b.on('connect', r));
	S1.close();
	const w4 = await emit<any>(S1b, 'watch_game', { gameId, name: '새이름', spectatorId: s1Id });
	await sleep(400);
	check(w4?.spectatorId === s1Id && blockEvents.S1b.includes('blocked'), `⑤ 이름을 바꿔 다시 들어와도 같은 관전 id → 그대로 차단`);
	P.emit('send_chat', { gameId, text: '재입장 확인' });
	await sleep(400);
	check(!got.S1b.includes('재입장 확인'), `⑤ 재입장한 S1 도 채팅을 못 받는다`);

	// ⑦ 해제
	S1b.on('chat_unblocked', () => blockEvents.S1b.push('unblocked'));
	await emit<any>(P, 'set_spectator_chat_block', { gameId, spectatorId: s1Id, blocked: false });
	await sleep(400);
	check(blockEvents.S1b.includes('unblocked') && !(lastP?.chatBlockedSpectators ?? []).includes(s1Id), `⑦ 해제 알림 · 상태에서 차단 표시 사라짐`);
	P.emit('send_chat', { gameId, text: '해제 후' });
	S1b.emit('send_chat', { gameId, text: 'S1 복귀' });
	await sleep(500);
	const h4 = await emit<any>(S1b, 'get_chat_history', { gameId });
	check(got.S1b.includes('해제 후') && got.P.includes('S1 복귀') && Array.isArray(h4?.messages), `⑦ 해제 뒤 다시 받고·보내고·기록도 받는다`);
	S1b.close();
	finish();
});
