/**
 * 초기 배치·R1 광산 기하 대조 — 같은 실게임(사람+봇 혼합, 6라운드 완주) 안에서 사람 좌석 vs 봇 좌석.
 *
 * 사용자 가설(2026-09-16): "1라운드 광산 뿌리는 것만 해도 사람이랑 차이가 많이 나는 것 같다".
 * round1Diag는 '개수/자원'만 봤으니 여기서는 '어디에' 놓는지(좌표)를 본다.
 *   시작 광산: 내 두 광산 간 거리 · 상대 시작광산까지 최소거리 · 우주선까지 최소거리 ·
 *              사거리 2 안의 싼 확장지(0~1삽 행성) 수 · 같은 섹터 여부
 *   R1 광산  : 삽 단계(종족 홈색 기준) · QIC 사용 · 그 시점 내 건물과의 거리(인접 비율) · 가이아/트랜스딤 비율
 *   누적 광산: R1~R6 끝 시점 광산 수(시작 2개 포함)
 * 사용: node scripts/placementGapDiag.mjs [--top 200]   (--top: 상위 사람 기준 점수)
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const argv = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TOP = Number(argv('--top', 200));
const SINCE = argv('--since', '');   // 이 날짜(파일명 앞 10자) 이후 게임만 — 최근 봇 버전만 볼 때

const HOME = ['terra', 'volcanic', 'oxide', 'desert', 'swamp', 'titanium', 'ice'];
const FACTION_HOME = {
  terran: 'terra', lantids: 'terra', hadsch_hallas: 'volcanic', ivits: 'volcanic', geodens: 'oxide', bal_tak: 'oxide',
  xenos: 'desert', gleens: 'desert', taklons: 'swamp', ambas: 'swamp', bescods: 'titanium', firaks: 'titanium',
  itars: 'ice', nevlas: 'ice', moweyip: 'proto', space_giants: 'proto', tinkeroids: 'asteroid', darkanians: 'asteroid',
};
/** 종족 → 행성 삽 단계 (모웨이드 3단계 행성 설정은 로그에 없어 2로 근사). gaia/transdim/asteroid는 삽 대상이 아니라 null */
function steps(faction, type) {
  if (!HOME.includes(type)) return null;
  if (faction === 'darkanians') return 1;
  if (faction === 'space_giants') return 2;
  if (faction === 'moweyip') return 2;
  const home = FACTION_HOME[faction];
  if (!HOME.includes(home)) return 2;
  const d = Math.abs(HOME.indexOf(home) - HOME.indexOf(type));
  return Math.min(d, 7 - d);
}
const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const isBotName = (n) => /^AI Bot/i.test(n || '');
const MINE_RE = /^(Built Mine|Built Parasitic Mine|Built Mine on Asteroid|Built Mine on Proto|Eclipse: Built mine|Placed Starting Mine)/i;
const BUILD_RE = /^(Built |Placed Starting Mine|Upgraded|Eclipse: Built)/i;

const mk = () => ({ n: 0, sum: {}, cnt: {} });
const add = (b, k, v) => { if (v == null || Number.isNaN(v)) return; b.sum[k] = (b.sum[k] ?? 0) + v; b.cnt[k] = (b.cnt[k] ?? 0) + 1; };
const buckets = { human: mk(), top: mk(), bot: mk() };
const dist = { human: {}, bot: {} };          // R1 광산 내건물거리 분포
const farCorr = { far: [], near: [] };        // 봇 좌석: 거리≥3 R1광산 있음/없음 → 최종점수
let games = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
  if (SINCE && f.slice(0, 10) < SINCE) continue;
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if ((g.roundNumber ?? 0) < 6 || !Array.isArray(g.fullGameLog) || !g.map) continue;
  const ids = Object.keys(g.players ?? {});
  const isBot = (id) => (g.botPlayerIds ?? []).includes(id) || isBotName(g.players[id]?.name);
  const nb = ids.filter(isBot).length;
  if (nb === 0 || nb === ids.length) continue;           // 혼합 게임만
  const tiles = {}; for (const t of Object.values(g.map)) tiles[t.id] = t;
  const ships = Object.values(g.map).filter((t) => /^ship_/.test(t.type));
  const planets = Object.values(g.map).filter((t) => !['space', 'deep_space'].includes(t.type) && !/^ship_/.test(t.type));
  const log = g.fullGameLog;
  if (!log.some((e) => e.action === 'Placed Starting Mine' && tiles[e.tileId])) continue;
  games++;

  // 시작 광산
  const start = {}; for (const e of log) if (e.action === 'Placed Starting Mine' && tiles[e.tileId]) (start[e.playerId] ??= []).push(tiles[e.tileId]);
  // 라운드 추적 + 좌석별 건물 좌표(시간순) + 광산 누적
  const own = {}; const mines = {}; const r1 = {};
  let round = 0;
  for (const e of log) {
    if (typeof e.round === 'number') round = e.round;
    const pid = e.playerId; if (!pid || !g.players[pid]) continue;
    const t = tiles[e.tileId];
    if (MINE_RE.test(e.action ?? '')) {
      const m = (mines[pid] ??= [0, 0, 0, 0, 0, 0, 0]);
      for (let r = Math.max(round, 0); r <= 6; r++) m[r]++;
      if (round === 1 && /^Built Mine$/.test(e.action) && t) {
        const o = own[pid] ?? [];
        const dmin = o.length ? Math.min(...o.map((x) => hexDist(x, t))) : null;
        const st = steps(g.players[pid].faction, t.type);
        (r1[pid] ??= []).push({ steps: st, qic: /(\d+)\s*QIC/i.test(e.details ?? '') ? Number((e.details.match(/(\d+)\s*QIC/i))[1]) : 0,
          dmin, gaia: t.type === 'gaia' ? 1 : 0, adj: dmin === 1 ? 1 : 0 });
      }
    }
    if (BUILD_RE.test(e.action ?? '') && t) (own[pid] ??= []).push(t);
  }

  for (const pid of ids) {
    const p = g.players[pid]; const s = start[pid] ?? [];
    const bs = [isBot(pid) ? 'bot' : 'human']; if (!isBot(pid) && (p.score ?? 0) >= TOP) bs.push('top');
    const fac = p.faction;
    const oppStart = ids.filter((x) => x !== pid).flatMap((x) => start[x] ?? []);
    for (const b of bs.map((k) => buckets[k])) {
      b.n++;
      if (s.length >= 2) {
        add(b, '시작광산 간 거리', hexDist(s[0], s[1]));
        add(b, '시작광산 같은 섹터', s[0].sector === s[1].sector ? 1 : 0);
      }
      if (s.length) {
        if (oppStart.length) add(b, '상대 시작광산 최소거리', Math.min(...s.flatMap((a) => oppStart.map((o) => hexDist(a, o)))));
        if (ships.length) add(b, '우주선까지 최소거리', Math.min(...s.flatMap((a) => ships.map((o) => hexDist(a, o)))));
        // 사거리 2 안의 확장지: 0삽/1삽/가이아/트랜스딤 (시작 시점 = 남의 시작광산 제외)
        const occupied = new Set(ids.flatMap((x) => (start[x] ?? []).map((t) => t.id)));
        const near = planets.filter((t) => !occupied.has(t.id) && s.some((a) => hexDist(a, t) <= 2));
        add(b, '사거리2 0삽 행성', near.filter((t) => steps(fac, t.type) === 0).length);
        add(b, '사거리2 1삽 행성', near.filter((t) => steps(fac, t.type) === 1).length);
        add(b, '사거리2 0~1삽 합', near.filter((t) => (steps(fac, t.type) ?? 9) <= 1).length);
        add(b, '사거리2 가이아', near.filter((t) => t.type === 'gaia').length);
        add(b, '사거리2 트랜스딤', near.filter((t) => t.type === 'transdim').length);
        const near1 = planets.filter((t) => !occupied.has(t.id) && s.some((a) => hexDist(a, t) <= 1));
        add(b, '사거리1 0~1삽 합', near1.filter((t) => (steps(fac, t.type) ?? 9) <= 1).length);
      }
      const rr = r1[pid] ?? [];
      add(b, 'R1 일반광산 수', rr.length);
      if (bs[0] !== 'top') for (const x of rr) { const key = x.dmin == null ? '?' : Math.min(x.dmin, 5); dist[bs[0]][key] = (dist[bs[0]][key] ?? 0) + 1; }
      for (const x of rr) {
        add(b, 'R1 광산 삽단계(색행성)', x.steps);
        add(b, 'R1 광산 QIC/건', x.qic);
        add(b, 'R1 광산 내건물 최소거리', x.dmin);
        add(b, 'R1 광산 인접(거리1) 비율', x.adj);
        add(b, 'R1 광산 거리≥3 비율', x.dmin != null && x.dmin >= 3 ? 1 : 0);
        add(b, 'R1 광산 가이아 비율', x.gaia);
      }
      if (bs[0] === 'bot' && b === buckets.bot) farCorr[rr.some((x) => x.dmin != null && x.dmin >= 3) ? 'far' : 'near'].push(p.score ?? 0);
      const m = mines[pid] ?? [0, 0, 0, 0, 0, 0, 0];
      for (let r = 1; r <= 6; r++) add(b, `광산 누적 R${r}끝`, m[r]);
    }
  }
}

const ORDER = ['시작광산 간 거리', '시작광산 같은 섹터', '상대 시작광산 최소거리', '우주선까지 최소거리',
  '사거리1 0~1삽 합', '사거리2 0삽 행성', '사거리2 1삽 행성', '사거리2 0~1삽 합', '사거리2 가이아', '사거리2 트랜스딤',
  'R1 일반광산 수', 'R1 광산 삽단계(색행성)', 'R1 광산 QIC/건', 'R1 광산 내건물 최소거리', 'R1 광산 인접(거리1) 비율', 'R1 광산 거리≥3 비율', 'R1 광산 가이아 비율',
  '광산 누적 R1끝', '광산 누적 R2끝', '광산 누적 R3끝', '광산 누적 R4끝', '광산 누적 R5끝', '광산 누적 R6끝'];
const avg = (b, k) => (b.cnt[k] ? b.sum[k] / b.cnt[k] : NaN);
console.log(`혼합 실게임 ${games}판 — 사람 ${buckets.human.n}석 / 상위사람(${TOP}점+) ${buckets.top.n}석 / 봇 ${buckets.bot.n}석\n`);
console.log('지표'.padEnd(24) + '사람'.padStart(8) + `상위${TOP}+`.padStart(9) + '봇'.padStart(8) + '  봇/사람');
for (const k of ORDER) {
  const h = avg(buckets.human, k), t = avg(buckets.top, k), b = avg(buckets.bot, k);
  if (Number.isNaN(h) && Number.isNaN(b)) continue;
  const ratio = h ? (b / h) : NaN;
  const flag = ratio < 0.8 ? ' ◀◀ 봇 낮음' : ratio > 1.25 ? ' ▶▶ 봇 높음' : '';
  console.log(k.padEnd(24) + h.toFixed(2).padStart(8) + t.toFixed(2).padStart(9) + b.toFixed(2).padStart(8) + ('×' + ratio.toFixed(2)).padStart(9) + flag);
}

console.log('\nR1 일반광산의 내 건물 최소거리 분포 (건수 비율)');
for (const k of ['human', 'bot']) {
  const tot = Object.values(dist[k]).reduce((a, b) => a + b, 0) || 1;
  console.log(k.padEnd(6) + ['1', '2', '3', '4', '5'].map((d) => `d${d === '5' ? '5+' : d} ${((dist[k][d] ?? 0) / tot * 100).toFixed(0).padStart(3)}%`).join('  ') + `  (n=${tot})`);
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log(`\n봇 좌석 최종점수: 거리≥3 R1광산 있음 ${mean(farCorr.far).toFixed(1)} (n=${farCorr.far.length}) vs 없음 ${mean(farCorr.near).toFixed(1)} (n=${farCorr.near.length})`);
