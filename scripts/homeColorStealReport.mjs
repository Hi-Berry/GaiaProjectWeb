/**
 * 홈컬러 탈취 리포트: "내 종족 홈색(=나에겐 0삽) 땅을 남이 얼마나 먼저 먹나".
 *
 * 맵에 깔린 내 홈색 칸을 100%로 두고 3분할: 내가 먹음 / 남이 먹음 / 아무도 안 먹음.
 * 확장 종족(moweyip·space_giants·tinkeroids·darkanians)은 제외 — proto/asteroid는 시작 위치일 뿐
 * '홈색'이 아니다(사용자 지적 2026-08-18). 가해자 쪽은 그대로 센다(남의 홈색을 판 건 판 거다).
 * 남이 먹은 것 중, 그 사람도 같은 홈색이면 '탈취'로 세지 않는다(자기 땅이기도 하므로 별도 표기).
 * 4인 사람 게임 완주 판만. 사용: node scripts/homeColorStealReport.mjs [--min 4] [--who 아이페르]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const argv = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MIN_GAMES = Number(argv('--min', 4));
const WHO = argv('--who', '아이페르');

const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박',
	// [사용자 2026-08-18] 소통맨=지수홍, 보노보노=mks (아직 로그엔 안 나온 이름 — 앞으로 들어올 판부터 통합된다)
	'소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

/** 종족→홈 행성. name은 'Terrans'와 "Bal T'aks" 두 형태가 섞여 있으니 둘 다 받는다 (발탁 누락 버그). */
function loadHome() {
	const src = fs.readFileSync(path.join(process.cwd(), 'shared', 'gameConfig.ts'), 'utf8');
	const m = {};
	for (const [, id, home] of src.matchAll(/id:\s*'([a-z_]+)',\s*name:\s*(?:'[^']*'|"[^"]*"),\s*homePlanet:\s*'([a-z]+)'/g)) m[id] = home;
	return m;
}
const HOME = loadHome();
/** 확장 종족: 시작 행성이 proto/asteroid라 '홈색' 개념이 없다 — 피해자 집계에서 뺀다 */
const EXPANSION = new Set(['moweyip', 'space_giants', 'tinkeroids', 'darkanians']);
const hasHome = (fac) => !!HOME[fac] && !EXPANSION.has(fac);
const isAllHuman4 = (g) => {
	const k = Object.keys(g.players ?? {});
	if (k.length !== 4) return false;
	const bots = new Set(g.botPlayerIds ?? []);
	return !k.some((x) => bots.has(x) || /^AI Bot/.test(g.players[x].name ?? ''));
};
const MINE_RE = /^(Built Mine|Placed Starting Mine|Built Parasitic Mine|Eclipse: Built mine on asteroid|Advanced TS built|Artifact:.*virtual mine)/i;

const P = {};                 // 피해자 집계
const byPair = {};            // 가해자>피해자
const byFaction = {};         // WHO의 종족별
const seat = (n) => (P[n] ??= { games: 0, tiles: 0, self: 0, stolen: 0, sameHome: 0, left: 0, r13: 0, r46: 0 });
const ps = (a, v) => (byPair[a + '>' + v] ??= { games: 0, stolen: 0 });

let games = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	if ((g.roundNumber ?? 0) < 6) continue;
	games++;

	const nameOf = {}, homeOf = {}, facOf = {};
	for (const [pid, p] of Object.entries(g.players ?? {})) {
		nameOf[pid] = canon(p.name ?? pid);
		facOf[pid] = p.faction ?? '';
		homeOf[pid] = hasHome(facOf[pid]) ? HOME[facOf[pid]] : '';   // 확장 종족은 홈색 없음
		if (homeOf[pid]) seat(nameOf[pid]).games++;
	}
	const ids = Object.keys(nameOf);
	for (const a of ids) for (const v of ids) if (a !== v && homeOf[v]) ps(nameOf[a], nameOf[v]).games++;

	const typeOf = {}, takenBy = {};
	for (const t of g.map ?? []) typeOf[t.id] = t.type;
	for (const v of ids) if (homeOf[v]) seat(nameOf[v]).tiles += (g.map ?? []).filter((t) => t.type === homeOf[v]).length;

	for (const e of g.gameLog ?? []) {
		if (!MINE_RE.test(e.action ?? '')) continue;
		const tid = e.tileId, A = e.playerId;
		if (!tid || !nameOf[A] || takenBy[tid]) continue;
		takenBy[tid] = A;
		const m = (e.details ?? '').match(/on\s+([a-z_]+)/i);
		const type = m ? m[1].toLowerCase() : (typeOf[tid] ?? '');
		const rd = e.round ?? 0;
		for (const v of ids) {
			if (!homeOf[v] || homeOf[v] !== type) continue;
			const s = seat(nameOf[v]);
			if (v === A) { s.self++; continue; }
			if (homeOf[A] === type) { s.sameHome++; continue; }
			s.stolen++;
			if (rd <= 3) s.r13++; else s.r46++;
			ps(nameOf[A], nameOf[v]).stolen++;
			if (nameOf[v] === WHO) {
				const b = (byFaction[facOf[v]] ??= { games: 0, tiles: 0, self: 0, stolen: 0 });
				b.stolen++;
			}
		}
	}
	// WHO 종족별 분모
	for (const v of ids) {
		if (nameOf[v] !== WHO || !homeOf[v]) continue;
		const b = (byFaction[facOf[v]] ??= { games: 0, tiles: 0, self: 0, stolen: 0 });
		b.games++;
		b.tiles += (g.map ?? []).filter((t) => t.type === homeOf[v]).length;
		b.self += Object.entries(takenBy).filter(([tid, a]) => a === v && (typeOf[tid] === homeOf[v])).length;
	}
}

const rows = Object.entries(P).filter(([, s]) => s.games > 0).map(([nm, s]) => ({
	nm, n: s.games,
	tiles: s.tiles / s.games,
	self: s.self / s.games,
	stolen: s.stolen / s.games,
	same: s.sameHome / s.games,
	pct: (100 * s.stolen) / s.tiles,
	selfPct: (100 * s.self) / s.tiles,
	r13: s.r13 / s.games, r46: s.r46 / s.games,
})).filter((r) => r.n >= MIN_GAMES).sort((a, b) => b.pct - a.pct);

console.log(`홈컬러 탈취 — 4인 사람 게임 완주 ${games}판 (확장 종족 판 제외) · 최소 ${MIN_GAMES}판 · 계정 통합 (판당 평균)\n`);
console.log('순위 이름            판수  맵홈색칸  내가먹음  남이먹음   탈취%  내가먹은%  R1-3  R4-6');
console.log('-'.repeat(92));
rows.forEach((r, i) => console.log(
	`${String(i + 1).padStart(3)}. ${r.nm.slice(0, 14).padEnd(15)}${String(r.n).padStart(3)} ${r.tiles.toFixed(1).padStart(8)} ${r.self.toFixed(2).padStart(9)} ${r.stolen.toFixed(2).padStart(9)} ` +
	`${r.pct.toFixed(1).padStart(6)}% ${r.selfPct.toFixed(1).padStart(9)}% ${r.r13.toFixed(2).padStart(6)} ${r.r46.toFixed(2).padStart(5)}`));
const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
console.log('-'.repeat(92));
console.log(`     ${'평균'.padEnd(15)}    ${avg('tiles').toFixed(1).padStart(8)} ${avg('self').toFixed(2).padStart(9)} ${avg('stolen').toFixed(2).padStart(9)} ${avg('pct').toFixed(1).padStart(6)}% ${avg('selfPct').toFixed(1).padStart(9)}% ${avg('r13').toFixed(2).padStart(6)} ${avg('r46').toFixed(2).padStart(5)}`);

const att = Object.entries(byPair).filter(([k]) => k.endsWith('>' + WHO))
	.map(([k, s]) => ({ a: k.split('>')[0], n: s.games, v: s.stolen / s.games }))
	.filter((r) => r.n >= MIN_GAMES).sort((a, b) => b.v - a.v);
console.log(`\n■ ${WHO}의 홈색 땅을 판 사람 (판당)`);
for (const r of att) console.log(`  ${r.a.slice(0, 14).padEnd(15)}${String(r.n).padStart(3)}판  ${r.v.toFixed(2)}`);

const fr = Object.entries(byFaction).filter(([, s]) => s.games).map(([fac, s]) => ({
	fac, home: HOME[fac] ?? '?', n: s.games, tiles: s.tiles / s.games, self: s.self / s.games, stolen: s.stolen / s.games,
	pct: (100 * s.stolen) / s.tiles,
})).sort((a, b) => b.n - a.n);
console.log(`\n■ ${WHO} 종족별 (홈색 기준)`);
console.log('  종족             홈색       판수 맵칸  내가먹음 남이먹음 탈취%');
for (const r of fr) console.log(`  ${r.fac.padEnd(16)}${r.home.padEnd(11)}${String(r.n).padStart(3)} ${r.tiles.toFixed(1).padStart(5)} ${r.self.toFixed(1).padStart(8)} ${r.stolen.toFixed(1).padStart(8)} ${r.pct.toFixed(0).padStart(5)}%`);
