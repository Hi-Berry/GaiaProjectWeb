/**
 * 회귀 테스트: 같은 사람이 관전을 다시 시작해도 관전자 목록에 유령 이름이 쌓이지 않는가.
 *
 * 리뷰(2026-08-14): 채팅의 "(관전자 : …)"는 connectedSpectators를 이름으로 바꿔 붙인 목록인데,
 *   ① watch_game이 들어올 때마다 새 spec-… 을 만들고
 *   ② socketToSpectatorMap을 덮어쓰기만 해서 예전 ID가 connectedSpectators에 남았다.
 *   → 로비에서 Watch를 다시 누를 때마다 "하이, 하이, 하이"로 늘어났다(모바일에서 특히 잦음).
 *
 * 서버 소켓 핸들러는 setupGameServer 안에 있어 직접 못 부르므로, 같은 자료구조를 쓰는
 * setSpectatorConnected의 계약(핵심 불변식)을 검증한다:
 *   - 같은 ID를 두 번 붙여도 목록에 한 번만 들어간다
 *   - 이전 ID를 빼면 목록에서 사라진다  ← 수정의 핵심(기존엔 이 호출이 없었다)
 *   - ID를 재사용하면 목록 길이가 늘지 않는다
 *
 * 사용: PORT=5095 npx tsx script/testSpectatorRewatchNoGhost.ts
 */

/** 서버 setSpectatorConnected와 동일 구현 (gameState.ts:2178 — 비공개 함수) */
function setSpectatorConnected(game: { connectedSpectators?: string[] }, spectatorId: string, on: boolean) {
	const list: string[] = game.connectedSpectators ?? (game.connectedSpectators = []);
	const i = list.indexOf(spectatorId);
	if (on && i < 0) list.push(spectatorId);
	if (!on && i >= 0) list.splice(i, 1);
}

type Game = { connectedSpectators?: string[]; spectatorIds?: string[]; spectatorNames?: Record<string, string> };

/** watch_game의 관전자 등록부를 축약 재현 (수정 후 동작) */
function watch(game: Game, socketMap: Map<string, string>, socketId: string, name: string, prevId?: string) {
	// ① 이 소켓이 이미 다른 관전 ID로 붙어 있었으면 먼저 뺀다
	const stale = socketMap.get(socketId);
	if (stale) { setSpectatorConnected(game, stale, false); socketMap.delete(socketId); }
	// ② 예전 ID가 이 게임 것이면 재사용
	const reusable = prevId && game.spectatorIds?.includes(prevId) ? prevId : null;
	const id = reusable ?? `spec-${Math.random().toString(36).slice(2, 8)}`;
	game.spectatorIds = game.spectatorIds ?? [];
	if (!reusable) game.spectatorIds.push(id);
	game.spectatorNames = game.spectatorNames ?? {};
	game.spectatorNames[id] = name;
	setSpectatorConnected(game, id, true);
	socketMap.set(socketId, id);
	return id;
}

const names = (g: Game) => (g.connectedSpectators ?? []).map(id => g.spectatorNames?.[id] ?? id);

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

console.log('① 같은 소켓으로 Watch를 세 번 눌러도 목록은 1명 (ID 미저장 = 최악의 경우)');
{
	const g: Game = {}; const m = new Map<string, string>();
	watch(g, m, 'sock1', '하이');
	watch(g, m, 'sock1', '하이');
	watch(g, m, 'sock1', '하이');
	check('접속 중 관전자 1명', (g.connectedSpectators ?? []).length === 1, names(g).join(', '));
	check('표시 이름도 1개', names(g).join(',') === '하이', names(g).join(', '));
}

console.log('\n② 저장된 ID를 넘기면 ID 자체가 안 늘어난다 (로비 Watch 재사용 경로)');
{
	const g: Game = {}; const m = new Map<string, string>();
	const id1 = watch(g, m, 'sock1', '하이');
	const id2 = watch(g, m, 'sock1', '하이', id1);
	const id3 = watch(g, m, 'sock1', '하이', id2);
	check('같은 ID 재사용', id1 === id2 && id2 === id3, `${id1}`);
	check('spectatorIds도 1개', (g.spectatorIds ?? []).length === 1, String((g.spectatorIds ?? []).length));
	check('접속 중 1명', (g.connectedSpectators ?? []).length === 1);
}

console.log('\n③ 이름을 바꿔 다시 관전하면 새 이름으로 갱신된다 (rejoin_game 대신 watch_game을 쓰는 이유)');
{
	const g: Game = {}; const m = new Map<string, string>();
	const id = watch(g, m, 'sock1', '하이');
	watch(g, m, 'sock1', '하이2', id);
	check('이름 갱신', names(g).join(',') === '하이2', names(g).join(', '));
	check('여전히 1명', (g.connectedSpectators ?? []).length === 1);
}

console.log('\n④ 서로 다른 사람은 각각 남는다 (과잉 정리 방지)');
{
	const g: Game = {}; const m = new Map<string, string>();
	watch(g, m, 'sockA', '하이');
	watch(g, m, 'sockB', '디애박');
	check('2명', (g.connectedSpectators ?? []).length === 2, names(g).join(', '));
	// A가 다시 눌러도 B는 그대로
	watch(g, m, 'sockA', '하이');
	check('A 재관전 후에도 2명', (g.connectedSpectators ?? []).length === 2, names(g).join(', '));
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 다시 관전해도 유령 이름이 쌓이지 않습니다.');
process.exit(0);
