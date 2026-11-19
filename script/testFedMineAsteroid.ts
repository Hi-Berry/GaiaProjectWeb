/**
 * [사용자 룰 2026-09-10] 우주선 연방 '무한 사거리 무료광산' 서버 규칙 스모크:
 *  ① 소행성 + 포머 1개 → 건설 성공, 포머 1개 파괴, 비용 0, pending 해제
 *  ② 소행성 + 포머 0개 → 거부(pending 유지)
 *  ③ 포머 없는 트랜스딤 → 거부
 *  ④ 사거리 밖 일반 행성 → 성공(QIC 미청구), 테라포밍 광석만 청구
 *  ⑦ [사용자 룰 2026-11-19] 란티다: 남의 광산 위 기생 광산 → 성공, 비용 0, 의회 있으면 +2K
 *  ⑥ 남의 가이아 포머가 성숙한(가이아로 바뀐) 칸 → 거부 / 내 성숙 포머 칸 → 성공(QIC 없음, 포머 회수)
 *  ⑤ [사용자 제보 2026-11-19] 의회 지은 다카니안이 새 섹터 원시행성에 → +6VP, +1K +2C, 로그 한 줄(광산 중복 집계 없음)
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
// ⑤ 다카니안(의회 보유) → 새 섹터 원시행성
{
    const g = clone(); const pid = setup(g, 0); const p = g.players[pid];
    const proto = g.map.find(t => t.type === 'proto' && t.sector !== 90 && !t.structure && !g.map.some(o => o.sector === t.sector && o.ownerId === pid));
    if (proto) {
        p.faction = 'darkanians' as any;
        const own = g.map.find(t => t.ownerId === pid && t.structure && t.structure !== 'planetary_institute');
        if (!g.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute') && own) own.structure = 'planetary_institute';
        p.knowledge = 0; p.credits = 0; // 상한(15K·30C) 클램프에 안 걸리게
        const vp0 = p.score ?? 0, k0 = p.knowledge ?? 0, c0 = p.credits ?? 0, logN = g.gameLog.length;
        const ok = executeBuildMine(dummyIo, g, pid, proto.id);
        const added = g.gameLog.slice(logN);
        check('darkanians proto (new sector) → built', ok && proto.structure === 'mine', `ok=${ok}`);
        check('  +6VP proto 이상', (p.score ?? 0) - vp0 >= 6, `vp +${(p.score ?? 0) - vp0}`);
        check('  +1K +2C (Darkanians PI)', (p.knowledge ?? 0) - k0 === 1 && (p.credits ?? 0) - c0 === 2, `k +${(p.knowledge ?? 0) - k0} c +${(p.credits ?? 0) - c0}`);
        check('  광산 로그는 Spaceship Fed 한 줄뿐', added.filter(e => /^(Built Mine|Built Mine on Proto|Spaceship Fed)$/.test(e.action)).length === 1,
            added.map(e => `${e.action}: ${e.details}`).join(' | '));
    } else console.log('SKIP proto (none on map)');
}
// ⑥ 포머 칸
{
    const g = clone(); const pid = setup(g, 0); const p = g.players[pid];
    const other = g.turnOrder.find(id => id !== pid)!;
    const cands = g.map.filter(t => (t.type as string) !== 'gaia' && ['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice'].includes(t.type as string) && !t.structure);
    const [a, b] = cands;
    // a: 남의 성숙 포머, b: 내 성숙 포머
    Object.assign(a, { type: 'gaia', isGaiaformed: true, hasGaiaformer: true, gaiaformerOwnerId: other });
    (g.players[other] as any).pendingGaiaformerTiles = [a.id];
    Object.assign(b, { type: 'gaia', isGaiaformed: true, hasGaiaformer: true, gaiaformerOwnerId: pid });
    (p as any).pendingGaiaformerTiles = [b.id];
    const okA = executeBuildMine(dummyIo, g, pid, a.id);
    check("other's matured gaiaformer tile → rejected", !okA && a.structure === null && g.pendingSpaceshipFedMine?.playerId === pid, `ok=${okA}`);
    const gf0 = p.gaiaformers ?? 0;
    const okB = executeBuildMine(dummyIo, g, pid, b.id);
    check('own matured gaiaformer tile → built, QIC 0, former returned', okB && b.structure === 'mine' && p.qic === 3 && (p.gaiaformers ?? 0) === gf0 + 1 && !b.hasGaiaformer, `ok=${okB} qic=${p.qic} gf=${p.gaiaformers}`);
}
// ⑦ 란티다 기생
{
    const g = clone(); const pid = setup(g, 0); const p = g.players[pid];
    p.faction = 'lantids' as any;
    const own = g.map.find(t => t.ownerId === pid && t.structure && t.structure !== 'planetary_institute');
    if (!g.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute') && own) own.structure = 'planetary_institute';
    const host = g.map.filter(t => t.ownerId && t.ownerId !== pid && t.structure && t.structure !== 'ship' && !t.parasiticMine)
        .sort((x, y) => Math.min(...g.map.filter(m => m.ownerId === pid).map(m => (Math.abs(m.q - y.q) + Math.abs(m.r - y.r))))
            - Math.min(...g.map.filter(m => m.ownerId === pid).map(m => (Math.abs(m.q - x.q) + Math.abs(m.r - x.r)))))[0];
    p.knowledge = 0;
    const ore0 = p.ore, c0 = p.credits, q0 = p.qic, owner0 = host.ownerId, st0 = host.structure;
    const ok = executeBuildMine(dummyIo, g, pid, host.id);
    check('lantids parasitic via fed → built', ok && host.parasiticMine?.ownerId === pid && host.ownerId === owner0 && host.structure === st0, `ok=${ok}`);
    check('  free (ore/credits/qic 그대로), pending 해제', p.ore === ore0 && p.credits === c0 && p.qic === q0 && g.pendingSpaceshipFedMine == null, `ore=${p.ore} c=${p.credits} q=${p.qic}`);
    check('  의회 +2K', p.knowledge === 2, `k=${p.knowledge}`);
}
console.log(`\n${pass} passed, ${fail} failed (${path.basename(file)})`);
process.exit(fail ? 1 : 0);
