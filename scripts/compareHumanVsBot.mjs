// 사람 강한 게임 vs 봇 게임의 우승자/전체 지표를 정량 비교해 점수 격차의 원인을 찾는다.
import fs from 'fs';
import path from 'path';

const HUMAN_DIR = 'data/human-games';
const BOT_DIR = 'data/selfplay-archive';
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const isTestName = n => /^(AI Bot|Runner|H2HRunner|SelfPlayRunner|Bot|Champion|Challenger)/i.test(n || '') || (n || '') === '';

function statsForPlayer(p) {
  const research = p.research || {};
  const r = TRACKS.map(t => research[t] ?? 0);
  return {
    score: p.score ?? 0,
    faction: p.faction,
    research: r,
    researchTotal: r.reduce((s, v) => s + v, 0),
    l5count: r.filter(v => v >= 5).length,
    l4plus: r.filter(v => v >= 4).length,
    tech: (p.techTiles || []).length,
    advTech: (p.techTiles || []).filter(id => String(id).startsWith('adv-')).length,
    fed: (p.federations || []).length,
    econ: research.economy ?? 0,
    nav: research.navigation ?? 0,
    gaia: research.gaiaProject ?? 0,
  };
}

function loadGames(dir, wantHuman) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    let g; try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const players = Object.values(g.players || {});
    if (!players.length) continue;
    const hasHuman = players.some(p => !isTestName(p.name));
    if (wantHuman && !(hasHuman && (g.actionJournal || []).length > 0)) continue;
    if (!wantHuman && hasHuman) continue;
    // winner = rank 1 (or max score)
    const ranked = [...players].sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
    const winner = (ranked[0]?.rank ? ranked[0] : [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]);
    out.push({ file: f, winner: statsForPlayer(wantHuman ? players.find(p => !isTestName(p.name)) || winner : winner), all: players.map(statsForPlayer) });
  }
  return out;
}

function agg(label, games, pick) {
  const arr = games.map(pick);
  if (!arr.length) { console.log(`${label}: (none)`); return; }
  const avg = k => (arr.reduce((s, x) => s + x[k], 0) / arr.length);
  const mn = k => Math.min(...arr.map(x => x[k]));
  const mx = k => Math.max(...arr.map(x => x[k]));
  console.log(`\n=== ${label} (n=${arr.length}) ===`);
  console.log(`  score:        avg ${avg('score').toFixed(1)}  [${mn('score')}–${mx('score')}]`);
  console.log(`  researchTotal:avg ${avg('researchTotal').toFixed(1)}  [${mn('researchTotal')}–${mx('researchTotal')}]`);
  console.log(`  L5 tracks:    avg ${avg('l5count').toFixed(2)}  [${mn('l5count')}–${mx('l5count')}]`);
  console.log(`  L4+ tracks:   avg ${avg('l4plus').toFixed(2)}`);
  console.log(`  techTiles:    avg ${avg('tech').toFixed(2)}  (adv ${avg('advTech').toFixed(2)})`);
  console.log(`  federations:  avg ${avg('fed').toFixed(2)}  [${mn('fed')}–${mx('fed')}]`);
  console.log(`  economy lvl:  avg ${avg('econ').toFixed(2)}   navigation: ${avg('nav').toFixed(2)}   gaia: ${avg('gaia').toFixed(2)}`);
}

const human = loadGames(HUMAN_DIR, true);
const bot = loadGames(BOT_DIR, false);

console.log('### HUMAN strong games - winners (the real target) ###');
human.forEach(h => {
  const w = h.winner;
  console.log(`  ${h.file}: ${w.faction} ${w.score} | L5x${w.l5count} tech${w.tech}(adv${w.advTech}) fed${w.fed} Rtot${w.researchTotal} econ${w.econ} nav${w.nav} gaia${w.gaia}`);
});
agg('HUMAN winners', human, h => h.winner);
agg('BOT winners', bot.slice(0, 400), b => b.winner);

// bot ALL players (typical bot, not just winner)
const botAll = bot.slice(0, 200).flatMap(b => b.all);
agg('BOT all players', botAll, x => x);
