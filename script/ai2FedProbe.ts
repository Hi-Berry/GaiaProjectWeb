/** [ai2 속도 2026-10-17] 탐색 중 연방 계획기 호출 통계: 횟수·빈 결과 비율·시간 (진단용) */
import * as fs from 'fs';
import { StateCloner } from '../server/ai/stateCloner';
import { FederationPlanner } from '../server/ai/federationPlanner';
import { ai2LiveDecide } from '../server/ai2/live';
const FP: any = FederationPlanner; const orig = FP.computeFederationActions.bind(FP);
let calls = 0, empty = 0, ms = 0, emptyMs = 0;
FP.computeFederationActions = (...a: any[]) => { const t = process.hrtime.bigint(); const r = orig(...a); const d = Number(process.hrtime.bigint() - t) / 1e6; calls++; ms += d; if (!r.length) { empty++; emptyMs += d; } return r; };
(async () => {
	const files = fs.readdirSync('logs/round-start').filter(f => /_r[2-5]\.json$/.test(f)).sort().filter((_, i) => i % 53 === 0).slice(0, 4);
	let tot = 0;
	for (const f of files) {
		const live: any = StateCloner.cloneGameStateForSimulation(JSON.parse(fs.readFileSync(`logs/round-start/${f}`, 'utf8')));
		const pid = live.turnOrder[live.currentPlayerIndex]; live.botPlayerIds = [pid];
		const r = await ai2LiveDecide(live, pid); tot += r.ms;
	}
	console.log(`결정 총 ${tot}ms · 계획기 실제 계산 ${calls}회 ${ms.toFixed(0)}ms (${(100 * ms / tot).toFixed(0)}%) · 빈 결과 ${empty}회(${(100 * empty / calls).toFixed(0)}%) ${emptyMs.toFixed(0)}ms · 캐시 적중 ${FP.memoStats.hit} / 미스 ${FP.memoStats.miss}`);
	process.exit(0);
})();
