import fs from 'fs';
import path from 'path';

const files = process.argv.slice(2);
if (files.length === 0) {
  // default: latest final state files in logs/
  const dir = 'logs';
  const all = fs.readdirSync(dir).filter(f => f.includes('final_state')).map(f => path.join(dir, f));
  all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  files.push(...all.slice(0, 4));
}

function sum(arr, key) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, x) => s + (typeof x === 'number' ? x : (x?.vp ?? 0)), 0);
}

for (const file of files) {
  const game = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(`\n======== ${path.basename(file)} (round ${game.roundNumber}, phase ${game.currentPhase}) ========`);
  const roundTiles = (game.roundScoringTiles || []).map(t => `${t.triggerType}:${t.vp}`).join(' | ');
  console.log(`Round scoring tiles: ${roundTiles}`);
  console.log(`Final missions: ${(game.finalMissionIds || []).join(', ')}`);
  for (const pid of Object.keys(game.players)) {
    const p = game.players[pid];
    const b = p.scoreBreakdown || {};
    const structures = (game.map || []).filter(t => t.ownerId === pid && t.structure);
    const counts = {};
    for (const t of structures) counts[t.structure] = (counts[t.structure] || 0) + 1;
    const research = Object.entries(p.research || {}).map(([k, v]) => `${k.slice(0,4)}${v}`).join(' ');
    const feds = (p.federations || p.federationTokens || []);
    const fedCount = Array.isArray(feds) ? feds.length : 0;
    console.log(`\n  --- ${p.name} [${p.faction}] FINAL SCORE: ${p.score} ---`);
    console.log(`    structures: ${JSON.stringify(counts)} (total ${structures.length})`);
    console.log(`    research: ${research}`);
    console.log(`    federations: ${fedCount}, techTiles: ${(p.techTiles||[]).length}`);
    console.log(`    leftover res: ore${p.ore} cr${p.credits} kn${p.knowledge} qic${p.qic}`);
    console.log(`    BREAKDOWN:`);
    console.log(`      roundMissions: ${sum(b.roundMissions)}  (${JSON.stringify(b.roundMissions)})`);
    console.log(`      bonusTilePass: ${sum(b.bonusTilePass)}`);
    console.log(`      techTiles: ${sum(b.techTiles)}`);
    console.log(`      finalMissions: ${b.finalMissions ?? 0}`);
    console.log(`      researchTracks(end): ${b.researchTracks ?? 0}`);
    console.log(`      powerReceived: ${b.powerReceived ?? 0}`);
    console.log(`      spaceships: ${sum(b.spaceships)}`);
    console.log(`      remainingResources: ${b.remainingResources ?? 0}`);
    console.log(`      other: ${sum(b.other)} (${JSON.stringify(b.other)})`);
  }
}
