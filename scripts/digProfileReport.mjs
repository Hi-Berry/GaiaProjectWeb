/**
 * 사람별 '내 종족 기준 몇 삽짜리 땅을 먹었나' 리포트 (4인 사람 게임 한정).
 *
 * 사용자 요청(2026-08-14): "내 땅 기준으로 먹은 땅들 1step, 2step, 3step 땅 수의 합·평균.
 *   삽 트랙도 같이."
 *
 * 삽 수는 **자기 종족 홈 행성 기준**이라 같은 desert도 종족마다 다르다:
 *   - 표준 7색: 테라포밍 휠에서 홈까지의 최단 거리(1~3)
 *   - 다카니안: 7색 전부 1삽 / 스페이스 자이언츠: 전부 2삽
 *   - proto: 3삽 · asteroid: 0삽(삽 불가, 인공물/이클립스 전용) · gaia: 포머로 해결(삽 아님)
 *
 * 로그의 `Built Mine :: on desert (...)` 에서 **건설 시점 행성 타입**을 읽는다
 * (맵 최종 상태를 쓰면 가이아포밍된 트랜스딤이 gaia로 보여 왜곡된다).
 *
 * 사용: node scripts/digProfileReport.mjs [--min 4]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const MIN_GAMES = Number(args.includes('--min') ? args[args.indexOf('--min') + 1] : 4);

const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박',
	// [사용자 2026-08-18] 소통맨=지수홍, 보노보노=mks (아직 로그엔 안 나온 이름 — 앞으로 들어올 판부터 통합된다)
	'소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

const HOME_PLANETS = ['terra', 'volcanic', 'oxide', 'desert', 'swamp', 'titanium', 'ice'];

/** shared/gameConfig.ts에서 종족→홈행성 (하드코딩 드리프트 방지) */
/** 종족→홈 행성. name은 'Terrans'와 "Bal T'aks" 두 형태가 섞여 있으니 둘 다 받는다 (발탁 누락 버그). */
function loadHome() {
	const src = fs.readFileSync(path.join(process.cwd(), 'shared', 'gameConfig.ts'), 'utf8');
	const m = {};
	for (const [, id, home] of src.matchAll(/id:\s*'([a-z_]+)',\s*name:\s*(?:'[^']*'|"[^"]*"),\s*homePlanet:\s*'([a-z]+)'/g)) m[id] = home;
	return m;
}
const HOME = loadHome();

/** getTerraformStepsForFaction 축약. moweyip/tinkeroids의 게임별 3삽 지정은 export에 없어 표준 휠로 근사(주석 참고). */
function steps(faction, to) {
	if (to === 'asteroid') return 0;
	if (to === 'gaia' || to === 'transdim') return -1;   // 포머 경로 — 삽 아님
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
	const keys = Object.keys(g.players ?? {});
	if (keys.length !== 4) return false;
	const bots = new Set(g.botPlayerIds ?? []);
	return !keys.some((k) => bots.has(k) || /^AI Bot/.test(g.players[k].name ?? ''));
};

const P = {};
const seat = (nm) => (P[nm] ??= { games: 0, s0: 0, s1: 0, s2: 0, s3: 0, gaia: 0, ast: 0, terraSum: 0, terraN: 0, oreDug: 0 });

let games = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	if ((g.roundNumber ?? 0) < 6) continue;     // 완주 판만 — 중도 게임은 땅 수가 왜곡
	games++;
	const nameOf = {}, facOf = {};
	for (const [pid, p] of Object.entries(g.players ?? {})) {
		nameOf[pid] = canon(p.name ?? pid);
		facOf[pid] = p.faction ?? '';
		const s = seat(nameOf[pid]);
		s.games++;
		const lv = p.research?.terraforming;
		if (typeof lv === 'number') { s.terraSum += lv; s.terraN++; }
	}
	for (const e of g.gameLog ?? []) {
		if (!/^Built Mine/.test(e.action ?? '')) continue;
		const nm = nameOf[e.playerId];
		if (!nm) continue;
		const s = seat(nm);
		const d = e.details ?? '';
		const m = d.match(/on\s+([a-z_]+)/i);
		const type = m ? m[1].toLowerCase() : (/Asteroid/i.test(e.action) ? 'asteroid' : /Proto/i.test(e.action) ? 'proto' : '');
		if (!type) continue;
		const ore = Number((d.match(/(\d+)\s*O\s*terraform/i) || [])[1] ?? 0);
		s.oreDug += ore;
		if (type === 'asteroid') { s.ast++; continue; }
		if (type === 'gaia' || type === 'transdim') { s.gaia++; continue; }
		const st = steps(facOf[e.playerId], type);
		if (st === 0) s.s0++;
		else if (st === 1) s.s1++;
		else if (st === 2) s.s2++;
		else if (st === 3) s.s3++;
	}
}

const rows = Object.entries(P)
	.map(([nm, s]) => {
		const n = s.games;
		const dug = s.s1 + s.s2 + s.s3;
		const totalSteps = s.s1 + s.s2 * 2 + s.s3 * 3;
		return {
			nm, n,
			s0: s.s0 / n, s1: s.s1 / n, s2: s.s2 / n, s3: s.s3 / n,
			gaia: s.gaia / n, ast: s.ast / n,
			dugPg: dug / n,
			stepsPg: totalSteps / n,
			avgStep: dug ? totalSteps / dug : 0,      // 판 땅 1개당 평균 삽 깊이
			orePg: s.oreDug / n,
			terra: s.terraN ? s.terraSum / s.terraN : 0,
		};
	})
	.filter((r) => r.n >= MIN_GAMES)
	.sort((a, b) => b.stepsPg - a.stepsPg);

console.log(`4인 사람 게임 완주 ${games}판 · 최소 ${MIN_GAMES}판 이상 · 계정 통합\n`);
console.log('삽 수는 자기 종족 홈 기준. 0삽=홈색 / 가이아=포머 경로 / 소행성=삽 불가\n');
console.log('이름            판수   0삽   1삽   2삽   3삽  가이아 소행성 | 판땅합 총삽수 평균깊이 광석삽 테라레벨');
console.log('-'.repeat(104));
for (const r of rows) {
	console.log(
		`${r.nm.slice(0, 14).padEnd(15)}${String(r.n).padStart(3)} ` +
		`${r.s0.toFixed(1).padStart(5)} ${r.s1.toFixed(1).padStart(5)} ${r.s2.toFixed(1).padStart(5)} ${r.s3.toFixed(1).padStart(5)} ` +
		`${r.gaia.toFixed(1).padStart(6)} ${r.ast.toFixed(1).padStart(6)} |` +
		`${r.dugPg.toFixed(1).padStart(7)} ${r.stepsPg.toFixed(1).padStart(6)} ${r.avgStep.toFixed(2).padStart(8)} ${r.orePg.toFixed(1).padStart(6)} ${r.terra.toFixed(1).padStart(8)}`
	);
}

const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
console.log('-'.repeat(104));
console.log(`${'평균'.padEnd(15)}    ${avg('s0').toFixed(1).padStart(5)} ${avg('s1').toFixed(1).padStart(5)} ${avg('s2').toFixed(1).padStart(5)} ${avg('s3').toFixed(1).padStart(5)} ${avg('gaia').toFixed(1).padStart(6)} ${avg('ast').toFixed(1).padStart(6)} |${avg('dugPg').toFixed(1).padStart(7)} ${avg('stepsPg').toFixed(1).padStart(6)} ${avg('avgStep').toFixed(2).padStart(8)} ${avg('orePg').toFixed(1).padStart(6)} ${avg('terra').toFixed(1).padStart(8)}`);
console.log('\n※ 총삽수 = 1삽×1 + 2삽×2 + 3삽×3 (실제 판 칸 수). 평균깊이 = 총삽수 ÷ 판 땅 수.');
console.log('※ moweyip·tinkeroids의 게임별 3삽 행성 지정은 저장 로그에 없어 표준 휠로 근사했다.');
