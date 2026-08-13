/**
 * 회귀 테스트: 리플레이에 필요한 연방 정보가 저장 페이로드에 실리는가.
 *
 * 사용자 요청(2026-08-13): "연방 전후로 어떤 건물이 연방 건물이 되었는지" 재생 가능하게.
 *   기존 로그는 개수만 남겼다 — `Formed federation (2 satellites, 7 power)`, tileId 없음.
 *   서버는 game.satellites / game.playerFederationHexes에 들고 있는데 export에서 빠져 있었다.
 *
 * 검증:
 *   ① 최종 상태(satellites·playerFederationHexes)가 페이로드에 실린다
 *   ② 값이 없는 옛 게임은 키가 조용히 빠진다
 *   ③ gameLog 항목의 fedHexes(시점별 편입 칸)가 JSON 왕복 후에도 남는다
 *
 * 사용: PORT=5091 npx tsx script/testReplayExport.ts
 */
import { buildLiveSnapshot } from '../server/humanGameLogger';

const SAT = { 'tile-12': ['p1'], 'tile-13': ['p1', 'p2'] };
const FED = { p1: ['tile-10', 'tile-11', 'tile-12'] };

function mkGame(withFed: boolean) {
	const game: any = {
		id: 'g1', createdAt: Date.now(), roundNumber: 4, currentPhase: 'main',
		players: { p1: { name: '사람', faction: 'terran', score: 40, research: {}, techTiles: [], federations: [] } },
		turnOrder: ['p1'], humanActionJournal: [], botPlayerIds: [], map: [],
		gameLog: [
			{ timestamp: 1, playerId: 'p1', playerName: '사람', action: 'Built Mine', round: 1 },
			{ timestamp: 2, playerId: 'p1', playerName: '사람', action: 'Federation Reward', details: '+7VP +6C', tileId: 'fed-7vp-6c', round: 3, fedHexes: ['tile-10', 'tile-11', 'tile-12'] },
		],
	};
	if (withFed) { game.satellites = SAT; game.playerFederationHexes = FED; }
	return game;
}

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

{
	const snap = JSON.parse(JSON.stringify(buildLiveSnapshot(mkGame(true))));
	check('위성 좌표 포함', snap.satellites, SAT);
	check('연방 편입 칸(최종) 포함', snap.playerFederationHexes, FED);
	const fedLog = snap.gameLog.find((e: any) => e.action === 'Federation Reward');
	check('로그의 시점별 편입 칸 유지', fedLog?.fedHexes, ['tile-10', 'tile-11', 'tile-12']);
	check('연방 아닌 로그엔 필드 없음', Object.prototype.hasOwnProperty.call(snap.gameLog[0], 'fedHexes'), false);
}
{
	const snap = JSON.parse(JSON.stringify(buildLiveSnapshot(mkGame(false))));
	check('옛 게임: satellites 키 없음', Object.prototype.hasOwnProperty.call(snap, 'satellites'), false);
	check('옛 게임: fedHexes 키 없음', Object.prototype.hasOwnProperty.call(snap, 'playerFederationHexes'), false);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 연방 재생에 필요한 위성·편입칸이 저장 파일에 남습니다.');
process.exit(0);
