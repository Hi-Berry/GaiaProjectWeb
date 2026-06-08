import { ServerGameState } from '../gameState';
import { BotLogic } from './bot';
import { StateCloner } from './stateCloner';
import { Evaluator } from './evaluator';
import { getPlayerFlag } from './variant';
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
                    currentState.hasDoneMainAction = false; // 가상의 다음 턴(수입/상대 미반영, 자원 제약은 유지)
                } else {
                    break;
                }
            }
        }

        return Evaluator.evaluateState(currentState, playerId);
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
