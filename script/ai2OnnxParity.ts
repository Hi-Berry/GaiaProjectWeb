/**
 * [ai2 실전 2026-10-14] ONNX 추론(OnnxNet) == 파이썬 torch 추론(NetClient) 확인 + 속도.
 *  사용: PORT=5192 npx tsx script/ai2OnnxParity.ts data/ai2/model_v4h4.pt server/ai2/models/ai2_v4h4.onnx
 */
import * as fs from 'fs';
import * as path from 'path';
import { prepareHeadless } from '../server/ai2/headlessDriver';
import { generateMoves } from '../server/ai2/moveGen';
import { NetClient } from '../server/ai2/netClient';
import { OnnxNet } from '../server/ai2/onnxNet';

(async () => {
	const [pt, onnx] = process.argv.slice(2);
	const py = new NetClient(pt); const ox = new OnnxNet(onnx); await ox.ready();
	const dir = 'logs/round-start';
	const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().filter((_, i) => i % 97 === 0).slice(0, 12);
	let maxP = 0, maxV = 0, n = 0;
	for (const f of files) {
		const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
		const pid = g.turnOrder[g.currentPlayerIndex];
		const moves = generateMoves(g, pid);
		if (!moves.length) continue;
		if (process.env.DBG) console.log("st", f, moves.length);
		const [a] = await py.evaluate([{ game: g, pov: pid, moves }]);
		if (process.env.DBG) console.log("py ok");
		const [b] = await ox.evaluate([{ game: g, pov: pid, moves }]);
		if (process.env.DBG) console.log("ox ok");
		maxP = Math.max(maxP, ...a.priors.map((p, i) => Math.abs(p - b.priors[i]))); maxV = Math.max(maxV, Math.abs(a.value - b.value)); n++;
	}
	const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))); const pid = g.turnOrder[g.currentPlayerIndex]; const moves = generateMoves(g, pid);
	const t0 = Date.now(); for (let i = 0; i < 100; i++) await ox.evaluate([{ game: g, pov: pid, moves }]); const tOx = (Date.now() - t0) / 100;
	const t1 = Date.now(); for (let i = 0; i < 100; i++) await py.evaluate([{ game: g, pov: pid, moves }]); const tPy = (Date.now() - t1) / 100;
	console.log(`상태 ${n}개 · 사전확률 최대 차 ${maxP.toExponential(2)} · 가치 최대 차 ${maxV.toExponential(2)} · 1회 평가 ONNX ${tOx.toFixed(1)}ms / 파이썬 ${tPy.toFixed(1)}ms (후보 ${moves.length}개)`);
	py.close(); process.exit(0);
})();
