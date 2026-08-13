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
import { countSpendableTokens, doomedBowl3Tokens } from '../shared/gameConfig';
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

console.log('\n⑥ 제노스: 3그릇 토큰을 소멸 직전에 크레딧으로 긁어도 위성 비용은 그대로');
{
	const need = 3;
	const { game, player } = mk({ p1: 2, p2: 0, p3: 0, ore: 1, faction: 'xenos' });
	const shortfall = need - countSpendableTokens(player);
	check('부족분 1', shortfall === 1, `shortfall=${shortfall}`);
	for (let i = 0; i < shortfall; i++) executeConvertResource(ioStub, game, ME, '1ore-to-1token');
	check('제노스 토큰이 3그릇에', player.power3 === 1, `p1=${player.power1} p3=${player.power3}`);
	const beforeCredits = player.credits;
	// 소멸 직전 1P→1C: 3그릇 → 1그릇으로 내려가면서 크레딧 획득
	for (let i = 0; i < shortfall; i++) executeConvertResource(ioStub, game, ME, '1power-to-1credit');
	check('크레딧을 부족분만큼 챙김', player.credits === beforeCredits + shortfall, `credits=${player.credits}`);
	check('토큰 수는 그대로(위성 비용 동일)', countSpendableTokens(player) === need, `토큰=${countSpendableTokens(player)}`);
	check('토큰이 1그릇으로 내려옴', player.power3 === 0 && player.power1 === 3, `p1=${player.power1} p3=${player.power3}`);
	check('여전히 지불 가능', canPay(player, need) === true);
}

console.log('\n⑦ 소멸 확정 3그릇 토큰 계산(doomedBowl3Tokens) — 전 종족 공통');
{
	// planTokenSpend가 1→2→3 순으로 빼므로, 3그릇에서 나가는 수만 긁어야 한다(더 긁으면 살아남을 토큰을 내림)
	const cases: Array<[S, number, number, string]> = [
		[{ p1: 0, p2: 0, p3: 3, ore: 0 }, 2, 2, '1·2그릇 없음 → 필요 수만큼'],
		[{ p1: 2, p2: 0, p3: 3, ore: 0 }, 2, 0, '1그릇으로 다 충당 → 3그릇 안 건드림'],
		[{ p1: 1, p2: 1, p3: 4, ore: 0 }, 3, 1, '1+2그릇 2개 쓰고 3그릇 1개'],
		[{ p1: 0, p2: 0, p3: 2, ore: 0 }, 5, 2, '모자라도 3그릇 보유분 이상은 안 셈'],
		[{ p1: 5, p2: 5, p3: 5, ore: 0 }, 3, 0, '여유 많으면 0'],
	];
	for (const [st, need, expect, name] of cases) {
		const { player } = mk(st);
		const d = doomedBowl3Tokens(player, need);
		check(name, d === expect, `need=${need} → ${d} (기대 ${expect})`);
	}
}

console.log('\n⑧ 긁은 뒤에도 토큰 수가 같아 비용이 그대로이다');
{
	const need = 3;
	const { game, player } = mk({ p1: 1, p2: 0, p3: 2, ore: 0 });
	const before = countSpendableTokens(player);
	const d = doomedBowl3Tokens(player, need);
	for (let i = 0; i < d; i++) executeConvertResource(ioStub, game, ME, '1power-to-1credit');
	check('크레딧을 소멸분만큼 획득', player.credits === d, `d=${d} credits=${player.credits}`);
	check('토큰 총수 불변', countSpendableTokens(player) === before, `${before} → ${countSpendableTokens(player)}`);
	check('3그릇이 1그릇으로 이동', player.power3 === 0 && player.power1 === 3, `p1=${player.power1} p3=${player.power3}`);
	check('여전히 지불 가능', canPay(player, need) === true);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 부족분만큼 광물을 바꾸면 연방·인공물 토큰 비용이 성립합니다.');
process.exit(0);
