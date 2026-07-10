/**
 * Sibling-ranking probe driver (offline, instrumentation only).
 * Boots N game-server workers with SIBLING_PROBE=1 and runs self-play games until each worker's
 * server has emitted enough decision records. The server-side probe (server/ai/siblingProbe.ts)
 * appends JSONL records to per-worker files. We then concatenate them for the report script.
 *
 * Env:
 *   SP_WORKERS=3 SP_GAMES_PER_WORKER=40 SP_MCTS_MS=150 SP_BASE_PORT=5400
 */
import { io as ioClient } from 'socket.io-client';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const WORKERS = Math.max(1, Number(process.env.SP_WORKERS) || 3);
const GAMES_PER_WORKER = Math.max(1, Number(process.env.SP_GAMES_PER_WORKER) || 40);
const MCTS_MS = Math.max(50, Number(process.env.SP_MCTS_MS) || 150);
const BASE_PORT = Math.max(1000, Number(process.env.SP_BASE_PORT) || 5400);
const GAME_TIMEOUT_MS = (Number(process.env.SP_GAME_TIMEOUT_MIN) || 8) * 60 * 1000;
const OUT_DIR = path.join(ROOT, 'data');
const MERGED_OUT = path.join(OUT_DIR, 'sibling-probe.jsonl');

const ACTIVE = new Set();
function killTree(proc) {
    if (!proc?.pid) { try { proc?.kill(); } catch {} ACTIVE.delete(proc); return; }
    if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else { try { proc.kill('SIGKILL'); } catch {} }
    ACTIVE.delete(proc);
}
process.on('exit', () => { for (const p of Array.from(ACTIVE)) killTree(p); });
process.on('SIGINT', () => { for (const p of Array.from(ACTIVE)) killTree(p); process.exit(130); });

function startServer(port, outFile) {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd.exe' : 'npx';
    const args = isWin ? ['/d', '/s', '/c', 'npx tsx server/index.ts'] : ['tsx', 'server/index.ts'];
    return spawn(cmd, args, {
        cwd: ROOT,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development',
               SIBLING_PROBE: '1', SIBLING_PROBE_OUT: outFile },
        stdio: 'ignore',
        windowsHide: true,
    });
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const s = ioClient(url, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
        s.on('connect', () => resolve(s));
        s.on('connect_error', (e) => reject(e));
    });
}
async function waitForServer(port, maxAttempts = 90) {
    const url = `http://localhost:${port}`;
    for (let i = 0; i < maxAttempts; i++) {
        try { return await connect(url); } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error(`server ${port} did not come up`);
}
function emitAsync(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res)));
}

function runOneGame(socket) {
    return new Promise((resolve, reject) => {
        let gameId = '';
        const timer = setTimeout(() => { socket.off('game_updated', onUpdate); reject(new Error('timeout')); }, GAME_TIMEOUT_MS);
        const onUpdate = (u) => {
            if (!gameId || u?.id !== gameId || u.currentPhase !== 'gameEnd') return;
            clearTimeout(timer); socket.off('game_updated', onUpdate);
            const scores = Object.values(u.players || {}).map((p) => p.score ?? 0);
            resolve(scores);
        };
        socket.on('game_updated', onUpdate);
        socket.emit('create_game', { playerName: 'SiblingProbe' }, (res) => {
            if (res?.error) { clearTimeout(timer); socket.off('game_updated', onUpdate); reject(new Error(res.error)); return; }
            gameId = res.gameId;
            socket.emit('auto_setup_test', { gameId, selfPlay: true });
        });
    });
}

async function worker(idx) {
    const port = BASE_PORT + idx;
    const outFile = path.join(OUT_DIR, `sibling-probe.w${idx}.jsonl`);
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
    try { fs.rmSync(outFile, { force: true }); } catch {}
    let proc = startServer(port, outFile);
    ACTIVE.add(proc);
    let socket = await waitForServer(port);
    await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs: MCTS_MS });
    await emitAsync(socket, 'admin_set_bot_delay_ms', { delayMs: 0 });
    console.log(`[w${idx}] ready on :${port} -> ${path.basename(outFile)}`);
    let done = 0;
    for (let g = 0; g < GAMES_PER_WORKER; g++) {
        try {
            const scores = await runOneGame(socket);
            done++;
            const recs = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).length : 0;
            console.log(`[w${idx}] game ${g + 1}/${GAMES_PER_WORKER} done scores=[${scores.join(',')}] decisions=${recs}`);
        } catch (e) {
            console.warn(`[w${idx}] game ${g + 1} failed: ${e.message} — recycling worker`);
            try { socket.disconnect(); } catch {}
            killTree(proc);
            await new Promise(r => setTimeout(r, 2000));
            proc = startServer(port, outFile); ACTIVE.add(proc);
            socket = await waitForServer(port);
            await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs: MCTS_MS });
            await emitAsync(socket, 'admin_set_bot_delay_ms', { delayMs: 0 });
        }
    }
    try { socket.disconnect(); } catch {}
    killTree(proc);
    console.log(`[w${idx}] finished ${done}/${GAMES_PER_WORKER} games`);
    return outFile;
}

async function main() {
    console.log(`[siblingProbe] workers=${WORKERS} gamesPerWorker=${GAMES_PER_WORKER} mcts=${MCTS_MS}ms`);
    const outFiles = await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
    // merge
    const out = fs.createWriteStream(MERGED_OUT, { flags: 'w' });
    let total = 0;
    for (const f of outFiles) {
        if (!fs.existsSync(f)) continue;
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        for (const ln of lines) { out.write(ln + '\n'); total++; }
    }
    out.end();
    console.log(`[siblingProbe] merged ${total} decision records -> ${MERGED_OUT}`);
}

main().catch((e) => { console.error('[siblingProbe] fatal', e); process.exit(1); });
