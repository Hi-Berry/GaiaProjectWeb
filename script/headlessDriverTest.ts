/**
 * [ai2 0단계 2026-10-05] 헤드리스 구동기 검증 — R1 액션 단계 시작 스냅샷(logs/round-start/*_r1.json,
 * AI_ROUND_START_SNAPSHOTS=1로 h2h가 덤프)에서 게임 끝까지 소켓·타이머 없이 진행되는지.
 *  게이트: ①무작위 정책 전 판 종료(막힘 0) ②한 판 시간 ③기존 봇 정책(빠른 경로)의 점수가 실제 h2h 판과 같은 대역인가
 *  사용: PORT=5131 npx tsx script/headlessDriverTest.ts [--random-reps 3]
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { prepareHeadless, runToEnd, randomPolicy, botFastPolicy, botFullPolicy } from '../server/ai2/headlessDriver';
import { MCTS } from '../server/ai/mcts';

const out = (s: string) => fs.writeSync(1, s + '\n');
const dir = path.join(process.cwd(), 'logs', 'round-start');
const args = process.argv.slice(2);
const reps = args.includes('--random-reps') ? Number(args[args.indexOf('--random-reps') + 1]) : 3;
const mctsMs = args.includes('--mcts') ? Number(args[args.indexOf('--mcts') + 1]) : 0; // >0이면 MCTS 포함 기존 봇 정책도 측정
if (mctsMs) MCTS.setBotOnlyCap(mctsMs);
const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json')).sort();

(async () => {
	const rows: any[] = [];
	for (const f of files) {
		const gid = f.replace('_r1.json', '');
		const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		const actual: number[] = []; // (실제 h2h 점수 비교는 h2h 리포트로 — final_state는 2026-10-05 이전 시뮬 종료가 덮어쓴 적 있음)
		const pols: [string, (i: number) => any][] = [['random', (i: number) => randomPolicy(i + 1)], ['bot', () => botFastPolicy]];
		if (mctsMs) pols.push(['botMcts', () => botFullPolicy]);
		for (const [name, mk] of pols) {
			const n = name === 'random' ? reps : 1;
			for (let i = 0; i < n; i++) {
				const g = prepareHeadless(snap);
				const t0 = performance.now();
				const r = await runToEnd(g, (mk as any)(i), { botParity: name !== 'random' });
				const ms = performance.now() - t0;
				rows.push({ gid, name, ms, ...r, actual });
				out(`${gid} ${name.padEnd(6)} ${r.ended ? 'END ' : 'STUCK'} ${ms.toFixed(0).padStart(6)}ms dec=${r.stats.decisions} act=${r.stats.actionsApplied} fail=${r.stats.actionFailures} auto=${JSON.stringify(r.stats.autoResolved)} scores=${Object.values(r.scores).join('/')}${actual.length ? ` | h2h실제=${actual.join('/')}` : ''}${r.stuck ? ` | ${r.stuck}` : ''}`);
			}
		}
	}
	for (const name of ['random', 'bot', 'botMcts']) {
		if (!rows.some(r => r.name === name)) continue;
		const rr = rows.filter(r => r.name === name);
		const ended = rr.filter(r => r.ended);
		const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
		const sc = ended.flatMap(r => Object.values(r.scores) as number[]);
		out(`\n[${name}] 종료 ${ended.length}/${rr.length} · 평균 ${avg(rr.map(r => r.ms)).toFixed(0)}ms/판 · 결정 ${avg(rr.map(r => r.stats.decisions)).toFixed(0)}개/판 · 평균 점수 ${avg(sc).toFixed(1)}`);
	}
	process.exit(0);
})();
