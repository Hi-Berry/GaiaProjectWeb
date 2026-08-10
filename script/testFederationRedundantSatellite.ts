/**
 * 회귀 테스트: 연방 선언 시 '불필요한 위성' 경고 판정.
 *
 * 사용자 지적(2026-08-10): "위성 클릭하면 7파워 계산할 때 건물이랑 위성 다 체크해서 계산하는게 아니야? 원리가 이상하네"
 *
 * 기존 버그: 재검사를 computeConnectedFederation(클릭 목록)으로 했는데, 그 함수는 시드가 비면 connected=false다
 *   (선택 없음 = 판정 불가). 위성만 클릭한 사람은 그 위성을 빼는 순간 시드가 0개 → '연방 불가'로 잘못 읽혀
 *   경고가 안 떴고, 건물까지 클릭한 사람만 경고를 받았다. 같은 보드인데 클릭 순서로 결과가 갈렸다.
 *   → 시드를 '이번 연방에 든 건물'에서 잡도록 변경(federationFormsWithoutSatellite).
 *
 * 사용: PORT=5094 npx tsx script/testFederationRedundantSatellite.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { federationFormsWithoutSatellite } from '../server/gameState';

const ME = 'p_me';

/** 일렬 보드: A(0,0) - B(1,0) - S(2,0) 빈우주 - C(3,0). A와 C는 위성 S를 거쳐야만 이어진다. */
function board(aStruct: string, bStruct: string, cStruct: string) {
	return [
		{ id: 'A', q: 0, r: 0, type: 'terra', ownerId: ME, structure: aStruct },
		{ id: 'B', q: 1, r: 0, type: 'desert', ownerId: ME, structure: bStruct },
		{ id: 'S', q: 2, r: 0, type: 'space', ownerId: null, structure: null },
		{ id: 'C', q: 3, r: 0, type: 'ice', ownerId: ME, structure: cStruct },
	] as any[];
}

function makeGame(map: any[], fedHexes: string[] = []) {
	return {
		id: 'g', map,
		players: { [ME]: { name: 'Me', faction: 'terran', techTiles: ['tech-big-4str'], coveredTechTiles: [] } },
		playerFederationHexes: { [ME]: fedHexes },
		satellites: {},
	} as any;
}

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

// tech-big-4str 보유 → 의회/아카데미 4, 교역소/연구소 2, 광산 1.

// [핵심 케이스] A(의회4) + B(아카데미3) = 7 → 위성 없이 이미 연방 성립.
// 여기에 위성 S를 써서 C(광산1)까지 8파워로 선언하면 그 위성은 불필요 → 경고가 떠야 한다.
// 시드는 '이번 연방에 든 건물' 전체(A,B,C) — 위성만 클릭해 selectedPlanetIds가 비어 있어도 동일하게 판정된다.
{
	const game = makeGame(board('planetary_institute', 'academy', 'mine'));
	check('위성 빼도 A+B=7 → 불필요(경고)', federationFormsWithoutSatellite(game, ME, [], ['A', 'B', 'C'], 7), true);
}

// 위성이 실제로 필요한 경우: A(의회4)+B(광산1)=5, C(아카데미4) 단독 4 → 어느 조각도 7 미달 → 경고 없음.
{
	const game = makeGame(board('planetary_institute', 'mine', 'academy'));
	check('위성 빼면 5/4로 쪼개짐 → 필요(경고 없음)', federationFormsWithoutSatellite(game, ME, [], ['A', 'B', 'C'], 7), false);
}

// 이미 다른 연방에 쓴 건물은 재사용 불가 → A가 묶여 있으면 남는 건 B(4)뿐이라 위성이 필요.
{
	const game = makeGame(board('planetary_institute', 'academy', 'mine'), ['A']);
	check('기존 연방 건물(A)은 제외하고 판정', federationFormsWithoutSatellite(game, ME, [], ['A', 'B', 'C'], 7), false);
}

// 위성 2개 중 1개만 빼는 상황: 남은 위성으로도 A+B가 이어지면 여전히 불필요.
{
	const map = board('planetary_institute', 'academy', 'mine');
	map[1].q = 2; map[1].r = 0;      // B를 (2,0)으로 밀고
	map[2].q = 1; map[2].r = 0;      // S1(빈우주)을 A와 B 사이에 둔다: A - S1 - B - S2 - C
	map.push({ id: 'S2', q: 3, r: 0, type: 'space', ownerId: null, structure: null } as any);
	map[3].q = 4; map[3].r = 0;      // C를 (4,0)으로
	const game = makeGame(map);
	check('S2만 빼도 A-S1-B=7 → 불필요', federationFormsWithoutSatellite(game, ME, ['S'], ['A', 'B', 'C'], 7), true);
	check('S1만 빼면 B-S2-C=5 → 필요', federationFormsWithoutSatellite(game, ME, ['S2'], ['A', 'B', 'C'], 7), false);
}

// 제노스 의회(요구 6)처럼 요구치가 낮아지면 판정도 따라간다.
{
	const game = makeGame(board('planetary_institute', 'trading_station', 'mine'));
	check('요구 6이면 A+B=6 → 불필요', federationFormsWithoutSatellite(game, ME, [], ['A', 'B', 'C'], 6), true);
	check('요구 7이면 A+B=6 → 필요', federationFormsWithoutSatellite(game, ME, [], ['A', 'B', 'C'], 7), false);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 위성만 클릭했든 건물까지 클릭했든 같은 보드면 같은 경고가 뜹니다.');
process.exit(0);
