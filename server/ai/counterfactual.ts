/**
 * 반사실(counterfactual) 복기 하네스 — 오프라인 분석 전용(게임플레이 미사용).
 *
 * 사용자 방법론(2026-07-13): "경기 하나하나 돌려보면서 매수 롤백해서 다른 수를 골라보고 미래 점수를 비교" —
 * 라운드 시작 스냅샷(AI_ROUND_SNAPSHOTS=1로 h2h가 logs/cf-snapshots/에 덤프)에서:
 *   1) 대상 플레이어의 '그 라운드 첫 메인 수'를 각 대안 후보로 강제
 *   2) 이후를 그리디 정책(mcts.simulateToTerminal과 동일 근사)으로 게임 끝까지 재생
 *   3) 대상의 최종 VP를 브랜치별 비교 → 후회(regret) = best대안 − 실제선택
 * 재생 정책이 근사(그리디)라 절대값은 편향되지만, 모든 브랜치에 같은 정책을 쓰므로 순위·후회는 유의미.
 * 실행: npx tsx server/ai/counterfactual.ts [스냅샷파일...] (인자 없으면 cf-snapshots 전체)
 */
import * as fs from 'fs';
import * as path from 'path';
import { BotLogic, BotAction } from './bot';
import { StateCloner } from './stateCloner';
import { ServerGameState, scoreTerminalStateForRollout } from '../gameState';
import { applyRolloutIncome } from './rolloutIncome';

const dummyIo = { to: () => ({ emit: () => { /* noop */ } }) } as any;

/** 스냅샷 정규화 — 덤프 시점이 roundNumber++ 직후(전원 hasPassed·수입 미적용)라 라운드 시작 상태로 보정 */
function normalizeSnapshot(raw: ServerGameState): ServerGameState {
    const s = StateCloner.cloneGameStateForSimulation(raw);
    (s as any).simulation = true;
    const order: string[] = s.turnOrder ?? Object.keys(s.players);
    for (const pid of order) {
        if (!s.players[pid]) continue;
        s.players[pid].hasPassed = false;
        applyRolloutIncome(s, pid);
    }
    s.currentPlayerIndex = 0;
    s.hasDoneMainAction = false;
    return s;
}

/** 스냅샷에서 대상의 이번 라운드 첫 결정을 override로 강제하고 터미널까지 그리디 재생 → 대상 최종 VP */
export async function playoutWithOverride(
    snapshot: ServerGameState,
    targetId: string,
    override: BotAction | null,
): Promise<number | null> {
    let s: ServerGameState;
    try {
        s = normalizeSnapshot(snapshot);
    } catch { return null; }

    const order: string[] = s.turnOrder ?? Object.keys(s.players);
    const MAX_STEPS = 800;
    let steps = 0;
    let overridePending = override != null;
    try {
        while (steps++ < MAX_STEPS) {
            if ((s as any).currentPhase === 'gameEnd' || (s.roundNumber ?? 1) > 6) break;
            const allPassed = order.every(pid => s.players[pid]?.hasPassed);
            if (allPassed) {
                if ((s.roundNumber ?? 1) >= 6) break;
                s.roundNumber = (s.roundNumber ?? 1) + 1;
                for (const pid of order) {
                    if (!s.players[pid]) continue;
                    s.players[pid].hasPassed = false;
                    applyRolloutIncome(s, pid);
                }
                s.currentPlayerIndex = 0;
                s.hasDoneMainAction = false;
                continue;
            }
            const cur = order[s.currentPlayerIndex ?? 0];
            if (!cur || s.players[cur]?.hasPassed) {
                s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                continue;
            }
            let action: BotAction | null = null;
            if (overridePending && cur === targetId && !s.hasDoneMainAction) {
                action = override;
                overridePending = false; // 첫 결정만 강제, 이후는 정책대로
            } else {
                action = await BotLogic.getNextMove(s, cur, true);
            }
            if (!action || action.type === 'end_turn' || action.type === 'pass_round') {
                s.players[cur].hasPassed = true;
                s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                s.hasDoneMainAction = false;
                continue;
            }
            const a = action as { type: string; params: any; preActions?: BotAction[] };
            let ok = true;
            try {
                if (a.preActions?.length) for (const pre of a.preActions) { if (!await BotLogic.performAction(dummyIo, s, pre, cur)) { ok = false; break; } }
                if (ok) ok = await BotLogic.performAction(dummyIo, s, { type: a.type, params: a.params } as any, cur);
            } catch { ok = false; }
            if (!ok) {
                // 강제 브랜치가 서버 룰에 막히면 이 브랜치는 무효
                if (action === override) return null;
                s.players[cur].hasPassed = true;
                s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                s.hasDoneMainAction = false;
                continue;
            }
            if (s.hasDoneMainAction) {
                s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                s.hasDoneMainAction = false;
            }
        }
        scoreTerminalStateForRollout(s);
    } catch { return null; }
    return s.players[targetId]?.score ?? null;
}

export type BranchResult = { label: string; type: string; vp: number | null };
export type DecisionAnalysis = {
    game: string; round: number; targetId: string; faction: string;
    policy: BranchResult;          // 현 정책(강제 없음)이 고르는 라인
    branches: BranchResult[];      // 대안 강제 브랜치들
    regret: number;                // best대안 − 정책 (양수 = 정책이 손해)
};

const label = (a: BotAction) => `${a.type}${(a.params as any)?.trackId ? ':' + (a.params as any).trackId : ''}${(a.params as any)?.target ? ':' + (a.params as any).target : ''}${(a.params as any)?.tileId ? '@' + (a.params as any).tileId : ''}`;

/** 한 스냅샷 × 한 플레이어: 정책 라인 vs 상위 대안 K개 비교 */
export async function analyzeDecision(snapshot: ServerGameState, targetId: string, topK = 3): Promise<DecisionAnalysis | null> {
    const p = snapshot.players[targetId];
    if (!p) return null;
    // 후보는 '대상의 관점' 정규화 스냅샷에서 산출 (드리프트 가드 회피: 인덱스를 대상에게 맞춤)
    let cands: BotAction[] = [];
    try {
        const view = normalizeSnapshot(snapshot);
        const orderV: string[] = view.turnOrder ?? Object.keys(view.players);
        view.currentPlayerIndex = Math.max(0, orderV.indexOf(targetId));
        cands = BotLogic.getCandidateMoves(view, targetId).filter(c => c.type !== 'pass_round');
    } catch { return null; }
    if (cands.length < 2) return null;

    const policyVp = await playoutWithOverride(snapshot, targetId, null);
    if (policyVp == null) return null;
    const branches: BranchResult[] = [];
    for (const c of cands.slice(0, topK)) {
        const vp = await playoutWithOverride(snapshot, targetId, c);
        branches.push({ label: label(c), type: c.type, vp });
    }
    const valid = branches.filter(b => b.vp != null) as { label: string; type: string; vp: number }[];
    if (!valid.length) return null;
    const best = Math.max(...valid.map(b => b.vp));
    return {
        game: snapshot.id, round: snapshot.roundNumber ?? 0, targetId, faction: p.faction ?? '?',
        policy: { label: 'policy', type: 'policy', vp: policyVp },
        branches, regret: best - policyVp,
    };
}

// ── CLI 드라이버 ──────────────────────────────────────────────────────────
async function main() {
    const dir = path.join(process.cwd(), 'logs', 'cf-snapshots');
    const files = process.argv.slice(2).length ? process.argv.slice(2)
        : (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)) : []);
    if (!files.length) { console.log('스냅샷 없음 — AI_ROUND_SNAPSHOTS=1로 h2h를 먼저 실행'); return; }
    console.log(`반사실 복기: 스냅샷 ${files.length}개`);
    const results: DecisionAnalysis[] = [];
    for (const f of files) {
        let snap: ServerGameState;
        try { snap = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
        for (const pid of (snap.turnOrder ?? Object.keys(snap.players))) {
            const r = await analyzeDecision(snap, pid, 3);
            if (r) {
                results.push(r);
                if (r.regret >= 5) {
                    console.log(`[REGRET ${r.regret.toFixed(0)}] ${r.game} R${r.round} ${r.faction}: 정책 ${r.policy.vp} vs ${r.branches.map(b => `${b.label}=${b.vp ?? 'X'}`).join(' | ')}`);
                }
            }
        }
    }
    // 수 유형별 집계: 정책이 고르지 않았지만 더 좋았던 대안 유형
    const agg: Record<string, { n: number; sum: number }> = {};
    for (const r of results) {
        if (r.regret < 5) continue;
        const best = r.branches.filter(b => b.vp != null).sort((a, b) => (b.vp ?? 0) - (a.vp ?? 0))[0];
        if (!best) continue;
        const a = agg[best.type] ??= { n: 0, sum: 0 };
        a.n++; a.sum += r.regret;
    }
    console.log('\n=== 유형별 후회 집계 (정책이 놓친 좋은 수) ===');
    for (const [t, a] of Object.entries(agg).sort((x, y) => y[1].sum - x[1].sum)) {
        console.log(`${t}: ${a.n}회, 평균 후회 ${(a.sum / a.n).toFixed(1)}VP`);
    }
    console.log(`\n총 결정 ${results.length}개, 후회≥5VP: ${results.filter(r => r.regret >= 5).length}개, 평균 후회 ${(results.reduce((s, r) => s + r.regret, 0) / Math.max(1, results.length)).toFixed(2)}VP`);
}

// tsx ESM에선 require.main이 없어 미실행(실측) → env 트리거. index import 부작용으로 서버가 떠 있으므로 명시적 exit.
if (process.env.CF_RUN === '1') {
    main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
