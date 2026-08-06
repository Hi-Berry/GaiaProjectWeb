/**
 * 검증: 롤백 횟수 집계와 게임 종료 로그 요약 (사용자 요청 2026-08-06 "롤백도 몇번씩 했는지 로그에 남겨줘").
 *
 * 집계를 game 객체가 아니라 모듈 레벨 Map(gameId 기준)에 두는 게 핵심이다.
 * 롤백은 게임 상태를 스냅샷으로 통째 복원하므로, game 안에 세면 카운터까지 같이 되감긴다.
 *
 * 사용: PORT=5093 npx tsx script/testRollbackCount.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 명시적 종료)
 */
import { countRollback, buildRollbackSummary } from '../server/gameState';

const game: any = {
	id: 'g-test',
	players: {
		pA: { name: '가마우지' },
		pB: { name: '시리' },
	},
	roundNumber: 4,
};

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = actual === expected;
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

check('롤백 전에는 요약 없음(로그 줄 안 생김)', buildRollbackSummary(game), null);

countRollback(game.id, 'pA');
check('1회 — 요청자 이름과 횟수', buildRollbackSummary(game), '총 1회 (가마우지 1회)');

countRollback(game.id, 'pB');
countRollback(game.id, 'pA');
check('여러 명 — 많이 한 사람부터', buildRollbackSummary(game), '총 3회 (가마우지 2회, 시리 1회)');

countRollback(game.id, null); // GM 되감기
check('GM 되감기는 GM으로 따로 집계', buildRollbackSummary(game), '총 4회 (가마우지 2회, 시리 1회, GM 1회)');

// 다른 게임의 집계와 섞이지 않아야 한다
const other: any = { id: 'g-other', players: { pC: { name: '마루' } }, roundNumber: 1 };
countRollback(other.id, 'pC');
check('게임별로 분리 집계', buildRollbackSummary(other), '총 1회 (마루 1회)');
check('원래 게임 집계는 그대로', buildRollbackSummary(game), '총 4회 (가마우지 2회, 시리 1회, GM 1회)');

// 좌석이 사라진 뒤에도(이름 못 찾음) 요약 자체는 만들어져야 한다
const gone: any = { id: 'g-test', players: {}, roundNumber: 6 };
check('이름 없으면 id로 대체', buildRollbackSummary(gone), '총 4회 (pA 2회, pB 1회, GM 1회)');

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 롤백 횟수가 요청자별·GM별로 집계되고 종료 로그 한 줄로 요약됩니다.');
process.exit(0); // 임포트로 뜬 서버가 프로세스를 붙잡고 있으므로 명시적 종료
