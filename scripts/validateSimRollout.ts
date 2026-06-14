/** B4 분수령 검증: (A) 속도 게이트 (B) 정확도 게이트 ρ≥0.6 vs 실제 결과(valuenet y). */
import fs from 'fs';
import readline from 'readline';
import type { SimState, SimPlayer } from '../server/ai/simModel';
import { simRollout, simRolloutAbsoluteScores } from '../server/ai/simRollout';

// features.ts 순서로 feature row → SimPlayer 복원 (clusters/slots/income은 근사)
function rowToPlayer(f: number[], id: string): SimPlayer {
    const mines = Math.round(f[11] * 8), ts = Math.round(f[12] * 4), labs = Math.round(f[13] * 3),
        pi = Math.round(f[14] * 1), aca = Math.round(f[15] * 2), feds = Math.round(f[22] * 3);
    const research = [f[16], f[17], f[18], f[19], f[20], f[21]].map(x => Math.round(x * 5));
    // 클러스터 근사: 총 건물파워를 ~6짜리 덩어리로 쪼갬(일부 7근처)
    const totalPower = mines * 1 + ts * 2 + labs * 2 + pi * 3 + aca * 3;
    const clusterPowers: number[] = [];
    let rem = totalPower; while (rem > 0) { const c = Math.min(rem, 6); clusterPowers.push(c); rem -= c; }
    clusterPowers.sort((a, b) => b - a);
    // income 근사
    const income = { ore: mines * 0.6 + 1, credits: ts * 2 + pi * 2 + 1, knowledge: labs + research[5] + 1, qic: 0, powerCharge: pi * 2, powerTokens: 0 };
    // slots 근사: 라운드 진행할수록 줄어듦
    const round = Math.round(f[0] * 6);
    const slotBase = Math.max(0, 5 - round);
    return {
        id, faction: 'terran',
        ore: Math.round(f[3] * 15), credits: Math.round(f[4] * 20), knowledge: Math.round(f[5] * 15), qic: Math.round(f[6] * 8),
        p1: Math.round(f[7] * 12), p2: Math.round(f[8] * 12), p3: Math.round(f[9] * 12), brainBowl: 0,
        score: Math.round(f[2] * 100),
        mines, ts, labs, pi, academies: aca, research, feds, techTiles: Math.round(f[23] * 6), gaiaformers: Math.round(f[24] * 3),
        bonusTileId: null, reachableSlots: { s0: slotBase, s1: slotBase, s2: slotBase },
        clusterPowers, passed: false, artifacts: [], income,
    };
}

function spearman(xs: number[], ys: number[]): number {
    const rank = (arr: number[]) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
    const rx = rank(xs), ry = rank(ys), n = xs.length;
    const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return num / Math.sqrt(dx * dy);
}

async function main() {
    // ---------- (A) 속도 게이트 ----------
    const repPlayer = rowToPlayer([2 / 6, 0.6, 0.1, 0.2, 0.3, 0.2, 0.1, 0.2, 0, 0, 0, 0.3, 0.1, 0, 0, 0, 0.1, 0.2, 0, 0, 0.2, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 0, 0, 0, 0], 'me');
    const repState: SimState = { round: 2, meId: 'me', players: [repPlayer], powerActionsAvail: 6 };
    const N = 3000; const t0 = Date.now();
    for (let i = 0; i < N; i++) simRollout(repState);
    const ms = Date.now() - t0; const perSec = N / (ms / 1000); const per600 = perSec * 0.6;
    console.log(`[속도] ${N}롤아웃 ${ms}ms → ${perSec.toFixed(0)}/s = ${per600.toFixed(0)}/0.6초 (게이트 ≥150)`);
    console.log(`       대표상태 예측 최종VP: ${simRolloutAbsoluteScores(repState)[0].toFixed(1)}`);

    // ---------- (B) 정확도 게이트: 실제 y와 상관 ----------
    const preds: number[] = [], actuals: number[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream('data/valuenet-data.jsonl'), crlfDelay: Infinity });
    let seen = 0;
    for await (const line of rl) {
        if (!line.trim() || preds.length >= 4000) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (!o.bot || o.y == null || !Array.isArray(o.f)) continue;
        const round = Math.round(o.f[0] * 6);
        if (round < 2 || round > 4) continue;              // 중반 스냅샷(롤아웃 to 6 신호)
        if (seen++ % 7 !== 0) continue;                    // 샘플링(게임당 과대표집 완화)
        const p = rowToPlayer(o.f, 'me');
        const pred = simRolloutAbsoluteScores({ round: Math.max(1, round), meId: 'me', players: [p], powerActionsAvail: 6 })[0];
        preds.push(pred); actuals.push(o.y);
    }
    const rho = spearman(preds, actuals);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`\n[정확도] 샘플 ${preds.length} | 예측 평균 ${mean(preds).toFixed(1)} vs 실제 평균 ${mean(actuals).toFixed(1)}`);
    console.log(`         Spearman ρ = ${rho.toFixed(3)} (게이트 ≥0.60)`);
    console.log(`\n=== B4 판정 ===`);
    console.log(`속도: ${per600 >= 150 ? '✅ 통과' : '❌ 미달'} (${per600.toFixed(0)}/0.6s)`);
    console.log(`정확도: ${rho >= 0.6 ? '✅ 통과' : (rho >= 0.4 ? '⚠️ 경계' : '❌ 미달')} (ρ=${rho.toFixed(3)})`);
}
main();
