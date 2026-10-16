/**
 * [ai2 실전 2026-10-14] ai2LiveDecide 점검: 라이브 상태 불변 · 결정 시간 · 고른 수가 서버 규칙상 합법인지.
 *  사용: PORT=5193 npx tsx script/ai2LiveTest.ts [상태 개수]
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import { StateCloner } from '../server/ai/stateCloner';
import { ai2LiveDecide } from '../server/ai2/live';
import { tryApply } from '../server/ai2/moveGen';

(async () => {
	const N = Number(process.argv[2] ?? 6);
	const dir = 'logs/round-start';
	const files = fs.readdirSync(dir).filter(f => /_r[2-5]\.json$/.test(f)).sort().filter((_, i) => i % 53 === 0).slice(0, N);
	const times: number[] = [];
	for (const f of files) {
		const live: any = StateCloner.cloneGameStateForSimulation(JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
		live.botPlayerIds = [live.turnOrder[live.currentPlayerIndex]]; // 나머지는 사람 좌석처럼
		const pid = live.turnOrder[live.currentPlayerIndex];
		const h0 = crypto.createHash('md5').update(JSON.stringify(live)).digest('hex');
		const r = await ai2LiveDecide(live, pid);
		const h1 = crypto.createHash('md5').update(JSON.stringify(live)).digest('hex');
		const legal = r.action ? !!(await tryApply(StateCloner.cloneGameStateForSimulation(live) as any, pid, r.action)) : false;
		times.push(r.ms);
		console.log(`${f}: ${r.action ? JSON.stringify(r.action.params).slice(0, 60) : ""} ${r.action?.type ?? "null"}${r.reason ? `(${r.reason})` : ''} · ${r.ms}ms · sims ${r.sims} · 후보 ${r.options} · 상태 불변 ${h0 === h1 ? 'O' : 'X 변경됨!'} · 합법 ${legal ? 'O' : 'X'}`);
	}
	console.log(`평균 ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)}ms · 최대 ${Math.max(...times)}ms`);
	process.exit(0);
})();
