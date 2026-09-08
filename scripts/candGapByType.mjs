// [갭 프로브 2026-09-08] 사람 결정(actionJournal, 후보 캡처 있음) vs 봇 후보 리스트 — 액션 *유형별* 커버리지.
// 질문: 사람이 고른 수가 봇 후보에 (a) 유형 자체가 없음(typeGap) (b) 유형은 있는데 타일/파라미터가 다름(paramGap) (c) 있음(hit).
// candidateProbe.mjs(2026-07)와 달리 우주선·기술·특수·보너스·프리액션까지 매칭하고, 라운드 구간(R1-2 / R3+)으로 나눠 본다.
// 주의: 후보 캡처는 사람 턴 시작 시점 1회 → 같은 턴의 2번째 이후 엔트리는 같은 리스트를 재사용(stale). --first 옵션이면 캡처당 첫 엔트리만.
// 실행: node scripts/candGapByType.mjs [--first] [--since 2026-08-01]
import fs from 'fs';
const dir = 'data/human-games';
const FIRST = process.argv.includes('--first');
const sinceArg = process.argv.indexOf('--since'); const SINCE = sinceArg > 0 ? process.argv[sinceArg + 1] : '';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f >= SINCE).sort();

// 사람 액션 → {ctype, pred}  (pred: 후보 c가 정확히 그 수인가). null → 결정 아님(패시브/서브스텝) → 스킵
function classify(e) {
  const a = e.action || '', d = e.details || '', tid = e.tileId;
  const has = (t) => (c) => c.type === t;
  if (/^Built Parasitic Mine/i.test(a)) return { ctype: 'build_mine(parasitic)', pred: c => c.type === 'build_mine' && c.tileId === tid, alt: 'build_mine' };
  if (/^Built Mine|^Placed Mine/i.test(a)) return { ctype: 'build_mine', pred: c => c.type === 'build_mine' && c.tileId === tid };
  if (/^Advanced Research/i.test(a)) { const m = d.match(/^(\w+) to level/i); if (!m) return null; const tr = m[1].toLowerCase(); return { ctype: 'advance_research', pred: c => c.type === 'advance_research' && (c.trackId || '').toLowerCase() === tr }; }
  if (/^Upgraded to Trading/i.test(a)) return { ctype: 'upgrade:TS', pred: c => c.type === 'upgrade_structure' && c.target === 'trading_station' && c.tileId === tid, alt: 'upgrade_structure' };
  if (/^Upgraded to Research Lab/i.test(a)) return { ctype: 'upgrade:Lab', pred: c => c.type === 'upgrade_structure' && c.target === 'research_lab' && c.tileId === tid, alt: 'upgrade_structure' };
  if (/^Academy \(/i.test(a)) return { ctype: 'special:academy_qic', pred: c => c.type === 'use_special_action' && /academy/i.test(String(c.actionId || '')), alt: 'use_special_action' }; // 아카데미 QIC 특수액션(업글 아님)
  if (/^Upgraded to Academy/i.test(a)) return { ctype: 'upgrade:Academy', pred: c => c.type === 'upgrade_structure' && String(c.target || '').startsWith('academy') && c.tileId === tid, alt: 'upgrade_structure' };
  if (/^Upgraded to Planetary Institute/i.test(a)) return { ctype: 'upgrade:PI', pred: c => c.type === 'upgrade_structure' && c.target === 'planetary_institute' && c.tileId === tid, alt: 'upgrade_structure' };
  if (/^Entered Ship/i.test(a)) return { ctype: 'enter_spaceship', pred: c => c.type === 'enter_spaceship' && c.tileId === tid };
  if (/^Placed Gaiaformer/i.test(a)) return { ctype: 'place_gaiaformer', pred: c => c.type === 'place_gaiaformer' && c.tileId === tid };
  if (/^Federation$|^Formed Federation/i.test(a)) return { ctype: 'form_federation', pred: has('form_federation') };
  if (/^Power Action/i.test(a)) { const kw = /ore/i.test(d) ? /ore/ : /credit/i.test(d) ? /credit/ : /knowledge/i.test(d) ? /knowledge/ : /token/i.test(d) ? /token/ : /step|terraform/i.test(d) ? /step|terraform/ : /qic/i.test(d) ? /qic/ : null; if (!kw) return null; return { ctype: 'use_power_action', pred: c => c.type === 'use_power_action' && kw.test(String(c.actionId || '')) }; }
  if (/^(Rebellion|Eclipse|Twilight|TF Mars)\b/i.test(a) && /internal-/.test(tid || '')) { const ship = a.split(':')[0].trim(); return { ctype: 'ship_action:' + ship, pred: c => c.type === 'use_ship_action' && c.shipTileId === tid, alt: 'use_ship_action' }; }
  if (/^Used Tech Action/i.test(a)) return { ctype: 'use_tech_action', pred: c => c.type === 'use_tech_action' && c.tileId === tid };
  if (/^Bonus Action/i.test(a)) return { ctype: 'use_bonus_action', pred: has('use_bonus_action') };
  if (/^Free Actions/i.test(a)) return { ctype: 'convert_resource', pred: has('convert_resource') };
  if (/^Power Burn/i.test(a)) return { ctype: 'burn_power', pred: has('burn_power') };
  if (/^Artifact/i.test(a)) return { ctype: 'take_twilight_artifact', pred: has('take_twilight_artifact') };
  if (/^Firaks: Downgrade/i.test(a)) return { ctype: 'special:firaks_downgrade', pred: c => c.type === 'firaks_downgrade' && c.tileId === tid, alt: 'firaks_downgrade' };
  if (/^Ivits: Space Station/i.test(a)) return { ctype: 'special:ivits_station', pred: c => c.type === 'place_ivits_space_station' && c.tileId === tid, alt: 'place_ivits_space_station' };
  if (/^Bescods.*Special/i.test(a)) return { ctype: 'special:bescods_lowest', pred: has('bescods_advance_lowest') };
  if (/^(Tinkeroid|Gleens|Space Giants|Moweyip|Ambas|Itars|Terran|Nevlas|Xenos|Lantids|Darkanians|Geodens|Taklons|Bal T.aks|Hadsch Hallas|Firaks|Ivits): Special/i.test(a)) return { ctype: 'use_special_action', pred: has('use_special_action') };
  if (/^Hadsch Hallas PI/i.test(a)) return { ctype: 'special:HH_PI_convert', pred: has('convert_resource') };
  if (/^Bal T.aks: 1 Gaiaformer/i.test(a)) return { ctype: 'special:baltak_gf_to_qic', pred: has('convert_resource') };
  return null; // 패시브 트리거(Council/PI 발동/Tech Tile 선택/Income/Reward 등) — 결정 아님
}

const stat = {}; // ctype -> {early:{n,hit,typeGap,paramGap}, late:{...}}
const byRound = {}; // ctype -> round -> {n,gap}
const gapFaction = {};
let entries = 0, used = 0, stale = 0, games = 0;
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
  const journal = (g.actionJournal || []).filter(e => e.candidates && e.candidates.length >= 2 && e.phase === 'main').sort((a, b) => a.timestamp - b.timestamp);
  if (!journal.length) continue; games++;
  let prevKey = '';
  for (const e of journal) {
    entries++;
    const key = e.playerId + '|' + JSON.stringify(e.candidates);
    const isStale = key === prevKey; prevKey = key;
    if (isStale) { stale++; if (FIRST) continue; }
    const cl = classify(e); if (!cl) continue; used++;
    const seg = (e.round || 1) <= 2 ? 'early' : 'late';
    const s = (stat[cl.ctype] ||= { early: { n: 0, hit: 0, typeGap: 0, paramGap: 0 }, late: { n: 0, hit: 0, typeGap: 0, paramGap: 0 } })[seg];
    s.n++;
    const baseType = cl.alt || cl.ctype;
    const hasType = e.candidates.some(c => c.type === baseType);
    if (e.candidates.some(cl.pred)) s.hit++;
    else if (!hasType) { s.typeGap++; if (seg === 'late') { const fk = cl.ctype + '|' + (e.faction || '?'); gapFaction[fk] = (gapFaction[fk] || 0) + 1; } }
    else s.paramGap++;
    const br = (byRound[cl.ctype] ||= {}); const r = (br[e.round || 1] ||= { n: 0, gap: 0 }); r.n++; if (!e.candidates.some(cl.pred)) r.gap++;
  }
}
console.log(`게임 ${games} · 후보캡처 엔트리 ${entries} (stale 재사용 ${stale}${FIRST ? ', 제외' : ', 포함'}) · 분류된 결정 ${used}`);
const pct = (a, b) => b ? (a / b * 100).toFixed(0).padStart(3) + '%' : '  - ';
console.log('\n' + '유형'.padEnd(26) + '| R1-2: n   hit  typeGap paramGap | R3+ : n    hit  typeGap paramGap');
const rows = Object.entries(stat).sort((a, b) => (b[1].late.typeGap + b[1].late.paramGap) - (a[1].late.typeGap + a[1].late.paramGap));
for (const [k, v] of rows) {
  const E = v.early, L = v.late;
  console.log(k.padEnd(26) + `| ${String(E.n).padStart(5)} ${pct(E.hit, E.n)} ${String(E.typeGap).padStart(6)} ${String(E.paramGap).padStart(8)} | ${String(L.n).padStart(5)} ${pct(L.hit, L.n)} ${String(L.typeGap).padStart(6)} ${String(L.paramGap).padStart(8)}`);
}
console.log('\n유형별 라운드 갭율(gap/n):');
for (const [k, br] of Object.entries(byRound)) { const tot = Object.values(br).reduce((s, x) => s + x.n, 0); if (tot < 150) continue; console.log(k.padEnd(26) + [1, 2, 3, 4, 5, 6].map(r => br[r] ? `R${r} ${pct(br[r].gap, br[r].n)}(${br[r].n})` : '').join(' ')); }
console.log('\nR3+ typeGap 상위 (유형|종족):', Object.entries(gapFaction).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k + ' ' + v).join(' · '));
