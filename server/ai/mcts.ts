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
        return Number.isFinite(v) ? v : 4000; // 3초에서 4초로 상향
    }
    /** 환경 변수 MCTS_MAX_DEPTH(숫자)로 오버라이드 가능. 깊이 늘리면 강해지지만 느려짐 */
    private static get MAX_DEPTH(): number {
        const v = typeof process !== 'undefined' && process.env?.MCTS_MAX_DEPTH ? parseInt(process.env.MCTS_MAX_DEPTH, 10) : NaN;
        return Number.isFinite(v) ? v : 5;
    }

    static async search(initialState: ServerGameState, playerId: string, possibleActions: any[]): Promise<any | null> {
        // Find possible top-level actions
        if (possibleActions.length === 0) return null;
        if (possibleActions.length === 1) return possibleActions[0];

        const rootStore = StateCloner.cloneGameState(initialState);
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
        return this.bestChild(root).action;
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

        const newState = StateCloner.cloneGameState(node.state);
        newState.simulation = true;

        // Emulate action (this is tricky because performAction requires an IO socket, which we don't really want to trigger events for during MCTS)
        // For MCTS to truly work, execute functions need a 'mock' mode or we use a separate simulation engine.
        // For our simplified MCTS, we will execute it with a dummy IO object.
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;
        await BotLogic.performAction(dummyIo, newState, action, playerId);

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
        let currentState = StateCloner.cloneGameState(state);
        currentState.simulation = true;
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;

        // Simulate 4 steps ahead greedily instead of fully random to avoid terrible play
        for (let i = 0; i < 4; i++) {
            if (currentState.turnOrder[currentState.currentPlayerIndex] !== playerId || currentState.currentPhase !== 'main') {
                break;
            }

            const nextAction = await BotLogic.getNextMove(currentState, playerId, true); // isSimulate = true
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
