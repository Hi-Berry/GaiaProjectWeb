import { ServerGameState } from '../gameState';
import { BotLogic } from './bot';
import { StateCloner } from './stateCloner';
import { Evaluator } from './evaluator';
import { log } from '../index';

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

        while (Date.now() - startTime < this.MAX_TIME_MS) {
            let node = this.selectNode(root);

            // Limit depth
            if (this.getDepth(node) > this.MAX_DEPTH) {
                const score = Evaluator.evaluateState(node.state, playerId);
                this.backpropagate(node, score);
                continue;
            }

            if (node.untriedActions.length > 0) {
                node = await this.expand(node, playerId);
            }

            const score = await this.simulate(node.state, playerId);
            this.backpropagate(node, score);
            iterations++;
        }

        console.log(`[MCTS] Executed ${iterations} iterations in ${Date.now() - startTime}ms`);
        const bestNode = this.bestChild(root);

        // --- PRINT DETAILED BREAKDOWN OF ALL CANDIDATES ---
        console.log(`\n=== MCTS DETAILED SCORE REPORT ===`);
        for (const child of root.children) {
            const avgScore = child.score / child.visits;
            const actionStr = `${child.action.type} ${JSON.stringify(child.action.params)}`;
            console.log(`[Candidate] ${actionStr} | Visits: ${child.visits} | AvgScore: ${avgScore.toFixed(2)}`);
            Evaluator.evaluateState(child.state, playerId, true);
        }
        console.log(`==================================\n`);

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

        log(`[MCTS] Candidates evaluation:`, 'game', node.state.id);
        for (const child of node.children) {
            const avgScore = child.score / child.visits;
            log(`  - Action: ${child.action.type}${child.action.params?.tileId ? ' ' + child.action.params.tileId : ''}, Score: ${avgScore.toFixed(2)}, Visits: ${child.visits}`, 'game', node.state.id);
            if (avgScore > bestScore) {
                bestScore = avgScore;
                bestChild = child;
            }
        }
        return bestChild;
    }

    private static async expand(node: MCTSNode, playerId: string): Promise<MCTSNode> {
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
                await BotLogic.performAction(dummyIo, newState, pre, playerId);
            }
        }
        await BotLogic.performAction(dummyIo, newState, { type: action.type, params: action.params }, playerId);

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
        const ROLLOUT_STEPS = 6;
        const TOP_N = 8;
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
                            await BotLogic.performAction(dummyIo, s2, pre as any, playerId);
                        }
                    }
                    await BotLogic.performAction(dummyIo, s2, { type: a.type, params: a.params } as any, playerId);
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

            await BotLogic.performAction(dummyIo, currentState, nextAction, playerId);

            if (currentState.hasDoneMainAction) {
                break; // 메인 액션 수행 시 턴이 넘어가거나 넘겨야하므로 시뮬레이션 종료
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
