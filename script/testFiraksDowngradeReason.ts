/**
 * 파이락 다운그레이드 거부 사유 — 서버 함수 직접 검증.
 *
 * 사용자 질문(2026-10-03): "파이락 이미 교역소 4개 있을 때 다운그레이드 누르면 에러 뜨나?"
 *   상태창·액션 칩에서 들어가면 연구소·트랙까지 고른 뒤 서버가 조용히 거부해 무반응이었다.
 *   이제 서버가 firaksDowngradeBlockReason 으로 사유를 돌려주고(game_error), executeFiraksDowngrade 도
 *   같은 함수로 판정한다. 두 곳이 어긋나지 않는지, 기존 동작(성공 시 결과)이 그대로인지 본다.
 *
 * 사용: PORT=5097 npx tsx script/testFiraksDowngradeReason.ts   (서버 모듈을 불러오므로 개발 서버와 다른 포트)
 */
import { firaksDowngradeBlockReason, executeFiraksDowngrade, FIRAKS_DOWNGRADE_TS_FULL_MSG } from '../server/gameState';

const ME = 'p_fk', OTHER = 'p_ot';
function mk(opts: { ts?: number; used?: boolean; myTurn?: boolean; mainDone?: boolean; sciLevel?: number; pi?: boolean } = {}) {
	const { ts = 3, used = false, myTurn = true, mainDone = false, sciLevel = 1, pi = true } = opts;
	const map: any[] = [];
	let n = 0;
	const add = (structure: string, ownerId = ME) => map.push({ id: `t${++n}`, q: n, r: 0, type: 'desert', ownerId, structure });
	if (pi) add('planetary_institute');
	add('research_lab');
	for (let i = 0; i < ts; i++) add('trading_station');
	add('mine');
	const mkP = (faction: string, research: any) => ({
		name: faction, faction, ore: 5, credits: 10, knowledge: 3, qic: 1, power1: 2, power2: 4, power3: 0, score: 10,
		research: { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0, ...research },
		techTiles: [], coveredTechTiles: [], federations: [], usedSpecialActions: used ? ['firaks-downgrade'] : [],
	});
	const game: any = {
		id: 'g', currentPhase: 'main', roundNumber: 2, turnOrder: [ME, OTHER], currentPlayerIndex: myTurn ? 0 : 1,
		hasDoneMainAction: mainDone, players: { [ME]: mkP('firaks', { science: sciLevel }), [OTHER]: mkP('terrans', {}) },
		map, gameLog: [], gameLogSeq: 0, roundScoringTiles: [], spaceships: {}, satellites: {},
	};
	return { game, lab: map.find((t) => t.structure === 'research_lab').id };
}

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// 교역소 4개 — 사용자가 물은 경우
{
	const { game, lab } = mk({ ts: 4 });
	const why = firaksDowngradeBlockReason(game, ME, lab, 'science');
	check(why === FIRAKS_DOWNGRADE_TS_FULL_MSG, `교역소 4개 → 사유 "${why}"`);
	const before = JSON.stringify(game);
	check(executeFiraksDowngrade(game, ME, lab, 'science') === false && JSON.stringify(game) === before, `교역소 4개 → 실행도 거부, 상태 변화 없음`);
}
// 교역소 3개 — 정상 실행(결과가 예전과 같아야 한다)
{
	const { game, lab } = mk({ ts: 3, sciLevel: 1 });
	check(firaksDowngradeBlockReason(game, ME, lab, 'science') === null, `교역소 3개 → 막는 사유 없음`);
	let ok = false, err = '';
	try { ok = executeFiraksDowngrade(game, ME, lab, 'science'); } catch (e: any) { err = e?.message ?? String(e); if (process.env.STACK) console.log(e?.stack?.split('\n').slice(0, 6).join('\n')); }
	const t = game.map.find((x: any) => x.id === lab);
	const p = game.players[ME];
	check(ok && t.structure === 'trading_station' && p.research.science === 2 && p.usedSpecialActions.includes('firaks-downgrade') && game.hasDoneMainAction,
		`교역소 3개 → 실행: 연구소→교역소, 과학 1→${p.research.science}, 사용 표시, 메인 액션 소진${err ? ` (오류: ${err})` : ''}`);
}
// 그 밖의 사유들
const cases: Array<[string, Parameters<typeof mk>[0], string, string]> = [
	['이번 라운드에 이미 사용', { used: true }, 'science', '이번 라운드에 이미 다운그레이드를 사용했습니다.'],
	['남의 턴', { myTurn: false }, 'science', '내 턴이 아닙니다.'],
	['메인 액션 이미 사용', { mainDone: true }, 'science', '이번 턴 메인 액션을 이미 사용했습니다.'],
	['의회 없음', { pi: false }, 'science', '의회가 있어야 다운그레이드할 수 있습니다.'],
	['이미 5단계 트랙', { sciLevel: 5 }, 'science', '이미 최고 단계인 트랙입니다.'],
	['4→5 인데 초록 연방 없음', { sciLevel: 4 }, 'science', '5단계로 올리려면 초록(미사용) 연방이 1개 필요합니다.'],
];
for (const [name, o, track, want] of cases) {
	const { game, lab } = mk(o);
	const why = firaksDowngradeBlockReason(game, ME, lab, track as any);
	check(why === want, `${name} → "${why}"`);
	check(executeFiraksDowngrade(game, ME, lab, track as any) === false, `${name} → 실행도 거부(판정이 한 곳이라 어긋나지 않음)`);
}
// 연구소가 아닌 칸을 골랐을 때
{
	const { game } = mk();
	const ts = game.map.find((x: any) => x.structure === 'trading_station').id;
	check(firaksDowngradeBlockReason(game, ME, ts, 'science') === '되돌릴 내 연구소를 골라 주세요.', `연구소가 아닌 칸 → 사유 안내`);
}

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
