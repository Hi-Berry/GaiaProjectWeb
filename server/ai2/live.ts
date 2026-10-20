/**
 * [ai2 실전 2026-10-14] 새 AI(정책·가치망 + PUCT 탐색)를 실게임 봇 좌석의 '메인 액션' 결정에 쓴다.
 *
 * 켜는 법: server/ai/liveExperiment.json = { "name": "ai2", "flags": { "ai2": true } }
 *   → 사람 방장이 추가하는 봇이 게임 안에서 새 AI / 기존 봇으로 번갈아 배정되고(players[pid].liveVariant),
 *     liveAbReport.mjs로 같은 게임 안 쌍비교. 파일을 비우면 즉시 꺼진다(봇 추가 시점 기준).
 * 범위: 메인 액션(턴 시작, 본인 보류 없음)만. 기술 타일 등 보류 선택·리치·셋업·메인 후 처리는 기존 봇 그대로
 *   (보류 선택을 신경망에 맡기면 판당 −11~12점 — RESULTS.md).
 * 안전: 라이브 상태는 절대 건드리지 않는다(prepareHeadless 복제본에서만 탐색). 실패·시간 초과·예외면 null →
 *   호출부가 기존 봇으로 폴백. 모델은 처음 쓸 때 한 번 불러온다.
 * 설정(환경변수): AI2_MODEL(정책, 기본 server/ai2/models/ai2_v4h6.onnx) · AI2_VALUE_MODEL(가치, 기본 ai2_vnet2.onnx, none=끔) · AI2_SIMS(160) · AI2_MAX_MS(8000)
 */
import * as path from 'path';
import { BotAction } from '../ai/bot';
import { ServerGameState } from '../gameState';
import { getPlayerFlag } from '../ai/variant';
import { prepareHeadless } from './headlessDriver';
import { generateMoves, generatePendingOptions } from './moveGen';
import { puctPolicy, newPuctStats } from './puct';
import { OnnxNet } from './onnxNet';

let net: OnnxNet | null = null;
let valueNet: OnnxNet | null = null;
let netFailed = false;
const getNet = (): OnnxNet | null => {
	if (netFailed) return null;
	if (!net) net = new OnnxNet(path.resolve(process.cwd(), process.env.AI2_MODEL || 'server/ai2/models/ai2_v4h6.onnx'));
	return net;
};
/** [2026-10-20] 가치 전용 모델(신경망이 이어 둔 8회 굴림 평균 목표) — v4h6 정책과 함께 144판 +8.4±2.5(v4h6 단독 대비). AI2_VALUE_MODEL=none 이면 끔. */
const getValueNet = (): OnnxNet | null => {
	const p = process.env.AI2_VALUE_MODEL ?? 'server/ai2/models/ai2_vnet2.onnx';
	if (p === 'none') return null;
	if (!valueNet) valueNet = new OnnxNet(path.resolve(process.cwd(), p));
	return valueNet;
};

/** 이 좌석이 새 AI 좌석인가(실험 플래그 — 재시작 뒤엔 저장된 liveVariant로 복원) */
export function isAi2Seat(game: ServerGameState, pid: string): boolean {
	if (getPlayerFlag(pid, 'ai2', false)) return true;
	return !!(game.players[pid] as any)?.liveVariant?.flags?.ai2;
}

/** 새 AI가 결정할 수 있는 시점인가: 메인 단계·내 차례·메인 액션 전·본인 보류 없음·미응답 리치 없음 */
function decidable(game: ServerGameState, pid: string): boolean {
	if (game.currentPhase !== 'main' || game.turnOrder[game.currentPlayerIndex] !== pid || game.hasDoneMainAction) return false;
	if (game.players[pid]?.hasPassed) return false;
	const g: any = game;
	if (Object.keys(g).some(k => /^pending/.test(k) && g[k] && (g[k].playerId === pid))) return false;
	if (((game.players[pid] as any)?.pendingTerraformSteps ?? 0) > 0) return false;
	if ((game.pendingPowerOffers ?? []).some(o => !o.responded)) return false;
	return !generatePendingOptions(game, pid);
}

export interface Ai2LiveResult { action: BotAction | null; ms: number; sims: number; options: number; reason?: string }

/** 메인 액션 결정. action=null이면 호출부가 기존 봇으로 폴백. */
export async function ai2LiveDecide(game: ServerGameState, pid: string): Promise<Ai2LiveResult> {
	const t0 = Date.now();
	try {
		if (!decidable(game, pid)) return { action: null, ms: 0, sims: 0, options: 0, reason: 'not-decidable' };
		const n = getNet();
		if (!n) return { action: null, ms: 0, sims: 0, options: 0, reason: 'no-model' };
		const vn = getValueNet();
		try { await n.ready(); if (vn) await vn.ready(); } catch (e) { netFailed = true; return { action: null, ms: Date.now() - t0, sims: 0, options: 0, reason: `model-load: ${(e as Error).message}` }; }
		const g = prepareHeadless(game);
		// 탐색 안에서 나 말고는 전부 기존 봇 빠른 경로로 모델링 — 사람 좌석의 리치·보류도 봇처럼 자동 처리되게
		g.botPlayerIds = g.turnOrder.filter(id => id !== pid);
		const options = generateMoves(g, pid);
		if (!options.length) return { action: null, ms: Date.now() - t0, sims: 0, options: 0, reason: 'no-options' };
		const st = newPuctStats();
		const policy = puctPolicy(n, st, { sims: Number(process.env.AI2_SIMS || 160), maxMs: Number(process.env.AI2_MAX_MS || 8000), valueNet: vn ?? undefined });
		const action = await policy(g, { kind: 'main', playerId: pid, options });
		return { action, ms: Date.now() - t0, sims: st.sims, options: options.length, reason: action ? undefined : 'no-pick' };
	} catch (e) {
		return { action: null, ms: Date.now() - t0, sims: 0, options: 0, reason: `error: ${(e as Error).message}` };
	}
}
