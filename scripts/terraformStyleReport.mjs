/**
 * 사람별 '삽(테라포밍) 스타일' 리포트 — 광석을 삽에 쏟는 사람 vs 무료 스텝으로 해결하는 사람.
 *
 * 사용자 질문(2026-08-14): "Step으로 광석 소모하는 것을 좋아하는 사람 뽑을 수 있나?
 *   (2삽 기술 먹으면 +2, 파워 액션 1삽·2삽) 3삽 연방 같은 것도 분석해서"
 *
 * 로그에서 뽑는 값:
 *   ① 광석 삽  — `Built Mine :: on desert (1O, 2C, 3O terraform)` 의 'NO terraform' 부분.
 *                실제로 광석을 태워 판 양이라 '삽에 광석 쓰는 성향'의 직접 지표.
 *   ② 무료 스텝 — 광석을 안 쓰고 얻는 스텝. 소스별로 따로 센다:
 *        파워액션 1삽(3P) / 파워액션 2삽(5P) / 보너스타일 1삽 / TF Mars 3C→1삽
 *        / 우주선기술 2TF+광산 / 스페이스자이언츠 특수 +2삽 / 연방보상 무료광산(N삽)
 *   ③ 테라포밍 연구 레벨 — 삽 단가(3→2→1 광석). 같은 광석으로 더 파는지 판별.
 *
 * 주의: 이건 '누가 잘하나'가 아니라 '스타일'이다. 삽 단가는 테라 레벨에 따라 달라서
 *   광석량만으로 비교하면 저레벨 플레이어가 과대평가된다 → 삽 횟수와 레벨을 같이 본다.
 *
 * 사용: node scripts/terraformStyleReport.mjs [--min 3]   (--min: 최소 참여 판수)
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const MIN_GAMES = Number(args.includes('--min') ? args[args.indexOf('--min') + 1] : 3);

/** 같은 사람이 쓰는 여러 계정 통합 (analyzeShipActions.mjs와 동일 규칙) */
const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박',
	// [사용자 2026-08-18] 소통맨=지수홍, 보노보노=mks (아직 로그엔 안 나온 이름 — 앞으로 들어올 판부터 통합된다)
	'소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
/** 두 사람이 계정 2개씩 쓴 판 — 사람 단위 통계에서 제외 */
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

/** 무료 스텝 소스 — [라벨, 매칭, 스텝수(함수)] */
const FREE = [
	['파워 1삽(3P)', (a, d) => a === 'Power Action' && /\+1 Terraform step/i.test(d), () => 1],
	['파워 2삽(5P)', (a, d) => a === 'Power Action' && /\+2 Terraform steps/i.test(d), () => 2],
	['보너스 1삽', (a, d) => a === 'Bonus Action' && /Terraform Step/i.test(d), () => 1],
	['TF마스 3C→1삽', (a) => /^TF Mars: 3C/.test(a), () => 1],
	['우주선 2TF+광산', (a) => /^Ship Tech: 2TF\+Mine/.test(a), () => 2],
	['자이언츠 특수', (a, d) => /^Space Giants: Special/.test(a) && /Terraform/i.test(d), (d) => Number((d.match(/\+(\d+)\s*Terraform/i) || [])[1] ?? 2)],
	['연방보상 무료광산', (a, d) => a === 'Federation Reward' && /Free Mine/i.test(d), (d) => Number((d.match(/\((\d+)\s*Terraform/i) || [])[1] ?? 0)],
];

const P = {};   // 이름 → 집계
const seat = (nm) => (P[nm] ??= { games: new Set(), oreDug: 0, digs: 0, mines: 0, free: {}, terraLvlSum: 0, terraLvlN: 0 });

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	const bots = new Set(g.botPlayerIds ?? []);
	const nameOf = {};
	for (const [pid, p] of Object.entries(g.players ?? {})) {
		if (bots.has(pid) || /^AI Bot/.test(p.name ?? '')) continue;
		nameOf[pid] = canon(p.name ?? pid);
	}
	// 완주 판만 — 중도 게임은 삽 총량이 왜곡된다
	if ((g.roundNumber ?? 0) < 6) continue;
	for (const [pid, nm] of Object.entries(nameOf)) {
		const s = seat(nm);
		s.games.add(f);
		const lv = g.players[pid]?.research?.terraforming;
		if (typeof lv === 'number') { s.terraLvlSum += lv; s.terraLvlN++; }
	}
	for (const e of g.gameLog ?? []) {
		const nm = nameOf[e.playerId];
		if (!nm) continue;
		const s = seat(nm);
		const a = e.action ?? '', d = e.details ?? '';
		// ① 광석 삽: "(1O, 2C, 3O terraform)"
		if (/^Built Mine/.test(a)) {
			s.mines++;
			const m = d.match(/(\d+)\s*O\s*terraform/i);
			if (m) { s.oreDug += Number(m[1]); s.digs++; }
		}
		// ② 무료 스텝
		for (const [label, match, steps] of FREE) {
			if (match(a, d)) { s.free[label] = (s.free[label] ?? 0) + (steps(d) || 0); break; }
		}
	}
}

const rows = Object.entries(P)
	.map(([nm, s]) => {
		const n = s.games.size;
		const freeTotal = Object.values(s.free).reduce((x, y) => x + y, 0);
		return {
			nm, n,
			orePg: s.oreDug / n,            // 판당 삽에 쓴 광석
			digsPg: s.digs / n,             // 판당 광석 삽 횟수
			orePerDig: s.digs ? s.oreDug / s.digs : 0,
			freePg: freeTotal / n,          // 판당 무료 스텝
			minesPg: s.mines / n,
			terra: s.terraLvlN ? s.terraLvlSum / s.terraLvlN : 0,
			free: s.free,
		};
	})
	.filter((r) => r.n >= MIN_GAMES)
	.sort((a, b) => b.orePg - a.orePg);

console.log(`완주 판 기준 · 최소 ${MIN_GAMES}판 이상 · 봇 제외 (같은 사람 계정 통합)\n`);
console.log('이름            판수  광석삽/판  삽횟수/판  삽당광석  무료스텝/판  광산/판  테라레벨');
console.log('-'.repeat(84));
for (const r of rows) {
	console.log(
		`${r.nm.slice(0, 14).padEnd(15)}${String(r.n).padStart(3)}  ${r.orePg.toFixed(1).padStart(8)}  ${r.digsPg.toFixed(1).padStart(8)}  ${r.orePerDig.toFixed(2).padStart(8)}  ${r.freePg.toFixed(1).padStart(10)}  ${r.minesPg.toFixed(1).padStart(7)}  ${r.terra.toFixed(1).padStart(7)}`
	);
}

console.log('\n무료 스텝 소스별 (판당) — 광석 대신 무엇으로 파는가');
const labels = FREE.map(([l]) => l);
console.log('이름            ' + labels.map((l) => l.slice(0, 12).padStart(13)).join(''));
console.log('-'.repeat(15 + 13 * labels.length));
for (const r of rows) {
	console.log(r.nm.slice(0, 14).padEnd(15) + labels.map((l) => ((r.free[l] ?? 0) / r.n).toFixed(1).padStart(13)).join(''));
}

const tot = rows.reduce((a, r) => ({ ore: a.ore + r.orePg, free: a.free + r.freePg }), { ore: 0, free: 0 });
console.log(`\n평균: 광석삽 ${(tot.ore / rows.length).toFixed(1)}/판 · 무료스텝 ${(tot.free / rows.length).toFixed(1)}/판`);
console.log('※ 삽 단가는 테라 레벨(3→2→1 광석)에 따라 달라 광석량만으로 우열을 보면 안 된다 — 삽횟수·레벨을 같이 볼 것.');
