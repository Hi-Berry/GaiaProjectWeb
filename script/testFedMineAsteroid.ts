/**
 * [사용자 룰 2026-09-10] 우주선 연방 '무한 사거리 무료광산' 서버 규칙 스모크:
 *  ① 소행성 + 포머 1개 → 건설 성공, 포머 1개 파괴, 비용 0, pending 해제
 *  ② 소행성 + 포머 0개 → 거부(pending 유지)
 *  ③ 포머 없는 트랜스딤 → 거부
 *  ④ 사거리 밖 일반 행성 → 성공(QIC 미청구), 테라포밍 광석만 청구
 * 실행: npx tsx script/testFedMineAsteroid.ts [final_state.json]
 */
import fs from 'fs';
import path from 'path';
import { executeBuildMine, ServerGameState } from '../server/gameState';
import { getTerraformStepsForFaction, getTerraformCost } from '../shared/gameConfig';

const dummyIo = { to: () => ({ emit: () => { /* noop */ } }), emit: () => { /* noop */ } } as any;
const file = process.argv[2] || (() => {
    const fs2 = fs.readdirSync('logs').filter(f => /_final_state\.json$/.test(f)).map(f => path.join('logs', f))
        .map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    // 빈 소행성이 있고 광산 8개 미만 플레이어가 있는 최근 파일
    for (const { f } of fs2.slice(0, 60)) {
        try { const g = JSON.parse(fs.readFileSync(f, 'utf8')); if (g.map.some((t: any) => t.type === 'asteroid' && !t.structure)) return f; } catch { /* skip */ }
    }
    throw new Error('no suitable final_state');
})();
const base: ServerGameState = JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base)) as ServerGameState;

function setup(g: ServerGameState, gf: number) {
    const pid = (g.turnOrder ?? Object.keys(g.players)).find(id => g.map.filter(t => t.ownerId === id && t.structure === 'mine').length < 8 && g.players[id].faction !== 'ivits')!;
    g.currentPhase = 'main' as any;
    g.currentPlayerIndex = g.turnOrder.indexOf(pid);
    g.hasDoneMainAction = true;
    (g as any).pendingPowerOffers = []; (g as any).pendingIncomeOrder = null; (g as any).pendingTurnEndPlayerId = undefined;
    g.pendingSpaceshipFedMine = { playerId: pid };
    const p = g.players[pid];
    p.gaiaformers = gf; (p as any).balTakGaiaformersUsedForQic = 0; p.destroyedGaiaformers = 0;
    p.ore = 10; p.qic = 3; p.credits = 10; p.pendingTerraformSteps = 0;
    return pid;
}
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); ok ? pass++ : fail++; };

// ① 소행성 + 포머 1
{
    const g = clone(); const pid = setup(g, 1); const p = g.players[pid];
    const ast = g.map.find(t => t.type === 'asteroid' && !t.structure)!;
    const ok = executeBuildMine(dummyIo, g, pid, ast.id);
    check('asteroid with former → built', ok && ast.structure === 'mine' && ast.ownerId === pid, `ok=${ok} struct=${ast.structure}`);
    check('  former destroyed', p.gaiaformers === 0 && p.destroyedGaiaformers === 1 && (ast as any).destroyedGaiaformer === true, `gf=${p.gaiaformers} destroyed=${p.destroyedGaiaformers}`);
    check('  no ore/qic charged', p.ore === 10 && p.qic === 3, `ore=${p.ore} qic=${p.qic}`);
    check('  pending cleared', g.pendingSpaceshipFedMine == null);
}
// ② 소행성 + 포머 0
{
    const g = clone(); const pid = setup(g, 0);
    const ast = g.map.find(t => t.type === 'asteroid' && !t.structure)!;
    const ok = executeBuildMine(dummyIo, g, pid, ast.id);
    check('asteroid without former → rejected', !ok && ast.structure === null && g.pendingSpaceshipFedMine?.playerId === pid, `ok=${ok}`);
}
// ③ 포머 없는 트랜스딤
{
    const g = clone(); const pid = setup(g, 1);
    const td = g.map.find(t => t.type === 'transdim' && !t.structure && !t.hasGaiaformer);
    if (td) { const ok = executeBuildMine(dummyIo, g, pid, td.id); check('bare transdim → rejected', !ok && td.structure === null, `ok=${ok}`); }
    else console.log('SKIP transdim (none on map)');
}
// ④ 사거리 밖 일반 행성 → 성공, QIC 미청구, 테라포밍 광석만
{
    const g = clone(); const pid = setup(g, 1); const p = g.players[pid];
    const mine = g.map.filter(t => t.ownerId === pid && t.structure);
    const dist = (a: any, b: any) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
    const far = g.map.filter(t => ['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice'].includes(t.type as string) && !t.structure && !t.ownerId)
        .map(t => ({ t, d: Math.min(...mine.map(m => dist(m, t))) })).sort((a, b) => b.d - a.d)[0];
    if (far) {
        const steps = getTerraformStepsForFaction(g, p.faction!, far.t.type as any); const expOre = 10 - steps * getTerraformCost(p.research.terraforming);
        const ok = executeBuildMine(dummyIo, g, pid, far.t.id);
        check(`far planet (dist ${far.d}, ${steps} steps) → built, QIC untouched, ore charged for steps`, ok && far.t.structure === 'mine' && p.qic === 3 && p.ore === expOre, `ok=${ok} ore=${p.ore}(exp ${expOre}) qic=${p.qic}`);
    } else console.log('SKIP far planet');
}
console.log(`\n${pass} passed, ${fail} failed (${path.basename(file)})`);
process.exit(fail ? 1 : 0);
