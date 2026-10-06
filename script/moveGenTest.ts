/**
 * [ai2 0단계 2026-10-05] 합법 수 생성기(server/ai2/moveGen.ts) 검증.
 *  A. 기존 봇(빠른 경로)으로 R1 스냅샷 게임을 진행하며 매 메인 결정(메인 전)마다:
 *     - 생성 시간 vs getCandidateMoves 시간
 *     - 커버리지: 기존 봇 후보(preActions 없는 것)가 생성기 출력에 있는가 — 유형별 누락
 *     - 유효율: 생성한 메인 수 중 서버가 받아 주는 비율(유형별)
 *  B. 생성기만으로 무작위 대국(첫 합법 수 지연 검증) — 한 판 시간·막힘
 *  사용: PORT=5131 npx tsx script/moveGenTest.ts [--games 6] [--random-reps 3]
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { BotLogic, BotAction } from '../server/ai/bot';
import { prepareHeadless, runToEnd, botFastPolicy, Policy } from '../server/ai2/headlessDriver';
import { generateMoves, moveKey, tryApply } from '../server/ai2/moveGen';

const out = (s: string) => fs.writeSync(1, s + '\n');
const args = process.argv.slice(2);
const opt = (k: string, d: number) => args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d;
const dir = path.join(process.cwd(), 'logs', 'round-start');
const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json')).sort().slice(0, opt('--games', 6));

const S = { genMs: [] as number[], candMs: [] as number[], genN: [] as number[], candN: [] as number[], applyMs: [] as number[],
	miss: {} as Record<string, number>, missEx: {} as Record<string, string>, candTotal: {} as Record<string, number>,
	legal: {} as Record<string, [number, number]> };
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** 기존 봇 정책을 감싸 매 결정 전에 측정 */
const probePolicy: Policy = async (game, d) => {
	if (game.currentPhase === 'main' && !game.hasDoneMainAction) {
		const t0 = performance.now(); const gen = generateMoves(game, d.playerId); const t1 = performance.now();
		const cands = BotLogic.getCandidateMoves(game, d.playerId); const t2 = performance.now();
		S.genMs.push(t1 - t0); S.candMs.push(t2 - t1); S.genN.push(gen.length); S.candN.push(cands.length);
		const keys = new Set(gen.map(moveKey));
		for (const c of cands) {
			if (c.type === 'end_turn' || (c.preActions?.length ?? 0) > 0) continue;
			inc(S.candTotal, c.type);
			if (!keys.has(moveKey(c))) {
				// 기존 후보가 서버에서도 합법일 때만 '진짜 누락'
				if (await tryApply(game, d.playerId, c)) { inc(S.miss, c.type); S.missEx[c.type] ??= moveKey(c); }
			}
		}
		for (const m of gen) {
			const ta = performance.now(); const ok = !!(await tryApply(game, d.playerId, m)); S.applyMs.push(performance.now() - ta);
			const e = (S.legal[m.type] ??= [0, 0]); e[1]++; if (ok) e[0]++;
		}
	}
	return botFastPolicy(game, d);
};

/** 생성기 기반 무작위 정책: 프리액션 20%, 나머지 메인; 첫 합법 수를 고른다(지연 검증) */
function genRandomPolicy(seed: number): Policy {
	let s = seed >>> 0 || 1; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	return async (game, d) => {
		const moves = generateMoves(game, d.playerId);
		const free = moves.filter(m => m.type === 'convert_resource' || m.type === 'burn_power' || m.type === 'bal_tak_gaiaformer_to_qic');
		const main = moves.filter(m => !free.includes(m));
		const pool = (free.length && rnd() < 0.2) ? free : main;
		const order = pool.map(m => [rnd(), m] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
		// 패스는 마지막 수단으로 뒤로(게임 진행)
		order.sort((a, b) => (a.type === 'pass_round' ? 1 : 0) - (b.type === 'pass_round' ? 1 : 0));
		for (const m of order) if (await tryApply(game, d.playerId, m)) return m;
		return null;
	};
}

(async () => {
	for (const f of files) {
		const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		const r = await runToEnd(prepareHeadless(snap), probePolicy, { botParity: true });
		out(`A ${f}: ${r.ended ? 'END' : 'STUCK ' + r.stuck}`);
	}
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
	const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
	out(`\n[A] 메인 결정 ${S.genMs.length}개`);
	out(`  생성기   평균 ${avg(S.genMs).toFixed(2)}ms · 중앙 ${med(S.genMs).toFixed(2)}ms · 수 평균 ${avg(S.genN).toFixed(1)}개`);
	out(`  기존후보 평균 ${avg(S.candMs).toFixed(2)}ms · 중앙 ${med(S.candMs).toFixed(2)}ms · 수 평균 ${avg(S.candN).toFixed(1)}개`);
	out(`  지연검증(tryApply) 평균 ${avg(S.applyMs).toFixed(2)}ms/수`);
	out('  커버리지(기존 후보 중 서버 합법인데 생성기에 없는 것):');
	for (const [t, n] of Object.entries(S.candTotal).sort((a, b) => b[1] - a[1])) out(`    ${t.padEnd(26)} 누락 ${S.miss[t] ?? 0}/${n}${S.miss[t] ? `  예: ${S.missEx[t]}` : ''}`);
	out('  유효율(생성한 수 중 서버 합법):');
	for (const [t, [ok, n]] of Object.entries(S.legal).sort((a, b) => b[1][1] - a[1][1])) out(`    ${t.padEnd(26)} ${ok}/${n} (${(100 * ok / n).toFixed(0)}%)`);

	const reps = opt('--random-reps', 3); const times: number[] = []; let ended = 0, total = 0; const stuck: Record<string, number> = {};
	const scores: number[] = [];
	for (const f of files) {
		const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		for (let i = 0; i < reps; i++) {
			const t0 = performance.now(); const r = await runToEnd(prepareHeadless(snap), genRandomPolicy(i + 7), {}); times.push(performance.now() - t0);
			total++; if (r.ended) { ended++; scores.push(...Object.values(r.scores) as number[]); } else inc(stuck, String(r.stuck).slice(0, 90));
		}
	}
	out(`\n[B] 생성기 무작위 대국: 종료 ${ended}/${total} · 평균 ${avg(times).toFixed(0)}ms/판 · 중앙 ${med(times).toFixed(0)}ms · 평균 점수 ${avg(scores).toFixed(1)}`);
	for (const [k, v] of Object.entries(stuck)) out(`  막힘 ${v}× ${k}`);
	process.exit(0);
})();
