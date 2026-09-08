/**
 * 스모크 테스트: [earlyHumanOverride] R1~R2 전용 사람 모방 랭커가 봇 안에서 실제로 점수를 내고,
 * 사람 패턴대로 자원 조건부 선택을 하는가 (h2h 태우기 전 "전제조건 발화" 확인).
 *  ① 가중치 로드·피처 차원 일치(148)
 *  ② 리벨리온 탑승 + QIC 3 → 리벨#1(3Q 기술타일)이 top-1이고 마진이 임계(0.5) 이상 → 오버라이드 발동
 *  ③ 같은 상태에서 QIC 0 → 리벨#1이 top-1이 아니어야 함(자원 조건부 학습 확인)
 *  ④ R3에서는 오버라이드 없음(maxRound 게이트)
 * 사용: npx tsx script/testEarlyRanker.ts
 */
import { BotLogic } from '../server/ai/bot';
import { setPlayerVariant } from '../server/ai/variant';

const ME = 'p_test';
function mkGame(round: number, qic: number, knowledge: number) {
	const map: Record<string, unknown>[] = [
		{ id: 't1', q: 0, r: 0, type: 'terra', sector: 1, ownerId: ME, structure: 'mine' },
		{ id: 't1b', q: -1, r: 0, type: 'terra', sector: 1, ownerId: ME, structure: 'trading_station' },
		{ id: 't2', q: 1, r: 0, type: 'volcanic', sector: 1, ownerId: null, structure: null },
		{ id: 't3', q: 0, r: 1, type: 'desert', sector: 1, ownerId: null, structure: null },
		{ id: 't4', q: 2, r: 0, type: 'transdim', sector: 1, ownerId: null, structure: null },
		{ id: 'reb', q: 1, r: 1, type: 'ship_rebellion', sector: 1, ownerId: null, structure: null },
		{ id: 'twi', q: -2, r: 1, type: 'ship_twilight', sector: 1, ownerId: null, structure: null },
	];
	const player: Record<string, unknown> = {
		name: 'T', faction: 'terran', ore: 4, credits: 9, knowledge, qic,
		power1: 2, power2: 3, power3: 2, research: { terraforming: 0, navigation: 1, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
		techTiles: [], federations: [], spaceshipsEntered: ['reb'],
	};
	return { id: 'g', roundNumber: round, hasDoneMainAction: false, players: { [ME]: player }, map, spaceships: { reb: { unlocked: true, occupants: [ME], usedActionIndices: [] } } } as never;
}
// 사람 R1 실제 후보셋과 비슷한 혼합: 광산·TS업글·연구·파워액션·리벨 3액션·트와 입장
const cands = [
	{ type: 'build_mine', params: { tileId: 't2' } },
	{ type: 'build_mine', params: { tileId: 't3' } },
	{ type: 'upgrade_structure', params: { tileId: 't1', target: 'trading_station' } },
	{ type: 'advance_research', params: { trackId: 'economy' } },
	{ type: 'use_power_action', params: { actionId: 'gain-2-ore' } },
	{ type: 'use_ship_action', params: { shipTileId: 'reb', actionIndex: 1 } },
	{ type: 'use_ship_action', params: { shipTileId: 'reb', actionIndex: 2, targetTileId: 't1' } },
	{ type: 'use_ship_action', params: { shipTileId: 'reb', actionIndex: 3 } },
	{ type: 'enter_spaceship', params: { tileId: 'twi', qicToUse: 0 } },
	{ type: 'pass_round', params: {} },
] as never[];
const label = (c: any) => `${c.type}${c.params?.actionIndex != null ? '#' + c.params.actionIndex : ''}${c.params?.tileId ? '@' + c.params.tileId : ''}`;

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };

setPlayerVariant(ME, { flags: { earlyHumanOverride: true } } as never);

// ① 로드
{
	const M = BotLogic.earlyRankerModel();
	check('① earlyRanker.json 로드', !!M, M ? `featDim=${M.featDim} maxRound=${M.maxRound} w.len=${M.w.length}` : 'null');
	if (M) check('① 피처 차원 = 148', M.featDim === 148 && M.w.length === 148);
}
// ② QIC 3, K 0 → 리벨#1 (K가 있으면 사람은 #3(2K→1Q2C)를 먼저 하고 #1을 다음 턴에 — 그 순서도 확인)
{
	const g2 = mkGame(1, 3, 2);
	const sc2 = BotLogic.earlyRankerScores(g2, ME, cands)!;
	const o2 = cands.map((c, i) => ({ c, s: sc2[i] })).sort((a, b) => b.s - a.s);
	console.log('    R1 q3 k2 순위: ' + o2.slice(0, 4).map(o => `${label(o.c)}(${o.s.toFixed(2)})`).join(' > '));
	check('② q3 k2 → 리벨#3(2K→1Q2C) 먼저 = 사람 순서', label(o2[0].c) === 'use_ship_action#3');
	const g = mkGame(1, 3, 0);
	const sc = BotLogic.earlyRankerScores(g, ME, cands)!;
	const order = cands.map((c, i) => ({ c, s: sc[i] })).sort((a, b) => b.s - a.s);
	console.log('    R1 q3 k0 순위: ' + order.slice(0, 5).map(o => `${label(o.c)}(${o.s.toFixed(2)})`).join(' > '));
	// 실행 불가 후보(K0의 #3, p3 2의 #2)는 earlyHumanPick이 걸러낸다 — 임계를 낮춰 '걸러낸 뒤 top-1'이 #1인지 확인
	setPlayerVariant(ME, { flags: { earlyHumanOverride: true, earlyOverrideMargin: 0.2 } } as never);
	const pick = BotLogic.earlyHumanPick(g, ME, cands);
	check('② q3 k0 → 실행가능 후보 중 top-1 = 리벨#1 (불가 #3·#2 필터)', !!pick && label(pick.action) === 'use_ship_action#1', pick ? `p=${pick.p.toFixed(2)} margin=${pick.margin.toFixed(2)}` : '미발동');
	setPlayerVariant(ME, { flags: { earlyHumanOverride: true } } as never);
	const pick5 = BotLogic.earlyHumanPick(g, ME, cands);
	console.log('    q3 k0 기본 임계(0.5) 오버라이드: ' + (pick5 ? label(pick5.action) + ' margin=' + pick5.margin.toFixed(2) : '없음(MCTS로) — 확신 부족 시 원래 경로'));
}
// ③ QIC 0 → 리벨#1 아님
{
	const g = mkGame(1, 0, 2);
	const sc = BotLogic.earlyRankerScores(g, ME, cands)!;
	const order = cands.map((c, i) => ({ c, s: sc[i] })).sort((a, b) => b.s - a.s);
	console.log('    R1 q0 k2 순위: ' + order.slice(0, 5).map(o => `${label(o.c)}(${o.s.toFixed(2)})`).join(' > '));
	check('③ q0 → 리벨#1이 top-1 아님(자원 조건부)', label(order[0].c) !== 'use_ship_action#1');
	const pick = BotLogic.earlyHumanPick(g, ME, cands);
	console.log('    q0 오버라이드: ' + (pick ? `${label(pick.action)} p=${pick.p.toFixed(2)} margin=${pick.margin.toFixed(2)}` : '없음(MCTS로)'));
}
// ④ R3 게이트
{
	const g = mkGame(3, 3, 2);
	check('④ R3 → 오버라이드 없음', BotLogic.earlyHumanPick(g, ME, cands) === null);
}
console.log(failed ? `\n실패 ${failed}건` : '\n전부 통과');
process.exit(failed ? 1 : 0);
