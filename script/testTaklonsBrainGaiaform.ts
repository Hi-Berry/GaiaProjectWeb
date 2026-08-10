/**
 * 회귀 테스트: 타클론 브레인 스톤으로 가이아포밍(가이아포머 배치).
 *
 * 사용자 지적(2026-08-10): "왜 타클론 브레인스톤으로 포밍 못해?"
 *
 * 기존 버그: executePlaceGaiaformer가 spendPowerTokens를 안 쓰고 손으로 그릇을 비우면서
 *   가용량 검사·차감 모두 power1+power2+power3만 봤다 → 브레인 스톤(별도 필드 brainStoneBowl)이
 *   계산에 아예 안 잡혀, 일반 토큰이 1개 모자라면 조용히 return false(클라 버튼은 활성이라 '눌러도 무반응').
 *   연방 위성·인공물 비용(spendPowerTokens)은 2026-06-29에 이미 브레인 1토큰 사용을 지원하고 있었다.
 *
 * 규칙: 브레인은 파워로 낼 땐 3이지만 '토큰 1개'가 필요한 곳에선 1 → 일반 토큰을 먼저 쓰고 부족분 1개만 충당.
 *   쓴 브레인은 가이아 영역(brainStoneInGaia)으로 가고 가이아 단계에 그릇1로 복귀한다(gameState :2678).
 *   gaiaformerPower에는 일반 토큰만 센다(브레인을 같이 세면 복귀 때 없던 토큰이 1개 생긴다).
 *
 * 사용: PORT=5099 npx tsx script/testTaklonsBrainGaiaform.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { executePlaceGaiaformer } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_me';

/** 내 광산(0,0) 바로 옆 (1,0)에 트랜스딤 — 사거리 걱정 없이 배치 가능한 최소 보드 */
function makeGame(power: { power1: number; power2: number; power3: number; brainStoneBowl?: 1 | 2 | 3; brainStoneInGaia?: boolean }, gaiaLevel: number, faction = 'taklons') {
	const player: any = {
		name: 'Me', faction, ore: 0, credits: 0, knowledge: 0, qic: 0,
		research: { gaiaProject: gaiaLevel, navigation: 1 },
		gaiaformers: 2, gaiaformerPower: 0, techTiles: [], coveredTechTiles: [],
		...power,
	};
	const game: any = {
		id: 'g', currentPhase: 'main', hasDoneMainAction: false,
		players: { [ME]: player }, turnOrder: [ME], currentPlayerIndex: 0, roundNumber: 3,
		gameLog: [], gameLogSeq: 0, humanActionJournal: [],
		map: [
			{ id: 'home', q: 0, r: 0, type: 'terra', ownerId: ME, structure: 'mine', hasGaiaformer: false },
			{ id: 'td', q: 1, r: 0, type: 'transdim', ownerId: null, structure: null, hasGaiaformer: false },
		],
	};
	return { game, player };
}

const snap = (p: any) => ({ p1: p.power1, p2: p.power2, p3: p.power3, bs: p.brainStoneBowl, inGaia: !!p.brainStoneInGaia, gfPower: p.gaiaformerPower });

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};

// gaiaProject 레벨 4+ → 토큰 3개 필요.

// [핵심] 일반 토큰 2개 + 브레인 = 3개. 예전엔 일반토큰만 2개로 세어 실패했다.
{
	const { game, player } = makeGame({ power1: 1, power2: 1, power3: 0, brainStoneBowl: 3 }, 4);
	check('일반 2개 + 브레인 → 배치 성공', executePlaceGaiaformer(ioStub, game, ME, 'td'), true);
	check('  일반 2개 소진 + 브레인은 가이아 영역', snap(player), { p1: 0, p2: 0, p3: 0, bs: 3, inGaia: true, gfPower: 2 });
}

// 일반 토큰만으로 충분하면 브레인은 건드리지 않는다(브레인 보존).
{
	const { game, player } = makeGame({ power1: 3, power2: 0, power3: 0, brainStoneBowl: 3 }, 4);
	check('일반 3개면 브레인 미사용', executePlaceGaiaformer(ioStub, game, ME, 'td'), true);
	check('  브레인 그대로, 일반 3개만 이동', snap(player), { p1: 0, p2: 0, p3: 0, bs: 3, inGaia: false, gfPower: 3 });
}

// 브레인까지 합쳐도 모자라면 여전히 거부(자원 증발 없이 원상태 유지).
{
	const { game, player } = makeGame({ power1: 1, power2: 0, power3: 0, brainStoneBowl: 3 }, 4);
	check('일반 1개 + 브레인 = 2개 < 3 → 거부', executePlaceGaiaformer(ioStub, game, ME, 'td'), false);
	check('  자원 그대로', snap(player), { p1: 1, p2: 0, p3: 0, bs: 3, inGaia: false, gfPower: 0 });
}

// 이미 가이아 영역에 있는 브레인은 두 번 못 쓴다.
{
	const { game, player } = makeGame({ power1: 2, power2: 0, power3: 0, brainStoneBowl: 1, brainStoneInGaia: true }, 4);
	check('브레인이 이미 가이아 영역 → 토큰 2개뿐이라 거부', executePlaceGaiaformer(ioStub, game, ME, 'td'), false);
	check('  자원 그대로', snap(player), { p1: 2, p2: 0, p3: 0, bs: 1, inGaia: true, gfPower: 0 });
}

// 레벨 1~2는 6개 필요 — 일반 5 + 브레인 1로 딱 맞는다.
{
	const { game, player } = makeGame({ power1: 2, power2: 2, power3: 1, brainStoneBowl: 2 }, 1);
	check('레벨1(6개): 일반 5 + 브레인 1', executePlaceGaiaformer(ioStub, game, ME, 'td'), true);
	check('  그릇 1→2→3 순으로 비우고 브레인 충당', snap(player), { p1: 0, p2: 0, p3: 0, bs: 2, inGaia: true, gfPower: 5 });
}

// 타클론이 아니면 아무 변화 없어야 한다(회귀 방지).
{
	const { game, player } = makeGame({ power1: 1, power2: 1, power3: 0 }, 4, 'terran');
	check('일반 종족: 토큰 2개면 거부(기존 동작)', executePlaceGaiaformer(ioStub, game, ME, 'td'), false);
	const { game: g2, player: p2 } = makeGame({ power1: 1, power2: 1, power3: 1 }, 4, 'terran');
	check('일반 종족: 토큰 3개면 성공', executePlaceGaiaformer(ioStub, g2, ME, 'td'), true);
	check('  gaiaformerPower 3', snap(p2).gfPower, 3);
	void player;
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 타클론 브레인 스톤이 가이아포밍 토큰 1개로 쓰이고, 일반 토큰이 우선 소모됩니다.');
process.exit(0);
