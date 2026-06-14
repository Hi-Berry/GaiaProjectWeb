import { ServerGameState } from '../gameState';
import { BotLogic } from './bot';
import { StateCloner } from './stateCloner';
import { Evaluator } from './evaluator';
import { getPlayerFlag } from './variant';
import { applyRolloutIncome } from './rolloutIncome';
import { scoreTerminalStateForRollout } from '../gameState';
import { extractSimState } from './simModel';
import { simRollout } from './simRollout';
import { log } from '../index';

// MCTS 디버그 로깅(후보 상세 리포트 등)은 매우 비싸다(턴당 수백 회 동기 console.log + 중복 전체평가).
// 기본 OFF. 디버깅 시 AI_MCTS_DEBUG=1 로 켠다. self-play/튜닝/측정 성능에 직결.
const MCTS_DEBUG = typeof process !== 'undefined' && process.env?.AI_MCTS_DEBUG === '1';

export interface MCTSNode {
    state: ServerGameState;
    action: any | null; // Action that led to this state
    parent: MCTSNode | null;
    children: MCTSNode[];
    visits: number;
    score: number;
    untriedActions: any[];
}

export class MCTS {
    private static readonly C = Math.sqrt(2); // Exploration constant
    /** tune-ai 등에서 런타임으로 짧게 쓰려면 setTimeMsOverride(1000) 호출 */
    private static _timeMsOverride: number | null = null;
    static setTimeMsOverride(ms: number | null): void {
        MCTS._timeMsOverride = ms;
    }
    /** 환경 변수 MCTS_TIME_MS(숫자)로 오버라이드 가능. 기본 3초. _timeMsOverride 있으면 우선 */
    private static get MAX_TIME_MS(): number {
        if (MCTS._timeMsOverride != null) return MCTS._timeMsOverride;
        const v = typeof process !== 'undefined' && process.env?.MCTS_TIME_MS ? parseInt(process.env.MCTS_TIME_MS, 10) : NaN;
        const configured = Number.isFinite(v) ? v : 6000; // 기본 6초 (Render 서버의 8초 타임아웃 방지)
        // 메모리 압박 시 탐색 시간을 자동 단축하여 힙 급증 완화
        try {
            const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
            if (heapMb >= 260) return Math.min(configured, 2200);
            if (heapMb >= 220) return Math.min(configured, 3200);
        } catch {
            // ignore
        }
        return configured;
    }
    /** 환경 변수 MCTS_MAX_DEPTH(숫자)로 오버라이드 가능. 깊이 늘리면 강해지지만 느려짐 */
    private static get MAX_DEPTH(): number {
        const v = typeof process !== 'undefined' && process.env?.MCTS_MAX_DEPTH ? parseInt(process.env.MCTS_MAX_DEPTH, 10) : NaN;
        return Number.isFinite(v) ? v : 8; // 5에서 8로 상향
    }

    static async search(initialState: ServerGameState, playerId: string, possibleActions: any[]): Promise<any | null> {
        // Find possible top-level actions
        if (possibleActions.length === 0) return null;
        if (possibleActions.length === 1) return possibleActions[0];

        const rootStore = StateCloner.cloneGameStateForSimulation(initialState);
        rootStore.simulation = true;
        const root: MCTSNode = {
            state: rootStore,
            action: null,
            parent: null,
            children: [],
            visits: 0,
            score: 0,
            untriedActions: [...possibleActions]
        };

        const startTime = Date.now();
        let iterations = 0;

        // 좌석별 think-time 배수(head-to-head로 "더 깊은 탐색=더 강함" 측정용). 기본 1.0.
        const timeBudget = this.MAX_TIME_MS * getPlayerFlag(playerId, 'mctsTimeMul', 1);

        while (Date.now() - startTime < timeBudget) {
            let node = this.selectNode(root);

            // Limit depth
            if (this.getDepth(node) > this.MAX_DEPTH) {
                const score = Evaluator.evaluateState(node.state, playerId);
                this.backpropagate(node, score);
                continue;
            }

            if (node.untriedActions.length > 0) {
                const expanded = await this.expand(node, playerId);
                if (expanded) node = expanded;
            }

            const score = await this.simulate(node.state, playerId);
            this.backpropagate(node, score);
            iterations++;
        }

        if (MCTS_DEBUG) console.log(`[MCTS] Executed ${iterations} iterations in ${Date.now() - startTime}ms`);
        if (root.children.length === 0) {
            // All expansions may have failed due to illegal transitions; fallback to safe candidate.
            return possibleActions[0] ?? null;
        }
        const bestNode = this.bestChild(root);

        // --- PRINT DETAILED BREAKDOWN OF ALL CANDIDATES (디버그 전용: 매우 비싸므로 기본 OFF) ---
        if (MCTS_DEBUG) {
            console.log(`\n=== MCTS DETAILED SCORE REPORT ===`);
            for (const child of root.children) {
                const avgScore = child.score / child.visits;
                const actionStr = `${child.action.type} ${JSON.stringify(child.action.params)}`;
                console.log(`[Candidate] ${actionStr} | Visits: ${child.visits} | AvgScore: ${avgScore.toFixed(2)}`);
                Evaluator.evaluateState(child.state, playerId, true);
            }
            console.log(`==================================\n`);
        }

        return bestNode.action;
    }

    private static getDepth(node: MCTSNode): number {
        let d = 0;
        let c: MCTSNode | null = node;
        while (c) {
            d++;
            c = c.parent;
        }
        return d;
    }

    private static selectNode(node: MCTSNode): MCTSNode {
        while (node.untriedActions.length === 0 && node.children.length > 0) {
            node = this.bestUCT(node);
        }
        return node;
    }

    private static bestUCT(node: MCTSNode): MCTSNode {
        let bestScore = -Infinity;
        let bestChild: MCTSNode = node.children[0];

        for (const child of node.children) {
            const uct = (child.score / child.visits) + this.C * Math.sqrt(Math.log(node.visits) / child.visits);
            if (uct > bestScore) {
                bestScore = uct;
                bestChild = child;
            }
        }
        return bestChild;
    }

    private static bestChild(node: MCTSNode): MCTSNode {
        let bestScore = -Infinity;
        let bestChild: MCTSNode = node.children[0];

        if (MCTS_DEBUG) log(`[MCTS] Candidates evaluation:`, 'game', node.state.id);
        for (const child of node.children) {
            const avgScore = child.score / child.visits;
            if (MCTS_DEBUG) log(`  - Action: ${child.action.type}${child.action.params?.tileId ? ' ' + child.action.params.tileId : ''}, Score: ${avgScore.toFixed(2)}, Visits: ${child.visits}`, 'game', node.state.id);
            if (avgScore > bestScore) {
                bestScore = avgScore;
                bestChild = child;
            }
        }
        return bestChild;
    }

    private static async expand(node: MCTSNode, playerId: string): Promise<MCTSNode | null> {
        if (node.untriedActions.length === 0) return null;
        const actionIndex = Math.floor(Math.random() * node.untriedActions.length);
        const action = node.untriedActions.splice(actionIndex, 1)[0];

        const newState = StateCloner.cloneGameStateForSimulation(node.state);
        newState.simulation = true;

        // Emulate action (this is tricky because performAction requires an IO socket, which we don't really want to trigger events for during MCTS)
        // For MCTS to truly work, execute functions need a 'mock' mode or we use a separate simulation engine.
        // For our simplified MCTS, we will execute it with a dummy IO object.
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;
        const act = action as { type: string; params: any; preActions?: any[] };
        if (act.preActions?.length) {
            for (const pre of act.preActions) {
                const ok = await BotLogic.performAction(dummyIo, newState, pre, playerId);
                if (!ok) return null;
            }
        }
        const applied = await BotLogic.performAction(dummyIo, newState, { type: action.type, params: action.params }, playerId);
        if (!applied) return null;

        const childNode: MCTSNode = {
            state: newState,
            action: action,
            parent: node,
            children: [],
            visits: 0,
            score: 0,
            untriedActions: this.getPossibleActions(newState, playerId)
        };

        node.children.push(childNode);
        return childNode;
    }

    private static async simulate(state: ServerGameState, playerId: string): Promise<number> {
        // [flag: fastSearch] Path A 벽돌B5: 경량 forward model(simModel/simRollout)로 R6까지 굴려 평가.
        // terminalRollout(진짜엔진 풀시뮬)이 비용으로 죽은 것 교정 — SimState 추출 1회 후 simRollout은 ~수만배 빠름.
        // 리프를 '진짜 최종VP 근사(내-최고상대)'로 평가해 eval 천장 우회 + 대량 반복 가능. 롤아웃 결정적이라 1회.
        if (getPlayerFlag(playerId, 'fastSearch', false)) {
            try {
                return simRollout(extractSimState(state, playerId));
            } catch {
                return Evaluator.evaluateState(state, playerId);
            }
        }
        // [flag: oppRollout] Path A 벽돌2: 상대 턴까지 시뮬하는 다턴 greedy 플레이아웃.
        // greedy 천장의 진짜 병목(opponent-blindness) 교정 시도. MCTS 재귀 없이 싼 1-ply 정책으로
        // 모든 플레이어를 굴려 "상대가 응수한 뒤" 위치를 평가. income/전환 페이즈서 break(hang-safe).
        if (getPlayerFlag(playerId, 'oppRollout', false)) {
            return this.simulateWithOpponents(state, playerId);
        }
        // [flag: terminalRollout] Path A 벽돌1b: 게임 끝(R6)까지 빠른 그리디로 굴린 뒤 '진짜 최종 VP'로 평가.
        // 기존 search들이 null이었던 건 leaf를 포화된 eval로 봤기 때문 → terminal 점수로 평가해 eval 천장 우회.
        if (getPlayerFlag(playerId, 'terminalRollout', false)) {
            return this.simulateToTerminal(state, playerId);
        }
        // Rollout phase. Take a few random pseudo-random moves.
        let currentState = StateCloner.cloneGameStateForSimulation(state);
        currentState.simulation = true;
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;

        // Simulate a few steps ahead with a cheap "1-ply" heuristic:
        // - evaluate top-N candidate actions by applying them once
        // - pick best (with a bit of noise) to avoid deterministic traps
        // [실험·플래그 deepRollout] 근시안 롤아웃(메인액션 1회 후 중단) 교정.
        // 켜면 메인액션 후에도 hasDoneMainAction을 리셋해 "현재 자원으로의 다턴 연쇄"를 시뮬 →
        // 셋업(우주선 진입/가이아포머/연구)이 만드는 후속 페이오프를 탐색이 보게 함. 수입/상대턴은 미시뮬(휴리스틱).
        const deepRollout = getPlayerFlag(playerId, 'deepRollout', false);
        const rolloutIncome = getPlayerFlag(playerId, 'rolloutIncome', false);
        // [flag: realRolloutIncome] 가상 라운드 사이 income을 가짜 모델(applyApproxIncome) 대신
        // 검증된 getNextRoundIncomePreview 기반 정확 적용(rolloutIncome.ts)으로. deepRollout과 함께 켜야 효과.
        const realRolloutIncome = getPlayerFlag(playerId, 'realRolloutIncome', false);
        const MAIN_ACTION_CAP = deepRollout ? 5 : 1;
        let mainActionsUsed = 0;
        const ROLLOUT_STEPS = deepRollout ? 14 : 6;
        // 좌석별 플래그로 롤아웃 평가 폭(TOP_N)을 조정 가능. 기본 8. 후보 starvation 완화 실험용(예: 12).
        const TOP_N = getPlayerFlag(playerId, 'rolloutTopN', 8);
        for (let i = 0; i < ROLLOUT_STEPS; i++) {
            if (currentState.turnOrder[currentState.currentPlayerIndex] !== playerId || currentState.currentPhase !== 'main') {
                break;
            }

            const candidates = this.getPossibleActions(currentState, playerId);
            if (!candidates || candidates.length === 0) break;

            // Score a subset of candidates by looking 1 move ahead
            const scored: Array<{ action: any; score: number }> = [];
            const subset = candidates.slice(0, Math.min(TOP_N, candidates.length));
            for (const act of subset) {
                try {
                    const s2 = StateCloner.cloneGameStateForSimulation(currentState);
                    s2.simulation = true;
                    const a = act as { type: string; params: any; preActions?: any[] };
                    if (a.preActions?.length) {
                        for (const pre of a.preActions) {
                            const okPre = await BotLogic.performAction(dummyIo, s2, pre as any, playerId);
                            if (!okPre) throw new Error('preAction_failed');
                        }
                    }
                    const okMain = await BotLogic.performAction(dummyIo, s2, { type: a.type, params: a.params } as any, playerId);
                    if (!okMain) throw new Error('mainAction_failed');
                    scored.push({ action: act, score: Evaluator.evaluateState(s2, playerId) });
                } catch {
                    // ignore invalid sim transitions
                }
            }
            scored.sort((a, b) => b.score - a.score);

            // If for some reason we couldn't score, fallback to BotLogic simulate picker
            const nextAction = scored.length > 0
                ? (Math.random() < 0.12 && scored.length >= 2 ? scored[1].action : scored[0].action)
                : await BotLogic.getNextMove(currentState, playerId, true); // isSimulate = true
            if (!nextAction || nextAction.type === 'end_turn') break;

            const ok = await BotLogic.performAction(dummyIo, currentState, nextAction, playerId);
            if (!ok) break;

            if (currentState.hasDoneMainAction) {
                mainActionsUsed++;
                // 기본: 메인 액션 1회 후 종료(턴 종료). deepRollout: 남은 자원으로 다음 메인 액션을 더 연쇄.
                if (deepRollout && mainActionsUsed < MAIN_ACTION_CAP
                    && currentState.turnOrder[currentState.currentPlayerIndex] === playerId
                    && currentState.currentPhase === 'main') {
                    currentState.hasDoneMainAction = false; // 가상의 다음 턴(자원 제약 유지)
                    // [flag: rolloutIncome/realRolloutIncome] 가상 라운드 사이 income 적용 → 다라운드 경제 빌드업
                    // (지금 경제 깔고 → 다음 자원으로 연방/연구5)을 롤아웃이 보게 함. 수입/상대턴 미반영의 보완.
                    if (realRolloutIncome) applyRolloutIncome(currentState, playerId); // 정확(검증된 프리뷰 기반)
                    else if (rolloutIncome) this.applyApproxIncome(currentState, playerId); // 가짜 근사(레거시)
                } else {
                    break;
                }
            }
        }

        return Evaluator.evaluateState(currentState, playerId);
    }

    /**
     * [Path A 벽돌2] 상대 턴까지 포함한 다턴 greedy 플레이아웃 롤아웃.
     * - 모든 플레이어를 "싼 1-ply 정책"(getCandidateMoves + 그 플레이어 관점 eval 최대)으로 굴림.
     *   getNextMove(→MCTS 재귀)는 절대 호출하지 않는다(무한재귀/폭발 방지).
     * - getCandidateMoves가 메인액션 후 end_turn, 적절 시 pass_round를 반환하므로 턴/라운드가 자연 전진.
     * - 안전장치: currentPhase!=='main'(income/전환) 또는 pendingIncomeOrder/pendingIncomeItems이면 즉시 break(hang 방지).
     *   라운드는 시작+2까지만, 총 STEP_CAP 회로 상한.
     */
    private static async simulateWithOpponents(state: ServerGameState, ourId: string): Promise<number> {
        const s = StateCloner.cloneGameStateForSimulation(state);
        s.simulation = true;
        const io = { to: () => ({ emit: () => { } }) } as any;
        const STEP_CAP = 60;
        const startRound = s.roundNumber ?? 1;
        const SUBSET = 6;

        for (let step = 0; step < STEP_CAP; step++) {
            if (s.currentPhase !== 'main') break;                       // income/전환 → 안전 종료
            if ((s.roundNumber ?? 1) > startRound + 2) break;           // 최대 ~2라운드 앞
            const cur = s.turnOrder?.[s.currentPlayerIndex];
            if (!cur || !s.players[cur]) break;
            if ((s as any).pendingIncomeOrder || (s.players[cur] as any).pendingIncomeItems) break; // 수익선택 = hang 위험 → 종료

            const cands = this.getPossibleActions(s, cur);
            if (!cands || cands.length === 0) break;

            // [fast-rollout] getCandidateMoves는 봇이 우선순위로 정렬 반환하므로 playout에선
            // 후보별 클론-스코어링(비쌈) 대신 1순위(cands[0])를 바로 쓴다. 스텝당 O(1) → 반복 수 ↑.
            // 약간의 다양성: 후보가 여럿이면 12% 확률로 2순위 선택(결정적 함정 회피).
            // (rolloutFatScore flag면 옛 6-클론 스코어링 방식으로 — 품질 vs 속도 A/B용)
            let best: any;
            if (getPlayerFlag(ourId, 'rolloutFatScore', false)) {
                best = null; let bestScore = -Infinity;
                for (const a of cands.slice(0, Math.min(SUBSET, cands.length))) {
                    try {
                        const s2 = StateCloner.cloneGameStateForSimulation(s); s2.simulation = true;
                        const act = a as { type: string; params: any; preActions?: any[] };
                        if (act.preActions?.length) for (const pre of act.preActions) { if (!await BotLogic.performAction(io, s2, pre, cur)) throw new Error('pre'); }
                        if (!await BotLogic.performAction(io, s2, { type: act.type, params: act.params } as any, cur)) throw new Error('main');
                        const sc = Evaluator.evaluateState(s2, cur);
                        if (sc > bestScore) { bestScore = sc; best = a; }
                    } catch { /* 무효 전이 무시 */ }
                }
                if (!best) best = cands[0];
            } else {
                best = (cands.length >= 2 && Math.random() < 0.12) ? cands[1] : cands[0];
            }

            // 선택한 수를 실제 상태 s에 적용
            try {
                const act = best as { type: string; params: any; preActions?: any[] };
                let okPre = true;
                if (act.preActions?.length) {
                    for (const pre of act.preActions) {
                        if (!await BotLogic.performAction(io, s, pre, cur)) { okPre = false; break; }
                    }
                }
                if (!okPre) break;
                if (!await BotLogic.performAction(io, s, { type: act.type, params: act.params } as any, cur)) break;
            } catch { break; }
        }

        return Evaluator.evaluateState(s, ourId);
    }

    /**
     * [Path A 벽돌1b] 클론 상태를 게임 끝(R6 전원패스)까지 빠른 그리디로 진행 후 진짜 최종 VP로 평가.
     * - 모든 플레이어를 fast 정책(cands[0])으로 굴림. 메인액션 1회=턴종료. pass/end_turn은 performAction 대신 수동 패스표시
     *   (executePassRound가 async 봇루프를 타므로 회피). 전원 패스 시 라운드 전환: rolloutIncome 적용 + round++.
     * - 종료 시 scoreTerminalStateForRollout로 최종미션/연구/잔여자원 점수 확정 → 내 VP - 최고 상대 VP 반환(상대적).
     * - 하드 스텝캡 + try/catch로 hang/예외 차단. 간소화(패스보너스·가이아포머 성숙·정확income 생략)는 후속 정밀화.
     */
    private static async simulateToTerminal(state: ServerGameState, playerId: string): Promise<number> {
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;
        let s: ServerGameState;
        try {
            s = StateCloner.cloneGameStateForSimulation(state);
            s.simulation = true;
        } catch { return Evaluator.evaluateState(state, playerId); }

        const order: string[] = s.turnOrder ?? Object.keys(s.players);
        const MAX_STEPS = 600;
        let steps = 0;
        try {
            while (steps++ < MAX_STEPS) {
                if ((s as any).currentPhase === 'gameEnd' || (s.roundNumber ?? 1) > 6) break;
                const allPassed = order.every(pid => s.players[pid]?.hasPassed);
                if (allPassed) {
                    if ((s.roundNumber ?? 1) >= 6) break; // 게임 종료
                    // 라운드 전환(간소): 패스 해제 + 수입 적용 + 라운드 증가
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
                // 현재 플레이어 한 수
                const cands = this.getPossibleActions(s, cur);
                let action: any = (cands && cands.length) ? cands[0] : await BotLogic.getNextMove(s, cur, true);
                if (!action || action.type === 'end_turn' || action.type === 'pass_round') {
                    // 패스: performAction(async 봇루프) 회피, 수동 표시 (패스보너스 생략=간소화)
                    s.players[cur].hasPassed = true;
                    s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                    s.hasDoneMainAction = false;
                    continue;
                }
                const a = action as { type: string; params: any; preActions?: any[] };
                let ok = true;
                try {
                    if (a.preActions?.length) for (const pre of a.preActions) { if (!await BotLogic.performAction(dummyIo, s, pre, cur)) { ok = false; break; } }
                    if (ok) ok = await BotLogic.performAction(dummyIo, s, { type: a.type, params: a.params } as any, cur);
                } catch { ok = false; }
                if (!ok) { s.players[cur].hasPassed = true; s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; s.hasDoneMainAction = false; continue; }
                if (s.hasDoneMainAction) { // 메인액션 1회 → 턴 종료
                    s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length;
                    s.hasDoneMainAction = false;
                }
            }
            scoreTerminalStateForRollout(s);
        } catch {
            // 시뮬 중 예외 → 현 상태 eval로 폴백
            return Evaluator.evaluateState(s, playerId);
        }
        const myVp = s.players[playerId]?.score ?? 0;
        const oppVps = order.filter(p => p !== playerId).map(p => s.players[p]?.score ?? 0);
        const bestOpp = oppVps.length ? Math.max(...oppVps) : 0;
        return myVp - bestOpp; // 상대적 최종 VP (eval과 스케일 다르지만 MCTS는 후보 간 상대비교라 OK)
    }

    /** 롤아웃 가상 라운드 사이 수입 근사(방향만 맞는 단순 모델: 구조물 많을수록 자원↑). 정확한 income은 아님. */
    private static applyApproxIncome(state: ServerGameState, playerId: string): void {
        const p = state.players[playerId];
        if (!p) return;
        let mine = 0, ts = 0, lab = 0, pi = 0, acad = 0;
        for (const t of state.map) {
            if (t.ownerId !== playerId || !t.structure || t.structure === 'ship') continue;
            switch (t.structure) {
                case 'mine': case 'lost_planet_mine': mine++; break;
                case 'trading_station': ts++; break;
                case 'research_lab': lab++; break;
                case 'planetary_institute': pi++; break;
                case 'academy': acad++; break;
            }
        }
        p.ore = (p.ore || 0) + Math.min(mine, 8) + 1;
        p.credits = (p.credits || 0) + ts * 2 + pi * 2 + 2;
        p.knowledge = (p.knowledge || 0) + lab * 2 + acad;
        p.power1 = (p.power1 || 0) + mine + ts + pi * 2; // 대략적 파워 수입(그릇1 추가)
    }

    private static backpropagate(node: MCTSNode, score: number): void {
        let current: MCTSNode | null = node;
        while (current !== null) {
            current.visits++;
            current.score += score;
            current = current.parent;
        }
    }

    private static getPossibleActions(state: ServerGameState, playerId: string): any[] {
        if (state.currentPhase !== 'main' || state.turnOrder[state.currentPlayerIndex] !== playerId) {
            return [];
        }
        return BotLogic.getCandidateMoves(state, playerId);
    }
}
