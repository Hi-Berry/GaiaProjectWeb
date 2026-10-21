/**
 * [ai2 2026-10-05] 새 AI 정책 2종.
 *  greedy : 정책망 확률 순으로 첫 합법 수(흉내만 한 수준의 기준선).
 *  search : 정책망 상위 K개 합법 후보를 실제로 둬 본 뒤 빠른 정책(기존 봇 빠른 경로)으로 게임 끝까지 굴려
 *           (내 최종 − 상대 평균)이 가장 큰 수를 고른다. 정책이 확신(최상위 확률 ≥ conf)하면 탐색 생략.
 *           — 가치망(v0, 상관 0.23)이 아직 약해서 롤아웃 결과로 평가한다. 가치망이 좋아지면 PUCT로 교체.
 * 보류 선택(기술 타일 등)은 v0가 학습하지 않았으므로 기존 봇 선택을 따른다(선택지에 있을 때).
 */
import { BotAction, BotLogic } from '../ai/bot';
import { ServerGameState } from '../gameState';
import { StateCloner } from '../ai/stateCloner';
import { Policy, Decision, runToEnd, botFastPolicy } from './headlessDriver';
import { moveKey, tryApply } from './moveGen';
import { NetClient } from './netClient';

export interface SearchStats { decisions: number; searched: number; rollouts: number; netMs: number; rolloutMs: number; changedFromTop: number }
export const newSearchStats = (): SearchStats => ({ decisions: 0, searched: 0, rollouts: 0, netMs: 0, rolloutMs: 0, changedFromTop: 0 });

async function pendingPick(game: ServerGameState, d: Decision): Promise<BotAction | null> {
	const bot = await BotLogic.getNextMove(game, d.playerId, true);
	if (bot && d.options?.some(o => moveKey(o) === moveKey(bot))) return bot;
	return d.options?.[0] ?? null;
}

/** 정책망 확률 내림차순으로 합법 후보 최대 k개(상태 포함) */
async function topLegal(net: NetClient, game: ServerGameState, d: Decision, k: number) {
	const [o] = await net.evaluate([{ game, pov: d.playerId, moves: d.options! }]);
	const order = d.options!.map((m, i) => ({ m, p: o.priors[i] })).sort((a, b) => b.p - a.p);
	const out: { m: BotAction; p: number; s: ServerGameState }[] = [];
	for (const x of order) {
		const s = await tryApply(game, d.playerId, x.m);
		if (s) out.push({ ...x, s });
		if (out.length >= k) break;
	}
	return out;
}

export function greedyPolicy(net: NetClient, st: SearchStats): Policy {
	return async (game, d) => {
		if (!d.options) return botFastPolicy(game, d);
		if (d.kind === 'pending' || d.kind === 'leech') return pendingPick(game, d);
		st.decisions++;
		const t0 = Date.now(); const c = await topLegal(net, game, d, 1); st.netMs += Date.now() - t0;
		return c[0]?.m ?? null;
	};
}

export function searchPolicy(net: NetClient, st: SearchStats, opt: { k?: number; conf?: number } = {}): Policy {
	const K = opt.k ?? 5, CONF = opt.conf ?? 0.7;
	return async (game, d) => {
		if (!d.options) return botFastPolicy(game, d);
		if (d.kind === 'pending' || d.kind === 'leech') return pendingPick(game, d);
		st.decisions++;
		const t0 = Date.now(); const cands = await topLegal(net, game, d, K); st.netMs += Date.now() - t0;
		if (!cands.length) return null;
		if (cands.length === 1 || cands[0].p >= CONF) return cands[0].m;
		st.searched++;
		let best = cands[0], bestV = -Infinity;
		for (const c of cands) {
			const t1 = Date.now();
			const s = StateCloner.cloneGameStateForSimulation(c.s) as any; s.simulation = true; s.headless = true; s.botCanceled = true;
			const r = await runToEnd(s, botFastPolicy, { botParity: true, maxSteps: 4000 });
			st.rollouts++; st.rolloutMs += Date.now() - t1;
			const sc = r.scores as Record<string, number>; const me = sc[d.playerId] ?? 0;
			const others = Object.entries(sc).filter(([id]) => id !== d.playerId).map(([, v]) => v);
			const v = me - others.reduce((a, b) => a + b, 0) / Math.max(1, others.length) + 2 * c.p; // 동점이면 정책 확률 쪽
			if (v > bestV) { bestV = v; best = c; }
		}
		if (best !== cands[0]) st.changedFromTop++;
		return best.m;
	};
}

/**
 * [ai2 2026-10-21] 가치 1수 앞보기: 정책 상위 k개 합법 수를 둬 본 상태를 가치 모델로 평가해 최고를 고른다(탐색 없음, 빠름).
 *  가치 학습용 굴림의 '이어 두는 쪽'을 사람 흉내(greedy)보다 강하게 — vnet2(greedy 굴림 목표)가 대결 +8.4였던 다음 반복용.
 */
export function valueGreedyPolicy(net: NetClient | any, valueNet: NetClient | any, st: SearchStats, k = 5): Policy {
	return async (game, d) => {
		if (!d.options) return botFastPolicy(game, d);
		if (d.kind === 'pending' || d.kind === 'leech') return pendingPick(game, d);
		st.decisions++;
		const cands = await topLegal(net, game, d, k);
		if (cands.length <= 1) return cands[0]?.m ?? null;
		const outs = await valueNet.evaluate(cands.map(c => ({ game: c.s, pov: d.playerId, moves: [{ type: 'pass_round', params: {} } as BotAction] })));
		let bi = 0; for (let i = 1; i < outs.length; i++) if (outs[i].value > outs[bi].value) bi = i;
		if (bi !== 0) st.changedFromTop++;
		return cands[bi].m;
	};
}

