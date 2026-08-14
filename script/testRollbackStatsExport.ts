/**
 * 회귀 테스트: 되돌리기(롤백) 집계가 **게임 export에 실리는가**.
 *
 * 사용자 요청(2026-08-14): "롤백 횟수도 저장 같이 해줘."
 *   기존엔 buildRollbackSummary 결과가 서버 로그 파일에만 남아, 다운로드한 게임 JSON으로는
 *   사후 통계를 낼 수 없었다(로그는 컨테이너 안에만 있고 재시작하면 사라짐).
 *
 * 확인 항목:
 *   ① countRollback이 좌석별/GM으로 나뉘어 누적되는가
 *   ② 롤백은 게임 상태를 스냅샷으로 통째 복원하는데 집계는 되감기지 않는가
 *      (그래서 rollbackCounts를 game 밖 모듈 레벨에 둔다 — 이게 깨지면 통계가 항상 0이 된다)
 *   ③ buildRollbackSummary 문자열이 사람 이름으로 나오는가
 *
 * 사용: PORT=5091 npx tsx script/testRollbackStatsExport.ts
 */
import { countRollback, buildRollbackSummary } from '../server/gameState';

const GID = 'test-rb-game';
const mkGame = () => ({
	id: GID,
	players: {
		p1: { name: '디애박' },
		p2: { name: '하이' },
	},
} as never);

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

// ① 좌석별 + GM 누적
countRollback(GID, 'p1');
countRollback(GID, 'p1');
countRollback(GID, 'p2');
countRollback(GID, null);      // GM 되감기

const s1 = buildRollbackSummary(mkGame());
check('요약이 생성됨', s1 !== null, String(s1));
check('총 4회로 집계', !!s1 && s1.startsWith('총 4회'), String(s1));
check('많이 한 사람이 앞에(디애박 2회)', !!s1 && s1.indexOf('디애박 2회') < s1.indexOf('하이 1회'), String(s1));
check('GM 분리 표기', !!s1 && s1.includes('GM 1회'), String(s1));

// ② 게임 객체를 새로 만들어도(=롤백으로 상태가 통째 복원돼도) 집계는 유지되어야 한다
const s2 = buildRollbackSummary(mkGame());
check('게임 객체를 새로 만들어도 집계 유지', s2 === s1, `${s2}`);

// ③ 롤백이 없던 게임은 null (export에서는 total:0으로 구분되어야 하므로 요약만 null)
check('롤백 없는 게임은 요약 null', buildRollbackSummary({ id: 'other-game', players: {} } as never) === null);

// ④ 이름을 모르는 좌석은 playerId로 폴백
countRollback('g2', 'ghost');
const s3 = buildRollbackSummary({ id: 'g2', players: {} } as never);
check('이름 없으면 playerId 폴백', !!s3 && s3.includes('ghost 1회'), String(s3));

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 롤백 집계가 좌석별/GM으로 누적되고 상태 복원과 무관하게 유지됩니다.');
console.log('    (export 반영은 humanGameLogger의 rollbacks 필드 — attachRollbackStats가 게임 종료 시 붙입니다)');
process.exit(0);
