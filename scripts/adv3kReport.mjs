/**
 * 고급 기술 타일 'ACT: 3K'(adv-act-3k) 획득자 리포트.
 *
 * 사용자 질문(2026-08-19): "3K 고급 타일 먹은 사람들 몇 라운드에 먹었고, 지식(science) 트랙과 최종 점수는?"
 *
 * 획득 시점은 gameLog의 `Advanced Tech Tile · "Covered <원타일> → adv-act-3k"` 항목에서 읽는다.
 * 옛 로그(6월)엔 round 필드가 없어 `Round Start` 마커로 역산하고, 그것도 없으면 unknown으로 센다.
 *
 * 기본: 4인 전원 사람 · 6라운드 완주 판만 (AI Bot 낀 판 제외 — 사용자 지정 2026-08-19).
 * 사용: node scripts/adv3kReport.mjs [--all]   (--all: 봇 낀 판의 사람 좌석까지 포함)
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
// --tile 로 다른 고급 타일도 같은 형식으로 뽑는다 (adv-act-3k / adv-act-3o / adv-act-1q-5c …)
const argv = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TILE = argv('--tile', 'adv-act-3k');
// 그 타일과 짝이 되는 '초점 트랙' — 3K는 지식(science), 3O는 삽(terraforming)이 쓰임새의 짝
const FOCUS = argv('--track', TILE === 'adv-act-3o' ? 'terraforming' : 'science');
// --track2: 두 번째 트랙도 같이 보고 싶을 때 (1Q+5C처럼 자원이 둘인 타일)
const FOCUS2 = argv('--track2', TILE === 'adv-act-1q-5c' ? 'economy' : '');
const KO = { science: '지식(science)', terraforming: '삽(terraforming)', navigation: '항법', gaiaProject: '가이아', economy: '경제', artificialIntelligence: 'AI' };
const FOCUS_KO = KO[FOCUS] ?? FOCUS;
const FOCUS2_KO = FOCUS2 ? (KO[FOCUS2] ?? FOCUS2) : '';
const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);
const INCLUDE_BOT_GAMES = process.argv.includes('--all');

const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');

/** 로그를 훑으며 각 항목의 라운드를 확정 — round 필드 우선, 없으면 Round Start 마커 누적 */
function roundOf(log) {
	const out = new Map();
	let cur = null;
	for (const e of log) {
		if (typeof e.round === 'number') cur = e.round;
		else if (/^Round Start/i.test(e.action ?? '')) {
			const m = (e.details ?? '').match(/(\d+)/);
			if (m) cur = Number(m[1]);
			else cur = (cur ?? 0) + 1;
		}
		out.set(e, cur);
	}
	return out;
}

const takers = [];
const allHumans = [];      // 비교군: 완주 게임의 모든 사람 좌석
let games = 0, gamesWithTile = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if ((g.roundNumber ?? 0) < 6) continue;
	const ids = Object.keys(g.players ?? {});
	const human4 = ids.length === 4 && !ids.some((k) => isBot(g, k));
	if (!human4 && !INCLUDE_BOT_GAMES) continue;   // 기본: 봇 낀 판 제외
	const log = g.gameLog ?? [];
	const rmap = roundOf(log);
	games++;
	let hit = false;

	for (const [pid, p] of Object.entries(g.players ?? {})) {
		if (isBot(g, pid)) continue;
		const row = {
			file: f, allHuman4: human4, name: canon(p.name ?? pid), faction: p.faction ?? '?',
			score: p.score ?? 0, rank: p.rank ?? null,
			science: p.research?.[FOCUS] ?? 0,
			sci2: FOCUS2 ? (p.research?.[FOCUS2] ?? 0) : null,
			mines: (g.map ?? []).filter((t) => t.ownerId === pid && t.structure === 'mine').length,
			bldgs: (g.map ?? []).filter((t) => t.ownerId === pid && t.structure && t.structure !== 'ship').length,
			tracks: p.research ?? {},
			vpTracks: p.scoreBreakdown?.researchTracks ?? null,
			// scoreBreakdown.techTiles는 [{vp, tileId}] 배열 — 합계로 환산
			vpTech: Array.isArray(p.scoreBreakdown?.techTiles)
				? p.scoreBreakdown.techTiles.reduce((a, x) => a + (x?.vp ?? 0), 0)
				: (p.scoreBreakdown?.techTiles ?? null),
			techCount: (p.techTiles ?? []).length,
		};
		allHumans.push(row);
		if (!(p.techTiles ?? []).includes(TILE)) continue;
		hit = true;
		const ev = log.find((e) => /Advanced Tech Tile/i.test(e.action ?? '') && (e.details ?? '').includes(TILE) && e.playerId === pid);
		takers.push({ ...row, round: ev ? (rmap.get(ev) ?? null) : null, covered: ev ? ((ev.details ?? '').match(/Covered\s+(\S+)/) || [])[1] ?? '?' : '?' });
	}
	if (hit) gamesWithTile++;
}

const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
const fmtR = (r) => (r == null ? '?' : `R${r}`);

console.log(`[${TILE}] ${INCLUDE_BOT_GAMES ? '완주 게임(봇 포함)' : '4인 전원 사람 · 완주 게임'} ${games}판 중 이 타일을 가져간 판 ${gamesWithTile}판 · 획득 좌석 ${takers.length}건`);
console.log(`(비교군: 같은 게임들의 사람 좌석 전체 ${allHumans.length}건)\n`);

console.log(`이름           종족            획득  최종점수 순위 | ${FOCUS_KO.padEnd(12)}${FOCUS2 ? ' ' + FOCUS2_KO.padEnd(8) : ''} 연구트랙VP 기술타일VP 기술타일수 광산 건물` + (INCLUDE_BOT_GAMES ? ' 판구성' : ''));
console.log('-'.repeat(104));
for (const t of takers.slice().sort((a, b) => (a.round ?? 99) - (b.round ?? 99) || b.score - a.score)) {
	console.log(
		`${t.name.slice(0, 12).padEnd(13)} ${t.faction.slice(0, 14).padEnd(15)} ${fmtR(t.round).padStart(4)} ` +
		`${String(t.score).padStart(8)} ${String(t.rank ?? '?').padStart(4)} |${String(t.science).padStart(12)} ` +
		`${FOCUS2 ? String(t.sci2).padStart(9) : ''}${String(t.vpTracks ?? '-').padStart(10)} ${String(t.vpTech ?? '-').padStart(10)} ${String(t.techCount).padStart(10)} ${String(t.mines).padStart(4)} ${String(t.bldgs).padStart(4)}${INCLUDE_BOT_GAMES ? ' ' + (t.allHuman4 ? '4인사람' : '봇포함') : ''}`
	);
}

console.log('-'.repeat(104));
console.log(`획득자 평균   점수 ${avg(takers, (t) => t.score).toFixed(1)} · 순위 ${avg(takers.filter(t => t.rank), (t) => t.rank).toFixed(2)} · ${FOCUS} ${avg(takers, (t) => t.science).toFixed(2)}${FOCUS2 ? ` · ${FOCUS2} ${avg(takers, (t) => t.sci2).toFixed(2)}` : ''} · 광산 ${avg(takers, (t) => t.mines).toFixed(1)} · 건물 ${avg(takers, (t) => t.bldgs).toFixed(1)} · 연구트랙VP ${avg(takers.filter(t => t.vpTracks != null), (t) => t.vpTracks).toFixed(1)} · 기술타일 ${avg(takers, (t) => t.techCount).toFixed(1)}장`);
console.log(`사람 전체     점수 ${avg(allHumans, (t) => t.score).toFixed(1)} · 순위 ${avg(allHumans.filter(t => t.rank), (t) => t.rank).toFixed(2)} · ${FOCUS} ${avg(allHumans, (t) => t.science).toFixed(2)}${FOCUS2 ? ` · ${FOCUS2} ${avg(allHumans, (t) => t.sci2).toFixed(2)}` : ''} · 광산 ${avg(allHumans, (t) => t.mines).toFixed(1)} · 건물 ${avg(allHumans, (t) => t.bldgs).toFixed(1)} · 연구트랙VP ${avg(allHumans.filter(t => t.vpTracks != null), (t) => t.vpTracks).toFixed(1)} · 기술타일 ${avg(allHumans, (t) => t.techCount).toFixed(1)}장`);

// 4인 사람 판만 따로 (--all 로 봇 판까지 섞어 볼 때만 의미)
const h4t = takers.filter((t) => t.allHuman4), h4a = allHumans.filter((t) => t.allHuman4);
if (INCLUDE_BOT_GAMES) {
	console.log(`
[4인 전원 사람 판만] 획득 ${h4t.length}건 / 사람 좌석 ${h4a.length}건`);
	console.log(`  획득자   점수 ${avg(h4t, (t) => t.score).toFixed(1)} · 순위 ${avg(h4t.filter(t => t.rank), (t) => t.rank).toFixed(2)} · science ${avg(h4t, (t) => t.science).toFixed(2)}`);
	console.log(`  전체     점수 ${avg(h4a, (t) => t.score).toFixed(1)} · 순위 ${avg(h4a.filter(t => t.rank), (t) => t.rank).toFixed(2)} · science ${avg(h4a, (t) => t.science).toFixed(2)}`);
}

// 라운드별 분포 + 그 라운드에 먹은 사람들의 성적
const byRound = {};
for (const t of takers) {
	const k = t.round == null ? '?' : String(t.round);
	(byRound[k] = byRound[k] || []).push(t);
}
console.log('\n획득 라운드별');
console.log('라운드  건수  평균점수  평균순위  평균 science  1위 수');
for (const k of Object.keys(byRound).sort()) {
	const a = byRound[k];
	const wins = a.filter((t) => t.rank === 1).length;
	console.log(`${('R' + k).padEnd(7)}${String(a.length).padStart(4)} ${avg(a, (t) => t.score).toFixed(1).padStart(9)} ${avg(a.filter(t => t.rank), (t) => t.rank).toFixed(2).padStart(9)} ${avg(a, (t) => t.science).toFixed(2).padStart(13)}${FOCUS2 ? avg(a, (t) => t.sci2).toFixed(2).padStart(11) : ''} ${String(wins).padStart(7)} ${avg(a, (t) => t.mines).toFixed(1).padStart(8)}`);
}

// science 레벨별 (이 타일을 먹고 지식 트랙을 얼마나 올렸나)
const bySci = {};
for (const t of takers) (bySci[t.science] = bySci[t.science] || []).push(t);
console.log('\nscience(지식) 트랙 최종 레벨별');
console.log('레벨  건수  평균점수  평균순위');
for (const k of Object.keys(bySci).sort((a, b) => a - b)) {
	const a = bySci[k];
	console.log(`${String(k).padEnd(6)}${String(a.length).padStart(4)} ${avg(a, (t) => t.score).toFixed(1).padStart(9)} ${avg(a.filter(t => t.rank), (t) => t.rank).toFixed(2).padStart(9)}`);
}

// 무엇을 덮었나 (고급타일은 기존 기술타일 위에 덮는다)
const cov = {};
for (const t of takers) cov[t.covered] = (cov[t.covered] || 0) + 1;
console.log('\n덮은 기술타일');
for (const [k, v] of Object.entries(cov).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
