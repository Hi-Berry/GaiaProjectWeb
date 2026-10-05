/**
 * [ai2 2026-10-05] 정책·가치망 추론 클라이언트 — 파이썬 추론 서버(scripts/ai2/infer_server.py)를 자식 프로세스로 띄워
 * JSON 한 줄 프로토콜로 묻는다. 모델 계산(합성곱 3층 × 20×24 격자)은 JS로 옮기면 상태당 수십 ms라 torch에 맡긴다.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import { BotAction } from '../ai/bot';
import { ServerGameState } from '../gameState';
import { encodeState, encodeMove } from './encoder';

const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(a[k]); } return [i, v]; };

export interface NetOut { logits: number[]; value: number; priors: number[] }

export class NetClient {
	private proc: ChildProcessWithoutNullStreams;
	private next = 1;
	private waiting = new Map<number, (o: any) => void>();
	calls = 0; ms = 0;
	constructor(modelPath: string) {
		this.proc = spawn('python3', ['-u', 'scripts/ai2/infer_server.py', modelPath], { env: { ...process.env, AI2_TORCH_THREADS: process.env.AI2_TORCH_THREADS ?? '1' } });
		readline.createInterface({ input: this.proc.stdout }).on('line', line => {
			const o = JSON.parse(line); const cb = this.waiting.get(o.id); if (cb) { this.waiting.delete(o.id); cb(o.out); }
		});
		this.proc.stderr.on('data', d => { const s = String(d); if (!/UserWarning|warn/i.test(s)) process.stderr.write(`[infer] ${s}`); });
	}
	/** 여러 (상태, 선택지)를 한 번에 평가. priors = 선택지 softmax. */
	async evaluate(reqs: { game: ServerGameState; pov: string; moves: BotAction[] }[]): Promise<NetOut[]> {
		const t0 = Date.now();
		const items = reqs.map(r => {
			const e = encodeState(r.game, r.pov);
			return { flat: sparse(e.flat), grid: sparse(e.grid), moves: r.moves.map(m => { const em = encodeMove(r.game, r.pov, m); return { f: sparse(em.flat), c: em.cell }; }) };
		});
		const id = this.next++;
		const out: { logits: number[]; value: number }[] = await new Promise(res => { this.waiting.set(id, res); this.proc.stdin.write(JSON.stringify({ id, items }) + '\n'); });
		this.calls++; this.ms += Date.now() - t0;
		return out.map(o => {
			const mx = Math.max(...o.logits, -1e9); const ex = o.logits.map(l => Math.exp(l - mx)); const z = ex.reduce((a, b) => a + b, 0) || 1;
			return { ...o, priors: ex.map(e => e / z) };
		});
	}
	close() { this.proc.kill(); }
}
