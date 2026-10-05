/**
 * [ai2 0단계 2026-10-05] ai2 좌석 구동 검증 — ai2 좌석은 생성기 선택지(메인·보류·리치)에서 무작위, 나머지는 기존 봇(빠른 경로).
 *  게이트: 전 판 종료(막힘 0), 결정 종류별 횟수, 정책 실패 폴백 횟수.
 *  사용: PORT=5131 npx tsx script/ai2SeatTest.ts [--seats 1|4] [--reps 2]
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { prepareHeadless, runToEnd, botFastPolicy, markAi2Seats, Policy } from '../server/ai2/headlessDriver';
import { tryApply } from '../server/ai2/moveGen';

const out = (s: string) => fs.writeSync(1, s + '\n');
const args = process.argv.slice(2);
const opt = (k: string, d: number) => args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d;
const dir = path.join(process.cwd(), 'logs', 'round-start');
const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json')).sort();
const kinds: Record<string, number> = {};

function mixedPolicy(seed: number): Policy {
	let s = seed >>> 0 || 1; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	return async (game, d) => {
		if (!d.options) return botFastPolicy(game, d);
		kinds[d.kind + (d.pendingKey ? ':' + d.pendingKey : '')] = (kinds[d.kind + (d.pendingKey ? ':' + d.pendingKey : '')] ?? 0) + 1;
		if (d.kind !== 'main') return d.options[Math.floor(rnd() * d.options.length)];
		const free = d.options.filter(m => m.type === 'convert_resource' || m.type === 'burn_power' || m.type === 'bal_tak_gaiaformer_to_qic');
		const main = d.options.filter(m => !free.includes(m));
		const pool = (free.length && rnd() < 0.15) ? free : main;
		const order = pool.map(m => [rnd(), m] as const).sort((a, b) => a[0] - b[0]).map(x => x[1])
			.sort((a, b) => (a.type === 'pass_round' ? 1 : 0) - (b.type === 'pass_round' ? 1 : 0));
		for (const m of order) if (await tryApply(game, d.playerId, m)) return m;
		return null;
	};
}

(async () => {
	const seatsN = opt('--seats', 1), reps = opt('--reps', 2);
	let ended = 0, total = 0; const times: number[] = []; const stuck: Record<string, number> = {}; const auto: Record<string, number> = {};
	const ai2Scores: number[] = [], botScores: number[] = [];
	for (const f of files) {
		const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		for (let i = 0; i < reps; i++) {
			const g = prepareHeadless(snap);
			const seats = new Set(g.turnOrder.slice(0, seatsN));
			markAi2Seats(g, seats);
			const t0 = performance.now();
			const r = await runToEnd(g, mixedPolicy(i + 3), { botParity: true, ai2Seats: seats });
			times.push(performance.now() - t0); total++;
			for (const [k, v] of Object.entries(r.stats.autoResolved)) auto[k] = (auto[k] ?? 0) + v;
			if (r.ended) { ended++; for (const [id, sc] of Object.entries(r.scores)) (seats.has(id) ? ai2Scores : botScores).push(sc as number); }
			else stuck[String(r.stuck).slice(0, 100)] = (stuck[String(r.stuck).slice(0, 100)] ?? 0) + 1;
		}
	}
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
	out(`ai2 좌석 ${seatsN}개 · 종료 ${ended}/${total} · 평균 ${avg(times).toFixed(0)}ms/판 · ai2 점수 ${avg(ai2Scores).toFixed(1)} · 봇 점수 ${avg(botScores).toFixed(1)}`);
	out('ai2 결정 종류: ' + JSON.stringify(kinds));
	out('자동/폴백 집계: ' + JSON.stringify(auto));
	for (const [k, v] of Object.entries(stuck)) out(`  막힘 ${v}× ${k}`);
	process.exit(0);
})();
