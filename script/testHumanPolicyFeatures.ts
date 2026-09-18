/**
 * 회귀: server/ai/humanPolicy.ts 피처가 학습 파이썬(build_dataset.py)과 1:1인지 — 파이썬이 만든 픽스처와 대조.
 *   1) python3 - <<'EOF' ... (scratchpad hp_fixture.json 생성, 세션 기록 참고)  2) PORT=5111 npx tsx script/testHumanPolicyFeatures.ts <fixture>
 * 픽스처: {geom, player, my, others, ctx, cands, state[66], cand[][69]}
 */
import * as fs from 'fs';
import { stateFeatures, candFeatures, humanPolicyProbs, STATE_DIM, CAND_DIM, type HPContext } from '../server/ai/humanPolicy';
import { createInitialPlayerState } from '../shared/gameConfig';
const out = (s: string) => fs.writeSync(1, s + '\n');
const fx = JSON.parse(fs.readFileSync(process.argv[2] || '/private/tmp/claude-501/hp_fixture.json', 'utf8'));
const P = 'p1';
const p: any = createInitialPlayerState('T');
Object.assign(p, { faction: fx.player.faction, ...fx.player.resources, research: fx.player.research, techTiles: fx.player.techTiles, federations: fx.player.federations, bonusTile: fx.player.bonusTile, spaceshipsEntered: fx.ctx.entered });
const map = fx.geom.map((t: any) => ({ ...t, ownerId: null, structure: null }));
for (const [tid, m] of Object.entries<any>(fx.my)) { const t = map.find((x: any) => x.id === tid); t.ownerId = P; t.structure = m.structure; }
for (const o of fx.others) { const t = map.find((x: any) => x.id === o.id); t.ownerId = 'p2'; t.structure = o.structure; }
const game: any = { id: 'g', players: { [P]: p, p2: createInitialPlayerState('O') }, map, roundNumber: fx.ctx.round, gameLog: [], spaceships: {} };
const ctx: HPContext = {
	round: fx.ctx.round, my: map.filter((t: any) => t.ownerId === P).map((t: any) => ({ id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector, structure: t.structure })),
	others: map.filter((t: any) => t.ownerId === 'p2'), mySectors: new Set(fx.ctx.my_sectors), enteredCount: fx.ctx.entered.length,
	slotsUsedThisRound: fx.ctx.slots_used_this_round, myActionsThisRound: fx.ctx.my_actions_this_round,
};
let fail = 0;
const cmp = (name: string, a: number[], b: number[]) => {
	if (a.length !== b.length) { out(`  실패 ${name}: 길이 ${a.length} vs ${b.length}`); fail++; return; }
	const bad = a.map((v, i) => [i, v, b[i]] as const).filter(([, v, w]) => Math.abs(v - w) > 1e-6);
	if (bad.length) { out(`  실패 ${name}: ${bad.length}개 불일치 ${JSON.stringify(bad.slice(0, 6))}`); fail++; } else out(`  OK   ${name}`);
};
cmp('state features', stateFeatures(game, P, ctx), fx.state);
fx.cands.forEach((c: any, i: number) => {
	const { type, ...params } = c;
	cmp(`cand[${i}] ${type}`, candFeatures(game, P, { type, params }, ctx), fx.cand[i]);
});
out(`  dims ${STATE_DIM}/${CAND_DIM}`);
const probs = humanPolicyProbs(game, P, fx.cands.map((c: any) => { const { type, ...params } = c; return { type, params }; }));
out(probs ? `  policy probs: ${probs.map((x, i) => `${fx.cands[i].type}=${x.toFixed(3)}`).join(' ')}` : '  실패 모델 로드');
if (!probs) fail++;
out(fail === 0 ? '\n전부 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
