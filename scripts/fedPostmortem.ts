// 종료상태 부검: 미연방 파워>=7 봇 좌석에서 FederationPlanner가 연방을 찾는지.
import fs from 'fs';
import { FederationPlanner } from '../server/ai/federationPlanner';
const POW: Record<string, number> = { mine: 1, trading_station: 2, research_lab: 2, planetary_institute: 3, academy: 3, lost_planet_mine: 1 };
const files = fs.readdirSync('logs').filter(f => f.endsWith('final_state.json'))
  .map(f => ({ f, m: fs.statSync('logs/' + f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 12);
let seats = 0, richSeats = 0, plannerFinds = 0, examples: string[] = [];
for (const { f } of files) {
  let g: any; try { g = JSON.parse(fs.readFileSync('logs/' + f, 'utf8')); } catch { continue; }
  if (!g.players || !g.map) continue;
  for (const pid of Object.keys(g.players)) {
    const p = g.players[pid]; seats++;
    const fedHexes = new Set((g.playerFederationHexes?.[pid] || []) as string[]);
    let unfed = 0;
    for (const t of g.map) {
      if (t.ownerId === pid && t.structure && t.structure !== 'ship' && !fedHexes.has(t.id)) unfed += POW[t.structure] ?? 0;
    }
    const tokens = (p.power1 ?? 0) + (p.power2 ?? 0) + (p.power3 ?? 0);
    if (unfed < 7) continue;
    richSeats++;
    let found: any = null;
    try { found = FederationPlanner.getBestFederationAction(g, pid); } catch (e: any) { /* planner err */ }
    if (found) { plannerFinds++; if (examples.length < 5) examples.push(`${f.slice(5, 18)} ${p.faction} unfedPow=${unfed} tokens=${tokens} → 플래너 발견(위성 ${found.spentTokens ?? '?'}개)`); }
    else if (examples.length < 10) examples.push(`${f.slice(5, 18)} ${p.faction} unfedPow=${unfed} tokens=${tokens} → 플래너 null`);
  }
}
console.log(`좌석 ${seats} | 미연방파워>=7 좌석 ${richSeats} | 그중 플래너가 연방 찾음 ${plannerFinds} (${richSeats ? Math.round(plannerFinds / richSeats * 100) : 0}%)`);
examples.forEach(x => console.log('  ' + x));
process.exit(0);
