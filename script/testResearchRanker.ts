/**
 * 스모크 테스트: [researchRankerSort] 연구 전용 랭커가 봇 안에서 실제로 점수를 내고 순서를 바꾸는가.
 *
 * DECISIONS.md 교훈("플래그 추가 시 전제조건 발화율부터 측정")에 따라 h2h 40판을 태우기 전에
 * ①가중치 로드 ②advance_research 후보에만 점수 ③순서가 봇 기본과 실제로 달라짐 을 먼저 확인한다.
 *
 * 사용: PORT=5094 npx tsx script/testResearchRanker.ts
 */
import { BotLogic } from '../server/ai/bot';

const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const;
const ME = 'p_test';

/** 육각 좌표 몇 개짜리 소형 맵 — 내 광산 1개 + 삽 행성 + 트랜스딤 + 먼 행성 */
function mkGame(round: number, research: Partial<Record<string, number>>) {
	const map: Record<string, unknown>[] = [
		{ id: 't1', q: 0, r: 0, type: 'terra', sector: 1, ownerId: ME, structure: 'mine' },
		{ id: 't2', q: 1, r: 0, type: 'volcanic', sector: 1, ownerId: null, structure: null },   // 1삽, 사거리 1
		{ id: 't3', q: 3, r: 0, type: 'desert', sector: 1, ownerId: null, structure: null },     // 사거리 3 (nav 필요)
		{ id: 't4', q: 2, r: 0, type: 'transdim', sector: 1, ownerId: null, structure: null },   // 가이아 대상
		{ id: 't5', q: 5, r: 0, type: 'space', sector: 1, ownerId: null, structure: null },
		{ id: 't6', q: 0, r: 2, type: 'swamp', sector: 1, ownerId: null, structure: null },      // 거리 2 — nav L1→L2에서 새로 열림
	];
	const player: Record<string, unknown> = {
		name: 'T', faction: 'terran', ore: 3, credits: 8, knowledge: 4, qic: 1,
		power1: 2, power2: 3, power3: 1, research: { ...research }, techTiles: [], federations: [],
	};
	return { id: 'g', roundNumber: round, players: { [ME]: player }, map } as never;
}

const cands = TRACKS.map(t => ({ type: 'advance_research', params: { trackId: t } })) as never[];

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

// ① 가중치 로드 + 연구 후보에만 점수
{
	const game = mkGame(2, { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 });
	const withOther = [...cands, { type: 'build_mine', params: { tileId: 't2' } }] as never[];
	const s = BotLogic.researchRankerScores(game, ME, withOther);
	check('가중치 로드됨(null 아님)', s !== null);
	if (s) {
		check('연구 후보 6개 전부 점수 있음', s.slice(0, 6).every(x => typeof x === 'number'));
		check('비-연구 후보는 null', s[6] === null);
	}
}

// ② 봇 기본 순서(TRACKS 나열 순)와 실제로 달라지는가
{
	const game = mkGame(2, { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 });
	const s = BotLogic.researchRankerScores(game, ME, cands)!;
	const order = TRACKS.map((t, i) => ({ t, v: s[i] as number })).sort((a, b) => b.v - a.v);
	console.log(`  R2 전 트랙 L0 → 랭커 순위: ${order.map(o => `${o.t}(${o.v.toFixed(2)})`).join(' > ')}`);
	check('1순위가 봇 기본 1순위(terraforming)와 다름', order[0].t !== 'terraforming', `1순위=${order[0].t}`);
	check('economy는 1순위가 아님(진단: 봇 과투자 트랙)', order[0].t !== 'economy', `economy 순위 ${order.findIndex(o => o.t === 'economy') + 1}`);
}

// ③ 기회 피처가 실제로 작동: 사거리 밖 행성이 nav로 열리면 nav 점수가 오른다
{
	const near = mkGame(3, { navigation: 1, terraforming: 1, artificialIntelligence: 1, gaiaProject: 1, economy: 1, science: 1 });
	const sNear = BotLogic.researchRankerScores(near, ME, cands)! as number[];
	// 같은 상태에서 열릴 행성을 없앤 맵(먼 행성 t3 제거)
	const far = mkGame(3, { navigation: 1, terraforming: 1, artificialIntelligence: 1, gaiaProject: 1, economy: 1, science: 1 }) as unknown as { map: { id: string }[] };
	far.map = far.map.filter(t => t.id !== 't6');
	const sFar = BotLogic.researchRankerScores(far as never, ME, cands)! as number[];
	const navI = TRACKS.indexOf('navigation');
	check('nav로 열리는 행성이 있으면 nav 점수가 더 높다', sNear[navI] > sFar[navI],
		`있음 ${sNear[navI].toFixed(3)} vs 없음 ${sFar[navI].toFixed(3)}`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 랭커가 봇 안에서 점수를 내고 순서를 바꿉니다.');
process.exit(0);
