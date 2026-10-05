// [ai2 2026-10-05] 대결 결과 집계 — data/ai2/match/<mode>_<model>.jsonl (script/ai2Match.ts 출력의 result 줄)
// Δ = (새 AI 좌석 점수 − 상대 평균) − (같은 시작·같은 좌석을 기존 봇이 뒀을 때의 같은 값, 4판 평균). 양수 = 새 AI가 기존 봇보다 잘함.
// 사용: node scripts/ai2/matchReport.mjs data/ai2/match/greedy_v0.jsonl [data/ai2/match/search_v0.jsonl ...]
import fs from 'fs';
for (const fn of process.argv.slice(2)) {
	const rows = fs.readFileSync(fn, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l.slice(l.indexOf('{'))));
	const ok = rows.filter(r => r.ended && Number.isFinite(r.delta));
	const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
	const se = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1) / Math.max(1, a.length)); };
	const d = ok.map(r => r.delta);
	const ranks = [1, 2, 3, 4].map(k => ok.filter(r => r.rank === k).length);
	const botMean = mean(ok.flatMap(r => r.others));
	console.log(`${fn}: ${ok.length}/${rows.length}판`);
	console.log(`  새 AI 평균 ${mean(ok.map(r => r.ai2)).toFixed(1)}점 · 같은 판 기존 봇 평균 ${botMean.toFixed(1)}점`);
	console.log(`  (내 점수 − 상대 평균): 새 AI ${mean(ok.map(r => r.margin)).toFixed(1)} vs 같은 좌석 기존 봇 ${mean(ok.map(r => r.baseMargin)).toFixed(1)}`);
	console.log(`  Δ(짝 비교) ${mean(d).toFixed(2)} ± ${se(d).toFixed(2)} (t=${(mean(d) / se(d)).toFixed(2)})`);
	console.log(`  순위 분포 1/2/3/4등 = ${ranks.join('/')} · 1등 비율 ${(100 * ranks[0] / Math.max(1, ok.length)).toFixed(1)}% (대등 기준 25%)`);
	const stuck = rows.filter(r => !r.ended); if (stuck.length) console.log(`  막힘 ${stuck.length}: ${[...new Set(stuck.map(r => r.stuck))].join(' | ')}`);
}
