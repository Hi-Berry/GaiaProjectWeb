/**
 * [ai2 2026-10-06] 가치망 PUCT 탐색 — 롤아웃(후보당 ~1초) 대신 가치망 평가(마디당 ~20ms)로 같은 시간에 넓고 깊게 본다.
 *
 * 트리 = 새 AI 좌석의 '메인 결정' 상태들. 간선 = 그 결정의 수(프리액션 포함).
 *   수를 두면 → 상대 차례·자동 처리·보류 선택(기존 봇 선택)을 구동기로 진행해 '내 다음 메인 결정'(또는 게임 끝)에서 멈춘다.
 *   상대는 기존 봇 빠른 경로로 모델링(실제 상대는 MCTS — 근사).
 * 마디 평가 = 가치망 (내 최종 − 상대 평균)/50 예측, 게임 끝이면 실제 값. 선택 = PUCT(정책망 사전확률), 최종 = 최다 방문.
 * 합법성은 펼칠 때 서버 규칙으로 판정(불법 간선은 제거). 분기 폭은 사전확률 상위 maxChildren개로 제한.
 */
import { BotAction, BotLogic } from '../ai/bot';
import { ServerGameState } from '../gameState';
import { step, newStats, botFastPolicy, Decision, Policy } from './headlessDriver';
import { moveKey, tryApply } from './moveGen';
import { NetClient } from './netClient';

class Stop { constructor(public d: Decision) {} }

/** 상대·자동 처리를 진행해 seat의 다음 메인 결정에서 멈춘다. 반환: 결정(선택지 포함) 또는 null(게임 끝/진행 불가). */
export async function advanceToOwnMain(game: ServerGameState, seat: string, maxSteps = 2000): Promise<Decision | null> {
	const stats = newStats(); const seats = new Set([seat]);
	const pol: Policy = async (g, d) => {
		if (d.playerId === seat) {
			if (d.kind === 'main' && d.options) throw new Stop(d);
			// 보류·리치: 기존 봇 선택(선택지에 있으면) — v1이 학습하지 않은 결정
			const bot = await BotLogic.getNextMove(g, d.playerId, true);
			if (bot && d.options?.some(o => moveKey(o) === moveKey(bot))) return bot;
			return d.options?.[0] ?? null;
		}
		return botFastPolicy(g, d);
	};
	for (let i = 0; i < maxSteps; i++) {
		try {
			const r = await step(game, pol, stats, { botParity: true, ai2Seats: seats });
			if (r.done) return null;
		} catch (e) { if (e instanceof Stop) return e.d; throw e; }
	}
	return null;
}

const marginOf = (game: ServerGameState, seat: string) => {
	const sc = Object.fromEntries(game.turnOrder.map(id => [id, game.players[id].score ?? 0]));
	const others = Object.entries(sc).filter(([k]) => k !== seat).map(([, v]) => v as number);
	return ((sc[seat] as number) - others.reduce((a, b) => a + b, 0) / Math.max(1, others.length)) / 50;
};

interface Node {
	state: ServerGameState; terminal: boolean; value: number;
	moves: BotAction[]; priors: number[]; N: number[]; W: number[]; child: (Node | null | undefined)[]; // undefined=미전개, null=불법
	visits: number;
}

async function makeNode(net: NetClient, state: ServerGameState, seat: string, d: Decision | null): Promise<Node> {
	if (!d || !d.options?.length) return { state, terminal: true, value: marginOf(state, seat), moves: [], priors: [], N: [], W: [], child: [], visits: 0 };
	const [o] = await net.evaluate([{ game: state, pov: seat, moves: d.options }]);
	return { state, terminal: false, value: o.value, moves: d.options, priors: o.priors, N: d.options.map(() => 0), W: d.options.map(() => 0), child: d.options.map(() => undefined), visits: 0 };
}

export interface PuctStats { decisions: number; sims: number; expansions: number; illegal: number; ms: number; changedFromTop: number; depthMax: number }
export const newPuctStats = (): PuctStats => ({ decisions: 0, sims: 0, expansions: 0, illegal: 0, ms: 0, changedFromTop: 0, depthMax: 0 });

/** 탐색 결과 보고(자기 강화 데이터용): 루트 상태·선택지·방문 수·고른 수 */
export type SearchReport = (r: { game: ServerGameState; seat: string; moves: BotAction[]; visits: number[]; pick: number }) => void;

export function puctPolicy(net: NetClient, st: PuctStats, opt: { sims?: number; cpuct?: number; maxChildren?: number; onSearch?: SearchReport; sampleUntilRound?: number; seed?: number } = {}): Policy {
	const SIMS = opt.sims ?? 48, CP = opt.cpuct ?? 1.5, MAXC = opt.maxChildren ?? 12;
	let rs = (opt.seed ?? 1) >>> 0 || 1; const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	return async (game, d) => {
		if (!d.options) return botFastPolicy(game, d);
		if (d.kind !== 'main') { // 보류·리치는 기존 봇 선택
			const bot = await BotLogic.getNextMove(game, d.playerId, true);
			if (bot && d.options.some(o => moveKey(o) === moveKey(bot))) return bot;
			return d.options[0] ?? null;
		}
		const t0 = Date.now(); st.decisions++;
		const seat = d.playerId;
		const root = await makeNode(net, game, seat, d);
		// 분기 제한: 사전확률 상위 MAXC개만 후보
		const allowed = (n: Node) => { const idx = n.priors.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]).slice(0, MAXC).map(x => x[1]); return new Set(idx); };
		const allowCache = new Map<Node, Set<number>>();
		for (let s = 0; s < SIMS; s++) {
			st.sims++;
			const path: [Node, number][] = [];
			let node = root; let leafValue = 0; let depth = 0;
			for (;;) {
				if (node.terminal) { leafValue = node.value; break; }
				const al = allowCache.get(node) ?? allowCache.set(node, allowed(node)).get(node)!;
				let best = -1, bestU = -Infinity;
				const sq = Math.sqrt(node.visits + 1);
				for (const i of Array.from(al)) {
					if (node.child[i] === null) continue;
					const q = node.N[i] ? node.W[i] / node.N[i] : node.value; // 미방문은 부모 가치로(FPU)
					const u = q + CP * node.priors[i] * sq / (1 + node.N[i]);
					if (u > bestU) { bestU = u; best = i; }
				}
				if (best < 0) { leafValue = node.value; break; } // 합법 간선 없음
				path.push([node, best]); depth++;
				if (node.child[best] === undefined) {
					// 펼치기: 수 적용(서버 규칙 검증) → 내 다음 메인 결정까지 진행 → 가치망 평가
					const applied = await tryApply(node.state, seat, node.moves[best]);
					if (!applied) { node.child[best] = null; st.illegal++; path.pop(); depth--; continue; }
					const nd = await advanceToOwnMain(applied, seat);
					const child = await makeNode(net, applied, seat, nd);
					node.child[best] = child; st.expansions++;
					leafValue = child.value; break;
				}
				node = node.child[best]!;
			}
			st.depthMax = Math.max(st.depthMax, depth);
			for (const [n, i] of path) { n.N[i]++; n.W[i] += leafValue; n.visits++; }
			if (path.length === 0 && root.child.every(c => c === null)) break;
		}
		// 최다 방문(동률이면 사전확률). 자가대국 다양성: sampleUntilRound 이하 라운드는 방문 비율로 표본 추출.
		let pick = -1;
		for (let i = 0; i < root.moves.length; i++) {
			if (root.child[i] === null || root.child[i] === undefined) continue;
			if (pick < 0 || root.N[i] > root.N[pick] || (root.N[i] === root.N[pick] && root.priors[i] > root.priors[pick])) pick = i;
		}
		if (pick >= 0 && opt.sampleUntilRound && (game.roundNumber ?? 1) <= opt.sampleUntilRound) {
			const tot = root.N.reduce((a, b, i) => a + (root.child[i] ? b : 0), 0);
			let x = rnd() * tot;
			for (let i = 0; i < root.moves.length; i++) { if (!root.child[i]) continue; x -= root.N[i]; if (x <= 0) { pick = i; break; } }
		}
		if (pick >= 0 && opt.onSearch) opt.onSearch({ game, seat, moves: root.moves, visits: root.moves.map((_, i) => (root.child[i] ? root.N[i] : 0)), pick });
		st.ms += Date.now() - t0;
		if (pick < 0) return null;
		const top = root.priors.indexOf(Math.max(...root.priors));
		if (pick !== top) st.changedFromTop++;
		return root.moves[pick];
	};
}
