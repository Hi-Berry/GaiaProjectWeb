/**
 * [ai2 가치망 강화 2026-10-19] 가치 학습용 '여러 번 끝까지 굴린 평균' 목표 생성.
 *
 * 왜: 지금 가치 목표는 그 국면에서 실제 한 판이 끝난 결과 하나(내 최종 − 상대 평균) — 같은 국면도 이후 운으로 ±20점
 *   흔들려 목표 자체가 시끄럽다(가치망 평균 오차 ~18점, RESULTS 10-18). 같은 국면에서 R번 끝까지 굴린 평균을 목표로
 *   쓰면 목표 노이즈가 1/√R. 굴림 정책 = 기존 봇 빠른 경로 + ε 무작위(탐색 안 상대 모델과 같은 계열).
 * 국면 수집: 기존 봇 빠른 경로 + ε로 한 판을 두면서 메인 결정마다 확률 1/every로 표본 → 그 국면에서 R번 굴림 →
 *   네 좌석 각각의 관점 행(vo=1, vt=평균 마진/50, vsd=표준편차/50).
 * 사용: PORT=5181 npx tsx script/ai2ValueRollouts.ts --shard 0 --shards 6 --minutes 240 --rollouts 8 --every 15 --out data/ai2/vroll
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BotLogic } from '../server/ai/bot';
import { StateCloner } from '../server/ai/stateCloner';
import { prepareHeadless, runToEnd, botFastPolicy, Policy } from '../server/ai2/headlessDriver';
import { encodeState } from '../server/ai2/encoder';
import { ServerGameState } from '../server/gameState';
import { OnnxNet } from '../server/ai2/onnxNet';
import { greedyPolicy, valueGreedyPolicy, newSearchStats } from '../server/ai2/ai2Policy';
import { advanceToOwnMain } from '../server/ai2/puct';
import { tryApply } from '../server/ai2/moveGen';
import { BotAction } from '../server/ai/bot';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const shard = Number(opt('--shard', '0')), shards = Number(opt('--shards', '1'));
const minutes = Number(opt('--minutes', '60')), R = Number(opt('--rollouts', '8')), every = Number(opt('--every', '15')), eps = Number(opt('--eps', '0.1'));
const outDir = opt('--out', 'data/ai2/vroll');
// [2026-10-19] --roll net <model.onnx>: 남은 판을 기존 봇 대신 신경망(사람 흉내 정책, 탐색 없이 최고 확률 수)이 네 좌석 모두 두게 한다.
//   기존 봇 굴림 목표(vnet1)는 예측은 정확해졌지만 '봇이 이어 둘 때' 가치라 대결이 나빠졌다(−5.2).
const rollMode = opt('--roll', 'bot');
const rollNet = rollMode === 'net' || rollMode === 'netv' ? new OnnxNet(opt('--model', 'server/ai2/models/ai2_v4h6.onnx')) : null;
// --roll netv --valueModel <onnx>: 정책 상위 5수를 가치 모델로 1수 앞보기(이어 두는 쪽을 더 강하게 — 다음 반복)
const rollValue = rollMode === 'netv' ? new OnnxNet(opt('--valueModel', 'server/ai2/models/ai2_vnet2.onnx')) : null;
// [2026-11-09 형제 비교] --siblings K: 표본 국면에서 메인 결정 좌석의 정책 상위 K개 합법 수를 각각 둬 보고, 탐색과 똑같이
//   '내 다음 메인 결정'까지 진행한 상태(=탐색이 가치망에 묻는 잎)를 기록. 각 형제에서 같은 난수열로 R번 굴려(공통 난수 — 형제 간
//   차이의 노이즈를 줄인다) 평균 마진을 목표로. 행에 sg(형제 묶음 id)를 달아 학습이 묶음 안 '차이'를 맞추게 한다(--sib-weight).
//   왜: vnet3는 국면 전체 가치 상관 0.69에서 정체 — 탐색이 실제로 필요한 건 비슷한 후보 사이 몇 점 차이의 순서.
const SIB = Number(opt('--siblings', '0'));
// [2026-11-10 재측정] --retest: 형제 묶음마다 서로 다른 난수로 두 번 굴려 vt·vt2 — 목표 자체의 재현성(후보 순서 일치) 확인용.
// --seedMath: 굴리는 동안 Math.random(봇 내부)도 같은 난수열로 — 공통 난수가 실제로 형제 간에 맞춰지게.
const RETEST = args.includes('--retest'), SEED_MATH = args.includes('--seedMath');
const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(Math.round(a[k] * 1000) / 1000); } return [i, v]; };

// --seed: 반복마다 다른 판(같으면 이전 생성과 똑같은 판이 나온다)
let s = (shard * 7919 + 17 + Number(opt('--seed', '0')) * 104729) >>> 0; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gst = newSearchStats();
const epsPolicy = (e: number): Policy => async (game, d) => {
	if (rollNet && d.options && d.kind === 'main' && game.currentPhase === 'main') {
		if (rnd() < e) { const o = d.options.filter(m => m.type !== 'pass_round'); if (o.length) return o[Math.floor(rnd() * o.length)]; }
		return (rollValue ? valueGreedyPolicy(rollNet, rollValue, gst, 5) : greedyPolicy(rollNet, gst))(game, d);
	}
	if (d.kind === 'main' && game.currentPhase === 'main' && rnd() < e) {
		const cands = BotLogic.getCandidateMoves(game, d.playerId).filter(c => c.type !== 'end_turn' && c.type !== 'pass_round');
		if (cands.length) return cands[Math.floor(rnd() * cands.length)];
	}
	return botFastPolicy(game, d);
};
const margins = (sc: Record<string, number>) => Object.fromEntries(Object.keys(sc).map(id => {
	const others = Object.entries(sc).filter(([k]) => k !== id).map(([, v]) => v);
	return [id, sc[id] - others.reduce((a, b) => a + b, 0) / others.length];
}));

class Sample { constructor(public g: ServerGameState) {} }

(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `shard${shard}_${Date.now()}.jsonl.gz`);
	const gz = zlib.createGzip({ level: 6 }); const ws = fs.createWriteStream(outPath); gz.pipe(ws);
	const write = (o: any) => gz.write(JSON.stringify(o) + '\n');
	const dir = path.join(process.cwd(), 'logs', 'round-start');
	const excl = opt('--exclude', 'data/ai2/model_v1.val_starts.json');
	const val = new Set<string>(fs.existsSync(excl) ? JSON.parse(fs.readFileSync(excl, 'utf8')) : []);
	const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json') && !val.has(f.replace('_r1.json', ''))).sort();
	const t0 = Date.now(); let games = 0, states = 0, sdSum = 0;
	for (let k = shard + Number(opt('--seed', '0')) * 37; (Date.now() - t0) / 60000 < minutes; k += shards) {
		const f = files[k % files.length];
		const gid = `${f.replace('_r1.json', '')}#vr${opt('--seed', '0')}_${shard}_${games}`;
		const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
		// 표본 국면: 메인 결정 시점에 확률 1/every로 상태를 복제해 둔다(게임 진행은 그대로)
		const picks: ServerGameState[] = [];
		const sibPicks: { st: ServerGameState; pid: string; options: BotAction[] }[] = [];
		const base = epsPolicy(0.15);
		const pol: Policy = async (game, d) => {
			if (d.kind === 'main' && game.currentPhase === 'main' && rnd() < 1 / every) {
				if (SIB > 0) { if (d.options?.length && d.options.length > 1) sibPicks.push({ st: StateCloner.cloneGameStateForSimulation(game), pid: d.playerId, options: d.options }); }
				else picks.push(StateCloner.cloneGameStateForSimulation(game));
			}
			return base(game, d);
		};
		const seatsAll = rollNet ? new Set(g.turnOrder) : undefined;
		const r0 = await runToEnd(g, pol, { botParity: true, ai2Seats: seatsAll });
		games++;
		if (!r0.ended) continue;
		for (const st of picks) {
			const acc: Record<string, number[]> = {};
			for (let i = 0; i < R; i++) {
				const c = prepareHeadless(st);
				const r = await runToEnd(c, epsPolicy(eps), { botParity: true, maxSteps: 4000, ai2Seats: rollNet ? new Set(c.turnOrder) : undefined });
				if (!r.ended) continue;
				for (const [id, m] of Object.entries(margins(r.scores as Record<string, number>))) (acc[id] ??= []).push(m);
			}
			const ids = Object.keys(acc); if (!ids.length || acc[ids[0]].length < Math.max(2, R / 2)) continue;
			for (const id of ids) {
				const a = acc[id]; const mu = a.reduce((x, y) => x + y, 0) / a.length;
				const sd = Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / Math.max(1, a.length - 1));
				const e = encodeState(st, id);
				write({ g: gid, p: id, r: st.roundNumber, y: 0, vo: 1, vt: Math.round(mu / 50 * 1000) / 1000, vsd: Math.round(sd / 50 * 1000) / 1000, n: a.length,
					flat: sparse(e.flat), grid: sparse(e.grid), moves: [{ f: [[], []], c: -1, k: '-' }] });
				sdSum += sd;
			}
			states++;
		}
		for (const [pi, sp] of sibPicks.entries()) {
			if (!rollNet) throw new Error('--siblings 는 --roll net 필요');
			const root = prepareHeadless(sp.st);
			const [o] = await rollNet.evaluate([{ game: root, pov: sp.pid, moves: sp.options }]);
			const order = sp.options.map((m, i) => ({ m, p: o.priors[i] })).sort((a, b) => b.p - a.p);
			const kids: { leaf: ServerGameState; terminal: boolean; p: number }[] = [];
			for (const x of order) {
				if (kids.length >= SIB) break;
				const applied = await tryApply(root, sp.pid, x.m);
				if (!applied) continue;
				(applied as any).ai2SearchLite = true; // 탐색 안 잎과 같은 상대 모델로 진행
				const nd = await advanceToOwnMain(applied, sp.pid);
				delete (applied as any).ai2SearchLite;
				kids.push({ leaf: applied, terminal: !nd, p: x.p });
			}
			if (kids.length < 2) continue;
			const sg = `${gid}~${pi}`; const seedBase = s; const rows: any[] = [];
			const rollKid = async (kd: { leaf: ServerGameState; terminal: boolean }, seed0: number) => {
				const a: number[] = [];
				if (kd.terminal) { a.push(margins(Object.fromEntries(kd.leaf.turnOrder.map(id => [id, kd.leaf.players[id].score ?? 0])))[sp.pid]); return a; }
				s = seed0; // 공통 난수: 형제마다 같은 난수열
				const mr = Math.random; if (SEED_MATH) Math.random = rnd;
				try {
					for (let i = 0; i < R; i++) {
						const c = prepareHeadless(kd.leaf);
						const r = await runToEnd(c, epsPolicy(eps), { botParity: true, maxSteps: 4000, ai2Seats: new Set(c.turnOrder) });
						if (r.ended) a.push(margins(r.scores as Record<string, number>)[sp.pid]);
					}
				} finally { Math.random = mr; }
				return a;
			};
			const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
			for (const [ki, kd] of kids.entries()) {
				const a = await rollKid(kd, seedBase);
				if (!a.length || (!kd.terminal && a.length < Math.max(2, R / 2))) continue;
				const mu = mean(a);
				let vt2: number | undefined;
				if (RETEST) { const b = await rollKid(kd, (seedBase * 31 + 999983) >>> 0); if (!b.length) continue; vt2 = Math.round(mean(b) / 50 * 1000) / 1000; }
				const e = encodeState(kd.leaf, sp.pid);
				rows.push({ g: gid, p: sp.pid, r: kd.leaf.roundNumber, y: 0, vo: 1, vt: Math.round(mu / 50 * 1000) / 1000, n: a.length, sg, sk: ki, vt2, sp: Math.round(kd.p * 1000) / 1000,
					flat: sparse(e.flat), grid: sparse(e.grid), moves: [{ f: [[], []], c: -1, k: '-' }] });
			}
			if (rows.length < 2) continue;
			for (const r of rows) write(r);
			const vs = rows.map(r => r.vt * 50); sdSum += Math.max(...vs) - Math.min(...vs); states++;
		}
		write({ final: true, g: gid, ended: r0.ended, scores: r0.scores });
		if (games % 10 === 0) fs.writeSync(1, `[vr s${shard}] 게임 ${games} · 국면 ${states} · ${SIB ? '형제 최대−최소 평균' : '굴림 표준편차 평균'} ${(sdSum / Math.max(1, states * (SIB ? 1 : 4))).toFixed(1)}점 · ${((Date.now() - t0) / 60000).toFixed(0)}분\n`);
	}
	gz.end(); await new Promise(r => ws.on('finish', r));
	fs.writeSync(1, `[vr s${shard}] 완료 게임 ${games} · 국면 ${states} → ${outPath}\n`);
	process.exit(0);
})();
