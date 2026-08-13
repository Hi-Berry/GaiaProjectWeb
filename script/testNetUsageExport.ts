/**
 * 회귀 테스트: 게임 저장 페이로드에 대역폭 측정치(netUsage)가 실리는가.
 *
 * 사용자 지적(2026-08-13): "로그에 용량 출력하더니 그건 왜 한 거야"
 *   → [NET-USAGE]는 서버 컨테이너 logs/에만 남아 다운로드가 안 됐다. 사람들이 받는 건 게임 JSON이다.
 *   gameState가 game 객체에 non-enumerable('__netUsage')로 붙이고 humanGameLogger가 그걸 실어 보낸다.
 *
 * 여기서 검증하는 것:
 *   ① 붙인 값이 export 페이로드에 그대로 나온다
 *   ② non-enumerable이라 브로드캐스트용 JSON.stringify(game)에는 안 실린다(대역폭 역효과 방지)
 *   ③ 값이 없으면 undefined로 조용히 빠진다(옛 게임 호환)
 *
 * 사용: PORT=5092 npx tsx script/testNetUsageExport.ts
 */
import { buildLiveSnapshot } from '../server/humanGameLogger';

const NU = { outBytes: 6220000, seats: 4, bots: 2, spectators: 3, receivers: 5, concurrentGames: 1 };

function mkGame(withUsage: boolean) {
	const game: any = {
		id: 'g1', createdAt: Date.now(), roundNumber: 4, currentPhase: 'main',
		players: { p1: { name: '사람', faction: 'terran', score: 40, research: {}, techTiles: [], federations: [] } },
		turnOrder: ['p1'], gameLog: [], humanActionJournal: [], botPlayerIds: [], map: [],
	};
	if (withUsage) Object.defineProperty(game, '__netUsage', { value: NU, writable: true, configurable: true, enumerable: false });
	return game;
}

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

{
	const game = mkGame(true);
	const snap = buildLiveSnapshot(game);
	check('export 페이로드에 netUsage 포함', snap.netUsage, NU);
	// 저장 파일은 JSON으로 직렬화되므로 왕복까지 확인
	check('JSON 왕복 후에도 유지', JSON.parse(JSON.stringify(snap)).netUsage, NU);
	// 브로드캐스트되는 game 자체에는 실리면 안 된다(대역폭 아끼려다 늘리는 일 방지)
	check('game 직렬화엔 미포함', JSON.parse(JSON.stringify(game)).__netUsage, undefined);
	check('코드 접근은 가능', (game as any).__netUsage.outBytes, NU.outBytes);
}
{
	const snap = buildLiveSnapshot(mkGame(false));
	check('측정치 없으면 undefined', snap.netUsage, undefined);
	check('키 자체가 JSON에서 빠짐', Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(snap)), 'netUsage'), false);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 대역폭 측정치가 저장 파일에는 실리고 브로드캐스트에는 안 실립니다.');
process.exit(0);
