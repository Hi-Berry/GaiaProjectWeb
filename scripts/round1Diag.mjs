// R1 전용 진단 — "스노우볼 게임이니 1라운드만 개선해도 극적"(사용자 2026-08-03).
// 같은 실게임 안에서 사람 좌석 vs 봇 좌석의 **R1 행동 구성과 자원 처리량**을 전면 대조한다.
// R1은 자원이 가장 좁아 선택이 강제적이고, 결과가 6라운드 복리로 굴러간다 → 격차가 있으면 최대 지렛대.
// 자원 처리량은 details의 비용 표기를 파싱('(1O, 2C, 1QIC)', '2O, 3C', '4K→0K').
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const isBotName = n => /^AI Bot/i.test((n || '').trim());

function spent(details) {
  const d = details || ''; const r = { O: 0, C: 0, K: 0, Q: 0, P: 0 };
  // '4K→0K' 형태는 연구비(지식 소모) — 앞의 숫자만
  const kr = d.match(/(\d+)K\s*(?:→|->)\s*\d+K/); if (kr) r.K += Number(kr[1]);
  for (const m of d.matchAll(/(\d+)O\b/g)) r.O += Number(m[1]);
  for (const m of d.matchAll(/(\d+)C\b/g)) r.C += Number(m[1]);
  for (const m of d.matchAll(/(\d+)QIC\b/g)) r.Q += Number(m[1]);
  for (const m of d.matchAll(/\((\d+)P\)/g)) r.P += Number(m[1]);
  return r;
}

const seats = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  const ps = g.players || {};
  if (!Object.values(ps).some(p => (p.score || 0) >= 120)) continue;
  const L = (g.fullGameLog || []).filter(e => e.round === 1);
  if (!L.length) continue;
  const hasBot = Object.values(ps).some(p => isBotName(p.name));
  const hasHum = Object.values(ps).some(p => !isBotName(p.name));
  if (!hasBot || !hasHum) continue;
  const agg = {};
  for (const e of L) {
    const pid = e.playerId; if (!pid) continue;
    const x = agg[pid] = agg[pid] || {
      acts: 0, main: 0, free: 0, mine: 0, ts: 0, lab: 0, pi: 0, acad: 0, research: 0, tech: 0,
      pAct: 0, burn: 0, shipEnter: 0, shipAct: 0, gform: 0, O: 0, C: 0, K: 0, Q: 0, P: 0, convert: 0,
    };
    const a = e.action || '', d = e.details || '';
    x.acts++;
    const s = spent(d); x.O += s.O; x.C += s.C; x.K += s.K; x.Q += s.Q; x.P += s.P;
    if (/^Free Actions|^Undo Free/i.test(a)) { x.free++; if (/(?:→|->)/.test(d)) x.convert++; }
    else if (/^Selected Bonus/i.test(a)) { /* 라운드 종료 */ }
    else x.main++;
    if (/^Built Mine|Built Mine on/i.test(a)) x.mine++;
    if (/^Upgraded to Trading Station|Mine → TS/i.test(a)) x.ts++;
    if (/^Upgraded to Research Lab|TS → Research Lab/i.test(a)) x.lab++;
    if (/^Upgraded to Planetary/i.test(a)) x.pi++;
    if (/^Upgraded to Academy|^Academy \(/i.test(a)) x.acad++;
    if (/^Advanced Research|Advanced track/i.test(a)) x.research++;
    if (/Gained Tech Tile|^Gained Tech/i.test(a)) x.tech++;
    if (/^Power Action/i.test(a)) x.pAct++;
    if (/^Power Burn/i.test(a)) x.burn++;
    if (/^Entered Ship/i.test(a)) x.shipEnter++;
    if (/^(Rebellion|Twilight|Eclipse|TF Mars|Ship Tech)/i.test(a)) x.shipAct++;
    if (/^Placed Gaiaformer/i.test(a)) x.gform++;
  }
  for (const [pid, p] of Object.entries(ps)) {
    const x = agg[pid]; if (!x) continue;
    seats.push({ bot: isBotName(p.name), faction: p.faction, score: p.score || 0, ...x });
  }
}

const hum = seats.filter(s => !s.bot), bot = seats.filter(s => s.bot);
const avg = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0;
const KEYS = [
  ['acts', 'R1 총 로그'], ['main', '주액션'], ['free', '자유행동'], ['convert', '└변환'],
  ['mine', '광산 건설'], ['ts', '교역소 업글'], ['lab', '연구소 업글'], ['pi', '의회 업글'], ['acad', '아카데미'],
  ['research', '연구 전진'], ['tech', '기술타일 획득'], ['pAct', '파워액션'], ['burn', '파워번'],
  ['shipEnter', '우주선 입장'], ['shipAct', '우주선 액션'], ['gform', '가이아포머'],
  ['O', '지출 광석'], ['C', '지출 크레딧'], ['K', '지출 지식'], ['Q', '지출 QIC'], ['P', '지출 파워'],
];
console.log(`R1 대조 — 사람 ${hum.length}석 / 봇 ${bot.length}석 (같은 게임 내, 완주만)\n`);
console.log('지표'.padEnd(16) + '사람'.padStart(8) + '봇'.padStart(8) + '차이'.padStart(9) + '  비율');
for (const [k, label] of KEYS) {
  const h = avg(hum, k), b = avg(bot, k), d = b - h;
  const ratio = h > 0.01 ? (b / h) : null;
  const mark = ratio == null ? '' : (ratio < 0.7 ? ' ◀◀ 봇 부족' : ratio > 1.4 ? ' ▶▶ 봇 과다' : '');
  console.log(label.padEnd(16) + h.toFixed(2).padStart(8) + b.toFixed(2).padStart(8) +
    ((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(9) + (ratio == null ? '   -' : ('  ×' + ratio.toFixed(2))) + mark);
}
// 상위 성적 사람만(진짜 목표치) 대조
const top = hum.filter(s => s.score >= 200);
console.log(`\n[상위 사람 ${top.length}석(200점+) 대비]`);
for (const [k, label] of [['mine', '광산 건설'], ['ts', '교역소 업글'], ['lab', '연구소 업글'], ['pi', '의회 업글'], ['research', '연구 전진'], ['tech', '기술타일 획득'], ['shipAct', '우주선 액션'], ['O', '지출 광석'], ['C', '지출 크레딧']]) {
  const t = avg(top, k), b = avg(bot, k);
  console.log('  ' + label.padEnd(14) + t.toFixed(2).padStart(7) + ' vs 봇 ' + b.toFixed(2).padStart(6) + '   ×' + (t > 0.01 ? (b / t).toFixed(2) : '-'));
}
