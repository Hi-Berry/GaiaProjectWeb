/**
 * 회귀: humanPolicy.ts v2 피처(상태 110·후보 71)가 build_dataset.py v2와 1:1인지 — make_fixture.py 픽스처와 대조.
 *   python3 .claude/skills/gaia-ai-lab/scripts/humanPolicy/make_fixture.py /tmp/fx.json && PORT=5111 npx tsx script/testHumanPolicyFeaturesV2.ts /tmp/fx.json
 */
import * as fs from 'fs';
import { stateFeaturesV2, candFeaturesV2, buildContext, STATE_DIM_V2, CAND_DIM_V2 } from '../server/ai/humanPolicy';
import { createInitialPlayerState, INITIAL_POWER_ACTIONS, ALL_TECH_TILES } from '../shared/gameConfig';
const out = (s: string) => fs.writeSync(1, s + '\n');
const fx = JSON.parse(fs.readFileSync(process.argv[2] || '/private/tmp/claude-501/hp_fixture_v2.json', 'utf8'));
const P = 'p1';
const me: any = createInitialPlayerState('T');
Object.assign(me, { faction: fx.player.faction, ...fx.player.resources, research: fx.player.research, techTiles: fx.player.techTiles, federations: fx.player.federations, bonusTile: fx.player.bonusTile, spaceshipsEntered: fx.ctx.entered, score: fx.scoreBefore });
const map = fx.geom.map((t: any) => ({ ...t, ownerId: null, structure: null }));
for (const [tid, m] of Object.entries<any>(fx.my)) { const t = map.find((x: any) => x.id === tid); t.ownerId = P; t.structure = m.structure; }
// 상대 3명: 건물은 others 배열대로(주인은 p2에 몰아도 피처엔 무관), 자원/VP/부스터/연방/패스는 ctx대로
const opp: any = {};
fx.ctx.others_res.forEach((r: any, i: number) => {
	const o: any = createInitialPlayerState('O' + i);
	Object.assign(o, { faction: 'xenos', ore: r.o, credits: r.c, knowledge: r.k, qic: r.q, power3: r.p3, score: fx.ctx.others_vp[i], federations: [], techTiles: [], hasPassed: i < fx.ctx.others_passed, bonusTile: fx.ctx.others_boosters[i] ?? null });
	opp['p' + (i + 2)] = o;
});
// 상대 연방 합계 4 → 첫 상대에 4개
opp.p2.federations = Array.from({ length: fx.ctx.others_feds }, (_, i) => ({ rewardId: 'fed-8vp-1q', isGreen: true }));
// 고급타일 총 adv_taken(3)장 = 내 1장(adv-imm-2vp-mine) + 상대 2장 (파이썬은 전원 합계를 셈)
opp.p2.techTiles = ['adv-a']; opp.p3.techTiles = ['adv-c'];
for (const o of fx.others) { const t = map.find((x: any) => x.id === o.id); t.ownerId = 'p2'; t.structure = o.structure; }
// 파워액션 사용 상태
const powerActions = INITIAL_POWER_ACTIONS.map(a => ({ ...a, isUsed: fx.ctx.power_used.includes(a.id) }));
// 기술타일 보드: 종류별 4장에서 tech_taken만큼 제거
const byTrack: any = {}; const pool: any[] = [];
ALL_TECH_TILES.forEach((t, i) => { const left = 4 - (fx.ctx.tech_taken[t.id] ?? 0); const arr = Array.from({ length: left }, () => ({ ...t })); if (i < 6) byTrack['trk' + i] = arr; else pool.push(...arr); });
const game: any = { id: 'g', players: { [P]: me, ...opp }, map, roundNumber: fx.ctx.round, gameLog: [], spaceships: { 'internal-0': { usedActionIndices: [1, 3] } }, powerActions, techTilesByTrack: byTrack, techTilesPool: pool };
// 내 이번 라운드 액션 1개 → gameLog에 기록
game.gameLog.push({ playerId: P, round: fx.ctx.round, action: 'Built Mine' });
const ctx = buildContext(game, P);
let fail = 0;
const cmp = (name: string, a: number[], b: number[]) => {
	if (a.length !== b.length) { out(`  실패 ${name}: 길이 ${a.length} vs ${b.length}`); fail++; return; }
	const bad = a.map((v, i) => [i, v, b[i]] as const).filter(([, v, w]) => Math.abs(v - w) > 1e-6);
	if (bad.length) { out(`  실패 ${name}: ${bad.length}개 불일치 ${JSON.stringify(bad.slice(0, 8))}`); fail++; } else out(`  OK   ${name}`);
};
cmp('state v2', stateFeaturesV2(game, P, ctx), fx.state);
fx.cands.forEach((c: any, i: number) => { const { type, ...params } = c; cmp(`cand[${i}] ${type}`, candFeaturesV2(game, P, { type, params }, ctx), fx.cand[i]); });
out(`  dims ${STATE_DIM_V2}/${CAND_DIM_V2}`);
out(fail === 0 ? '\n전부 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
