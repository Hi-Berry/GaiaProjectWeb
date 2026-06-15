// 강한 사람(1) vs 봇(3) 같은 테이블 게임에서 *신뢰 가능한* 신호만 뽑는다.
//  (1) 사람 빌드오더 스켈레톤: 라운드별로 사람이 뭘 하는지 (actionJournal=전 라운드 완전)
//  (2) 최종상태 갭: 사람 vs 봇의 research/tech/federation 등 (players=전원 게임끝, 완전)
// 주의: gameLog는 마지막 100줄(엔드게임)만 보존 → 봇의 라운드별 행동은 신뢰 불가, 여기선 안 씀.
import fs from 'fs';
import path from 'path';

const DIR = 'data/human-games';
const isBotName = n => /^(AI Bot|Runner|H2HRunner|SelfPlayRunner|Bot|Champion|Challenger)\b/i.test(n || '');
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];

function categorize(action) {
  const a = action || '';
  if (/^Built Mine|^Built Parasitic Mine|^Eclipse: Built mine|^Placed Starting Mine|Build mine on asteroid|Built Mine on Asteroid/i.test(a)) return 'Expand(Mine)';
  if (/^Upgraded to Trading Station|Mine → TS|TS →/i.test(a)) return 'Upgrade→TS';
  if (/^Upgraded to Research Lab|→ Research Lab/i.test(a)) return 'Upgrade→Lab';
  if (/^Upgraded to Academy|^Academy/i.test(a)) return 'Upgrade→Academy';
  if (/^Upgraded to Planetary Institute/i.test(a)) return 'Upgrade→PI';
  if (/^Advanced Research/i.test(a)) return 'Research(track)';
  if (/^Advanced Tech Tile|^Advanced Tech:/i.test(a)) return 'AdvancedTechTile';
  if (/Gained Tech Tile|Gain tech tile|tech tile/i.test(a)) return 'TechTile';
  if (/Used Tech Action|Tech Action/i.test(a)) return 'UseTechAction';
  if (/^Federation Reward/i.test(a)) return 'FederationReward';
  if (/^Federation/i.test(a)) return 'FormFederation';
  if (/^Entered Ship|Spaceship Fed|Ship Tech/i.test(a)) return 'Spaceship';
  if (/^Power Action|^Bonus Action/i.test(a)) return 'PowerAction';
  if (/^Placed Gaiaformer/i.test(a)) return 'Gaiaformer';
  if (/^Terraforming|TF Mars/i.test(a)) return 'Terraform';
  if (/^Artifact:/i.test(a)) return 'Artifact';
  return null; // 자동/반응/패시브 제외
}
const CATS = ['Expand(Mine)','Upgrade→TS','Upgrade→Lab','Upgrade→Academy','Upgrade→PI',
  'Research(track)','AdvancedTechTile','TechTile','UseTechAction','FormFederation','FederationReward',
  'Spaceship','PowerAction','Gaiaformer','Terraform','Artifact'];

const humanByRound = {};   // round -> {cat: count}  (사람 스켈레톤, actionJournal 기반, 전 게임)
const humanEnd = [];       // 사람 최종상태
const botEnd = [];         // 봇 최종상태
let humanGames = 0;

// fullGameLog(전 라운드·봇 포함)가 있는 게임에서만 신뢰 가능한 라운드별 사람 vs 봇 대조
const fullHumanByRound = {}, fullBotByRound = {};
let fullGames = 0, fullBotSeats = 0, fullHumanSeats = 0;

for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const players = g.players || {};
  const humanIds = new Set(Object.entries(players).filter(([, p]) => !isBotName(p.name)).map(([id]) => id));
  if (!humanIds.size || !(g.actionJournal || []).length) continue;
  humanGames++;

  for (const e of g.actionJournal) {
    if (!humanIds.has(e.playerId)) continue;
    const c = categorize(e.action); if (!c) continue;
    const r = e.round ?? 0;
    (humanByRound[r] ??= {})[c] = (humanByRound[r][c] || 0) + 1;
  }

  // fullGameLog: 전 라운드, 사람+봇 모든 액션 → 같은 보드에서 라운드별 대조 가능 (신뢰)
  const full = g.fullGameLog || [];
  if (full.length) {
    fullGames++;
    fullHumanSeats += humanIds.size;
    fullBotSeats += Object.keys(players).length - humanIds.size;
    for (const e of full) {
      const c = categorize(e.action); if (!c) continue;
      const r = e.round ?? 0;
      const bucket = e.isBot ? fullBotByRound : fullHumanByRound;
      (bucket[r] ??= {})[c] = (bucket[r][c] || 0) + 1;
    }
  }

  for (const [id, p] of Object.entries(players)) {
    const stat = {
      score: p.score ?? 0,
      researchTotal: TRACKS.reduce((s, t) => s + (p.research?.[t] ?? 0), 0),
      gaia: p.research?.gaiaProject ?? 0,
      l5: TRACKS.filter(t => (p.research?.[t] ?? 0) >= 5).length,
      tech: (p.techTiles || []).length,
      advTech: (p.techTiles || []).filter(t => /^adv-/.test(String(t))).length,
      fed: (p.federations || []).length,
    };
    (humanIds.has(id) ? humanEnd : botEnd).push(stat);
  }
}

const avg = (arr, k) => arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : 0;
const fmt = n => n.toFixed(2).padStart(5);

// ── (1) 사람 빌드오더 스켈레톤 ────────────────────────────────
console.log(`\n${'='.repeat(64)}\n  강한 사람 빌드오더 스켈레톤 (${humanGames}판, 좌석당 평균 횟수/라운드)\n${'='.repeat(64)}`);
const rounds = Object.keys(humanByRound).map(Number).sort((a, b) => a - b);
for (const r of rounds) {
  const H = humanByRound[r];
  const rows = CATS.map(c => ({ c, v: (H[c] || 0) / humanGames })).filter(x => x.v > 0.1).sort((a, b) => b.v - a.v);
  const label = r === 0 ? 'R0(배치)' : `R${r}`;
  console.log(`\n  ${label}:  ` + rows.map(x => `${x.c} ${x.v.toFixed(1)}`).join('  ·  '));
}

// ── (1b) 라운드별 사람 vs 봇 대조 (fullGameLog 있는 게임 한정 = 신뢰) ──
if (fullGames > 0) {
  console.log(`\n\n${'='.repeat(64)}\n  라운드별 사람 vs 봇 행동 대조 (fullGameLog ${fullGames}판 · H=사람/좌석, B=봇/좌석)\n${'='.repeat(64)}`);
  const rs = [...new Set([...Object.keys(fullHumanByRound), ...Object.keys(fullBotByRound)].map(Number))].sort((a, b) => a - b);
  for (const r of rs) {
    const H = fullHumanByRound[r] || {}, B = fullBotByRound[r] || {};
    const rows = CATS.map(c => ({ c, h: (H[c] || 0) / fullHumanSeats, b: (B[c] || 0) / fullBotSeats }))
      .map(x => ({ ...x, d: x.h - x.b })).filter(x => x.h > 0.05 || x.b > 0.05)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    console.log(`\n  ── ${r === 0 ? 'R0' : 'R' + r} ` + '─'.repeat(36));
    for (const x of rows) {
      const flag = Math.abs(x.d) >= 0.4 ? (x.d > 0 ? '  ◀ 사람↑' : '  ▶ 봇↑') : '';
      console.log(`     ${x.c.padEnd(16)} H${x.h.toFixed(2).padStart(5)}  B${x.b.toFixed(2).padStart(5)}  Δ${(x.d >= 0 ? '+' : '') + x.d.toFixed(2)}${flag}`);
    }
  }
} else {
  console.log(`\n  (아직 fullGameLog가 담긴 게임 없음 — gameLog 100캡 해제 후 새 1:3 게임부터 라운드별 봇 대조 활성화)`);
}

// ── (2) 최종상태 갭 (사람 vs 봇, 전원·전 게임 완전 데이터) ──────────
console.log(`\n\n${'='.repeat(64)}\n  최종상태 갭 — 사람(${humanEnd.length}좌석) vs 봇(${botEnd.length}좌석)\n${'='.repeat(64)}`);
const metrics = [
  ['최종점수 score', 'score'], ['연구합 researchTotal', 'researchTotal'],
  ['가이아트랙 gaia', 'gaia'], ['L5 트랙수 l5', 'l5'],
  ['기술타일 tech', 'tech'], ['고급기술 advTech', 'advTech'], ['연방 fed', 'fed'],
];
console.log(`   ${'지표'.padEnd(22)}  사람     봇      배율`);
for (const [label, k] of metrics) {
  const h = avg(humanEnd, k), b = avg(botEnd, k);
  const ratio = b > 0.01 ? (h / b).toFixed(1) + '×' : (h > 0.01 ? '∞' : '—');
  console.log(`   ${label.padEnd(22)} ${fmt(h)}   ${fmt(b)}    ${ratio.padStart(5)}`);
}
console.log('');
