#!/usr/bin/env node
// 사람 게임 로그에서 종족별 expert 프로파일 추출 (봇 좌석 제외).
// 최종 점수 · 건물 구성(map) · 연구 레벨 · 연방(수/위성) · 랭크. 봇 랭킹과 대조용.
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = 'data/human-games';
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

const STRUCTS = ['mine', 'trading_station', 'research_lab', 'planetary_institute', 'academy'];
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

const byFaction = {};
const add = (fac) => (byFaction[fac] ??= { n: 0, score: 0, structs: {}, research: {}, feds: 0, sats: 0, fedGames: 0, ranks: [] });

let games = 0, humanSeats = 0;
for (const f of files) {
  let d;
  try { d = JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { continue; }
  if (!d.players || !d.map) continue;
  games++;
  const bots = new Set(d.botPlayerIds || []);
  for (const [pid, p] of Object.entries(d.players)) {
    if (bots.has(pid)) continue;           // 봇 좌석 제외 = 사람만
    if (!p.faction) continue;
    humanSeats++;
    const rec = add(p.faction);
    rec.n++;
    rec.score += p.score ?? 0;
    if (typeof p.rank === 'number') rec.ranks.push(p.rank);
    // 건물: 최종 map에서 소유 타일 집계
    for (const s of STRUCTS) rec.structs[s] = (rec.structs[s] || 0);
    for (const t of d.map) {
      if (t.ownerId !== pid || !t.structure) continue;
      const s = t.structure === 'lost_planet_mine' ? 'mine' : t.structure;
      if (rec.structs[s] != null) rec.structs[s]++;
    }
    // 연구
    for (const tr of TRACKS) rec.research[tr] = (rec.research[tr] || 0) + (p.research?.[tr] ?? 0);
    // 연방
    const feds = Array.isArray(p.federations) ? p.federations : [];
    if (feds.length) { rec.feds += feds.length; rec.fedGames++; }
  }
}

console.log(`games=${games} humanSeats=${humanSeats}\n`);
const rows = Object.entries(byFaction).sort((a, b) => (b[1].score / b[1].n) - (a[1].score / a[1].n));
console.log('faction         n  avgScore | mine  TS  lab  PI  aca | terra nav ai gaia eco sci | fed/g  avgRank');
for (const [fac, r] of rows) {
  const avg = (x) => (x / r.n).toFixed(1);
  const sc = (r.score / r.n).toFixed(1).padStart(5);
  const st = STRUCTS.map(s => avg(r.structs[s]).padStart(4)).join(' ');
  const re = TRACKS.map(t => avg(r.research[t]).padStart(3)).join(' ');
  const fedg = (r.feds / r.n).toFixed(2);
  const rank = r.ranks.length ? (r.ranks.reduce((a, b) => a + b, 0) / r.ranks.length).toFixed(1) : '-';
  console.log(`${fac.padEnd(14)} ${String(r.n).padStart(2)} ${sc}  | ${st} | ${re} | ${fedg.padStart(5)}  ${rank}`);
}
