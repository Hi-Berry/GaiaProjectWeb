/**
 * 사람 플레이어 종합 통계 → JSON (HTML 프로필 뷰어용).
 *
 * 대상: 4인 전원 사람 · 6라운드 완주 게임. 계정 통합(ALIAS).
 * 지표: 성적 / 종족별 / 삽 프로필 / 홈색 방어 / 진영 압박 / 상대 전적.
 * 정의는 digProfileReport·homeColorStealReport·landPressureReport와 동일하게 맞춘다.
 *
 * 사용: node scripts/playerStatsJson.mjs [--out data/player-stats.json] [--min 4]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const argv = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = argv('--out', path.join('data', 'player-stats.json'));
const MIN_GAMES = Number(argv('--min', 4));

const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박',
	// [사용자 2026-08-18] 소통맨=지수홍, 보노보노=mks (아직 로그엔 안 나온 이름 — 앞으로 들어올 판부터 통합된다)
	'소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

/** 연구 트랙 6종 (shared/gameConfig.ts RESEARCH_TRACKS 순서) */
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const TRACK_KO = { terraforming: '테라포밍', navigation: '항법', artificialIntelligence: 'AI', gaiaProject: '가이아', economy: '경제', science: '과학' };

const HOME_PLANETS = ['terra', 'volcanic', 'oxide', 'desert', 'swamp', 'titanium', 'ice'];
const EXPANSION = new Set(['moweyip', 'space_giants', 'tinkeroids', 'darkanians']);

function loadFactions() {
	const src = fs.readFileSync(path.join(process.cwd(), 'shared', 'gameConfig.ts'), 'utf8');
	const home = {}, name = {};
	// name은 'Terrans' 또는 "Bal T'aks" 둘 다 나온다
	for (const [, id, nm1, nm2, hp] of src.matchAll(/id:\s*'([a-z_]+)',\s*name:\s*(?:'([^']*)'|"([^"]*)"),\s*homePlanet:\s*'([a-z]+)'/g)) { home[id] = hp; name[id] = nm1 ?? nm2; }
	return { home, name };
}
const { home: HOME, name: FAC_NAME } = loadFactions();
const FAC_KO = {
	terran: '테란', lantids: '란티다', hadsch_hallas: '하쉬할라스', ivits: '아이비츠', geodens: '게오덴',
	bal_tak: '발탁', xenos: '제노스', gleens: '글렌스', taklons: '타클론', ambas: '엠바스',
	bescods: '베스코드', firaks: '피락스', itars: '이타르', nevlas: '네블라',
	moweyip: '모웨이드', space_giants: '스페이스자이언츠', tinkeroids: '팅커로이드', darkanians: '다카니안',
};

/** 자기 종족 홈 기준 삽 수 (digProfileReport와 동일) */
function steps(faction, to) {
	if (to === 'asteroid') return 0;
	if (to === 'gaia' || to === 'transdim') return -1;
	if (to === 'proto') return 3;
	if (faction === 'darkanians') return HOME_PLANETS.includes(to) ? 1 : 0;
	if (faction === 'space_giants') return HOME_PLANETS.includes(to) ? 2 : 0;
	const from = HOME[faction];
	if (!from || from === to) return 0;
	const a = HOME_PLANETS.indexOf(from), b = HOME_PLANETS.indexOf(to);
	if (a < 0 || b < 0) return 0;
	const d = Math.abs(a - b);
	return Math.min(d, 7 - d);
}

const isAllHuman4 = (g) => {
	const k = Object.keys(g.players ?? {});
	if (k.length !== 4) return false;
	const bots = new Set(g.botPlayerIds ?? []);
	return !k.some((x) => bots.has(x) || /^AI Bot/.test(g.players[x].name ?? ''));
};

const PLACE_RE = /^(Built Mine|Placed Starting Mine|Placed Starting Planetary Institute|Built Parasitic Mine|Eclipse: Built mine on asteroid|Ivits: Space Station|Placed Gaiaformer|Advanced TS built|Artifact:.*virtual mine)/i;
const MINE_RE = /^(Built Mine|Placed Starting Mine|Built Parasitic Mine|Eclipse: Built mine on asteroid|Advanced TS built|Artifact:.*virtual mine)/i;
/** 삽 프로필 전용 — 시작 광산·기생광산은 '판 땅'이 아니므로 digProfileReport와 같이 제외 */
const DIG_RE = /^Built Mine/i;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

const P = {};
const blank = () => ({
	games: 0, wins: 0, rankSum: 0, scoreSum: 0, best: 0, gapSum: 0, ranks: [0, 0, 0, 0],
	tech: 0, feds: 0, resSum: 0, trackSum: {}, trackN: {},
	s0: 0, s1: 0, s2: 0, s3: 0, gaia: 0, ast: 0, oreDug: 0, terraSum: 0, terraN: 0,
	hGames: 0, hTiles: 0, hSelf: 0, hStolen: 0, hR13: 0, hR46: 0,
	adjIn: 0, adjOut: 0, paras: 0, parasBy: 0, builds: 0,
	factions: {}, vs: {},
});
const seat = (n) => (P[n] ??= blank());
const vsSeat = (s, o) => (s.vs[o] ??= { games: 0, myRankSum: 0, myWins: 0, theirWins: 0, stealBy: 0, stealOn: 0, adjBy: 0, adjOn: 0 });

let games = 0, files = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	files++;
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	if ((g.roundNumber ?? 0) < 6) continue;
	games++;

	const nameOf = {}, facOf = {}, homeOf = {};
	const scores = Object.values(g.players).map((p) => p.score ?? 0);
	const top = Math.max(...scores);
	for (const [pid, p] of Object.entries(g.players)) {
		const nm = canon(p.name ?? pid);
		nameOf[pid] = nm; facOf[pid] = p.faction ?? '';
		homeOf[pid] = EXPANSION.has(facOf[pid]) ? '' : (HOME[facOf[pid]] ?? '');
		const s = seat(nm);
		s.games++;
		const rk = p.rank ?? 4;
		s.rankSum += rk;
		if (rk >= 1 && rk <= 4) s.ranks[rk - 1]++;
		if (rk === 1) s.wins++;
		s.scoreSum += p.score ?? 0;
		s.best = Math.max(s.best, p.score ?? 0);
		s.gapSum += top - (p.score ?? 0);
		s.tech += (p.techTiles ?? []).length;
		s.feds += (p.federations ?? []).length;
		const rv = Object.values(p.research ?? {});
		if (rv.length) s.resSum += rv.reduce((a, b) => a + b, 0) / rv.length;
		for (const t of TRACKS) {
			const v = p.research?.[t];
			if (typeof v === 'number') { s.trackSum[t] = (s.trackSum[t] ?? 0) + v; s.trackN[t] = (s.trackN[t] ?? 0) + 1; }
		}
		const lv = p.research?.terraforming;
		if (typeof lv === 'number') { s.terraSum += lv; s.terraN++; }
		const fb = (s.factions[facOf[pid]] ??= { n: 0, wins: 0, rankSum: 0, scoreSum: 0 });
		fb.n++; fb.rankSum += rk; fb.scoreSum += p.score ?? 0; if (rk === 1) fb.wins++;
		if (homeOf[pid]) { s.hGames++; s.hTiles += (g.map ?? []).filter((t) => t.type === homeOf[pid]).length; }
	}
	const ids = Object.keys(nameOf);
	for (const a of ids) for (const b of ids) {
		if (a === b) continue;
		const v = vsSeat(seat(nameOf[a]), nameOf[b]);
		v.games++;
		v.myRankSum += g.players[a].rank ?? 4;
		if ((g.players[a].rank ?? 4) < (g.players[b].rank ?? 4)) v.myWins++; else v.theirWins++;
	}

	const pos = {}, at = {}, typeOf = {};
	for (const t of g.map ?? []) { pos[t.id] = [t.q, t.r]; at[t.q + ',' + t.r] = t.id; typeOf[t.id] = t.type; }

	const owner = {};
	for (const e of g.gameLog ?? []) {
		const act = e.action ?? '';
		if (!PLACE_RE.test(act)) continue;
		const tid = e.tileId, A = e.playerId;
		if (!tid || !nameOf[A] || !pos[tid]) continue;
		const sA = seat(nameOf[A]);
		const isMine = MINE_RE.test(act);
		sA.builds++;

		const prev = owner[tid];
		if (prev && prev !== A && nameOf[prev]) { seat(nameOf[prev]).paras++; sA.parasBy++; }

		const [q, r] = pos[tid];
		const vict = new Set();
		for (const [dq, dr] of DIRS) {
			const nid = at[(q + dq) + ',' + (r + dr)];
			const o = nid && owner[nid];
			if (o && o !== A && nameOf[o]) vict.add(o);
		}
		for (const v of vict) {
			seat(nameOf[v]).adjIn++;
			sA.adjOut++;
			vsSeat(sA, nameOf[v]).adjOn++;
			vsSeat(seat(nameOf[v]), nameOf[A]).adjBy++;
		}

		if (isMine) {
			const m = (e.details ?? '').match(/on\s+([a-z_]+)/i);
			const type = m ? m[1].toLowerCase() : (typeOf[tid] ?? '');
			// 삽 프로필 (본인 기준) — 'Built Mine' 계열만
			if (!DIG_RE.test(act)) { /* 시작·기생광산은 삽 집계 제외 */ }
			else if (type === 'asteroid') sA.ast++;
			else if (type === 'gaia' || type === 'transdim') sA.gaia++;
			else {
				const st = steps(facOf[A], type);
				if (st === 0) sA.s0++; else if (st === 1) sA.s1++; else if (st === 2) sA.s2++; else if (st === 3) sA.s3++;
			}
			if (DIG_RE.test(act)) sA.oreDug += Number(((e.details ?? '').match(/(\d+)\s*O\s*terraform/i) || [])[1] ?? 0);
			// 홈색 탈취/확보 (첫 점유자만)
			if (!prev) {
				for (const v of ids) {
					if (!homeOf[v] || homeOf[v] !== type) continue;
					const sV = seat(nameOf[v]);
					if (v === A) { sV.hSelf++; continue; }
					if (homeOf[A] === type) continue;
					sV.hStolen++;
					if ((e.round ?? 0) <= 3) sV.hR13++; else sV.hR46++;
					vsSeat(sA, nameOf[v]).stealOn++;
					vsSeat(sV, nameOf[A]).stealBy++;
				}
			}
		}
		if (!prev) owner[tid] = A;
	}
}

const players = Object.entries(P).filter(([, s]) => s.games >= MIN_GAMES).map(([nm, s]) => {
	const n = s.games, dug = s.s1 + s.s2 + s.s3, totalSteps = s.s1 + s.s2 * 2 + s.s3 * 3;
	return {
		name: nm, games: n,
		wins: s.wins, winPct: (100 * s.wins) / n,
		avgRank: s.rankSum / n, ranks: s.ranks,
		avgScore: s.scoreSum / n, best: s.best, gap: s.gapSum / n,
		tech: s.tech / n, feds: s.feds / n, research: s.resSum / n, terra: s.terraN ? s.terraSum / s.terraN : 0,
		tracks: Object.fromEntries(TRACKS.map((t) => [t, s.trackN[t] ? s.trackSum[t] / s.trackN[t] : 0])),
		dig: {
			s0: s.s0 / n, s1: s.s1 / n, s2: s.s2 / n, s3: s.s3 / n, gaia: s.gaia / n, ast: s.ast / n,
			dug: dug / n, steps: totalSteps / n, depth: dug ? totalSteps / dug : 0, ore: s.oreDug / n,
		},
		home: s.hGames ? {
			games: s.hGames, tiles: s.hTiles / s.hGames,
			self: s.hSelf / s.hGames, stolen: s.hStolen / s.hGames,
			left: (s.hTiles - s.hSelf - s.hStolen) / s.hGames,
			pct: (100 * s.hStolen) / s.hTiles, selfPct: (100 * s.hSelf) / s.hTiles,
			r13: s.hR13 / s.hGames, r46: s.hR46 / s.hGames,
		} : null,
		zone: { adjIn: s.adjIn / n, adjOut: s.adjOut / n, paras: s.paras / n, parasBy: s.parasBy / n, builds: s.builds / n },
		factions: Object.entries(s.factions).map(([id, f]) => ({
			id, label: FAC_NAME[id] ?? id, ko: FAC_KO[id] ?? id, home: HOME[id] ?? '', expansion: EXPANSION.has(id),
			n: f.n, wins: f.wins, avgRank: f.rankSum / f.n, avgScore: f.scoreSum / f.n,
		})).sort((a, b) => b.n - a.n || a.avgRank - b.avgRank),
		vs: Object.entries(s.vs).map(([o, v]) => ({
			name: o, games: v.games, myAvgRank: v.myRankSum / v.games,
			myWins: v.myWins, theirWins: v.theirWins,
			stealBy: v.stealBy / v.games, stealOn: v.stealOn / v.games,
			adjBy: v.adjBy / v.games, adjOn: v.adjOn / v.games,
		})).sort((a, b) => b.games - a.games),
	};
}).sort((a, b) => b.games - a.games);

// 그룹 평균 + 지표별 순위(참고용)
const mean = (f) => players.reduce((a, p) => a + f(p), 0) / players.length;
const homePlayers = players.filter((p) => p.home);
const hmean = (f) => homePlayers.reduce((a, p) => a + f(p.home), 0) / homePlayers.length;
const avg = {
	games: mean((p) => p.games), winPct: mean((p) => p.winPct), avgRank: mean((p) => p.avgRank),
	avgScore: mean((p) => p.avgScore), gap: mean((p) => p.gap), tech: mean((p) => p.tech),
	feds: mean((p) => p.feds), research: mean((p) => p.research), terra: mean((p) => p.terra),
	tracks: Object.fromEntries(TRACKS.map((t) => [t, mean((p) => p.tracks[t])])),
	dig: {
		s0: mean((p) => p.dig.s0), s1: mean((p) => p.dig.s1), s2: mean((p) => p.dig.s2), s3: mean((p) => p.dig.s3),
		gaia: mean((p) => p.dig.gaia), ast: mean((p) => p.dig.ast), dug: mean((p) => p.dig.dug),
		steps: mean((p) => p.dig.steps), depth: mean((p) => p.dig.depth), ore: mean((p) => p.dig.ore),
	},
	home: {
		tiles: hmean((h) => h.tiles), self: hmean((h) => h.self), stolen: hmean((h) => h.stolen),
		pct: hmean((h) => h.pct), selfPct: hmean((h) => h.selfPct), r13: hmean((h) => h.r13), r46: hmean((h) => h.r46),
	},
	zone: {
		adjIn: mean((p) => p.zone.adjIn), adjOut: mean((p) => p.zone.adjOut),
		paras: mean((p) => p.zone.paras), builds: mean((p) => p.zone.builds),
	},
};

/** 낮을수록 좋은 지표는 asc:true */
const RANKED = [
	['winPct', (p) => p.winPct, false], ['avgRank', (p) => p.avgRank, true], ['avgScore', (p) => p.avgScore, false],
	['steps', (p) => p.dig.steps, false], ['depth', (p) => p.dig.depth, false], ['ore', (p) => p.dig.ore, false],
	['gaia', (p) => p.dig.gaia, false], ['tech', (p) => p.tech, false], ['feds', (p) => p.feds, false],
	['stealPct', (p) => (p.home ? p.home.pct : null), true], ['selfPct', (p) => (p.home ? p.home.selfPct : null), false],
	['adjIn', (p) => p.zone.adjIn, false], ['adjOut', (p) => p.zone.adjOut, false],
];
for (const [key, get, asc] of RANKED) {
	const list = players.filter((p) => get(p) !== null).slice().sort((a, b) => (asc ? get(a) - get(b) : get(b) - get(a)));
	list.forEach((p, i) => { (p.rank ??= {})[key] = { pos: i + 1, of: list.length }; });
}

const out = { generated: '2026-08-18', files, games, minGames: MIN_GAMES, tracks: TRACKS, trackNames: TRACK_KO, avg, players };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${OUT} — ${players.length}명 / 완주 ${games}판 (파일 ${files}개) / ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
console.log(players.map((p) => `${p.name}(${p.games})`).join(' '));
