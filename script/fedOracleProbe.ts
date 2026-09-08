/**
 * [연방 갭 2026-09-08] FederationPlanner vs 단순 오라클 — "플래너가 못 찾는 실현 가능 연방"이 있는가?
 *
 * 배경: 사람 로그 갭 프로브에서 R5~6 사람 연방 630건이 봇 후보에 없었고, 자가대국 계측(fedGapDiag)에서 파워는 충분한데
 *   플래너가 전 시작점 null(searchNull)인 결정이 다수(토큰 6+·건물 5+ 포함). 그리디 BFS의 탐색 실패인지, 정당한 불가인지 판별.
 * 오라클(건전한 하한): 연방 밖 컴포넌트(기존 연방 hex 차단) 파워 + 컴포넌트 간 최단 위성 경로(빈 hex BFS)로
 *   ① 단일 컴포넌트 ≥ 요구파워, ② 쌍: d(A,B) ≤ 토큰 & pow ≥ 요구, ③ 삼중(스타/체인): 두 경로 합 ≤ 토큰 & pow ≥ 요구.
 *   오라클이 찾으면 실제로 그 구성이 합법(서버 규칙: 연방 hex 재사용 금지, 빈 hex, 내 위성 없는 곳). 놓치는 건 있어도 거짓 양성은 없음.
 * 입력: logs/*_final_state.json (게임 종료 상태) 또는 인자로 파일들. 이비츠(누적 규칙)·타클론 브레인은 단순화를 위해 제외.
 * 실행: npx tsx script/fedOracleProbe.ts [--limit N] [files...]
 */
import fs from 'fs';
import path from 'path';
import { FederationPlanner } from '../server/ai/federationPlanner';
import { getFederationRequiredPower, getFederationBuildingPower, getPlanetConnectedComponent } from '../server/gameState';
import { getNeighbors, isEmptyHex } from '../shared/gameConfig';

const args = process.argv.slice(2);
const li = args.indexOf('--limit'); const LIMIT = li >= 0 ? Number(args[li + 1]) : Infinity;
const fileArgs = args.filter((a, i) => !a.startsWith('--') && (li < 0 || i !== li + 1));
const files = fileArgs.length ? fileArgs : fs.readdirSync('logs').filter(f => /_final_state\.json$/.test(f)).map(f => path.join('logs', f));

type Comp = { ids: Set<string>; power: number };
const stat = { players: 0, bothNone: 0, bothFeasible: 0, oracleOnly: 0, plannerOnly: 0, skipped: 0 };
const oracleOnlyByFaction: Record<string, number> = {};
const oracleOnlyByK: Record<string, number> = {};
const samples: string[] = [];
let done = 0;
for (const f of files) {
    if (done >= LIMIT) break;
    let game: any; try { game = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!Array.isArray(game.map) || !game.players) continue;
    done++;
    const tileById = new Map<string, any>(game.map.map((t: any) => [t.id, t]));
    for (const [pid, p] of Object.entries<any>(game.players)) {
        if (p.faction === 'ivits' || p.faction === 'taklons') { stat.skipped++; continue; }
        stat.players++;
        const fedHexes: string[] = game.playerFederationHexes?.[pid] || [];
        const blocked = new Set(fedHexes);
        const isOwn = (t: any) => (t.ownerId === pid && t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === pid || t.spaceStation?.ownerId === pid;
        const nodes = game.map.filter((t: any) => isOwn(t) && !blocked.has(t.id));
        const comps: Comp[] = []; const seen = new Set<string>();
        for (const n of nodes) {
            if (seen.has(n.id)) continue;
            const ids = getPlanetConnectedComponent(game, pid, n.id, blocked);
            ids.forEach(id => seen.add(id));
            if (ids.size) comps.push({ ids, power: getFederationBuildingPower(game, pid, ids) });
        }
        const req = getFederationRequiredPower(game, pid);
        const tokens = (p.power1 || 0) + (p.power2 || 0) + (p.power3 || 0);
        // 빈 hex 그래프(내 위성 없는 곳)
        const emptyOk = (t: any) => { if (!isEmptyHex(t) || blocked.has(t.id)) return false; const s = game.satellites?.[t.id]; const arr = Array.isArray(s) ? s : (s ? [s] : []); return !arr.includes(pid); };
        const distFrom = (c: Comp): Map<string, number> => {
            const dist = new Map<string, number>(); const q: string[] = [];
            for (const id of c.ids) for (const nb of getNeighbors(game.map, tileById.get(id))) if (emptyOk(nb) && !dist.has(nb.id)) { dist.set(nb.id, 1); q.push(nb.id); }
            while (q.length) { const cur = q.shift()!; const d = dist.get(cur)!; for (const nb of getNeighbors(game.map, tileById.get(cur))) if (emptyOk(nb) && !dist.has(nb.id)) { dist.set(nb.id, d + 1); q.push(nb.id); } }
            return dist;
        };
        const dists = comps.map(distFrom);
        const pairD = (i: number, j: number): number => { let best = Infinity; for (const id of comps[j].ids) for (const nb of getNeighbors(game.map, tileById.get(id))) { const d = dists[i].get(nb.id); if (d != null && d < best) best = d; } return best; };
        let feasible: string | null = null;
        for (let i = 0; i < comps.length && !feasible; i++) if (comps[i].power >= req) feasible = 'single';
        const D: number[][] = comps.map(() => comps.map(() => Infinity));
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) { D[i][j] = D[j][i] = pairD(i, j); }
        for (let i = 0; i < comps.length && !feasible; i++) for (let j = i + 1; j < comps.length && !feasible; j++)
            if (D[i][j] <= tokens && comps[i].power + comps[j].power >= req) feasible = `pair d=${D[i][j]}`;
        for (let i = 0; i < comps.length && !feasible; i++) for (let j = 0; j < comps.length && !feasible; j++) for (let k = j + 1; k < comps.length && !feasible; k++) {
            if (i === j || i === k) continue; // i = 중심(스타)
            const cost = D[i][j] + D[i][k];
            if (cost <= tokens && comps[i].power + comps[j].power + comps[k].power >= req) feasible = `triple d=${cost}`;
        }
        let plannerN = 0; let diag: any = null;
        try { plannerN = FederationPlanner.getFederationActions(game, pid, 0, 3).length; diag = FederationPlanner.lastDiag; } catch (e) { plannerN = -1; }
        if (plannerN < 0) { stat.skipped++; continue; }
        if (feasible && plannerN > 0) stat.bothFeasible++;
        else if (!feasible && plannerN === 0) stat.bothNone++;
        else if (feasible && plannerN === 0) {
            stat.oracleOnly++; oracleOnlyByFaction[p.faction] = (oracleOnlyByFaction[p.faction] || 0) + 1;
            const kind = feasible.split(' ')[0]; oracleOnlyByK[kind] = (oracleOnlyByK[kind] || 0) + 1;
            if (samples.length < 12) samples.push(`${path.basename(f)} ${p.faction} R${game.roundNumber} feds=${(p.federations || []).length} tokens=${tokens} req=${req} comps=[${comps.map(c => c.power).join(',')}] ${feasible} | planner starts=${diag?.starts} nulls=${diag?.nulls} max5=${diag?.max5Skipped} powerShort=${diag?.powerShort} structs=${diag?.structures}`);
        } else { stat.plannerOnly++; }
    }
}
console.log(`파일 ${done} · 플레이어 ${stat.players}(제외 ${stat.skipped}) | 둘다없음 ${stat.bothNone} · 둘다있음 ${stat.bothFeasible} · ★오라클만(플래너 미스) ${stat.oracleOnly} · 플래너만 ${stat.plannerOnly}`);
console.log('오라클만 종류:', JSON.stringify(oracleOnlyByK), '| 종족:', Object.entries(oracleOnlyByFaction).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · '));
for (const s of samples) console.log('  ', s);

process.exit(0);
