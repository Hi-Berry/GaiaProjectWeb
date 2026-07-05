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
type SeatResult = { playerId: string; faction?: string; score: number; group: 'A' | 'B' | null; pos?: number; actions?: Record<string, number>; r1income?: number };
type GameResult = { gameId: string; bPositions: number[]; seats: SeatResult[] };

// 행동 분류 — "변경이 의도한 행동대체를 실제로 했는지"(예: 교역소↓ → 광산/연구소↑ vs 그냥 패스↑) 검증용.
const BEHAVIOR_KEYS = ['mine', 'tradingStation', 'researchLab', 'piAcademy', 'upgrade', 'downgrade', 'research', 'federation', 'powerAct', 'hhConvert', 'techTile', 'advTile', 'gaiaform', 'shipEnter', 'shipAct', 'navP1', 'pass', 'total',
    // [라운드 분해 계측] 전체합계는 후반 랩발판 때문에 무의미 → "초반에 얼마나 린하게 유지하나"를 본다.
    //   tsEarly=R1~2 TS업글수(적을수록 광산 유지), mineEarly=R1~2 광산건설수(많을수록 확장 우선), tsRoundSum/tsRoundN=TS 평균 라운드(늦을수록 절제).
    'tsEarly', 'mineEarly', 'tsRoundSum', 'tsRoundN',
    // [즉포 계측] gaia_project 부스터(bon-2pw-gaiaproject) 선택 vs 특수액션 사용 — "골라놓고 안 씀"(반납 낭비) 측정.
    'gaiaPick', 'gaiaUse',
    // [란티다 계측] PI(의회) 건설·평균라운드·기생광산 — PI 먼저 짓고 기생하는지(각 후속 기생=+2지식).
    'piBuilt', 'paraMine', 'piRoundSum', 'piRoundN',
    // [아이타 계측] 파워 번 횟수 — 아이타는 번 토큰이 가이아 복귀라 적극 번해도 됨(막라 제외).
    'burn',
    // [Ivits 계측] 우주정거장 배치 수 — 봇 4.5/게임 vs 사람 11.3, 안 놓고 패스하던 누수 확인용.
    'spaceStation',
    // [타클론 브레인 점검] takBurn=브레인 bowl2→3 번 횟수, takBrainIdle=브레인 bowl3에 둔 채 턴종료 횟수(미사용).
    'takBurn', 'takBrainIdle',
    // [연구/QIC 행동 검증] 코드 넣은 게 실제로 행동을 바꿨는지 직접 계측(사용자 요청 "넣어서 실제로 이렇게 동작").
    //   econAdv=경제트랙 상승 전체, econAdvR4=R4+ 경제상승(막라 낭비), resLateL3=R5+에 L3+ 도달(엔드게임 VP 챙김),
    //   gaiaMine=가이아 광산 전체, gaiaQic2=2QIC+ 던진 가이아 광산("2Qic 가이아 그만").
    'econAdv', 'econAdvR4', 'resLateL3', 'gaiaMine', 'gaiaQic2',
    // [파워관리 검증] finalP3=종료 시 bowl3, midP3=게임내내 평균 보유 bowl3(사람~1.5), charge=충전횟수(Power Gained=공급).
    //   파워액션(powerAct)과 함께: midP3 낮고 파워액션 적으면 '공급부족'(충전 안함), midP3 높은데 파워액션 적으면 '소비부족'(안씀).
    'finalP3', 'midP3', 'charge'] as const;
function classifyAction(a: string): string | null {
    if (!a) return null;
    // 1) 우주선 Nav+1 획득 (일반 우주선액션보다 먼저)
    if (/Ship Tech: Nav\+1|Rebellion: Gain.*tech|Rebellion: Gained Tech/i.test(a)) return 'navP1';
    // 2) 우주선 입장/액션 (우주선 prefix 행동은 광산건설 등이어도 우주선으로 일관 분류)
    if (/Entered Ship|Entered Spaceship/i.test(a)) return 'shipEnter';
    if (/^(Rebellion|Eclipse|TF Mars|Twilight):|Ship Action/i.test(a)) return 'shipAct';
    // 3) 기술타일 획득
    if (/Gained Tech Tile|Advanced Tech Tile|^Advanced Tech:|^Ship Tech:/i.test(a)) return 'techTile';
    // 4) 업그레이드 — ★특정 대상(교역소/연구소/의회)을 일반 'Upgraded'보다 먼저 잡아야 함
    if (/Upgraded to Trading Station/i.test(a)) return 'tradingStation';
    if (/Upgraded to Research Lab/i.test(a)) return 'researchLab';
    if (/Upgraded to (Planetary Institute|Academy)/i.test(a)) return 'piAcademy';
    if (/Downgrade/i.test(a)) return 'downgrade'; // Firaks 시그니처(PI 다운그레이드) 별도 계측
    if (/^Upgraded/i.test(a)) return 'upgrade';
    // 5) 건설/연구/연방/가이아/파워
    if (/Built Mine|Build Mine/i.test(a)) return 'mine';
    if (/Advanced Research/i.test(a)) return 'research';
    if (/^Federation\b/i.test(a)) return 'federation';
    if (/Placed Gaiaformer|Gaia Project/i.test(a)) return 'gaiaform';
    if (/Hadsch Hallas PI/i.test(a)) return 'hhConvert'; // HH 시그니처 변환 계측
    if (/Power Action|Q\.I\.C\.? Action|QIC Action/i.test(a)) return 'powerAct';
    // 6) 패스(보너스 선택)
    if (/Selected Bonus|^Pass\b|^Passed/i.test(a)) return 'pass';
    return null;
}

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
const GAME_TIMEOUT_MS = (Number(process.env.H2H_GAME_TIMEOUT_MIN) || 8) * 60 * 1000; // [2026-07-05] 35→8분: 정상게임 1.5-2분, hang 1건=35분 손실×13=6h wedge 사고
// [faction-forcing] 종족별 측정: 이 종족을 고정 좌석(FORCE_FACTION_POS, 기본 0)에 강제 배정.
// 그 좌석은 B_PATTERNS 회전으로 절반은 B(플래그ON)/절반은 A(OFF)가 되어 동일 종족 paired 비교가 된다.
const FORCE_FACTION = process.env.H2H_FORCE_FACTION || '';
// 위치 고정 override: H2H_FORCE_FACTION_POS를 명시하면 그 위치 고정(선플만 측정),
// 안 주면 게임마다 위치를 회전(0→1→2→3)해 모든 좌석의 종족을 측정(선플 confound 제거).
const FORCE_FACTION_POS_FIXED = process.env.H2H_FORCE_FACTION_POS != null && process.env.H2H_FORCE_FACTION_POS !== ''
    ? Math.max(0, Math.min(3, Number(process.env.H2H_FORCE_FACTION_POS)))
    : null;

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
    const cleanup = () => { for (const p of Array.from(ACTIVE_WORKERS)) killWorkerTree(p); };
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

function runOneGame(socket: Socket, headToHead: { bPositions: number[]; A: Variant; B: Variant; forceFaction?: string; forceFactionPos?: number }): Promise<GameResult> {
    return new Promise((resolve, reject) => {
        let gameId = '';
        let lastUpdate: any = null; // [hang 진단] 마지막 게임상태 — 타임아웃 시 어느 종족/pending에서 멈췄는지 덤프
        const p3samp: Record<string, { s: number; n: number }> = {}; // [파워 공급vs소비] 게임 내내 bowl3 샘플 → mid-game 평균 보유 bowl3
        const timer = setTimeout(() => {
            // [hang 진단] 사용자 가설: 스톨=특정 종족 액션 무한루프 버그(아이타/아이비츠류). 걸린 상태를 찍는다.
            try {
                const u = lastUpdate;
                if (u) {
                    // [2026-07-05 정밀화] 기존 필드명이 틀려 turn=?(?)만 찍힘 → 실제 필드(turnOrder[currentPlayerIndex])로.
                    const cur = u.turnOrder?.[u.currentPlayerIndex] || '?';
                    const fac = u.players?.[cur]?.faction || '?';
                    const pend = Object.keys(u).filter(k => /^pending/i.test(k) && u[k] && !(Array.isArray(u[k]) && u[k].length === 0)).join(',') || 'none';
                    const seats = Object.values(u.players || {}).map((p: any) => p.faction).join('/');
                    const stm = u.pendingShipTechMine ? `${u.pendingShipTechMine.playerId}(${u.players?.[u.pendingShipTechMine.playerId]?.faction})` : '-';
                    const offers = (u.pendingPowerOffers || []).map((o: any) =>
                        `${o.targetPlayerId?.slice(-4)}(${u.players?.[o.targetPlayerId]?.faction})amt${o.amount}vp${o.vpCost}${o.responded ? 'R' : '!'}`).join(',') || '-';
                    const lastLogs = (u.gameLog || []).slice(-4).map((e: any) => `${e.playerName}:${e.action}`).join(' | ');
                    console.warn(`[HANG] game=${gameId} phase=${u.currentPhase} R${u.roundNumber} turn=${cur}(${fac}) hasMain=${u.hasDoneMainAction} pend=[${pend}] seats=${seats}`);
                    console.warn(`[HANG+] shipTechMine=${stm} offers=[${offers}] turnEndPending=${u.pendingTurnEndPlayerId?.slice(-4) || '-'} lastLog=[${lastLogs}]`);
                }
            } catch (dumpErr) { console.warn(`[HANG] dump failed: ${(dumpErr as Error).message}`); }
            cleanup(); reject(new Error('Game timeout'));
        }, GAME_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timer); socket.off('game_updated', onUpdate); };

        const onUpdate = (updated: any) => {
            if (updated?.id === gameId) {
                lastUpdate = updated; // 매 갱신 저장(hang 진단용)
                // [파워 공급vs소비] 매 갱신마다 각 플레이어 bowl3 샘플 → 봇이 사람(~1.5)만큼 충전파워를 들고 있나(공급) 판별
                for (const [pid, p] of Object.entries(updated.players || {})) {
                    const q = (p3samp[pid] ??= { s: 0, n: 0 }); q.s += ((p as any).power3 ?? 0); q.n++;
                }
            }
            if (!gameId || updated?.id !== gameId || updated.currentPhase !== 'gameEnd') return;
            cleanup();
            // 행동믹스 집계: 게임상태에 포함된 gameLog를 playerId별로 분류 카운트.
            const byPlayer: Record<string, Record<string, number>> = {};
            for (const e of (updated.gameLog ?? [])) {
                const pid = e?.playerId;
                if (!pid) continue;
                // [즉포 계측] classifyAction 밖에서 원시 로그로 직접 카운트(Bonus Action은 classify null이라 continue됨).
                const _det = e.details || '';
                if ((e.action === 'Selected Bonus' && /took bon-2pw-gaiaproject/.test(_det)) ||
                    (e.action === 'Selected Bonus Tile' && /ACT: GP/.test(_det))) {
                    (byPlayer[pid] ??= {}).gaiaPick = ((byPlayer[pid] ??= {}).gaiaPick || 0) + 1;
                }
                if (e.action === 'Bonus Action' && /Gaia Project/i.test(_det)) {
                    (byPlayer[pid] ??= {}).gaiaUse = ((byPlayer[pid] ??= {}).gaiaUse || 0) + 1;
                }
                // [파워 공급vs소비] 충전 횟수(Power Gained) — 봇이 사람만큼 파워를 모으나(leech/수입=공급).
                if (/Power Gained/i.test(e.action || '')) (byPlayer[pid] ??= {}).charge = ((byPlayer[pid] ??= {}).charge || 0) + 1;
                // [란티다 계측] PI 건설(+평균 라운드), 기생광산 수.
                if (/Upgraded to Planetary Institute/i.test(e.action || '')) {
                    (byPlayer[pid] ??= {}).piBuilt = ((byPlayer[pid] ??= {}).piBuilt || 0) + 1;
                    const prd = typeof e.round === 'number' ? e.round : 99;
                    (byPlayer[pid] ??= {}).piRoundSum = ((byPlayer[pid] ??= {}).piRoundSum || 0) + prd;
                    (byPlayer[pid] ??= {}).piRoundN = ((byPlayer[pid] ??= {}).piRoundN || 0) + 1;
                }
                if (/Built Parasitic Mine/i.test(e.action || '')) {
                    (byPlayer[pid] ??= {}).paraMine = ((byPlayer[pid] ??= {}).paraMine || 0) + 1;
                }
                // 번은 consolidation으로 action이 'Free Actions'가 되고 번 텍스트가 details로 감 → action+details 둘 다 검사(안 그럼 과소집계).
                if (/Power Burn|Burn 2 Power|Burn \(/i.test(e.action || '') || /Bowl II ?-> ?III|to Gaia area/i.test(e.details || '')) {
                    (byPlayer[pid] ??= {}).burn = ((byPlayer[pid] ??= {}).burn || 0) + 1;
                }
                if (/Ivits: Space Station/i.test(e.action || '')) {
                    (byPlayer[pid] ??= {}).spaceStation = ((byPlayer[pid] ??= {}).spaceStation || 0) + 1;
                }
                if (/Taklons: Burn/i.test(e.action || '')) {
                    (byPlayer[pid] ??= {}).takBurn = ((byPlayer[pid] ??= {}).takBurn || 0) + 1;
                }
                if (/Brain idle bowl3/i.test(e.action || '')) {
                    (byPlayer[pid] ??= {}).takBrainIdle = ((byPlayer[pid] ??= {}).takBrainIdle || 0) + 1;
                }
                // [연구/QIC 행동 검증] 라운드별 트랙/비용을 원시 로그에서 직접 계측.
                if (/Advanced Research/i.test(e.action || '')) {
                    const rm = /^(\w+) to level (\d+)/i.exec(_det);
                    const rrd = typeof e.round === 'number' ? e.round : 99;
                    if (rm) {
                        const trk = rm[1].toLowerCase(); const lvl = +rm[2];
                        if (trk === 'economy') {
                            (byPlayer[pid] ??= {}).econAdv = ((byPlayer[pid] ??= {}).econAdv || 0) + 1;
                            if (rrd >= 4) (byPlayer[pid] ??= {}).econAdvR4 = ((byPlayer[pid] ??= {}).econAdvR4 || 0) + 1;
                        }
                        if (lvl >= 3 && rrd >= 5) (byPlayer[pid] ??= {}).resLateL3 = ((byPlayer[pid] ??= {}).resLateL3 || 0) + 1;
                    }
                }
                if (/Built Mine/i.test(e.action || '') && /on gaia\b/i.test(_det)) {
                    (byPlayer[pid] ??= {}).gaiaMine = ((byPlayer[pid] ??= {}).gaiaMine || 0) + 1;
                    const qm = /(\d+)QIC/.exec(_det);
                    if (qm && +qm[1] >= 2) (byPlayer[pid] ??= {}).gaiaQic2 = ((byPlayer[pid] ??= {}).gaiaQic2 || 0) + 1;
                }
                const k = classifyAction(e.action || '');
                if (!k) continue;
                (byPlayer[pid] ??= {})[k] = ((byPlayer[pid] ??= {})[k] || 0) + 1;
                byPlayer[pid].total = (byPlayer[pid].total || 0) + 1;
                // [라운드 분해] 초반 타이밍 계측 — 전체합계로는 안 보이는 "초반 린함"을 잡는다.
                const rd = typeof e.round === 'number' ? e.round : 99;
                if (k === 'tradingStation') {
                    if (rd <= 2) byPlayer[pid].tsEarly = (byPlayer[pid].tsEarly || 0) + 1;
                    byPlayer[pid].tsRoundSum = (byPlayer[pid].tsRoundSum || 0) + rd; // TS 평균 라운드 계산용
                    byPlayer[pid].tsRoundN = (byPlayer[pid].tsRoundN || 0) + 1;
                }
                if (k === 'mine' && rd <= 2) byPlayer[pid].mineEarly = (byPlayer[pid].mineEarly || 0) + 1;
            }
            const seats: SeatResult[] = Object.entries(updated.players || {}).map(([playerId, p]: [string, any]) => ({
                playerId,
                faction: p.faction,
                score: typeof p.score === 'number' ? p.score : 0,
                group: (p.h2hGroup as 'A' | 'B' | undefined) ?? null,
                pos: p.h2hPos,
                // [고급타일 계측] 최종 보유 기술타일 중 고급('adv-' 접두) 개수 — greenForAdvTile 등 고급타일 획득 효과 직접 확인용.
                actions: { ...(byPlayer[playerId] ?? {}), advTile: (Array.isArray(p.techTiles) ? p.techTiles.filter((t: string) => typeof t === 'string' && t.startsWith('adv-')).length : 0), finalP3: p.power3 ?? 0, midP3: (p3samp[playerId] && p3samp[playerId].n) ? p3samp[playerId].s / p3samp[playerId].n : 0 },
                // [진단] 1라운드 수익 합(O+K+C). 0이면 그 플레이어가 1R 수익 못 받음 = 수익 스킵 버그 게임.
                r1income: (() => { const t = p.roundIncomeTotals?.[1]; return t ? ((t.ore ?? 0) + (t.knowledge ?? 0) + (t.credits ?? 0)) : 0; })(),
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
        let bPositions = B_PATTERNS[gi % B_PATTERNS.length];
        let forcePos = FORCE_FACTION_POS_FIXED ?? 0;
        if (FORCE_FACTION) {
            // 위치 회전(고정 override 없으면): 강제 종족을 게임마다 다른 좌석에 앉혀 선플 confound 제거.
            forcePos = FORCE_FACTION_POS_FIXED ?? (gi % 4);
            // ON/OFF는 B_PATTERNS에 맡기지 않고 직접 구성(4와 6이 안 맞아 비율/위치가 깨짐).
            // 4게임 블록마다 ON/OFF 교대 → 위치별로도 전체로도 ON·OFF 균형. 나머지 B석은 비대상 종족(플래그 no-op).
            const forcedOn = Math.floor(gi / 4) % 2 === 0;
            bPositions = forcedOn
                ? [forcePos, (forcePos + 1) % 4]
                : [(forcePos + 1) % 4, (forcePos + 2) % 4];
        }
        try {
            const r = await runOneGame(worker.socket, { bPositions, A: headToHead.A, B: headToHead.B, forceFaction: FORCE_FACTION || undefined, forceFactionPos: forcePos });
            results.push(r);
            const line = r.seats
                .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
                .map(s => `${s.group}:${s.faction ?? '?'}=${s.score}`)
                .join(' | ');
            console.log(`[head2head][w${worker.idx + 1}] game ${gi + 1}/${GAMES} (B@${bPositions}) ${line}`);
        } catch (e) {
            console.warn(`[head2head][w${worker.idx + 1}] game ${gi + 1}/${GAMES} failed: ${(e as Error).message}`);
            // [2026-07-05 워커 recycle] hang 후 워커 서버가 오염돼 이후 게임 연쇄 타임아웃(13연속→run wedge 6h 사고).
            // 실패 시 해당 워커 프로세스를 죽이고 재부팅해 깨끗한 상태로 계속.
            try {
                console.warn(`[head2head][w${worker.idx + 1}] recycling worker after failure...`);
                try { worker.socket.disconnect(); } catch { }
                killWorkerTree(worker.proc);
                ACTIVE_WORKERS.delete(worker.proc);
                await new Promise(r => setTimeout(r, 2000));
                const proc2 = startServerProcess(worker.port);
                ACTIVE_WORKERS.add(proc2);
                const socket2 = await waitForServer(worker.port);
                const token = process.env.AI_TUNING_TOKEN;
                await emitAsync(socket2, 'admin_set_mcts_time_ms', { timeMs: MCTS_MS, token });
                await emitAsync(socket2, 'admin_set_bot_delay_ms', { delayMs: BOT_DELAY_MS, token });
                worker.proc = proc2; worker.socket = socket2;
                console.warn(`[head2head][w${worker.idx + 1}] worker recycled on :${worker.port}`);
            } catch (re) {
                console.warn(`[head2head][w${worker.idx + 1}] recycle failed: ${(re as Error).message} — 이 워커 잔여 게임 스킵`);
                return results;
            }
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

        // [faction-forcing] 강제 종족이 있으면 그 종족의 B(플래그ON) vs A(OFF) 점수를 직접 비교(paired, 동일 좌석).
        // 이게 종족별 측정의 핵심 지표 — 전체 승률/마진은 비대상 좌석 때문에 희석되므로 이 줄을 봐야 함.
        let factionSplit: { faction: string; bScores: number[]; aScores: number[] } | null = null;
        if (FORCE_FACTION) {
            const bs: number[] = [], as: number[] = [];
            for (const g of results) {
                for (const s of g.seats) {
                    if (s.faction !== FORCE_FACTION) continue;
                    if (s.group === 'B') bs.push(s.score);
                    else if (s.group === 'A') as.push(s.score);
                }
            }
            factionSplit = { faction: FORCE_FACTION, bScores: bs, aScores: as };
        }

        // [행동믹스 검증] 변경이 '의도한 행동대체'를 실제로 했는지 — 예: 교역소↓가 광산/연구소↑(좋은 발전)로
        // 갔는지, 아니면 그냥 패스↑(헛수고)인지. VP가 무해(±0)여도 이 표로 메커니즘이 작동했는지 구분한다.
        const behaviorAgg = (group: 'A' | 'B') => {
            const sums: Record<string, number> = {};
            let seatN = 0;
            for (const g of results) {
                for (const s of g.seats) {
                    if (s.group !== group) continue;
                    seatN++;
                    for (const k of BEHAVIOR_KEYS) sums[k] = (sums[k] || 0) + (s.actions?.[k] || 0);
                }
            }
            const avg: Record<string, number> = {};
            for (const k of BEHAVIOR_KEYS) avg[k] = seatN ? sums[k] / seatN : 0;
            return { avg, seatN };
        };
        const behA = behaviorAgg('A');
        const behB = behaviorAgg('B');

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
            forceFaction: FORCE_FACTION || null,
            factionSplit: factionSplit ? {
                faction: factionSplit.faction,
                onN: factionSplit.bScores.length,
                offN: factionSplit.aScores.length,
                onAvg: mean(factionSplit.bScores),
                offAvg: mean(factionSplit.aScores),
                delta: mean(factionSplit.bScores) - mean(factionSplit.aScores),
            } : null,
            behavior: { champion: behA.avg, challenger: behB.avg, championSeats: behA.seatN, challengerSeats: behB.seatN },
        };
        writeJson(REPORT_PATH, report);

        console.log('\n[head2head] ====== 결과 ======');
        console.log(`  완료 게임: ${results.length}/${GAMES} (승패결정 ${decisive}, 무 ${draws})`);
        console.log(`  도전자 승률: ${(bWinRate * 100).toFixed(1)}%  (B ${bWins} : A ${aWins}, 95%CI ${(ciLo * 100).toFixed(0)}~${(ciHi * 100).toFixed(0)}%, p=${winPValue.toFixed(3)})`);
        console.log(`  평균 VP: 챔피언 ${mean(aScores).toFixed(1)} vs 도전자 ${mean(bScores).toFixed(1)}`);
        console.log(`  VP 마진(도전자-챔피언): ${marginMean >= 0 ? '+' : ''}${marginMean.toFixed(2)} ± ${marginSE.toFixed(2)} (p=${marginPValue.toFixed(3)})`);
        console.log(`  판정: ${verdict}`);
        if (factionSplit) {
            const onAvg = mean(factionSplit.bScores), offAvg = mean(factionSplit.aScores);
            const d = onAvg - offAvg;
            // paired는 아니지만 동일 종족·동일 고정좌석이라 분산이 작다. 2표본 t 근사로 유의성 참고치 제공.
            const sePooled = Math.sqrt((std(factionSplit.bScores) ** 2) / Math.max(1, factionSplit.bScores.length) + (std(factionSplit.aScores) ** 2) / Math.max(1, factionSplit.aScores.length));
            const tFac = sePooled > 0 ? d / sePooled : 0;
            const pFac = 2 * (1 - normCdf(Math.abs(tFac)));
            console.log(`\n  ★ [${factionSplit.faction}] 플래그ON ${onAvg.toFixed(1)} (n=${factionSplit.bScores.length}) vs OFF ${offAvg.toFixed(1)} (n=${factionSplit.aScores.length}) → Δ${d >= 0 ? '+' : ''}${d.toFixed(2)} (p≈${pFac.toFixed(3)})`);
        }
        // 행동믹스 차이표: 도전자(B)가 챔피언(A) 대비 각 행동을 좌석당 평균 몇 번 더/덜 했는지.
        // "교역소↓ → 광산/연구소/연구↑"면 의도한 발전 대체가 일어난 것(좋음). "그냥 총행동↓·패스 빠름"이면 헛수고.
        console.log('\n  ── 행동믹스(좌석당 평균, B=도전자 − A=챔피언) ──');
        const labelMap: Record<string, string> = {
            mine: '광산', tradingStation: '교역소', researchLab: '연구소', piAcademy: '의회/아카데미',
            upgrade: '업글(기타)', downgrade: '다운그레이드', research: '연구진행', federation: '연방', powerAct: '파워액션', hhConvert: 'HH변환',
            techTile: '기술타일', advTile: '고급타일', gaiaform: '가이아포밍', shipEnter: '우주선입장', shipAct: '우주선액션', navP1: 'Nav+1획득', pass: '패스', total: '총행동',
            tsEarly: 'TS(R1-2)', mineEarly: '광산(R1-2)', tsRoundSum: '_tsRsum', tsRoundN: '_tsRn',
            gaiaPick: '즉포선택', gaiaUse: '즉포사용', piBuilt: 'PI건설', paraMine: '기생광산', piRoundSum: '_piRsum', piRoundN: '_piRn', burn: '파워번', spaceStation: '우주정거장', takBurn: '타클론번', takBrainIdle: '브레인놀림',
            econAdv: '경제상승', econAdvR4: '경제상승R4+', resLateL3: 'R5+L3도달', gaiaMine: '가이아광산', gaiaQic2: '2Q+가이아',
            finalP3: '종료bowl3', midP3: '평균bowl3', charge: '충전횟수',
        };
        for (const k of BEHAVIOR_KEYS) {
            if (k === 'tsRoundSum' || k === 'tsRoundN' || k === 'piRoundSum' || k === 'piRoundN') continue; // 내부 집계용 → 평균라운드로 따로 출력
            const a = behA.avg[k] || 0, b = behB.avg[k] || 0, d = b - a;
            const bar = Math.abs(d) < 0.05 ? '' : (d > 0 ? '▲' : '▼');
            console.log(`    ${(labelMap[k] || k).padEnd(7)} A ${a.toFixed(2).padStart(6)}  B ${b.toFixed(2).padStart(6)}  Δ${d >= 0 ? '+' : ''}${d.toFixed(2)} ${bar}`);
        }
        // TS 평균 라운드(늦을수록 절제) — 좌석평균 합/횟수로 재계산.
        const tsAvgRd = (bh: any) => (bh.avg.tsRoundN ? (bh.avg.tsRoundSum / bh.avg.tsRoundN) : 0);
        const ta = tsAvgRd(behA), tb = tsAvgRd(behB);
        console.log(`    ${'TS평균R'.padEnd(7)} A ${ta.toFixed(2).padStart(6)}  B ${tb.toFixed(2).padStart(6)}  Δ${(tb - ta) >= 0 ? '+' : ''}${(tb - ta).toFixed(2)} ${Math.abs(tb - ta) < 0.05 ? '' : (tb > ta ? '▲(늦음=절제)' : '▼(빠름)')}`);
        // PI 평균 라운드(란티다: 낮을수록 조기 PI=기생 지식 극대화)
        const piAvgRd = (bh: any) => (bh.avg.piRoundN ? (bh.avg.piRoundSum / bh.avg.piRoundN) : 0);
        const pa = piAvgRd(behA), pb = piAvgRd(behB);
        console.log(`    ${'PI평균R'.padEnd(7)} A ${pa.toFixed(2).padStart(6)}  B ${pb.toFixed(2).padStart(6)}  Δ${(pb - pa) >= 0 ? '+' : ''}${(pb - pa).toFixed(2)} ${Math.abs(pb - pa) < 0.05 ? '' : (pb < pa ? '▼(조기=좋음)' : '▲(늦음)')}`);
        console.log(`  리포트: ${REPORT_PATH}`);
    } finally {
        await shutdownWorkers(workers);
    }
}

main().catch((err) => {
    console.error('[head2head] Fatal:', err);
    process.exit(1);
});
