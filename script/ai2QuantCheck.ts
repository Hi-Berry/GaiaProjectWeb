/**
 * [ai2 속도 2026-10-25] 양자화 모델 vs 원래 ONNX: 1회 평가 시간 · 최고 확률 수 일치율 · 사전확률/가치 차이.
 *  사용: npx tsx script/ai2QuantCheck.ts <원래.onnx> <양자화.onnx> [상태 수]
 */
import * as fs from 'fs';
import { prepareHeadless } from '../server/ai2/headlessDriver';
import { generateMoves } from '../server/ai2/moveGen';
import { OnnxNet } from '../server/ai2/onnxNet';

(async () => {
	const [a, b, nArg] = process.argv.slice(2);
	const A = new OnnxNet(a), B = new OnnxNet(b); await A.ready(); await B.ready();
	const files = fs.readdirSync('logs/round-start').filter(f => f.endsWith('.json')).sort().filter((_, i) => i % 7 === 0).slice(0, Number(nArg ?? 150));
	let n = 0, top = 0, maxP = 0, sumV = 0, maxV = 0;
	const reqs: any[] = [];
	for (const f of files) {
		const g = prepareHeadless(JSON.parse(fs.readFileSync('logs/round-start/' + f, 'utf8')));
		for (const pid of g.turnOrder) {
			const moves = generateMoves(g, pid).length ? generateMoves(g, pid) : [{ type: 'pass_round', params: {} } as any];
			reqs.push({ game: g, pov: pid, moves });
		}
	}
	for (const r of reqs) {
		const [x] = await A.evaluate([r]); const [y] = await B.evaluate([r]);
		n++; const ix = x.priors.indexOf(Math.max(...x.priors)), iy = y.priors.indexOf(Math.max(...y.priors)); if (ix === iy) top++;
		maxP = Math.max(maxP, ...x.priors.map((p, i) => Math.abs(p - y.priors[i]))); const dv = Math.abs(x.value - y.value) * 50; sumV += dv; maxV = Math.max(maxV, dv);
	}
	const time = async (net: OnnxNet) => { const t0 = process.hrtime.bigint(); for (let k = 0; k < 3; k++) for (const r of reqs.slice(0, 100)) await net.evaluate([r]); return Number(process.hrtime.bigint() - t0) / 1e6 / 300; };
	const ta = await time(A), tb = await time(B);
	console.log(`상태 ${n} · 최고 확률 수 일치 ${(100 * top / n).toFixed(1)}% · 사전확률 최대 차 ${maxP.toFixed(3)} · 가치 차 평균 ${(sumV / n).toFixed(2)}점 최대 ${maxV.toFixed(2)}점 · 1회 평가 ${ta.toFixed(2)}ms → ${tb.toFixed(2)}ms (${(ta / tb).toFixed(2)}배)`);
	process.exit(0);
})();
