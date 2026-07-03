// 사람 파워 운영 분석 — human-games/*.json actionJournal(사람 액션만 기록, playerAfter.resources 포함).
// 봇 최대약점 "파워 관리"에서 사람이 실제로 뭘 하는지 계량. (봇 파워상태는 actionJournal에 없어 대조는 별도.)
// 사용: node scripts/analyzeHumanPower.mjs
import fs from 'fs';
const DIR = 'data/human-games';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const isBot = (pid, name) => /^bot-/.test(pid || '') || /bot|runner/i.test(name || '');
const seats = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); } catch { continue; }
  const aj = g.actionJournal || []; if (!aj.length) continue;
  const byPid = {};
  for (const e of aj) {
    const pid = e.playerId; if (!pid || isBot(pid, e.playerName)) continue;
    const s = byPid[pid] || (byPid[pid] = { pid, fac: e.faction, n: 0, pAct: 0, burn: 0, charge: 0, fed: 0, p3sum: 0, ptot: 0, p3R: {}, nR: {}, passP3: [], score: 0 });
    const a = e.action || '', res = e.playerAfter?.resources, rd = e.round || 0;
    s.fac = e.faction || s.fac; s.n++; if (typeof e.scoreAfter === 'number') s.score = e.scoreAfter;
    if (res) { const p3 = res.power3 || 0; s.p3sum += p3; s.ptot += (res.power1 || 0) + (res.power2 || 0) + p3; s.p3R[rd] = (s.p3R[rd] || 0) + p3; s.nR[rd] = (s.nR[rd] || 0) + 1; }
    if (/Power Action/i.test(a)) s.pAct++;
    if (/Power Burn|Burn \(|Taklons: Burn/i.test(a)) s.burn++;
    if (/Power Gained/i.test(a)) s.charge++;
    if (/^Federation\b/i.test(a)) s.fed++;
    if (/Pass|Passed|Selected Bonus/i.test(a) && res) s.passP3.push(res.power3 || 0);
  }
  for (const pid in byPid) if (byPid[pid].n >= 8) seats.push(byPid[pid]);
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`\n=== 사람 파워 운영 (seat ${seats.length}) ===\n`);
for (const [grp, list] of [['전체', seats], ['강한사람(≥150)', seats.filter(s => s.score >= 150)]]) {
  if (!list.length) continue;
  console.log(`[${grp}] n=${list.length}, 평균점수 ${mean(list.map(s => s.score)).toFixed(0)}`);
  console.log(`  파워액션 ${mean(list.map(s => s.pAct)).toFixed(2)} | 파워번 ${mean(list.map(s => s.burn)).toFixed(2)} | 충전 ${mean(list.map(s => s.charge)).toFixed(2)}`);
  console.log(`  보유bowl3(결정당) ${mean(list.map(s => s.n ? s.p3sum / s.n : 0)).toFixed(2)} | 총파워 ${mean(list.map(s => s.n ? s.ptot / s.n : 0)).toFixed(2)} | 패스직전bowl3 ${mean(list.filter(s => s.passP3.length).map(s => mean(s.passP3))).toFixed(2)}`);
}
console.log('\n라운드별 평균 보유 bowl3:');
const sumR = {}, cntR = {}; for (const s of seats) for (const r in s.p3R) { sumR[r] = (sumR[r] || 0) + s.p3R[r]; cntR[r] = (cntR[r] || 0) + s.nR[r]; }
for (let r = 1; r <= 6; r++) console.log(`  R${r}: ${cntR[r] ? (sumR[r] / cntR[r]).toFixed(2) : '-'}`);
