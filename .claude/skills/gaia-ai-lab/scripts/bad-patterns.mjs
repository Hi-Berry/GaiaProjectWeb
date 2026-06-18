#!/usr/bin/env node
// 사람 게임 로그(data/human-games/*.json)에서 봇 vs 사람 행동을 비교해 약점 신호를 뽑는다.
// fullGameLog의 액션/디테일을 파싱. playerId가 'bot-'로 시작 = 봇.
//
// 현재 측정 지표:
//   - 연방당 위성 수 분포 (사람은 적게 모아서, 봇은 멀리 흩뿌리는지)  ← "Formed federation (N 위성, ...)"
//   - 연방 횟수/게임
// 새 지표 추가는 아래 PATTERNS에 한 항목씩.
//
// 사용법: node bad-patterns.mjs [data/human-games 경로]
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] || 'data/human-games';
if (!fs.existsSync(dir)) { console.error(`경로 없음: ${dir}`); process.exit(1); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const stat = { human: { sats: [], feds: 0, games: 0 }, bot: { sats: [], feds: 0, games: 0 } };

for (const f of files) {
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const log = g.fullGameLog || g.gameLog || [];
  for (const e of log) {
    if (e.action !== 'Federation') continue;
    const who = (e.playerId || '').startsWith('bot-') ? 'bot' : 'human';
    const m = /(\d+)\s*위성/.exec(e.details || '');
    if (m) { stat[who].sats.push(Number(m[1])); stat[who].feds++; }
  }
}

const summ = (arr) => {
  if (!arr.length) return 'n=0';
  const s = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
  const dist = s.reduce((o, v) => { o[v] = (o[v] || 0) + 1; return o; }, {});
  return `n=${arr.length} avg=${avg.toFixed(2)} median=${s[Math.floor(s.length / 2)]} dist=${JSON.stringify(dist)}`;
};

console.log('=== 연방당 위성 수 (사람 vs 봇) — 봇이 사람보다 크게 높으면 sprawl 문제 ===');
console.log('HUMAN:', summ(stat.human.sats));
console.log('BOT  :', summ(stat.bot.sats));
console.log('\n참고: 둔한 위성캡/빌드페널티로 줄이는 시도는 과거 실패(DECISIONS.md). 연방형성+티어업글 의사결정으로 접근할 것.');
