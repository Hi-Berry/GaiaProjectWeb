/** B4 진단: 내 롤아웃 ρ vs 단순 베이스라인들. 모델이 신호를 더하나, 롤아웃이 돕나/해치나. */
import fs from 'fs';
import readline from 'readline';
import type { SimPlayer } from '../server/ai/simModel';
import { simRolloutAbsoluteScores, terminalScore } from '../server/ai/simRollout';

function rowToPlayer(f: number[], id: string): SimPlayer {
    const mines = Math.round(f[11] * 8), ts = Math.round(f[12] * 4), labs = Math.round(f[13] * 3),
        pi = Math.round(f[14] * 1), aca = Math.round(f[15] * 2), feds = Math.round(f[22] * 3);
    const research = [f[16], f[17], f[18], f[19], f[20], f[21]].map(x => Math.round(x * 5));
    const totalPower = mines + ts * 2 + labs * 2 + pi * 3 + aca * 3;
    const clusterPowers: number[] = []; let rem = totalPower; while (rem > 0) { const c = Math.min(rem, 6); clusterPowers.push(c); rem -= c; }
    const round = Math.round(f[0] * 6); const slotBase = Math.max(0, 5 - round);
    return { id, faction: 'terran', ore: Math.round(f[3] * 15), credits: Math.round(f[4] * 20), knowledge: Math.round(f[5] * 15),
        qic: Math.round(f[6] * 8), p1: Math.round(f[7] * 12), p2: Math.round(f[8] * 12), p3: Math.round(f[9] * 12), brainBowl: 0,
        score: Math.round(f[2] * 100), mines, ts, labs, pi, academies: aca, research, feds, techTiles: Math.round(f[23] * 6),
        gaiaformers: Math.round(f[24] * 3), bonusTileId: null, reachableSlots: { s0: slotBase, s1: slotBase, s2: slotBase },
        clusterPowers, passed: false, artifacts: [], income: { ore: mines * 0.6 + 1, credits: ts * 2 + pi * 2 + 1, knowledge: labs + research[5] + 1, qic: 0, powerCharge: pi * 2, powerTokens: 0 } };
}
function spearman(xs: number[], ys: number[]): number {
    const rank = (arr: number[]) => { const idx = arr.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
    const rx = rank(xs), ry = rank(ys), n = xs.length, mx = rx.reduce((a, b) => a + b) / n, my = ry.reduce((a, b) => a + b) / n;
    let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return num / Math.sqrt(dx * dy);
}
async function main() {
    const rollout: number[] = [], termOnly: number[] = [], baseScore: number[] = [], baseStruct: number[] = [], y: number[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream('data/valuenet-data.jsonl'), crlfDelay: Infinity });
    let seen = 0;
    for await (const line of rl) {
        if (!line.trim() || y.length >= 4000) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (!o.bot || o.y == null || !Array.isArray(o.f)) continue;
        const round = Math.round(o.f[0] * 6); if (round < 2 || round > 4) continue;
        if (seen++ % 7 !== 0) continue;
        const p = rowToPlayer(o.f, 'me');
        rollout.push(simRolloutAbsoluteScores({ round: Math.max(1, round), meId: 'me', players: [p], powerActionsAvail: 6 })[0]);
        termOnly.push(terminalScore(p));
        baseScore.push(o.f[2] * 100);
        baseStruct.push(p.mines + p.ts + p.labs + p.pi + p.academies + p.feds * 2 + p.research.reduce((a, b) => a + b, 0));
        y.push(o.y);
    }
    console.log(`샘플 ${y.length} (중반 R2-4 봇)`);
    console.log(`ρ(내 롤아웃)        = ${spearman(rollout, y).toFixed(3)}`);
    console.log(`ρ(종료점수만,롤아웃X) = ${spearman(termOnly, y).toFixed(3)}  ← 롤아웃이 도움?`);
    console.log(`ρ(현재점수만)        = ${spearman(baseScore, y).toFixed(3)}  ← 단순 베이스라인`);
    console.log(`ρ(구조물+연구 합)     = ${spearman(baseStruct, y).toFixed(3)}  ← 엔진크기 베이스라인`);
}
main();
