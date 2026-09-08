// 고득점 봇 게임 보존 (사용자 요청 2026-09-08): 봇이 150점 이상 낸 게임의 final_state.json + game_<id>.log를
// logs/high-score/ 로 복사해 run-h2h.sh의 7일 자동 정리(find -delete)에서 제외한다. 자가대국 37,446석 중 150+는 29석(0.08%)뿐인
// 상위 꼬리라 "봇이 어떻게 그 점수에 도달했나"를 나중에 뜯어볼 귀한 표본 — 7/22의 hadsch_hallas 212점 게임은 이미 정리돼 복원 불가.
// 실행: node scripts/archiveHighScoreGames.mjs [--min 150] [--all]   (기본: 최근 8일 내 final_state만 스캔, 멱등)
import fs from 'fs';
import path from 'path';

const MIN = Number(process.argv.includes('--min') ? process.argv[process.argv.indexOf('--min') + 1] : 150);
const ALL = process.argv.includes('--all');
const LOGS = 'logs';
const DEST = path.join(LOGS, 'high-score');
fs.mkdirSync(DEST, { recursive: true });

const cutoff = Date.now() - 8 * 24 * 3600e3;
const files = fs.readdirSync(LOGS).filter(f => f.endsWith('_final_state.json'));
let scanned = 0, kept = 0, skipped = 0;
const index = [];
for (const f of files) {
    const src = path.join(LOGS, f);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (!ALL && st.mtimeMs < cutoff) continue;
    scanned++;
    let g; try { g = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { continue; }
    const players = Object.values(g.players || {});
    if (!players.length) continue;
    const bots = new Set(g.botPlayerIds || []);
    // 봇 좌석 판정: botPlayerIds 또는 자가대국 러너 이름(H2HRunner/AI Bot/SelfPlayRunner)
    const isBot = (id, p) => bots.has(id) || /^(AI Bot|H2HRunner|SelfPlayRunner|Runner|Champion|Challenger)/i.test(p.name || '');
    const hi = Object.entries(g.players).filter(([id, p]) => isBot(id, p) && (p.score ?? 0) >= MIN);
    if (!hi.length) continue;
    const gameId = f.replace('_final_state.json', '').replace(/^game_/, '');
    const dstState = path.join(DEST, f);
    if (fs.existsSync(dstState)) { skipped++; continue; }
    fs.copyFileSync(src, dstState);
    const logSrc = path.join(LOGS, `game_${gameId}.log`);
    if (fs.existsSync(logSrc)) fs.copyFileSync(logSrc, path.join(DEST, `game_${gameId}.log`));
    kept++;
    index.push({ gameId, savedAt: new Date().toISOString(), round: g.roundNumber, high: hi.map(([, p]) => `${p.faction}=${p.score}`), all: players.map(p => `${p.name}/${p.faction}=${p.score}`) });
}
// 색인 누적(사람이 읽는 목록)
const idxPath = path.join(DEST, 'INDEX.md');
if (index.length) {
    const lines = index.map(e => `- ${e.savedAt.slice(0, 10)} game ${e.gameId} R${e.round} — **${e.high.join(', ')}** | 전체: ${e.all.join(' · ')}`);
    fs.appendFileSync(idxPath, (fs.existsSync(idxPath) ? '' : `# 봇 ${MIN}점 이상 게임 보관 색인\n\n`) + lines.join('\n') + '\n');
}
console.log(`[archiveHighScore] 스캔 ${scanned} · 새로 보존 ${kept} · 이미 보존 ${skipped} → ${DEST}`);
