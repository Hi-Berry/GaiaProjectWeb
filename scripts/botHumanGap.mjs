// 사람 로그(data/human-games)에서 종족별 봇 vs 사람 행동 갭을 산출.
// 목적: 사용자가 짚어온 유형(PI 타이밍·아카vs랩·연방·연구트랙·유휴자원)의 체계적 발굴.
import fs from 'fs';
const DIR = 'data/human-games';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));

// 종족별 누적: bot/human 각각
const acc = {}; // faction -> {bot:{...}, human:{...}}
function bucket(fac, isBot) {
  acc[fac] ??= { bot: mk(), human: mk() };
  return acc[fac][isBot ? 'bot' : 'human'];
}
function mk() {
  return { n: 0, score: 0, pi: 0, piRoundSum: 0, piRoundN: 0, lab: 0, acad: 0, ts: 0, mine: 0,
    fed: 0, greenFed: 0, idleC: 0, idleO: 0, idlePow: 0, idleQ: 0, idleK: 0,
    firaksDg: 0, research: {}, burn: 0 };
}
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];

for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); } catch { continue; }
  const bots = new Set(g.botPlayerIds || []);
  const map = g.map || [];
  const fl = g.fullGameLog || [];
  // playerId -> 첫 PI 라운드
  const piRound = {}, dgCount = {}, burnCount = {};
  for (const e of fl) {
    const pid = e.playerId; if (!pid) continue;
    const a = e.action || '';
    if (a === 'Upgraded to Planetary Institute' && piRound[pid] == null) piRound[pid] = e.round ?? 0;
    if (a === 'Firaks: Downgrade') dgCount[pid] = (dgCount[pid] || 0) + 1;
    if (/burn/i.test(a) || /Burn/i.test(e.details || '')) burnCount[pid] = (burnCount[pid] || 0) + 1;
  }
  for (const [id, p] of Object.entries(g.players || {})) {
    const b = bucket(p.faction, bots.has(id));
    b.n++;
    b.score += p.score ?? 0;
    const st = map.filter(t => t.ownerId === id && t.structure);
    const lab = st.filter(t => t.structure === 'research_lab').length;
    const acad = st.filter(t => t.structure === 'academy').length;
    const ts = st.filter(t => t.structure === 'trading_station').length;
    const mine = st.filter(t => t.structure === 'mine').length;
    const pi = st.some(t => t.structure === 'planetary_institute') ? 1 : 0;
    b.lab += lab; b.acad += acad; b.ts += ts; b.mine += mine; b.pi += pi;
    if (piRound[id] != null) { b.piRoundSum += piRound[id]; b.piRoundN++; }
    const feds = p.federations || [];
    b.fed += feds.length; b.greenFed += feds.filter(x => x.isGreen).length;
    const r = p.resources || p;
    b.idleC += r.credits ?? 0; b.idleO += r.ore ?? 0; b.idleQ += r.qic ?? 0; b.idleK += r.knowledge ?? 0;
    b.idlePow += (r.power1 ?? 0) + (r.power2 ?? 0) + (r.power3 ?? 0);
    b.firaksDg += dgCount[id] || 0;
    b.burn += burnCount[id] || 0;
    const res = p.research || {};
    for (const t of TRACKS) { b.research[t] = (b.research[t] || 0) + (res[t] ?? 0); }
  }
}

function avg(o, k) { return o.n ? (o[k] / o.n) : 0; }
const rows = [];
for (const [fac, d] of Object.entries(acc)) {
  const h = d.human, bt = d.bot;
  if (h.n < 3 || bt.n < 2) continue; // 표본 부족 제외
  rows.push({
    fac, hN: h.n, bN: bt.n,
    score: [avg(h,'score'), avg(bt,'score')],
    piRound: [h.piRoundN? h.piRoundSum/h.piRoundN:0, bt.piRoundN? bt.piRoundSum/bt.piRoundN:0],
    piRate: [avg(h,'pi'), avg(bt,'pi')],
    lab: [avg(h,'lab'), avg(bt,'lab')],
    acad: [avg(h,'acad'), avg(bt,'acad')],
    mine: [avg(h,'mine'), avg(bt,'mine')],
    fed: [avg(h,'fed'), avg(bt,'fed')],
    idlePow: [avg(h,'idlePow'), avg(bt,'idlePow')],
    idleC: [avg(h,'idleC'), avg(bt,'idleC')],
  });
}
rows.sort((a,b)=> (a.score[1]-a.score[0]) - (b.score[1]-b.score[0])); // 봇이 사람보다 가장 뒤진 종족 먼저

const fmt = (arr) => `사람 ${arr[0].toFixed(1)} vs 봇 ${arr[1].toFixed(1)} (Δ${(arr[1]-arr[0]>=0?'+':'')}${(arr[1]-arr[0]).toFixed(1)})`;
console.log('=== 종족별 봇 vs 사람 갭 (봇 최열세 순) ===\n');
for (const r of rows) {
  console.log(`【${r.fac}】 사람${r.hN}/봇${r.bN}석  점수: ${fmt(r.score)}`);
  console.log(`   PI라운드: ${fmt(r.piRound)} | PI율: ${fmt(r.piRate)} | 아카: ${fmt(r.acad)} | 랩: ${fmt(r.lab)}`);
  console.log(`   연방: ${fmt(r.fed)} | 광산: ${fmt(r.mine)} | 유휴파워: ${fmt(r.idlePow)} | 유휴크레딧: ${fmt(r.idleC)}`);
  console.log('');
}
