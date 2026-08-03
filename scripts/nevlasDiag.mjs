// 네블라스 저득점 원인 진단 — 실게임(data/human-games) 좌석 단위 비교.
// 3-way 대조: ①봇 nevlas ②사람 nevlas(목표치) ③봇 그외종족(봇 평균) — 어느 지표가 '네블라스 고유'로 무너지는지 분리.
// 종족 정체성: 의회(PI)=bowl3 토큰1개가 파워2 (모든 파워비용 절반, ceil), 연구소=지식 대신 파워+2 수입,
//              기본능력=bowl3 토큰→가이아+1지식. 즉 **PI·연구소가 엔진의 전부**인 종족.
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const isBotName = n => /^AI Bot/i.test((n || '').trim());
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

const seats = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  const ps = g.players || {};
  if (!Object.values(ps).some(p => (p.score || 0) >= 120)) continue;   // 완주 근사
  const structOf = {};                                                  // pid -> {mine,ts,lab,pi,ac}
  for (const t of (g.map || [])) {
    if (!t.ownerId || !t.structure) continue;
    const s = structOf[t.ownerId] = structOf[t.ownerId] || { mine: 0, ts: 0, lab: 0, pi: 0, ac: 0 };
    if (t.structure === 'mine') s.mine++;
    else if (t.structure === 'trading_station') s.ts++;
    else if (t.structure === 'research_lab') s.lab++;
    else if (t.structure === 'planetary_institute') s.pi++;
    else if (t.structure === 'academy') s.ac++;
  }
  // 타이밍/행동: fullGameLog
  const ev = {};   // pid -> {piRound, firstLabRound, powerAct, convert, gaiaform, labRounds:[]}
  for (const e of (g.fullGameLog || [])) {
    const pid = e.playerId; if (!pid) continue;
    const x = ev[pid] = ev[pid] || { piRound: null, labRounds: [], powerAct: 0, convert: 0, research: 0, mineR: [] };
    const a = e.action || '', d = e.details || '';
    if (/^Upgraded to Planetary/i.test(a) && x.piRound == null) x.piRound = e.round;
    if (/^Upgraded to Research Lab/i.test(a)) x.labRounds.push(e.round);
    if (/Power Action|Q\.I\.C|QIC Action/i.test(a)) x.powerAct++;
    if (/Convert/i.test(a) || /convert/i.test(d)) x.convert++;
    if (/Advanced Research/i.test(a)) x.research++;
    if (/Built Mine/i.test(a)) x.mineR.push(e.round);
  }
  for (const [pid, p] of Object.entries(ps)) {
    const st = structOf[pid] || { mine: 0, ts: 0, lab: 0, pi: 0, ac: 0 };
    const e = ev[pid] || { piRound: null, labRounds: [], powerAct: 0, convert: 0, research: 0, mineR: [] };
    const res = p.research || {};
    seats.push({
      faction: p.faction, bot: isBotName(p.name), score: p.score || 0,
      tech: (p.techTiles || []).length, fed: (p.federations || []).length,
      resSum: TRACKS.reduce((s, t) => s + (res[t] || 0), 0),
      science: res.science || 0, eco: res.economy || 0,
      ...st, struct: st.mine + st.ts + st.lab + st.pi + st.ac,
      piRound: e.piRound, labs: e.labRounds.length, firstLab: e.labRounds.length ? Math.min(...e.labRounds) : null,
      powerAct: e.powerAct, convert: e.convert, researchActs: e.research,
      mines12: e.mineR.filter(r => r <= 2).length,
    });
  }
}

const avg = (a, k) => a.length ? a.reduce((s, x) => s + (Number(x[k]) || 0), 0) / a.length : 0;
const avgNN = (a, k) => { const v = a.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const botNev = seats.filter(s => s.bot && s.faction === 'nevlas');
const humNev = seats.filter(s => !s.bot && s.faction === 'nevlas');
const botOth = seats.filter(s => s.bot && s.faction !== 'nevlas');
const humOth = seats.filter(s => !s.bot && s.faction !== 'nevlas');

const KEYS = [
  ['score', '최종점수'], ['struct', '건물총수'], ['mine', '광산'], ['ts', '교역소'], ['lab', '연구소'],
  ['pi', '의회(PI)'], ['ac', '아카데미'], ['tech', '기술타일'], ['fed', '연방'], ['resSum', '연구합'],
  ['science', '과학트랙'], ['eco', '경제트랙'], ['powerAct', '파워액션'], ['researchActs', '연구액션'],
  ['convert', '변환행동'], ['mines12', 'R1-2광산'],
];
console.log(`좌석: 봇 nevlas ${botNev.length} / 사람 nevlas ${humNev.length} / 봇 그외 ${botOth.length} / 사람 그외 ${humOth.length}\n`);
console.log('지표'.padEnd(12) + '봇nev   봇그외   Δ(nev-그외)   사람nev   사람그외');
for (const [k, label] of KEYS) {
  const bn = avg(botNev, k), bo = avg(botOth, k), hn = avg(humNev, k), ho = avg(humOth, k);
  const d = bn - bo;
  const mark = Math.abs(d) > 0.15 * Math.max(1, Math.abs(bo)) ? (d > 0 ? ' ▲' : ' ▼') : '';
  console.log(label.padEnd(12) + bn.toFixed(2).padStart(6) + bo.toFixed(2).padStart(8) + (d >= 0 ? '+' : '') + d.toFixed(2).padStart(9) + mark.padEnd(3) + hn.toFixed(2).padStart(8) + ho.toFixed(2).padStart(9));
}
const pr = a => { const v = avgNN(a, 'piRound'); return v == null ? '없음' : v.toFixed(2); };
const fl = a => { const v = avgNN(a, 'firstLab'); return v == null ? '없음' : v.toFixed(2); };
console.log('\nPI 건설 라운드   봇nev ' + pr(botNev) + ' (건설비율 ' + (botNev.filter(s => s.piRound != null).length / botNev.length * 100).toFixed(0) + '%)' +
  ' | 봇그외 ' + pr(botOth) + ' (' + (botOth.filter(s => s.piRound != null).length / botOth.length * 100).toFixed(0) + '%)' +
  ' | 사람nev ' + pr(humNev) + ' (' + (humNev.filter(s => s.piRound != null).length / Math.max(1, humNev.length) * 100).toFixed(0) + '%)');
console.log('첫 연구소 라운드 봇nev ' + fl(botNev) + ' (보유비율 ' + (botNev.filter(s => s.labs > 0).length / botNev.length * 100).toFixed(0) + '%)' +
  ' | 봇그외 ' + fl(botOth) + ' (' + (botOth.filter(s => s.labs > 0).length / botOth.length * 100).toFixed(0) + '%)' +
  ' | 사람nev ' + fl(humNev) + ' (' + (humNev.filter(s => s.labs > 0).length / Math.max(1, humNev.length) * 100).toFixed(0) + '%)');
