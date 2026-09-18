#!/usr/bin/env node
// 실게임 봇 좌석 A/B 집계 — server/ai/liveExperiment.ts가 배정한 ON/OFF 그룹을 같은 게임 안에서 쌍비교.
//   node scripts/liveAbReport.mjs [--name <실험명>] [--since 2026-09-18]
// 판정 원칙은 head2head와 동일("음수만 거른다"): 게임 내 ON−OFF 평균 차이의 부호·안정성 + 행동 지표.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wantName = opt('--name', null);
const since = opt('--since', '2026-09-18');
const dir = path.join(process.cwd(), 'data', 'human-games');
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const fmt = x => (Math.round(x * 100) / 100).toFixed(2);

const byName = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && f >= since).sort()) {
  let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (d.roundNumber !== 6) continue;
  const bots = new Set(d.botPlayerIds || []);
  const groups = {};
  for (const [pid, p] of Object.entries(d.players || {})) {
    if (!bots.has(pid) || !p.liveVariant?.name) continue;
    if (wantName && p.liveVariant.name !== wantName) continue;
    const g = (groups[p.liveVariant.name] ||= { on: [], off: [] });
    g[p.liveVariant.group === 'on' ? 'on' : 'off'].push({
      score: p.score || 0, faction: p.faction,
      feds: (p.federations || []).length, tiles: (p.techTiles || []).length,
      adv: (p.techTiles || []).filter(t => String(t).startsWith('adv-')).length,
      research: Object.values(p.research || {}).reduce((s, x) => s + x, 0),
    });
  }
  for (const [name, g] of Object.entries(groups)) {
    const acc = (byName[name] ||= { games: 0, pairedDiff: [], on: [], off: [], seatsOn: 0, seatsOff: 0 });
    acc.on.push(...g.on); acc.off.push(...g.off); acc.seatsOn += g.on.length; acc.seatsOff += g.off.length;
    if (g.on.length && g.off.length) { acc.games++; acc.pairedDiff.push(mean(g.on.map(x => x.score)) - mean(g.off.map(x => x.score))); }
  }
}

if (!Object.keys(byName).length) { console.log(`${since} 이후 liveVariant가 기록된 완주 게임이 없습니다. server/ai/liveExperiment.json에 실험을 설정했는지 확인.`); process.exit(0); }
for (const [name, a] of Object.entries(byName)) {
  const se = a.pairedDiff.length > 1 ? sd(a.pairedDiff) / Math.sqrt(a.pairedDiff.length) : 0;
  const m = mean(a.pairedDiff);
  console.log(`# 실험 ${name} — 쌍비교 게임 ${a.games} (ON 좌석 ${a.seatsOn} / OFF 좌석 ${a.seatsOff}, ${since}~)`);
  console.log(`  게임 내 ON−OFF 점수 차: ${fmt(m)} ± ${fmt(se)} (SE)  |  ON 평균 ${fmt(mean(a.on.map(x => x.score)))} · OFF 평균 ${fmt(mean(a.off.map(x => x.score)))}`);
  console.log(`  <100 비율: ON ${fmt(100 * a.on.filter(x => x.score < 100).length / Math.max(1, a.on.length))}% · OFF ${fmt(100 * a.off.filter(x => x.score < 100).length / Math.max(1, a.off.length))}%`);
  for (const k of ['feds', 'tiles', 'adv', 'research'])
    console.log(`  ${k.padEnd(9)} ON ${fmt(mean(a.on.map(x => x[k])))} · OFF ${fmt(mean(a.off.map(x => x[k])))}`);
  const verdict = a.games < 15 ? '판수 부족(15게임+ 권장)' : m < -se ? '❌ 음수 방향 — 기각 후보' : m > se ? '✅ 양수 방향 — 채택 후보(행동 지표 확인)' : '➖ 중립';
  console.log(`  판정 힌트: ${verdict}\n`);
}
