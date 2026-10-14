/**
 * [ai2 실전 2026-10-14] 정책·가치망 추론 — 서버 프로세스 안에서 onnxruntime-node로 실행(파이썬·torch 불필요).
 * 운영 서버는 CPU 1개·메모리 1GB라 torch를 올릴 수 없다. 모델은 scripts/ai2/export_onnx.py로 .pt → .onnx 변환.
 * NetClient(파이썬 추론 서버)와 같은 evaluate 인터페이스 — puctPolicy에 그대로 넘긴다.
 * onnxruntime-node는 처음 쓸 때 불러온다(새 AI를 안 쓰는 서버는 로드 비용 없음).
 */
import { BotAction } from '../ai/bot';
import { ServerGameState } from '../gameState';
import { encodeState, encodeMove } from './encoder';
import type { NetOut } from './netClient';

const C = 51, H = 20, W = 24, FLAT = 1091, MOVE = 203, GRID = C * H * W;

export interface Evaluator { evaluate(reqs: { game: ServerGameState; pov: string; moves: BotAction[] }[]): Promise<NetOut[]> }

export class OnnxNet implements Evaluator {
	private session: Promise<any>;
	private ort: any;
	calls = 0; ms = 0;
	constructor(modelPath: string, threads = 1) {
		this.session = (async () => {
			// 동적 import — 개발(tsx, ES 모듈)·운영(esbuild CJS, 외부 모듈) 둘 다 동작. require는 ES 모듈에 없다.
			const mod: any = await import('onnxruntime-node' as string);
			this.ort = mod.default ?? mod;
			return this.ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
		})();
	}
	ready() { return this.session.then(() => true); }

	async evaluate(reqs: { game: ServerGameState; pov: string; moves: BotAction[] }[]): Promise<NetOut[]> {
		const t0 = Date.now();
		const sess = await this.session; const ort = this.ort;
		const B = reqs.length; const K = Math.max(1, ...reqs.map(r => r.moves.length));
		const g = new Float32Array(B * GRID), fl = new Float32Array(B * FLAT), mv = new Float32Array(B * K * MOVE);
		const cell = new BigInt64Array(B * K).fill(BigInt(-1)); const mask = new Uint8Array(B * K);
		reqs.forEach((r, b) => {
			const e = encodeState(r.game, r.pov);
			g.set(e.grid, b * GRID); fl.set(e.flat, b * FLAT);
			r.moves.forEach((m, k) => {
				const em = encodeMove(r.game, r.pov, m);
				mv.set(em.flat, (b * K + k) * MOVE); cell[b * K + k] = BigInt(em.cell); mask[b * K + k] = 1;
			});
		});
		const out = await sess.run({
			g: new ort.Tensor('float32', g, [B, C, H, W]), fl: new ort.Tensor('float32', fl, [B, FLAT]), mv: new ort.Tensor('float32', mv, [B, K, MOVE]),
			cell: new ort.Tensor('int64', cell, [B, K]), mask: new ort.Tensor('bool', mask, [B, K]),
		});
		const logit = out.logit.data as Float32Array, value = out.value.data as Float32Array;
		this.calls++; this.ms += Date.now() - t0;
		return reqs.map((r, b) => {
			const logits = Array.from(logit.subarray(b * K, b * K + r.moves.length));
			const mx = Math.max(...logits, -1e9); const ex = logits.map(l => Math.exp(l - mx)); const z = ex.reduce((a, c) => a + c, 0) || 1;
			return { logits, value: value[b], priors: ex.map(e => e / z) };
		});
	}
	close() { /* 세션은 프로세스와 함께 정리 */ }
}
