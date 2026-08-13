/**
 * 회귀 테스트: 연방 위성 / 인공물의 '토큰 부족분을 광물로 메우기'.
 *
 * 사용자 요청(2026-08-13): "연방이나 인공물 먹을 때 토큰 부족한 것도 Ore 그만큼 차감시키면서 진행"
 *
 * 클라 확인창은 `countSpendableTokens(p) < 비용` 이고 `ore >= 부족분` 일 때만 뜬 뒤,
 * 부족분만큼 1O→1토큰 프리액션을 실행하고 연방/인공물을 진행한다. 그 전제를 서버 함수로 검증한다:
 *   ① countSpendableTokens가 서버 지불 가능 판정(spendPowerTokens 성공 여부)과 일치하는가
 *      — 특히 타클론 브레인 스톤을 1토큰으로 세는 부분
 *   ② 부족분만큼 변환하면 실제로 지불이 성공하는가 (제노스는 3그릇으로 들어가는 예외 포함)
 *
 * 사용: PORT=5097 npx tsx script/testOreToTokenCover.ts
 */
import { countSpendableTokens } from '../shared/gameConfig';
import { executeConvertResource } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_t';

type S = { p1: number; p2: number; p3: number; ore: number; faction?: string; brain?: 1 | 2 | 3 | null };

function mk(s: S) {
	const player: any = {
		name: 'T', faction: s.faction ?? 'terran', ore: s.ore, credits: 0, knowledge: 0, qic: 0,
		power1: s.p1, power2: s.p2, power3: s.p3, research: {}, techTiles: [], coveredTechTiles: [],
	};
	if (s.brain) player.brainStoneBowl = s.brain;
	const game: any = {
		id: 'g', currentPhase: 'main', players: { [ME]: player }, turnOrder: [ME],
		currentPlayerIndex: 0, roundNumber: 3, gameLog: [], gameLogSeq: 0, map: [], hasDoneMainAction: false,
	};
	return { game, player };
}

/** 서버 spendPowerTokens는 비공개라, 동일 규칙인 planTokenSpend로 지불 가능 여부를 본다 */
import { planTokenSpend } from '../shared/gameConfig';
const canPay = (player: any, n: number) => planTokenSpend(player, n) !== null;

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

console.log('① 토큰 수 계산이 서버 지불 판정과 일치');
for (const s of [
	{ p1: 2, p2: 1, p3: 0, ore: 0 },
	{ p1: 0, p2: 0, p3: 5, ore: 0 },
	{ p1: 1, p2: 1, p3: 1, ore: 0, faction: 'taklons', brain: 2 as const },   // 브레인 포함 4
	{ p1: 0, p2: 0, p3: 0, ore: 0, faction: 'taklons', brain: 3 as const },   // 브레인만 1
	{ p1: 0, p2: 0, p3: 0, ore: 0 },
]) {
	const { player } = mk(s);
	const n = countSpendableTokens(player);
	check(`토큰 ${n}개 — 정확히 ${n}개까지 지불 가능`,
		canPay(player, n) === true && (n === 0 || canPay(player, n + 1) === false),
		`n=${n} pay(n)=${canPay(player, n)} pay(n+1)=${canPay(player, n + 1)}`);
}

console.log('\n② 부족분만큼 1O→1토큰 하면 지불이 성립 (연방 위성 3개)');
{
	const need = 3;
	const { game, player } = mk({ p1: 1, p2: 0, p3: 0, ore: 5 });   // 토큰 1개, 광물 5
	const shortfall = need - countSpendableTokens(player);
	check('부족분 2로 계산', shortfall === 2, `shortfall=${shortfall}`);
	for (let i = 0; i < shortfall; i++) executeConvertResource(ioStub, game, ME, '1ore-to-1token');
	check('변환 후 지불 가능', canPay(player, need) === true, `토큰=${countSpendableTokens(player)} 광물=${player.ore}`);
	check('광물이 부족분만큼만 줄었다', player.ore === 3, `ore=${player.ore}`);
}

console.log('\n③ 인공물 6토큰');
{
	const need = 6;
	const { game, player } = mk({ p1: 0, p2: 2, p3: 0, ore: 9 });
	const shortfall = need - countSpendableTokens(player);
	for (let i = 0; i < shortfall; i++) executeConvertResource(ioStub, game, ME, '1ore-to-1token');
	check('6토큰 확보', canPay(player, need) === true && player.ore === 9 - shortfall,
		`부족분=${shortfall} 토큰=${countSpendableTokens(player)} 광물=${player.ore}`);
}

console.log('\n④ 제노스는 변환 토큰이 3그릇으로 들어간다(그래도 토큰 수는 동일하게 셈)');
{
	const { game, player } = mk({ p1: 0, p2: 0, p3: 0, ore: 3, faction: 'xenos' });
	executeConvertResource(ioStub, game, ME, '1ore-to-1token');
	check('3그릇으로 들어감', player.power3 === 1 && player.power1 === 0, `p1=${player.power1} p3=${player.power3}`);
	check('토큰 수 1개로 계산', countSpendableTokens(player) === 1);
}

console.log('\n⑤ 타클론 브레인이 마지막 1토큰 역할을 한다');
{
	const { player } = mk({ p1: 0, p2: 0, p3: 0, ore: 0, faction: 'taklons', brain: 1 });
	check('브레인만으로 1토큰 지불 가능', countSpendableTokens(player) === 1 && canPay(player, 1) === true);
	check('2토큰은 불가', canPay(player, 2) === false);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 부족분만큼 광물을 바꾸면 연방·인공물 토큰 비용이 성립합니다.');
process.exit(0);
