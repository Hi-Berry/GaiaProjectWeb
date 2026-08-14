/**
 * 되돌리기(롤백) 통계 — 저장된 게임 JSON의 `rollbacks` 필드 기준.
 *
 * 이 필드는 2026-08-14부터 서버가 export에 싣는다(그 전 게임엔 없다).
 * 필드가 없는 게임과 total:0인 게임은 다르다 — 전자는 '구버전이라 알 수 없음', 후자는 '실제로 0회'.
 *
 * 참고: 이 값은 **관리자 되감기 + 투표 롤백**만 센다(countRollback 호출부 기준).
 *   턴 리셋이나 프리액션 Undo는 포함되지 않는다 — 그건 로그 차집합으로만 추정 가능하고
 *   정확도가 낮다(두 로그의 details가 달라 오탐이 나기 쉬움).
 *
 * 사용: node scripts/rollbackReport.mjs [--since YYYY-MM-DD]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const SINCE = args.includes('--since') ? args[args.indexOf('--since') + 1] : '0000-00-00';

let scanned = 0, withField = 0, withAny = 0, total = 0, admin = 0;
const byPlayer = {};      // 이름 → { count, games }
const seats = {};         // 이름 → 참여 판수 (필드 있는 게임만)
const perGame = [];

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (f.slice(0, 10) < SINCE) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	scanned++;
	const rb = g.rollbacks;
	if (!rb) continue;                       // 구버전 서버 — '0회'와 구분해서 제외
	withField++;
	total += rb.total ?? 0;
	admin += rb.admin ?? 0;
	if ((rb.total ?? 0) > 0) withAny++;

	for (const p of Object.values(g.players ?? {})) {
		if (!p?.name) continue;
		seats[p.name] = (seats[p.name] ?? 0) + 1;
	}
	for (const v of Object.values(rb.byPlayer ?? {})) {
		const nm = v.name ?? '(?)';
		byPlayer[nm] = byPlayer[nm] ?? { count: 0, games: 0 };
		byPlayer[nm].count += v.count ?? 0;
		byPlayer[nm].games += 1;
	}
	perGame.push({ d: f.slice(0, 10), total: rb.total ?? 0, admin: rb.admin ?? 0 });
}

console.log(`스캔 ${scanned}판 · 롤백 집계가 있는 게임 ${withField}판`);
if (withField === 0) {
	console.log('\n아직 집계가 실린 게임이 없습니다. 2026-08-14 배포 이후 끝난 게임부터 쌓입니다.');
	process.exit(0);
}
console.log(`롤백이 1회 이상 있던 게임 ${withAny}판 (${(100 * withAny / withField).toFixed(0)}%)`);
console.log(`총 ${total}회 (그중 GM 되감기 ${admin}회) · 게임당 평균 ${(total / withField).toFixed(2)}회`);

console.log('\n사람별 (참여 판수로 정규화)');
console.log('이름              롤백    참여판   판당');
const rows = Object.entries(byPlayer)
	.map(([nm, v]) => ({ nm, c: v.count, g: seats[nm] ?? v.games }))
	.sort((a, b) => b.c - a.c);
for (const r of rows.slice(0, 20)) {
	console.log(`${r.nm.slice(0, 14).padEnd(16)} ${String(r.c).padStart(4)}  ${String(r.g).padStart(5)}판  ${(r.c / (r.g || 1)).toFixed(2)}`);
}

const busiest = perGame.filter(x => x.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);
if (busiest.length) {
	console.log('\n롤백 많았던 게임');
	for (const r of busiest) console.log(`  ${r.d}  ${r.total}회${r.admin ? ` (GM ${r.admin})` : ''}`);
}
