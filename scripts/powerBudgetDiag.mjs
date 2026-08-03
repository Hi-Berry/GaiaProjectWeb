// 파워 수지 진단 — "봇이 파워를 못 받고 못 쓴다"(사용자 가설 2026-08-03) 검증.
// 같은 실게임 안에서 사람 좌석 vs 봇 좌석의 파워 소비를 직접 계측한다(공급은 로그에 이벤트가 없어 소비로 하한 추정).
// 근거: fullGameLog details에 실지불 파워가 찍힘 — 'Power Action — +1 Terraform step (2P)', 'Free Actions — 1P → 2C',
//       'Power Burn', 'Used Tech Action — Gained 4 Power'(획득) 등.
// ★네블라스 의회는 파워비용을 절반(ceil)으로 만들므로, 같은 액션의 지불액 자체가 다르다(사람 2P vs 봇 3P) — 그래서
//   '액션 횟수'와 '지불 파워'를 분리해서 본다. 지불 파워가 적은 게 절약(효율)일 수도, 못 쓴 것일 수도 있어 둘 다 필요.
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const isBotName = n => /^AI Bot/i.test((n || '').trim());

// details에서 소비 파워 추출
function powerSpent(action, details) {
  const d = details || '', a = action || '';
  let sum = 0;
  // 1) 파워액션/우주선/테크액션 등: 괄호 안 실지불 '(NP)'
  for (const m of d.matchAll(/\((\d+)P\)/g)) sum += Number(m[1]);
  // 2) 자유행동 변환: 'NP → ...' (파워 토큰 소비)
  for (const m of d.matchAll(/(?:^|[,\s])(\d+)P\s*(?:→|->)/g)) sum += Number(m[1]);
  // 3) 우주선/종족 액션에 'NP' 비용이 콤마 목록으로 적히는 경우: '1O, 3P'
  if (!/\(\d+P\)/.test(d)) for (const m of d.matchAll(/(?:^|,\s*)(\d+)P(?![a-zA-Z])/g)) {
    if (!/→|->/.test(d.slice(0, m.index))) sum += Number(m[1]);
  }
  return sum;
}
function powerGained(action, details) {
  const d = details || '', a = action || '';
  let sum = 0;
  if (/Gained (\d+) Power/i.test(a + ' ' + d)) sum += Number((a + ' ' + d).match(/Gained (\d+) Power/i)[1]);
  if (/\+(\d+) Power tokens?/i.test(d)) sum += Number(d.match(/\+(\d+) Power tokens?/i)[1]);
  for (const m of d.matchAll(/(?:→|->)\s*(?:[^,]*,\s*)*?(\d+)P\b/g)) sum += Number(m[1]);
  return sum;
}

const seats = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  const ps = g.players || {};
  if (!Object.values(ps).some(p => (p.score || 0) >= 120)) continue;
  const L = g.fullGameLog || [];
  if (!L.length) continue;
  const hasBot = Object.values(ps).some(p => isBotName(p.name));
  const hasHum = Object.values(ps).some(p => !isBotName(p.name));
  if (!hasBot || !hasHum) continue;                       // 같은 게임 내 대조만
  const agg = {};
  for (const e of L) {
    const pid = e.playerId; if (!pid) continue;
    const x = agg[pid] = agg[pid] || { spent: 0, gained: 0, pAct: 0, burn: 0, freeP: 0, acts: 0, tech: 0 };
    const a = e.action || '', d = e.details || '';
    x.acts++;
    x.spent += powerSpent(a, d);
    x.gained += powerGained(a, d);
    if (/^Power Action/i.test(a)) x.pAct++;
    if (/^Power Burn/i.test(a)) x.burn++;
    if (/^Free Actions/i.test(a) && /\d+P\s*(?:→|->)/.test(d)) x.freeP++;
    if (/^Used Tech Action/i.test(a)) x.tech++;
  }
  for (const [pid, p] of Object.entries(ps)) {
    const x = agg[pid] || { spent: 0, gained: 0, pAct: 0, burn: 0, freeP: 0, acts: 0, tech: 0 };
    seats.push({ faction: p.faction, bot: isBotName(p.name), score: p.score || 0, ...x });
  }
}

const avg = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0;
const show = (label, arr) => {
  if (!arr.length) { console.log(label.padEnd(20) + ' (n=0)'); return; }
  console.log(label.padEnd(20) + String(arr.length).padStart(4) +
    avg(arr, 'score').toFixed(1).padStart(8) +
    avg(arr, 'spent').toFixed(1).padStart(9) +
    avg(arr, 'gained').toFixed(1).padStart(9) +
    avg(arr, 'pAct').toFixed(2).padStart(9) +
    avg(arr, 'burn').toFixed(2).padStart(8) +
    avg(arr, 'freeP').toFixed(2).padStart(9) +
    avg(arr, 'acts').toFixed(1).padStart(9));
};
const hum = seats.filter(s => !s.bot), bot = seats.filter(s => s.bot);
console.log('좌석'.padEnd(20) + '  n' + '   점수' + '  지불파워' + '  획득파워' + ' 파워액션' + '   번' + '  P자유행동' + '   총로그');
show('사람 전체', hum);
show('봇 전체', bot);
console.log('');
show('사람 nevlas', hum.filter(s => s.faction === 'nevlas'));
show('봇 nevlas', bot.filter(s => s.faction === 'nevlas'));
console.log('');
show('사람 그외종족', hum.filter(s => s.faction !== 'nevlas'));
show('봇 그외종족', bot.filter(s => s.faction !== 'nevlas'));

// 행동당 파워 소비 = '파워를 얼마나 게임에 녹였나'의 밀도(총행동 차이 보정)
const dens = a => a.length ? (a.reduce((s, x) => s + x.spent, 0) / a.reduce((s, x) => s + x.acts, 0)) : 0;
console.log('\n[총행동 보정] 로그 1건당 지불파워 — 사람 ' + dens(hum).toFixed(3) + ' vs 봇 ' + dens(bot).toFixed(3) +
  '   | nevlas: 사람 ' + dens(hum.filter(s => s.faction === 'nevlas')).toFixed(3) + ' vs 봇 ' + dens(bot.filter(s => s.faction === 'nevlas')).toFixed(3));
