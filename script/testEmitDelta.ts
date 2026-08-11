/**
 * 회귀 테스트: emit 델타 계측(measureDeltaSize)의 복원 정확도.
 *
 * 리뷰 지적 이력
 *  1) 이전 payload를 참조로 보관 → 서버가 제자리 변경하면 '이전 상태'가 같이 변해 전부 '변화 없음' 오판.
 *  2) 삭제된 최상위 키·퇴장한 좌석을 표현하지 않아 복원 불가.
 *  3) undefined로 바뀐 필드는 Object.keys에 남아 $del에 안 들어가는데 JSON.stringify에서는 사라진다
 *     → 클라에 옛 값이 남는다(pendingTurnEndPlayerId 등이 자주 undefined가 된다).
 *
 * 핵심 검증은 bad === false — 델타를 적용한 결과가 원본과 일치하는지다. 이게 깨지면 절감률은 의미가 없다.
 *
 * 사용: PORT=5099 npx tsx script/testEmitDelta.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { measureDeltaSize } from '../server/gameState';

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

/** 실제 emit payload를 흉내 낸 최소 형태 */
function mkPayload() {
	return {
		id: 'g1', currentPhase: 'main', hasDoneMainAction: false, currentPlayerIndex: 0,
		roundNumber: 3, gameLogStart: 0, gameLogLen: 0, gameLog: [] as unknown[],
		pendingTurnEndPlayerId: 'p1' as string | undefined,
		availableShipTechTileIds: ['t1'] as string[] | undefined,
		map: [{ id: 'a', q: 0, r: 0, structure: null as string | null }, { id: 'b', q: 1, r: 0, structure: null as string | null }],
		players: {
			p1: { name: 'A', credits: 10, ore: 2 },
			p2: { name: 'B', credits: 7, ore: 1 },
		} as Record<string, { name: string; credits: number; ore: number }>,
	};
}

// 각 케이스는 게임 id를 달리해 계측 상태를 분리한다.
{
	const g = 'case-base';
	const p = mkPayload();
	const first = measureDeltaSize(g, p);
	check('첫 emit은 전체 전송', [first.full, first.bad], [true, false]);

	// [핵심 1] 서버는 객체를 '제자리에서' 바꾼다 — 참조를 들고 있었다면 여기서 변화를 못 잡았다.
	p.players.p1.credits = 4;
	const d1 = measureDeltaSize(g, p);
	check('제자리 변경을 잡아냄(빈 델타 아님)', [d1.empty, d1.bad], [false, false]);

	const d2 = measureDeltaSize(g, p);
	check('진짜 변화가 없으면 빈 델타', [d2.empty, d2.bad], [true, false]);
}

// [핵심 2] undefined로 바뀐 필드 — 리뷰 3번 지적
{
	const g = 'case-undef';
	const p = mkPayload();
	measureDeltaSize(g, p);
	p.pendingTurnEndPlayerId = undefined;
	const d = measureDeltaSize(g, p);
	check('undefined로 바뀐 필드를 삭제로 전달(복원 일치)', [d.empty, d.bad], [false, false]);

	p.availableShipTechTileIds = undefined;
	const d2 = measureDeltaSize(g, p);
	check('배열 필드도 undefined 처리', [d2.empty, d2.bad], [false, false]);

	// 다시 값이 생기는 경우도 복원돼야 한다
	p.pendingTurnEndPlayerId = 'p2';
	const d3 = measureDeltaSize(g, p);
	check('undefined → 값 복귀도 반영', [d3.empty, d3.bad], [false, false]);
}

// 맵 타일 변경 — 바뀐 칸만 담기고 복원이 맞아야 한다
{
	const g = 'case-map';
	const p = mkPayload();
	measureDeltaSize(g, p);
	p.map[1].structure = 'mine';
	const d = measureDeltaSize(g, p);
	check('타일 1칸 변경 복원', [d.empty, d.bad], [false, false]);
}

// 좌석 퇴장 — 리뷰 2번 지적
{
	const g = 'case-seat';
	const p = mkPayload();
	measureDeltaSize(g, p);
	delete p.players.p2;
	const d = measureDeltaSize(g, p);
	check('퇴장한 좌석 삭제 전달', [d.empty, d.bad], [false, false]);
}

// 최상위 키 자체가 사라지는 경우
{
	const g = 'case-delkey';
	const p = mkPayload() as Record<string, unknown>;
	measureDeltaSize(g, p);
	delete p.availableShipTechTileIds;
	const d = measureDeltaSize(g, p);
	check('최상위 키 삭제 전달', [d.empty, d.bad], [false, false]);
}

// 맵 길이 변경(잊혀진 행성 등) — 통째로 보내고 복원이 맞아야 한다
{
	const g = 'case-maplen';
	const p = mkPayload();
	measureDeltaSize(g, p);
	p.map.push({ id: 'c', q: 2, r: 0, structure: null });
	const d = measureDeltaSize(g, p);
	check('맵 길이 변경 시 전체 맵 전달', [d.empty, d.bad], [false, false]);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 모든 변경 유형에서 델타 적용 결과가 원본과 일치합니다(bad=false).');
process.exit(0);
