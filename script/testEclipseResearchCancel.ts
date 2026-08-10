/**
 * 회귀 테스트: 이클립스 2K+3P(연구 트랙) 취소 시 자원 복원.
 *
 * 사용자 제보(2026-08-10): "타클론 3파워 2지식 액션하고 취소하면 1그릇에 토큰 3개 생겨있다"
 *
 * 기존 버그: 소켓 핸들러 cancel_eclipse_research가 knowledge+2 / power3+3 / power1-3을 하드코딩 환불했다.
 *   타클론이 브레인 스톤(=3파워)으로 내면 지불 때 power3는 줄지 않고 브레인만 3그릇→1그릇 이동하는데,
 *   환불은 power3에 3개를 새로 만들고 넣은 적 없는 power1에서 3개를 빼려 해 토큰이 통째로 늘었다.
 *   네블라 의회(3그릇 토큰 1개=파워2 → 실제 2개만 소모)도 같은 이유로 어긋났다.
 *   795d59a가 봇 폴백용 executeCancelEclipseResearch만 pre 스냅샷 복원으로 고치고 사람용 핸들러를 놓쳤다.
 *   → 핸들러가 같은 함수로 위임하도록 변경. 이 테스트는 그 함수의 복원 정확도를 종족별로 검증한다.
 *
 * 사용: PORT=5097 npx tsx script/testEclipseResearchCancel.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { executeCancelEclipseResearch } from '../server/gameState';
import { spendTaklonsPower } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_me';
const SHIP = 'ship_tile_1';

type Power = { power1: number; power2: number; power3: number; brainStoneBowl?: 1 | 2 | 3 };

/** 지불 직전 상태 → 이클립스 2K+3P 지불 → pending 세팅까지, use_ship_action(:4430) 경로를 그대로 재현 */
function setup(faction: string, start: Power & { knowledge: number }, hasNevlasPI = false, brainPriority = true) {
	const player: any = { name: 'Me', faction, knowledge: start.knowledge, ore: 0, credits: 0, qic: 0, taklonsBrainPriority: brainPriority, ...start };
	const game: any = {
		id: 'g', currentPhase: 'main',
		players: { [ME]: player },
		turnOrder: [ME], currentPlayerIndex: 0, roundNumber: 3,
		gameLog: [], gameLogSeq: 0,
		spaceships: { [SHIP]: { occupants: [ME], usedActionIndices: [], actionsUsed: 0 } },
		map: [],
	};
	const shipPowerTokens = (cost: number) => hasNevlasPI ? Math.ceil(cost / 2) : cost;
	// :4439 — 지불 직전 스냅샷
	const pre = { knowledge: player.knowledge, power1: player.power1, power2: player.power2, power3: player.power3, brainStoneBowl: player.brainStoneBowl };
	player.knowledge -= 2;
	if (faction === 'taklons') {
		spendTaklonsPower(player, 3, 3, player.taklonsBrainPriority ?? true);
	} else {
		player.power3 -= shipPowerTokens(3);
		player.power1 = (player.power1 || 0) + shipPowerTokens(3);
	}
	game.spaceships[SHIP].usedActionIndices = [2];
	game.spaceships[SHIP].actionsUsed = 1;
	game.pendingEclipseResearch = { playerId: ME, shipTileId: SHIP, pre };
	game.hasDoneMainAction = true;
	return { game, player };
}

const snap = (p: any) => ({ k: p.knowledge, p1: p.power1, p2: p.power2, p3: p.power3, bs: p.brainStoneBowl });

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

// [핵심] 타클론 브레인 스톤(3그릇)으로 지불 → 취소. 브레인만 3그릇으로 돌아가고 일반 토큰은 그대로여야 한다.
{
	const before = { knowledge: 5, power1: 0, power2: 0, power3: 4, brainStoneBowl: 3 as const };
	const { game, player } = setup('taklons', before);
	check('타클론 지불 직후 — 브레인만 1그릇으로, 일반토큰 불변', snap(player), { k: 3, p1: 0, p2: 0, p3: 4, bs: 1 });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('타클론 취소 — 지불 전과 완전히 동일', snap(player), { k: 5, p1: 0, p2: 0, p3: 4, bs: 3 });
}

// 타클론이라도 브레인이 3그릇에 없으면 일반 토큰 3개로 지불 → 취소도 그대로 되돌린다.
{
	const before = { knowledge: 4, power1: 1, power2: 2, power3: 3, brainStoneBowl: 2 as const };
	const { game, player } = setup('taklons', before);
	check('타클론(브레인 2그릇) 지불 — 일반토큰 3개가 1그릇으로', snap(player), { k: 2, p1: 4, p2: 2, p3: 0, bs: 2 });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('타클론(브레인 2그릇) 취소 — 원복', snap(player), { k: 4, p1: 1, p2: 2, p3: 3, bs: 2 });
}

// '브레인 보존'(taklonsBrainPriority=false)이면 브레인을 아끼고 일반 토큰으로 낸다.
// (기존엔 이 액션만 useBrain=true로 못박혀 설정을 무시하고 브레인을 항상 썼다 — 다른 배 액션 3곳은 설정을 따름)
{
	const before = { knowledge: 4, power1: 0, power2: 0, power3: 3, brainStoneBowl: 3 as const };
	const { game, player } = setup('taklons', before, false, false);
	check('브레인 보존 — 일반토큰 3개로 지불, 브레인은 3그릇 유지', snap(player), { k: 2, p1: 3, p2: 0, p3: 0, bs: 3 });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('브레인 보존 취소 — 원복', snap(player), { k: 4, p1: 0, p2: 0, p3: 3, bs: 3 });
}

// 브레인 보존이어도 일반 토큰이 모자라면 브레인으로 폴백해 액션이 막히지 않는다.
{
	const before = { knowledge: 4, power1: 0, power2: 0, power3: 1, brainStoneBowl: 3 as const };
	const { game, player } = setup('taklons', before, false, false);
	check('보존인데 일반토큰 부족 — 브레인 폴백', snap(player), { k: 2, p1: 0, p2: 0, p3: 1, bs: 1 });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('폴백 취소 — 원복', snap(player), { k: 4, p1: 0, p2: 0, p3: 1, bs: 3 });
}

// 네블라 의회: 3그릇 토큰 1개 = 파워 2 → 3파워를 토큰 2개로 낸다. 하드코딩 3개 환불이면 1개가 늘었다.
{
	const before = { knowledge: 6, power1: 0, power2: 0, power3: 5 };
	const { game, player } = setup('nevlas', before, true);
	check('네블라 의회 지불 — 토큰 2개만 소모', snap(player), { k: 4, p1: 2, p2: 0, p3: 3, bs: undefined });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('네블라 의회 취소 — 토큰 총량 보존', snap(player), { k: 6, p1: 0, p2: 0, p3: 5, bs: undefined });
}

// 일반 종족: 기존 동작과 동일해야 한다(회귀 방지).
{
	const before = { knowledge: 3, power1: 2, power2: 1, power3: 4 };
	const { game, player } = setup('terran', before);
	check('일반 종족 지불', snap(player), { k: 1, p1: 5, p2: 1, p3: 1, bs: undefined });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('일반 종족 취소 — 원복', snap(player), { k: 3, p1: 2, p2: 1, p3: 4, bs: undefined });
}

// 취소 시 액션 사용 횟수·메인액션 플래그도 풀려야 재시도가 가능하다.
{
	const { game } = setup('terran', { knowledge: 3, power1: 0, power2: 0, power3: 3 });
	executeCancelEclipseResearch(ioStub, game, ME);
	check('액션 인덱스 2 롤백', game.spaceships[SHIP].usedActionIndices, []);
	check('hasDoneMainAction 해제', game.hasDoneMainAction, false);
	check('pending 해제', game.pendingEclipseResearch, null);
}

// pre가 없는 진행 중 게임(구버전 세션)은 기존 하드코딩 폴백을 그대로 탄다.
{
	const { game, player } = setup('terran', { knowledge: 3, power1: 0, power2: 0, power3: 3 });
	delete (game.pendingEclipseResearch as any).pre;
	executeCancelEclipseResearch(ioStub, game, ME);
	check('pre 없으면 폴백 환불', snap(player), { k: 3, p1: 0, p2: 0, p3: 3, bs: undefined });
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 이클립스 2K+3P 취소가 종족별 지불 경로를 정확히 되돌립니다(토큰 생성/소멸 없음).');
process.exit(0);
