/**
 * Head-to-head A/B: 챔피언(현행)과 도전자(변경안)를 같은 테이블에 앉혀 직접 붙인다.
 *
 * 기존 selfPlay/validateAi는 두 버전을 "따로" 돌려 평균 VP를 비교했다. 4인 동일봇 평균 VP는
 * 노이즈가 크고(±5) 실력 차를 거의 못 잡는다. 이 러너는 한 게임에 챔피언 2 + 도전자 2를
 * 앉히고, 좌석(턴순서) 배정을 6패턴으로 순환시켜 선플레이어/위치 편향을 상쇄한 뒤,
 * 도전자 승률과 VP 마진을 유의성 검정과 함께 보고한다.
 *
 * 비교 대상 정의:
 *   - 가중치(weights): aiWeights.json(챔피언) vs aiWeights.candidate.json(도전자).
 *     도전자 파일이 없으면 챔피언과 동일 가중치로 두고 "플래그만" 비교한다.
 *   - 기능 플래그(flags): 코드 변경을 getPlayerFlag(playerId, 'X', false)로 게이팅한 뒤,
 *     도전자 플래그 파일에서 {"X": true}로 켜면 같은 테이블에서 구/신 코드 경로를 비교할 수 있다.
 *
 * 사용법(서버는 이 러너가 직접 띄움):
 *   npm run head2head
 *   H2H_GAMES=120 npm run head2head
 *   AI_CHALLENGER_FLAGS=server/ai/challenger.flags.json npm run head2head
 *   AI_CHALLENGER_WEIGHTS=server/ai/aiWeights.candidate.json npm run head2head
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

type Flags = Record<string, number | boolean>;
type Variant = { label?: string; weights?: unknown; flags?: Flags };
type SeatResult = { playerId: string; faction?: string; score: number; group: 'A' | 'B' | null; pos?: number };
type GameResult = { gameId: string; bPositions: number[]; seats: SeatResult[] };

type Worker = { idx: number; port: number; proc: ChildProcess; socket: Socket };

const ROOT = process.cwd();
const CHAMPION_WEIGHTS_PATH = process.env.AI_CHAMPION_WEIGHTS || path.join(ROOT, 'server', 'ai', 'aiWeights.json');
const CHALLENGER_WEIGHTS_PATH = process.env.AI_CHALLENGER_WEIGHTS || path.join(ROOT, 'server', 'ai', 'aiWeights.candidate.json');
const CHAMPION_FLAGS_PATH = process.env.AI_CHAMPION_FLAGS || '';
const CHALLENGER_FLAGS_PATH = process.env.AI_CHALLENGER_FLAGS || path.join(ROOT, 'server', 'ai', 'challenger.flags.json');
const REPORT_PATH = process.env.H2H_REPORT || path.join(ROOT, 'data', 'h2h-report.json');

const WORKERS = Math.max(1, Number(process.env.H2H_WORKERS) || 3);
const BASE_PORT = Math.max(1000, Number(process.env.H2H_BASE_PORT) || 5300);
const GAMES = Math.max(6, Number(process.env.H2H_GAMES) || 60);
const MCTS_MS = Math.max(50, Number(process.env.H2H_MCTS_MS) || 500);
const BOT_DELAY_MS = Math.max(0, Number(process.env.H2H_BOT_DELAY_MS) || 0);
const GAME_TIMEOUT_MS = (Number(process.env.H2H_GAME_TIMEOUT_MIN) || 35) * 60 * 1000;

// 4좌석 중 2좌석을 B(도전자)로: choose(4,2)=6 패턴. 순환하면 6의 배수마다 각 위치가 정확히 3번 B가 되어
// 선플레이어/위치 편향이 완전히 상쇄된다.
const B_PATTERNS: number[][] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

function readJson(filePath: string): any | null {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        // PowerShell로 저장된 파일에 BOM이 붙는 경우가 있어 제거 후 파싱
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[head2head] failed to read ${filePath}: ${(e as Error).message}`);
        return null;
    }
}

function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function emitAsync<T = any>(socket: Socket, event: string, payload: any): Promise<T> {
    return new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
}

function connectSocket(baseUrl: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => reject(err));
    });
}

async function waitForServer(port: number, maxAttempts = 60): Promise<Socket> {
    const baseUrl = `http://localhost:${port}`;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            return await connectSocket(baseUrl);
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw new Error(`Failed to connect head2head server on port ${port}`);
}

// [좀비 워커 수정 2026-06-18] Windows에선 워커가 cmd.exe→npx→tsx→node 트리로 스폰돼서
// proc.kill()은 맨 위 cmd.exe만 죽이고 실제 게임서버 node(~140MB)는 살아남아 좀비가 됐다(세션마다 누적→RSS급증).
// → taskkill /T 로 트리 전체를 죽인다. 또 정상종료 외 크래시/SIGINT/중단에도 반드시 정리되도록 전역 핸들러 등록.
const ACTIVE_WORKERS = new Set<ChildProcess>();
function killWorkerTree(proc: ChildProcess) {
    if (!proc?.pid) { try { proc?.kill(); } catch { } ACTIVE_WORKERS.delete(proc); return; }
    if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
    } else {
        try { proc.kill('SIGKILL'); } catch { }
    }
    ACTIVE_WORKERS.delete(proc);
}
let cleanupRegistered = false;
function registerWorkerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    const cleanup = () => { for (const p of [...ACTIVE_WORKERS]) killWorkerTree(p); };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
    process.on('uncaughtException', (e) => { console.error('[head2head] uncaught:', e); cleanup(); process.exit(1); });
}

function startServerProcess(port: number): ChildProcess {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd.exe' : 'npx';
    const args = isWin ? ['/d', '/s', '/c', 'npx tsx server/index.ts'] : ['tsx', 'server/index.ts'];
    return spawn(cmd, args, {
        cwd: ROOT,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development' },
        stdio: 'ignore',
        windowsHide: true,
    });
}

async function bootWorkers(): Promise<Worker[]> {
    registerWorkerCleanup();
    const workers: Worker[] = [];
    for (let i = 0; i < WORKERS; i++) {
        const port = BASE_PORT + i;
        const proc = startServerProcess(port);
        ACTIVE_WORKERS.add(proc);
        const socket = await waitForServer(port);
        const token = process.env.AI_TUNING_TOKEN;
        await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs: MCTS_MS, token });
        await emitAsync(socket, 'admin_set_bot_delay_ms', { delayMs: BOT_DELAY_MS, token });
        workers.push({ idx: i, port, proc, socket });
        console.log(`[head2head] worker #${i + 1} ready on :${port}`);
    }
    return workers;
}

async function shutdownWorkers(workers: Worker[]) {
    const token = process.env.AI_TUNING_TOKEN;
    await Promise.all(workers.map(async (w) => {
        try { await emitAsync(w.socket, 'admin_set_mcts_time_ms', { timeMs: null, token }); } catch { }
        try { await emitAsync(w.socket, 'admin_set_bot_delay_ms', { delayMs: null, token }); } catch { }
        try { w.socket.disconnect(); } catch { }
        killWorkerTree(w.proc);   // proc.kill()은 cmd.exe만 죽임 → 트리 전체 kill
    }));
}

function runOneGame(socket: Socket, headToHead: { bPositions: number[]; A: Variant; B: Variant }): Promise<GameResult> {
    return new Promise((resolve, reject) => {
        let gameId = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('Game timeout')); }, GAME_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timer); socket.off('game_updated', onUpdate); };

        const onUpdate = (updated: any) => {
            if (!gameId || updated?.id !== gameId || updated.currentPhase !== 'gameEnd') return;
            cleanup();
            const seats: SeatResult[] = Object.entries(updated.players || {}).map(([playerId, p]: [string, any]) => ({
                playerId,
                faction: p.faction,
                score: typeof p.score === 'number' ? p.score : 0,
                group: (p.h2hGroup as 'A' | 'B' | undefined) ?? null,
                pos: p.h2hPos,
            }));
            resolve({ gameId, bPositions: headToHead.bPositions, seats });
        };

        socket.on('game_updated', onUpdate);
        socket.emit('create_game', { playerName: 'H2HRunner' }, (res: any) => {
            if (res?.error) { cleanup(); reject(new Error(res.error)); return; }
            gameId = res.gameId;
            socket.emit('auto_setup_test', { gameId, selfPlay: true, headToHead });
        });
    });
}

// ---- 통계 헬퍼 ----
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function std(xs: number[]): number {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
/** 표준정규 CDF (Abramowitz-Stegun 근사) */
function normCdf(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
}
/** Wilson 95% 신뢰구간 (승률) */
function wilson(wins: number, n: number): [number, number] {
    if (n === 0) return [0, 1];
    const z = 1.959963985;
    const phat = wins / n;
    const denom = 1 + (z * z) / n;
    const center = (phat + (z * z) / (2 * n)) / denom;
    const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
    return [center - half, center + half];
}

async function evalWorker(worker: Worker, headToHead: { A: Variant; B: Variant }, gameIndices: number[]): Promise<GameResult[]> {
    const results: GameResult[] = [];
    for (const gi of gameIndices) {
        const bPositions = B_PATTERNS[gi % B_PATTERNS.length];
        try {
            const r = await runOneGame(worker.socket, { bPositions, A: headToHead.A, B: headToHead.B });
            results.push(r);
            const line = r.seats
                .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
                .map(s => `${s.group}:${s.faction ?? '?'}=${s.score}`)
                .join(' | ');
            console.log(`[head2head][w${worker.idx + 1}] game ${gi + 1}/${GAMES} (B@${bPositions}) ${line}`);
        } catch (e) {
            console.warn(`[head2head][w${worker.idx + 1}] game ${gi + 1}/${GAMES} failed: ${(e as Error).message}`);
        }
    }
    return results;
}

async function main() {
    const championWeights = readJson(CHAMPION_WEIGHTS_PATH);
    if (!championWeights) throw new Error(`Champion weights not found: ${CHAMPION_WEIGHTS_PATH}`);
    const challengerWeights = readJson(CHALLENGER_WEIGHTS_PATH) ?? championWeights;
    const championFlags: Flags = readJson(CHAMPION_FLAGS_PATH) ?? {};
    const challengerFlags: Flags = readJson(CHALLENGER_FLAGS_PATH) ?? {};

    const weightsDiffer = JSON.stringify(championWeights) !== JSON.stringify(challengerWeights);
    const flagsDiffer = JSON.stringify(championFlags) !== JSON.stringify(challengerFlags);

    console.log('[head2head] ====== 설정 ======');
    console.log(`  champion weights : ${CHAMPION_WEIGHTS_PATH}`);
    console.log(`  challenger weights: ${CHALLENGER_WEIGHTS_PATH}${weightsDiffer ? '' : ' (동일)'}`);
    console.log(`  champion flags   : ${JSON.stringify(championFlags)}`);
    console.log(`  challenger flags : ${JSON.stringify(challengerFlags)}${flagsDiffer ? '' : ' (동일)'}`);
    console.log(`  workers=${WORKERS} games=${GAMES} mcts=${MCTS_MS}ms botDelay=${BOT_DELAY_MS}ms`);
    if (!weightsDiffer && !flagsDiffer) {
        console.warn('  ⚠ 챔피언과 도전자가 완전히 동일합니다 — A/A 샘플(노이즈 기준선) 측정이 됩니다.');
    }

    const A: Variant = { label: 'champion', weights: championWeights, flags: championFlags };
    const B: Variant = { label: 'challenger', weights: challengerWeights, flags: challengerFlags };

    const workers = await bootWorkers();
    try {
        // 게임 인덱스를 워커에 라운드로빈 분배(패턴 순환 보존)
        const buckets: number[][] = Array.from({ length: workers.length }, () => []);
        for (let i = 0; i < GAMES; i++) buckets[i % workers.length].push(i);
        const batches = await Promise.all(workers.map((w, i) => evalWorker(w, { A, B }, buckets[i])));
        const results = batches.flat();

        // ---- 집계 ----
        let bWins = 0, aWins = 0, draws = 0;
        const aScores: number[] = [];
        const bScores: number[] = [];
        const perGameMargin: number[] = []; // meanB - meanA
        for (const g of results) {
            const a = g.seats.filter(s => s.group === 'A').map(s => s.score);
            const b = g.seats.filter(s => s.group === 'B').map(s => s.score);
            if (a.length === 0 || b.length === 0) continue;
            aScores.push(...a);
            bScores.push(...b);
            perGameMargin.push(mean(b) - mean(a));
            const topScore = Math.max(...g.seats.map(s => s.score));
            const topGroups = new Set(g.seats.filter(s => s.score === topScore).map(s => s.group));
            if (topGroups.has('A') && topGroups.has('B')) draws++;
            else if (topGroups.has('B')) bWins++;
            else if (topGroups.has('A')) aWins++;
        }

        const decisive = aWins + bWins;
        const bWinRate = decisive ? bWins / decisive : 0;
        const [ciLo, ciHi] = wilson(bWins, decisive);
        // 승률이 0.5와 다른지 양측 z검정
        const z = decisive ? (bWins - decisive / 2) / (0.5 * Math.sqrt(decisive)) : 0;
        const winPValue = decisive ? 2 * (1 - normCdf(Math.abs(z))) : 1;

        const marginMean = mean(perGameMargin);
        const marginSE = perGameMargin.length ? std(perGameMargin) / Math.sqrt(perGameMargin.length) : 0;
        const marginT = marginSE > 0 ? marginMean / marginSE : 0;
        const marginPValue = perGameMargin.length ? 2 * (1 - normCdf(Math.abs(marginT))) : 1;

        const verdict = (() => {
            if (decisive < 10) return '판수 부족 — 더 많은 게임 필요 (권장 60+)';
            const sigWin = winPValue < 0.05;
            const sigMargin = marginPValue < 0.05;
            if (bWinRate > 0.5 && (sigWin || sigMargin)) return '✅ 도전자가 더 강함 (유의)';
            if (bWinRate < 0.5 && (sigWin || sigMargin)) return '❌ 도전자가 더 약함 (유의) — 채택 금지';
            return '➖ 유의차 없음 (노이즈 범위) — 판수 늘리거나 변경 보류';
        })();

        const report = {
            createdAt: new Date().toISOString(),
            config: {
                championWeightsPath: CHAMPION_WEIGHTS_PATH,
                challengerWeightsPath: CHALLENGER_WEIGHTS_PATH,
                championFlags, challengerFlags,
                weightsDiffer, flagsDiffer,
                workers: WORKERS, games: GAMES, mctsMs: MCTS_MS, botDelayMs: BOT_DELAY_MS,
            },
            finished: results.length,
            requested: GAMES,
            bWins, aWins, draws, decisive,
            bWinRate,
            bWinRate95ci: [ciLo, ciHi],
            winPValue,
            avgChampionVp: mean(aScores),
            avgChallengerVp: mean(bScores),
            vpMarginMean: marginMean,
            vpMarginSE: marginSE,
            vpMarginPValue: marginPValue,
            verdict,
        };
        writeJson(REPORT_PATH, report);

        console.log('\n[head2head] ====== 결과 ======');
        console.log(`  완료 게임: ${results.length}/${GAMES} (승패결정 ${decisive}, 무 ${draws})`);
        console.log(`  도전자 승률: ${(bWinRate * 100).toFixed(1)}%  (B ${bWins} : A ${aWins}, 95%CI ${(ciLo * 100).toFixed(0)}~${(ciHi * 100).toFixed(0)}%, p=${winPValue.toFixed(3)})`);
        console.log(`  평균 VP: 챔피언 ${mean(aScores).toFixed(1)} vs 도전자 ${mean(bScores).toFixed(1)}`);
        console.log(`  VP 마진(도전자-챔피언): ${marginMean >= 0 ? '+' : ''}${marginMean.toFixed(2)} ± ${marginSE.toFixed(2)} (p=${marginPValue.toFixed(3)})`);
        console.log(`  판정: ${verdict}`);
        console.log(`  리포트: ${REPORT_PATH}`);
    } finally {
        await shutdownWorkers(workers);
    }
}

main().catch((err) => {
    console.error('[head2head] Fatal:', err);
    process.exit(1);
});
