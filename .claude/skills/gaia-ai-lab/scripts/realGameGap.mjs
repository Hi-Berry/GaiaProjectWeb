#!/usr/bin/env node
// 실게임(사람+봇 혼합) 로그에서 봇 vs 사람 격차를 한 번에 뽑는 진단 스크립트.
//   node scripts/realGameGap.mjs [--since 2026-08] [--players 4]
// 출력: 점수 분포(<100 비율) · VP 출처 · 라운드별 메인 액션 수 · 패스 순서 · 라운드 시작 자원 ·
//       패스 시 자원 · 라운드별 패스VP · 부스터 선택 분포 · 기술타일 선택 분포.
// 데이터: data/human-games/*.json (fullGameLog=액션, gameLog=snap/base 자원 스냅샷, players=종료 상태)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const since = opt('--since', '2026-08');
const nPlayers = Number(opt('--players', '4'));
const dir = path.join(process.cwd(), 'data', 'human-games');

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f >= since).sort();
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const fmt = x => (Math.round(x * 100) / 100).toFixed(2);
const sumVp = v => Array.isArray(v) ? v.reduce((s, x) => s + (typeof x === 'object' ? (x?.vp || 0) : (x || 0)), 0)
  : (v && typeof v === 'object') ? Object.values(v).reduce((s, x) => s + sumVp(x), 0) : (v || 0);

const K = ['bot', 'hum'];
const seats = { bot: 0, hum: 0 };
const score = { bot: [], hum: [] };
const vpSrc = { bot: {}, hum: {} };
const acts = { bot: {}, hum: {} };          // round -> [count per seat]
const passOrd = { bot: {}, hum: {} };
const startRes = { bot: {}, hum: {} };      // `${r}:${res}` -> []
const passRes = { bot: {}, hum: {} };
const passVp = { bot: {}, hum: {} };
const boost = { bot: {}, hum: {} };         // round -> {tile: n}
const tiles = { bot: {}, hum: {} };
const push = (o, k, v) => { (o[k] ||= []).push(v); };
const inc = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };

const SKIP = new Set(['Received Power', 'Free Actions', 'Power Burn', 'Selected Bonus', 'Income Order', 'Undo Free Action',
  'Selected Bonus Tile', 'Selected Faction', 'Gained Tech Tile', 'Rebellion: Gained Tech Tile', 'Federation Reward',
  'Ship Tech: Advanced track', 'Advanced Tech: Advanced track', 'Tech Tile Bonus', 'Final Mission', 'Economy Track Reward']);

for (const f of files) {
  let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const bots = new Set(d.botPlayerIds || []);
  if (!bots.size || Object.keys(d.players || {}).length !== nPlayers || d.roundNumber !== 6) continue;
  const kOf = pid => bots.has(pid) ? 'bot' : 'hum';
  for (const [pid, p] of Object.entries(d.players)) {
    const k = kOf(pid); seats[k]++;
    score[k].push(p.score || 0);
    for (const [src, v] of Object.entries(p.scoreBreakdown || {})) if (src !== 'finalMissionDetails') push(vpSrc[k], src, sumVp(v));
    push(vpSrc[k], '_techTiles(n)', (p.techTiles || []).length);
    push(vpSrc[k], '_advTiles(n)', (p.techTiles || []).filter(t => t.startsWith('adv-')).length);
    push(vpSrc[k], '_feds(n)', (p.federations || []).length);
    push(vpSrc[k], '_researchSum', Object.values(p.research || {}).reduce((s, x) => s + x, 0));
  }
  const passCnt = {}; const perSeat = {};
  for (const e of d.fullGameLog || []) {
    const pid = e.playerId, r = e.round || 0, a = e.action || '';
    if (!d.players[pid]) continue;
    const k = kOf(pid);
    if (a === 'Selected Bonus') { passCnt[r] = (passCnt[r] || 0) + 1; push(passOrd[k], r, passCnt[r]); }
    else if (r >= 1 && !SKIP.has(a)) { perSeat[pid] ||= {}; inc(perSeat[pid], r); }
    if ((a === 'Gained Tech Tile' || a === 'Rebellion: Gained Tech Tile') && e.tileId) inc(tiles[k], e.tileId);
  }
  for (const pid of Object.keys(d.players)) for (let r = 1; r <= 6; r++) push(acts[kOf(pid)], r, perSeat[pid]?.[r] || 0);
  const seen = new Set();
  for (const e of d.gameLog || []) {
    const pid = e.playerId, r = e.round || 0, a = e.action || '', sn = e.snap, b = e.base;
    if (!d.players[pid] || !r || !sn || !b) continue;
    const k = kOf(pid);
    if (!seen.has(pid + ':' + r) && a !== 'Received Power' && a !== 'Income Order') {
      seen.add(pid + ':' + r);
      for (const res of ['c', 'k', 'o', 'q', 'p3']) push(startRes[k], `${r}:${res}`, b[res] || 0);
    }
    if (a === 'Selected Bonus') {
      for (const res of ['c', 'k', 'o', 'q', 'p3']) push(passRes[k], `${r}:${res}`, sn[res] || 0);
      push(passVp[k], r, (sn.vp || 0) - (b.vp || 0));
      const m = /took (bon-[\w-]+)/.exec(String(e.details || ''));
      if (m && r < 6) { boost[k][r] ||= {}; inc(boost[k][r], m[1]); }
    }
  }
}

const both = (fn) => `${fn('bot')} | ${fn('hum')}`;
console.log(`# 실게임 ${nPlayers}P 혼합 완주 게임 (${since}~): 봇 좌석 ${seats.bot}, 사람 좌석 ${seats.hum}\n`);
console.log(`점수 평균 ${both(k => fmt(mean(score[k])))} · 봇 <100 비율 ${fmt(100 * score.bot.filter(x => x < 100).length / Math.max(1, score.bot.length))}%\n`);

console.log('## VP 출처 / 종료 지표 (bot | hum)');
for (const src of [...new Set([...Object.keys(vpSrc.bot), ...Object.keys(vpSrc.hum)])].sort())
  console.log(`  ${src.padEnd(22)} ${both(k => fmt(mean(vpSrc[k][src] || [])).padStart(7))}`);

console.log('\n## 라운드별 메인 액션 수/좌석 · 패스 순서(1=첫 패스) · 패스VP (bot | hum)');
for (let r = 1; r <= 6; r++)
  console.log(`  R${r} acts ${both(k => fmt(mean(acts[k][r] || [])))}   passOrd ${both(k => fmt(mean(passOrd[k][r] || [])))}   passVP ${both(k => fmt(mean(passVp[k][r] || [])))}`);

console.log('\n## 라운드 시작 자원(수입 후) c/k/o/q/p3 (bot | hum)');
for (let r = 1; r <= 6; r++)
  console.log(`  R${r} ` + ['c', 'k', 'o', 'q', 'p3'].map(res => `${res}:${both(k => fmt(mean(startRes[k][`${r}:${res}`] || [])))}`).join('  '));
console.log('\n## 패스 시점 잔여 자원 (bot | hum)');
for (let r = 1; r <= 6; r++)
  console.log(`  R${r} ` + ['c', 'k', 'o', 'q', 'p3'].map(res => `${res}:${both(k => fmt(mean(passRes[k][`${r}:${res}`] || [])))}`).join('  '));

console.log('\n## 패스 시 집은 부스터(다음 라운드용) 비율 — |차이|>5%p만');
for (let r = 1; r <= 5; r++) {
  const nb = Object.values(boost.bot[r] || {}).reduce((s, x) => s + x, 0) || 1;
  const nh = Object.values(boost.hum[r] || {}).reduce((s, x) => s + x, 0) || 1;
  const all = new Set([...Object.keys(boost.bot[r] || {}), ...Object.keys(boost.hum[r] || {})]);
  const rows = [...all].map(t => [t, (boost.bot[r]?.[t] || 0) / nb, (boost.hum[r]?.[t] || 0) / nh]).filter(x => Math.abs(x[2] - x[1]) > 0.05).sort((a, b) => (b[2] - b[1]) - (a[2] - a[1]));
  console.log(`  R${r}: ` + rows.map(([t, b, h]) => `${t} ${Math.round(b * 100)}%|${Math.round(h * 100)}%`).join(' · '));
}

console.log('\n## 기술타일 획득/좌석 (bot | hum)');
for (const t of [...new Set([...Object.keys(tiles.bot), ...Object.keys(tiles.hum)])].sort())
  console.log(`  ${t.padEnd(22)} ${both(k => fmt((tiles[k][t] || 0) / Math.max(1, seats[k])))}`);
