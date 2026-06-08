import fs from 'fs';

const file = process.argv[2] || 'data/human-games/2026-06-08_dn8vkjxf.json';
const g = JSON.parse(fs.readFileSync(file, 'utf8'));

// winner = rank 1
const winnerId = Object.entries(g.players).sort((a, b) => (a[1].rank ?? 9) - (b[1].rank ?? 9))[0][0];
const winner = g.players[winnerId];
console.log(`=== ${file} ===`);
console.log(`Winner: ${winner.name} [${winner.faction}] = ${winner.score}\n`);

const structKeys = ['mine', 'lost_planet_mine', 'trading_station', 'research_lab', 'planetary_institute', 'academy'];
function structCount(p) {
  // playerAfter doesn't carry map; approximate from research/techTiles only. We rely on gameLog for builds.
  return null;
}
function resStr(p) {
  if (!p) return '';
  const r = p.resources || {};
  return `c${r.credits ?? 0} o${r.ore ?? 0} k${r.knowledge ?? 0} q${r.qic ?? 0} pw${r.power1 ?? 0}/${r.power2 ?? 0}/${r.power3 ?? 0}`;
}
function researchStr(p) {
  if (!p?.research) return '';
  return Object.entries(p.research).filter(([, v]) => v > 0).map(([k, v]) => `${k.slice(0, 4)}${v}`).join(' ');
}

const entries = (g.actionJournal || []).filter(e => e.playerId === winnerId);
console.log(`Winner action-journal entries: ${entries.length}\n`);

let curRound = -1;
let lastResearch = '';
let lastFeds = 0;
let lastTech = 0;
for (const e of entries) {
  if (e.round !== curRound) {
    curRound = e.round;
    const pa = e.playerAfter;
    console.log(`\n────────── ROUND ${curRound} (${e.phase}) ──────────`);
  }
  const before = e.playerBefore, after = e.playerAfter;
  const deltas = [];
  // score delta
  if (e.scoreAfter != null && e.scoreBefore != null && e.scoreAfter !== e.scoreBefore) {
    deltas.push(`VP+${e.scoreAfter - e.scoreBefore}→${e.scoreAfter}`);
  }
  // research change
  const rNow = researchStr(after);
  if (rNow !== lastResearch) { deltas.push(`R:[${rNow}]`); lastResearch = rNow; }
  // federations
  const fedNow = (after?.federations || []).length;
  if (fedNow !== lastFeds) { deltas.push(`FED→${fedNow}`); lastFeds = fedNow; }
  // tech tiles
  const techNow = (after?.techTiles || []).length;
  if (techNow !== lastTech) { deltas.push(`TECH→${techNow}(${(after.techTiles || []).slice(-1)[0] || ''})`); lastTech = techNow; }
  const action = `${e.action}${e.details ? ' — ' + e.details : ''}${e.tileId ? ' @' + e.tileId : ''}`;
  console.log(`  ${action}`);
  if (deltas.length) console.log(`      ${deltas.join('  ')}   res:${resStr(after)}`);
}

console.log(`\n\n=== FINAL winner state ===`);
console.log(`research: ${researchStr(winner)}`);
console.log(`techTiles(${(winner.techTiles || []).length}): ${(winner.techTiles || []).join(', ')}`);
console.log(`federations(${(winner.federations || []).length}): ${(winner.federations || []).map(f => f.rewardId || f).join(', ')}`);
console.log(`bonusTile: ${winner.bonusTile}`);
console.log(`final res: ${resStr(winner)}`);
