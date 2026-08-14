/**
 * 회귀 테스트: 편의기능 창의 '예상 점수'가 서버가 이미 반영한 항목을 두 번 더하지 않는가.
 *
 * 리뷰(2026-08-14): 서버는 각 항목을 **발생 시점에 곧바로 score에 넣는다**.
 *   - 패스 VP  : 패스하는 순간 addScore(bonusTilePass)·addScore(techTiles)  [gameState.ts:8501, :2595]
 *   - 종료 정산: addScore(researchTracks / remainingResources / finalMissions) + 비딩 차감
 *                                                                    [:2084 :2091 :2495 :2094]
 * 패널이 그걸 또 더해서 ①한 명이라도 패스하면 순위가 부풀고 ②종료 화면에선 거의 두 배가 됐다.
 *
 * projectScore는 UtilityPanel 내부 함수라 export가 없다 → 같은 shared 규칙으로 기대값을 만들고
 * 패널이 쓰는 입력(hasPassed / currentPhase)에 따라 **더해지면 안 되는 항목이 0인지**를 본다.
 *
 * 사용: PORT=5092 npx tsx script/testProjectScoreNoDoubleCount.ts
 */
import {
	computeBonusTilePassVp, computeAdvancedTechPassVp, endgameLeftoverUnits,
	RESEARCH_TRACKS, RESEARCH_TRACK_END_BONUS, getFinalMissionVp,
	type GaiaGameState, type ResearchTrack,
} from '../shared/gameConfig';

/** UtilityPanel.projectScore와 동일 로직(수정 후) — 함수가 export되면 여기서 직접 import로 바꿀 것 */
function projectScore(game: GaiaGameState, pid: string) {
	const p = game.players[pid];
	const ended = game.currentPhase === 'gameEnd';
	const willPass = !ended && !p.hasPassed;
	const passTile = willPass ? (computeBonusTilePassVp(game, pid)?.vp ?? 0) : 0;
	const passAdv = willPass ? computeAdvancedTechPassVp(game, pid).reduce((s, r) => s + r.vp, 0) : 0;
	const track = ended ? 0 : RESEARCH_TRACKS.reduce((s, t) => {
		const lv = p.research?.[t.id as ResearchTrack] ?? 0;
		return s + (lv >= 5 ? RESEARCH_TRACK_END_BONUS[5] : lv >= 4 ? RESEARCH_TRACK_END_BONUS[4] : lv >= 3 ? RESEARCH_TRACK_END_BONUS[3] : 0);
	}, 0);
	const mission = ended ? 0 : (game.finalMissionIds ?? []).reduce((s, m) => s + getFinalMissionVp(game, pid, m), 0);
	const leftover = ended ? 0 : Math.floor(endgameLeftoverUnits(game, pid, p) / 3);
	const bid = ended ? 0 : -(p.factionBidVp ?? 0);
	const now = p.score ?? 0;
	return { now, pass: passTile + passAdv, track, mission, leftover, bid, total: now + passTile + passAdv + track + mission + leftover + bid };
}

const ME = 'p1';
function mk(opts: { phase?: string; passed?: boolean; score?: number } = {}) {
	const player: any = {
		name: '테스터', faction: 'terran', score: opts.score ?? 50,
		ore: 4, credits: 5, knowledge: 3, qic: 2, power1: 0, power2: 4, power3: 3,
		research: { terraforming: 5, navigation: 4, science: 3, gaiaProject: 0, economy: 0, artificialIntelligence: 0 },
		techTiles: [], coveredTechTiles: [], federations: [],
		bonusTile: 'bon-pass-3vp-mine', factionBidVp: 4,
		hasPassed: !!opts.passed,
	};
	return {
		id: 'g', currentPhase: opts.phase ?? 'main', roundNumber: 5,
		players: { [ME]: player }, turnOrder: [ME], currentPlayerIndex: 0,
		map: [{ id: 't1', q: 0, r: 0, type: 'terra', ownerId: ME, structure: 'mine' }],
		finalMissionIds: [], gameLog: [],
	} as never as GaiaGameState;
}

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

console.log('① 아직 패스 안 함 (진행 중) — 패스·종료 항목 모두 예상치로 더한다');
{
	const s = projectScore(mk(), ME);
	check('트랙 종료 보너스 포함', s.track === RESEARCH_TRACK_END_BONUS[5] + RESEARCH_TRACK_END_BONUS[4] + RESEARCH_TRACK_END_BONUS[3], `track=${s.track}`);
	check('잔여 자원 포함', s.leftover > 0, `leftover=${s.leftover}`);
	check('비딩 차감 포함(음수)', s.bid === -4, `bid=${s.bid}`);
	check('합계 = 현재 + 각 항목', s.total === s.now + s.pass + s.track + s.mission + s.leftover + s.bid);
}

console.log('\n② 이미 패스함 — 패스 VP는 score에 들어 있으므로 다시 더하면 안 된다');
{
	const s = projectScore(mk({ passed: true }), ME);
	check('pass = 0', s.pass === 0, `pass=${s.pass}`);
	check('종료 항목은 그대로 예상', s.track > 0 && s.leftover > 0, `track=${s.track} leftover=${s.leftover}`);
}

console.log('\n③ 게임 종료 — 종료 정산이 전부 score에 들어 있으므로 아무것도 더하면 안 된다');
{
	const s = projectScore(mk({ phase: 'gameEnd', score: 180 }), ME);
	check('pass = 0', s.pass === 0);
	check('track = 0', s.track === 0);
	check('mission = 0', s.mission === 0);
	check('leftover = 0', s.leftover === 0);
	check('bid = 0', s.bid === 0);
	check('합계 = 서버 최종 점수 그대로', s.total === 180, `total=${s.total}`);
}

console.log('\n④ 종료 + 이미 패스 (실제 종료 화면 상태) — 두 배로 뛰지 않는다');
{
	const s = projectScore(mk({ phase: 'gameEnd', passed: true, score: 180 }), ME);
	check('합계 = 180', s.total === 180, `total=${s.total}`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 서버가 이미 score에 넣은 항목을 다시 더하지 않습니다.');
process.exit(0);
