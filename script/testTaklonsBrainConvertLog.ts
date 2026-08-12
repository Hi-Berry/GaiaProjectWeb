/**
 * 회귀 테스트: 타클론 프리액션 변환에서 '브레인 스톤을 썼는지'가 로그에 드러나는가.
 *
 * 사용자 지적(2026-08-12): "1B→3C 로그는 뜨는데 왜 3P→1O로 뜰까? 둘 다 브레인스톤으로 바꾼 건데"
 *
 * 원인: 1B→3C는 전용 변환 타입(1brain-to-3credit)이라 자체 로그가 있는데,
 *   광석·QIC·지식은 일반 파워 변환 타입(3power-to-1ore 등)을 재사용해 브레인을 써도 '3P → 1O'로 찍혔다.
 *   → spendTaklonsPower 전후의 brainStoneBowl(3 → 1)로 실제 소비를 판정해 표기를 나눈다.
 *
 * 사용: PORT=5093 npx tsx script/testTaklonsBrainConvertLog.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { executeConvertResource } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_tak';

/** power3에 일반 토큰 reg개 + 브레인(bowl) 을 둔 타클론 */
function mk(reg: number, bowl: 1 | 2 | 3 | null) {
	const player: any = {
		name: 'Tak', faction: 'taklons', ore: 0, credits: 0, knowledge: 0, qic: 0,
		power1: 0, power2: 0, power3: reg, research: {}, techTiles: [], coveredTechTiles: [],
	};
	if (bowl) player.brainStoneBowl = bowl;
	const game: any = {
		id: 'g', currentPhase: 'main', players: { [ME]: player },
		turnOrder: [ME], currentPlayerIndex: 0, roundNumber: 3,
		gameLog: [], gameLogSeq: 0, map: [], hasDoneMainAction: false,
	};
	return { game, player };
}

const lastLog = (game: any) => {
	const l = (game.gameLog || []).filter((e: any) => e.action === 'Free Actions');
	return l.length ? l[l.length - 1].details : '(로그 없음)';
};

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

// --- 광석: 브레인으로 냈으면 1B → 1O, 일반 토큰이면 3P → 1O ---
{
	const { game } = mk(0, 3); // 일반 토큰 없음 → 브레인만
	executeConvertResource(ioStub, game, ME, '3power-to-1ore', true);
	check('브레인으로 광석', lastLog(game), '1B → 1O');
}
{
	const { game } = mk(3, null); // 브레인 없음 → 일반 토큰 3개
	executeConvertResource(ioStub, game, ME, '3power-to-1ore', false);
	check('일반 토큰으로 광석', lastLog(game), '3P → 1O');
}
{
	const { game } = mk(3, 3); // 둘 다 가능한데 보존 선택 → 일반 토큰
	executeConvertResource(ioStub, game, ME, '3power-to-1ore', false);
	check('브레인 보존 선택 시 일반 표기', lastLog(game), '3P → 1O');
}

// --- QIC: 브레인(3) + 일반 1개 ---
{
	const { game } = mk(1, 3);
	executeConvertResource(ioStub, game, ME, '4power-to-1qic', true);
	check('브레인+1P로 QIC', lastLog(game), '1B+1P → 1Q');
}
{
	const { game } = mk(4, null);
	executeConvertResource(ioStub, game, ME, '4power-to-1qic', false);
	check('일반 토큰으로 QIC', lastLog(game), '4P → 1Q');
}

// --- 지식 ---
{
	const { game } = mk(1, 3);
	executeConvertResource(ioStub, game, ME, '4power-to-1knowledge', true);
	check('브레인+1P로 지식', lastLog(game), '1B+1P → 1K');
}
{
	const { game } = mk(4, null);
	executeConvertResource(ioStub, game, ME, '4power-to-1knowledge', false);
	check('일반 토큰으로 지식', lastLog(game), '4P → 1K');
}

// --- 크레딧: 전용 타입과 폴백 경로가 같은 표기여야 한다 ---
{
	const { game } = mk(0, 3);
	executeConvertResource(ioStub, game, ME, '1brain-to-3credit');
	check('전용 타입 1B → 3C', lastLog(game), '1B → 3C');
}
{
	const { game } = mk(0, 3); // 일반 토큰이 없어 브레인 폴백
	executeConvertResource(ioStub, game, ME, '1power-to-1credit');
	check('1P→1C 폴백도 같은 표기', lastLog(game), '1B → 3C');
}
{
	const { game } = mk(1, 3); // 일반 토큰이 있으면 그걸로(브레인 보존)
	executeConvertResource(ioStub, game, ME, '1power-to-1credit');
	check('일반 토큰 있으면 1P → 1C', lastLog(game), '1P → 1C');
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 브레인을 쓴 변환은 모두 1B 표기로 구분됩니다.');
process.exit(0);
