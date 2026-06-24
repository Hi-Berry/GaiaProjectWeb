/**
 * 가치망 학습 데이터 수집 — 자기대국 중 각 봇 결정 시점의 특징 벡터를 버퍼링하고,
 * 게임 종료 시 그 플레이어의 "최종 VP"로 라벨링해 JSONL로 append한다.
 * 환경변수 VALUE_NET_COLLECT=1 일 때만 동작(프로덕션 무영향).
 *   record: botHandler가 봇 메인 행동 직전에 호출
 *   flush : 게임 종료(gameEnd) 시 호출
 */
import fs from 'fs';
import path from 'path';
import { extractFeatures } from './features';
import type { ServerGameState } from '../gameState';

// 수집 활성: VALUE_NET_COLLECT=1 명시, 또는 개발 모드 기본 ON(=0으로 명시 opt-out).
// → 사용자가 평소 `npm run dev`로 그냥 플레이해도 강한 게임이 자동 수집됨(특별 명령 불필요).
const ENABLED = process.env.VALUE_NET_COLLECT === '1'
    || (process.env.NODE_ENV === 'development' && process.env.VALUE_NET_COLLECT !== '0');
const OUT = process.env.VALUE_NET_DATA || path.join(process.cwd(), 'data', 'valuenet-data.jsonl');

type Rec = { playerId: string; round: number; bot: boolean; f: number[]; a?: string };
const buffers = new Map<string, Rec[]>();

export function valueCollectEnabled(): boolean { return ENABLED; }

/** action: 이 상태에서 선택한 수(모방학습용, 선택). 봇 턴은 getNextMove 전 호출이라 보통 생략. */
export function recordDecisionFeatures(game: ServerGameState, playerId: string, action?: string): void {
    if (!ENABLED || (game as any).simulation || !game.id) return;
    if (!game.players[playerId]) return;
    const bot = game.botPlayerIds?.includes(playerId) ?? false;
    const arr = buffers.get(game.id) ?? [];
    arr.push({ playerId, round: game.roundNumber ?? 0, bot, f: extractFeatures(game, playerId), a: action });
    buffers.set(game.id, arr);
}

export function flushGameData(game: ServerGameState): void {
    if (!ENABLED || !game.id) return;
    const arr = buffers.get(game.id);
    if (!arr || !arr.length) { buffers.delete(game.id); return; }
    try {
        const lines = arr
            // g(gameId)·fac(종족) 추가: 게임단위 train/val 분할 + 강한 게임만 필터링(MINVP)·중복제거 가능케.
            .map(r => JSON.stringify({ y: game.players[r.playerId]?.score ?? 0, g: game.id, fac: game.players[r.playerId]?.faction ?? null, round: r.round, bot: r.bot, a: r.a, f: r.f }))
            .join('\n') + '\n';
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.appendFileSync(OUT, lines);
    } catch { /* best-effort */ }
    buffers.delete(game.id);
}
