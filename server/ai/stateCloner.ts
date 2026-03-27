import { ServerGameState } from '../gameState';

export class StateCloner {
    /**
     * Creates a deep copy of the ServerGameState suitable for MCTS simulation.
     * MCTS needs to mutate this state without affecting the real game state.
     */
    static cloneGameState(game: ServerGameState): ServerGameState {
        // We use JSON parse/stringify for a deep clone. 
        // This is safe because ServerGameState only contains serializable data (no functions, no cyclic references).
        // It might be slightly slow, but it guarantees absolute isolation.
        // For MCTS performance optimization later, we could hand-write a custom, faster cloner, 
        // but for now, this ensures 100% correctness.
        return JSON.parse(JSON.stringify(game)) as ServerGameState;
    }

    /**
     * MCTS/시뮬레이션 전용 경량 복제.
     * - 시뮬레이션에 불필요한 대용량 필드(gameLog, turnStartState, freeActionUndoState)를 제거해
     *   메모리 사용량 급증을 완화한다.
     */
    static cloneGameStateForSimulation(game: ServerGameState): ServerGameState {
        const { gameLog: _log, turnStartState: _ts, freeActionUndoState: _fa, ...rest } = game as any;
        return JSON.parse(JSON.stringify({
            ...rest,
            gameLog: [],
            turnStartState: undefined,
            freeActionUndoState: undefined,
        })) as ServerGameState;
    }

    /**
     * Helper to clone just the player state if we only need partial simulation.
     */
    static clonePlayer(game: ServerGameState, playerId: string) {
        if (!game.players[playerId]) return null;
        return JSON.parse(JSON.stringify(game.players[playerId]));
    }
}
