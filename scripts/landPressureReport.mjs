/**
 * "남의 땅을 얼마나 파고 들어가나" 리포트 (4인 사람 게임 한정).
 *
 * 사용자 요청(2026-08-18): "아이페르의 땅을 (남들이) 많이 파는지".
 * 땅을 '판다'의 해석이 셋이라 셋 다 낸다:
 *   A. 인접침범  — 피해자가 이미 지어둔 칸에 '붙여서' 남이 새 건물을 놓은 횟수(건설 시점 점유 기준)
 *   B. 홈컬러탈취 — 피해자 종족 홈 행성색(=피해자에겐 0삽) 땅을 남이 먼저 판 횟수
 *                  (가해자 홈색도 같은 색이면 제외 — 그건 자기 땅이기도 하다)
 *   C. 기생광산  — 란티다가 실제로 그 사람 행성 위에 광산을 얹은 횟수
 *
 * 사용: node scripts/landPressureReport.mjs [--min 4] [--who 아이페르]
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

const isAllHuman4 = (g) => {
	const keys = Object.keys(g.players ?? {});
	if (keys.length !== 4) return false;
	const bots = new Set(g.botPlayerIds ?? []);
	return !keys.some((k) => bots.has(k) || /^AI Bot/.test(g.players[k].name ?? ''));
};

/** 칸을 점유하는 배치 액션 (업그레이드는 주인이 안 바뀌니 제외) */
const PLACE_RE = /^(Built Mine|Placed Starting Mine|Placed Starting Planetary Institute|Built Parasitic Mine|Eclipse: Built mine on asteroid|Ivits: Space Station|Placed Gaiaformer|Advanced TS built|Artifact:.*virtual mine)/i;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

const P = {};          // 피해자 기준 집계
const pair = {};       // `${가해자}>${피해자}` 상세
const seat = (nm) => (P[nm] ??= { games: 0, adjIn: 0, adjOut: 0, steal: 0, stealSelf: 0, paras: 0, homeTiles: 0, mine: 0 });
const pseat = (a, v) => (pair[a + '>' + v] ??= { games: 0, adj: 0, steal: 0, paras: 0 });

let games = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	if ((g.roundNumber ?? 0) < 6) continue;
	games++;

	const nameOf = {}, homeOf = {};
	for (const [pid, p] of Object.entries(g.players ?? {})) {
		nameOf[pid] = canon(p.name ?? pid);
		homeOf[pid] = HOME[p.faction ?? ''] ?? '';
		seat(nameOf[pid]).games++;
	}
	const ids = Object.keys(nameOf);
	for (const a of ids) for (const v of ids) if (a !== v) pseat(nameOf[a], nameOf[v]).games++;

	// 맵: tileId → 좌표 / 좌표 → tileId
	const pos = {}, at = {};
	for (const t of g.map ?? []) { pos[t.id] = [t.q, t.r]; at[t.q + ',' + t.r] = t.id; }
	const typeOf = Object.fromEntries((g.map ?? []).map((t) => [t.id, t.type]));

	// 맵에 깔린 홈컬러 땅 수(정규화용)
	for (const v of ids) {
		const h = homeOf[v];
		if (h) seat(nameOf[v]).homeTiles += (g.map ?? []).filter((t) => t.type === h).length;
	}

	const owner = {};   // tileId → playerId (건설 시점 재생)
	for (const e of g.gameLog ?? []) {
		const act = e.action ?? '';
		if (!PLACE_RE.test(act)) continue;
		const tid = e.tileId, A = e.playerId;
		if (!tid || !A || !nameOf[A] || !pos[tid]) continue;
		const isMine = /Mine|Advanced TS/i.test(act);
		if (isMine) seat(nameOf[A]).mine++;

		// C. 기생광산: 이미 남이 쓰던 칸 위에 얹기
		const prev = owner[tid];
		if (prev && prev !== A && nameOf[prev]) {
			seat(nameOf[prev]).paras++;
			pseat(nameOf[A], nameOf[prev]).paras++;
		}

		// A. 인접침범: 건설 시점에 이웃 칸을 쥐고 있던 사람들
		const [q, r] = pos[tid];
		const vict = new Set();
		for (const [dq, dr] of DIRS) {
			const nid = at[(q + dq) + ',' + (r + dr)];
			const o = nid && owner[nid];
			if (o && o !== A && nameOf[o]) vict.add(o);
		}
		for (const v of vict) {
			seat(nameOf[v]).adjIn++;
			seat(nameOf[A]).adjOut++;
			pseat(nameOf[A], nameOf[v]).adj++;
		}

		// B. 홈컬러 탈취 (광산 계열만)
		if (isMine) {
			const m = (e.details ?? '').match(/on\s+([a-z_]+)/i);
			const type = m ? m[1].toLowerCase() : (typeOf[tid] ?? '');
			for (const v of ids) {
				if (v === A) continue;
				if (!homeOf[v] || homeOf[v] !== type) continue;
				if (homeOf[A] === type) continue;      // 가해자에게도 홈색이면 탈취로 안 셈
				seat(nameOf[v]).steal++;
				pseat(nameOf[A], nameOf[v]).steal++;
			}
			const t2 = (e.details ?? '').match(/on\s+([a-z_]+)/i);
			if (t2 && t2[1].toLowerCase() === homeOf[A]) seat(nameOf[A]).stealSelf++;
		}
		if (!prev) owner[tid] = A;
	}
}

const rows = Object.entries(P)
	.map(([nm, s]) => ({
		nm, n: s.games,
		adjIn: s.adjIn / s.games,
		adjOut: s.adjOut / s.games,
		steal: s.steal / s.games,
		self: s.stealSelf / s.games,
		paras: s.paras / s.games,
		homeT: s.homeTiles / s.games,
		adjPer: s.mine ? s.adjIn / s.mine : 0,          // 내 건물 1개당 남이 붙인 횟수(노출 보정)
		stealPct: s.homeTiles ? (100 * s.steal) / s.homeTiles : 0,  // 맵에 깔린 내 홈색 땅 중 남이 먹은 비율
		build: s.mine / s.games,
	}))
	.filter((r) => r.n >= MIN_GAMES)
	.sort((a, b) => b.adjIn - a.adjIn);

console.log(`4인 사람 게임 완주 ${games}판 · 최소 ${MIN_GAMES}판 · 계정 통합 (수치는 판당 평균)\n`);
console.log('이름            판수 | 당한:인접침범 건물당 홈컬러탈취 홈색뺏긴% 기생 | 내가:인접침범 내홈색먹기 | 건물수');
console.log('-'.repeat(112));
for (const r of rows) {
	console.log(
		`${r.nm.slice(0, 14).padEnd(15)}${String(r.n).padStart(3)} |` +
		`${r.adjIn.toFixed(1).padStart(12)} ${r.adjPer.toFixed(2).padStart(6)} ${r.steal.toFixed(1).padStart(10)} ${r.stealPct.toFixed(0).padStart(9)}% ${r.paras.toFixed(2).padStart(5)} |` +
		`${r.adjOut.toFixed(1).padStart(12)} ${r.self.toFixed(1).padStart(10)} |${r.build.toFixed(1).padStart(7)}`
	);
}
const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
console.log('-'.repeat(112));
console.log(`${'평균'.padEnd(15)}    |${avg('adjIn').toFixed(1).padStart(12)} ${avg('adjPer').toFixed(2).padStart(6)} ${avg('steal').toFixed(1).padStart(10)} ${avg('stealPct').toFixed(0).padStart(9)}% ${avg('paras').toFixed(2).padStart(5)} |${avg('adjOut').toFixed(1).padStart(12)} ${avg('self').toFixed(1).padStart(10)} |${avg('build').toFixed(1).padStart(7)}`);

// WHO 상세: 누가 WHO의 땅을 파는가
const attackers = Object.entries(pair)
	.filter(([k]) => k.endsWith('>' + WHO))
	.map(([k, s]) => ({ a: k.split('>')[0], n: s.games, adj: s.adj / s.games, steal: s.steal / s.games, paras: s.paras / s.games }))
	.filter((r) => r.n >= MIN_GAMES)
	.sort((a, b) => b.adj - a.adj);
console.log(`\n■ ${WHO} 땅을 판 사람들 (같이 한 판 기준, 판당 평균)`);
console.log('가해자          같이한판 인접침범 홈컬러탈취 기생광산');
console.log('-'.repeat(60));
for (const r of attackers) console.log(`${r.a.slice(0, 14).padEnd(15)}${String(r.n).padStart(6)} ${r.adj.toFixed(2).padStart(8)} ${r.steal.toFixed(2).padStart(10)} ${r.paras.toFixed(2).padStart(8)}`);

// 역방향: WHO가 남의 땅을 파는가
const victimsOf = Object.entries(pair)
	.filter(([k]) => k.startsWith(WHO + '>'))
	.map(([k, s]) => ({ v: k.split('>')[1], n: s.games, adj: s.adj / s.games, steal: s.steal / s.games }))
	.filter((r) => r.n >= MIN_GAMES)
	.sort((a, b) => b.adj - a.adj);
console.log(`\n■ ${WHO}가 판 남의 땅 (역방향)`);
console.log('피해자          같이한판 인접침범 홈컬러탈취');
console.log('-'.repeat(60));
for (const r of victimsOf) console.log(`${r.v.slice(0, 14).padEnd(15)}${String(r.n).padStart(6)} ${r.adj.toFixed(2).padStart(8)} ${r.steal.toFixed(2).padStart(10)}`);
