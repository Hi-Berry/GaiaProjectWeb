/**
 * [사용자 2026-08-28] 수입 순서 선택 UI는 아이타만 — 나머지는 자동 최적 적용 검증.
 * helperTriggerIncomePhase 재진입 경로(incomePhaseAppliedThisRound=true)에 두 대기자
 * (테란=비아이타, 아이타)를 넣고: ①테란은 선택 UI 없이 최적 순서로 즉시 적용
 * ②아이타는 기존대로 pendingIncomeOrder(선택 UI) ③'Income Order' 로그 기록을 확인.
 *
 * 실행: npx tsx script/testIncomeAutoNonItars.ts
 */
import { helperTriggerIncomePhase } from '../server/gameState';

const mkPlayer = (name: string, faction: string, over: Record<string, unknown> = {}) => ({
	name, faction, score: 10, ore: 4, credits: 15, knowledge: 3, qic: 1,
	power1: 1, power2: 4, power3: 2, gaiaformers: 0, research: {}, techTiles: [],
	usedSpecialActions: [], usedTechActions: [], federations: [],
	...over,
});

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, extra = '') => {
	console.log((ok ? '✓' : '✗') + ' ' + label + (extra ? ` — ${extra}` : ''));
	ok ? pass++ : fail++;
};

const game: any = {
	id: 'test-income-auto',
	roundNumber: 3,
	currentPhase: 'income',
	turnOrder: ['pA', 'pB'],
	currentPlayerIndex: 0,
	botPlayerIds: [],
	gameLog: [],
	fullGameLog: [],
	map: [],
	players: {
		// jjc R3 실측 케이스 재현: (1,4,2) + 토큰1 + 충전6 → 최적 (1,0,7)
		pA: mkPlayer('사람A', 'terran', { pendingIncomeItems: [
			{ type: 'tokens', amount: 1, id: 't1' },
			{ type: 'power', amount: 6, id: 'p1' },
		] }),
		pB: mkPlayer('사람B', 'itars', { pendingIncomeItems: [
			{ type: 'tokens', amount: 1, id: 't1' },
			{ type: 'power', amount: 4, id: 'p1' },
		] }),
	},
	pendingIncomeOrder: null,
	incomePhaseAppliedThisRound: true, // 재진입 경로
};

const ioStub: any = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };

helperTriggerIncomePhase(ioStub, game);

const a = game.players.pA;
check('비아이타(테란): 선택 UI 없이 즉시 적용', !a.pendingIncomeItems);
check('비아이타(테란): 최적 순서(충전 먼저) 결과 (1,0,7)', a.power1 === 1 && a.power2 === 0 && a.power3 === 7, `실제 (${a.power1},${a.power2},${a.power3})`);
const ioLog = game.gameLog.find((e: any) => e.action === 'Income Order' && e.playerId === 'pA');
// [사용자 2026-08-28] 로그에 받은 양(영어, 첫 줄) + 그릇 변화(아랫줄, '·' 뒤) 표기
check('비아이타(테란): Income Order 로그에 받은 양+그릇 변화 표기', !!ioLog && /Auto-optimal: Tokens \+1 \/ Power \+6 · 1\/4\/2 → 1\/0\/7/.test(ioLog.details ?? ''), ioLog?.details ?? '로그 없음');
check('아이타: pendingIncomeOrder(선택 UI) 유지', game.pendingIncomeOrder?.playerId === 'pB', String(game.pendingIncomeOrder?.playerId));
const b = game.players.pB;
check('아이타: 파워 미적용(선택 대기)', b.power1 === 1 && b.power2 === 4 && b.power3 === 2, `실제 (${b.power1},${b.power2},${b.power3})`);

// [사용자 2026-08-28] '?' 설정에서 자동 최적을 끈 사람(incomeAutoOff) → 비아이타여도 기존 선택 팝업
const game2: any = {
	...game,
	id: 'test-income-auto-off',
	gameLog: [],
	fullGameLog: [],
	pendingIncomeOrder: null,
	players: {
		pC: mkPlayer('사람C', 'terran', {
			incomeAutoOff: true,
			pendingIncomeItems: [
				{ type: 'tokens', amount: 1, id: 't1' },
				{ type: 'power', amount: 6, id: 'p1' },
			],
		}),
	},
	turnOrder: ['pC'],
};
helperTriggerIncomePhase(ioStub, game2);
const c = game2.players.pC;
check('자동 최적 OFF(테란): pendingIncomeOrder(선택 UI) 생성', game2.pendingIncomeOrder?.playerId === 'pC', String(game2.pendingIncomeOrder?.playerId));
check('자동 최적 OFF(테란): 파워 미적용(선택 대기)', c.power1 === 1 && c.power2 === 4 && c.power3 === 2, `실제 (${c.power1},${c.power2},${c.power3})`);

console.log(`\n${pass + fail}건 중 ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
