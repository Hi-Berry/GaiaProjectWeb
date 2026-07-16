/** 종료 시점에 '형성 가능했는데 안 만든 연방'이 있는 봇 좌석 계수 — 연방 3개 기본 목표의 낭비 셀 실측 */
import fs from 'fs';
import { FederationPlanner } from '../server/ai/federationPlanner';

const dir = 'D:/GaiaProjectWeb/logs';
const files = fs.readdirSync(dir).filter(f => f.includes('final_state'))
    .map(f => ({ f, t: fs.statSync(dir + '/' + f).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(0, 120);

let seats = 0, unformed = 0, fedDist: Record<string, number> = {};
const byFaction: Record<string, { s: number, u: number }> = {};
for (const { f } of files) {
    let g: any; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
    for (const [pid, p] of Object.entries<any>(g.players || {})) {
        seats++;
        const fedN = (p.federations || []).length;
        fedDist[fedN] = (fedDist[fedN] || 0) + 1;
        let can = false;
        try { can = !!FederationPlanner.getBestFederationAction(g, pid); } catch { /* skip */ }
        if (can) {
            unformed++;
            const fac = p.faction || '?';
            byFaction[fac] = byFaction[fac] || { s: 0, u: 0 };
            byFaction[fac].u++;
        }
        const fac = p.faction || '?';
        byFaction[fac] = byFaction[fac] || { s: 0, u: 0 };
        byFaction[fac].s++;
    }
}
console.log(`좌석 ${seats} | 종료시 형성가능 연방 미형성 ${unformed}석 (${Math.round(100 * unformed / seats)}%)`);
console.log('연방 수 분포:', JSON.stringify(fedDist));
console.log('종족별 미형성/좌석:', Object.entries(byFaction).map(([f, x]) => `${f}:${x.u}/${x.s}`).join(' '));
process.exit(0);
