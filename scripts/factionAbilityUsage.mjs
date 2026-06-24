/**
 * 종족 시그니처 능력 사용률 (봇 vs 사람) — 실전 로그에서 각 종족의 핵심 액션을 봇/사람이 얼마나 쓰는지.
 * 봇 사용 ≈0 인데 사람은 쓰는 종족 = "깨끗한 능력 갭" 후보(Firaks류, 고치기 쉬움).
 * 실행: node scripts/factionAbilityUsage.mjs
 */
import fs from 'fs';
const DIR = 'data/human-games';
const isBotName = n => typeof n === 'string' && /^AI Bot/i.test(n.trim());

// 종족 → 시그니처 액션 정규식(로그 action/details 매칭)
const SIG = {
  nevlas: /Nevlas|2P→1K|1P → Gaiaformer|네뷸라/i,
  itars: /Itars PI|Itars.*Gaia|4 ?tokens.*Tech/i,
  firaks: /Firaks: Downgrade/i,
  moweyip: /Moweyip/i,
  ivits: /Ivits: Space Station|Space Station/i,
  gleens: /Gleens:/i,
  geodens: /Geodens Council|Geodens/i,
  darkanians: /Darkanians PI|Darkanians/i,
  hadsch_hallas: /Hadsch Hallas/i,
  lantids: /Lantid|Parasitic/i,
  space_giants: /Space Giants:/i,
  bescods: /Bescods|매안/i,
  taklons: /Taklons:/i,
  tinkeroids: /Tinkeroid/i,
  ambas: /Ambas:/i,
  bal_tak: /bal.?tak|Gaiaformer.*QIC/i,
  terran: /Terran Council/i,
  xenos: /Xenos/i,
};

const stat = {}; // faction -> {botGames, humGames, botUses, humUses}
const ensure = f => stat[f] || (stat[f] = { botGames: 0, humGames: 0, botUses: 0, humUses: 0 });

for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  let g; try { g = JSON.parse(fs.readFileSync(DIR + '/' + file, 'utf8')); } catch { continue; }
  // playerId -> {faction, bot}
  const pinfo = {};
  for (const id of Object.keys(g.players || {})) {
    const p = g.players[id];
    pinfo[id] = { faction: p.faction, bot: isBotName(p.name) };
  }
  // 게임 카운트
  const seen = {};
  for (const id of Object.keys(pinfo)) {
    const { faction, bot } = pinfo[id]; if (!faction) continue;
    const k = faction + (bot ? ':bot' : ':hum'); if (seen[k]) continue; seen[k] = 1;
    const s = ensure(faction); if (bot) s.botGames++; else s.humGames++;
  }
  // 능력 사용 카운트 (로그 entry의 playerId로 종족·봇판정)
  for (const e of (g.fullGameLog || []).concat(g.actionJournal || [])) {
    const pi = pinfo[e.playerId]; if (!pi || !pi.faction) continue;
    const re = SIG[pi.faction]; if (!re) continue;
    const text = (e.action || '') + ' ' + (e.details || '');
    if (re.test(text)) { const s = ensure(pi.faction); if (pi.bot) s.botUses++; else s.humUses++; }
  }
}

const rows = Object.entries(stat).map(([f, s]) => ({
  faction: f,
  botPerGame: s.botGames ? s.botUses / s.botGames : 0,
  humPerGame: s.humGames ? s.humUses / s.humGames : 0,
  botGames: s.botGames, humGames: s.humGames, botUses: s.botUses, humUses: s.humUses,
})).sort((a, b) => (a.botPerGame - a.humPerGame) - (b.botPerGame - b.humPerGame)); // 봇이 사람보다 가장 덜 쓰는 순

console.log('종족        | 봇/게임 | 사람/게임 | 봇사용/판수 | 사람사용/판수 | 갭(봇-사람)');
console.log('-'.repeat(78));
for (const r of rows) {
  const gap = (r.botPerGame - r.humPerGame).toFixed(1);
  console.log(
    r.faction.padEnd(13) + '| ' +
    r.botPerGame.toFixed(1).padStart(5) + '  | ' +
    r.humPerGame.toFixed(1).padStart(6) + '   | ' +
    `${r.botUses}/${r.botGames}`.padStart(8) + '   | ' +
    `${r.humUses}/${r.humGames}`.padStart(9) + '    | ' + gap
  );
}
console.log('\n※ 갭이 크게 음수 = 봇이 그 종족 능력을 사람보다 훨씬 덜 씀 = 깨끗한 갭 후보(위에서부터).');
console.log('※ 봇판수 0이면 비교 불가(데이터 없음). humUses 0이면 시그니처 정규식 재확인 필요.');
