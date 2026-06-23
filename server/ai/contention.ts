// 공유 1회성 자원(파워 액션)의 경쟁도(contention) 예측기.
// scripts/extractContention.mjs가 만든 server/ai/contention.json을 런타임 로드.
// 봇이 "이 자원은 이번 라운드에 어차피 뺏긴다 → 지금 선점" 판단에 사용.
import fs from 'fs';
import path from 'path';

type ActionContention = {
    perRound: Record<string, number>; // round(1..6) -> P(taken | reached)
    overall: number;                  // 라운드 평균 P
    earlyOrder: number;               // 0=라운드 내 가장 먼저 선점(시급), 1=늦게
    n: number;
};
type ContentionData = { meta?: unknown; byAction: Record<string, ActionContention> };

let _data: ContentionData | null = null;
let _tried = false;
function getData(): ContentionData | null {
    if (_tried) return _data;
    _tried = true;
    try {
        const p = process.env.CONTENTION_OUT || path.join(process.cwd(), 'server', 'ai', 'contention.json');
        if (fs.existsSync(p)) _data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { _data = null; }
    return _data;
}
export function reloadContention(): void { _tried = false; _data = null; }

/** 이 파워 액션이 '현재 라운드 안에 누군가에게 먹힐' 추정 확률(0~1). 데이터 없으면 0. */
export function getActionContention(actionId: string, round: number): number {
    const d = getData();
    if (!d || !d.byAction || !d.byAction[actionId]) return 0;
    const a = d.byAction[actionId];
    const pr = a.perRound && a.perRound[String(round)];
    if (typeof pr === 'number') return pr;
    return typeof a.overall === 'number' ? a.overall : 0;
}

/** 선점 시급도(0=가장 먼저 먹힘 → 지금 안 잡으면 사라짐, 1=늦게). 데이터 없으면 1(여유). */
export function getActionEarlyOrder(actionId: string): number {
    const d = getData();
    const a = d?.byAction?.[actionId];
    return a && typeof a.earlyOrder === 'number' ? a.earlyOrder : 1;
}

/**
 * 선점 시급도 가중치(0~1). 경쟁도 높고(P) + 일찍 선점될수록(earlyOrder 낮음) 1에 가까움.
 * findPowerActions / MCTS prior에서 "지금 잡아라" 보정 계수로 사용.
 */
export function getGrabUrgency(actionId: string, round: number): number {
    const p = getActionContention(actionId, round);
    if (p <= 0) return 0;
    const early = getActionEarlyOrder(actionId);      // 0=시급, 1=여유
    const earlyFactor = 1 - Math.min(1, Math.max(0, early)); // 1=시급
    // P가 주신호, earlyFactor로 살짝 가중. 0~1.
    return Math.min(1, p * (0.6 + 0.4 * earlyFactor));
}
