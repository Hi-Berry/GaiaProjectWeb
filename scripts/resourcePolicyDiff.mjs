/**
 * 자원상태→행동 정책 발산표 (사람 vs 봇) — 크레딧 풍선 해부 (2026-07-16)
 * gameLog의 base 스냅샷(턴시작 자원)으로 (광석·크레딧) 밴드별 메인액션 분포를 비교.
 *  - 사람: data/human-games 사람 좌석
 *  - 봇(프로덕션): 같은 게임들의 봇 좌석 (구버전 코드 주의)
 *  - 봇(현재코드): logs/ 최근 셀프플레이 final_state
 * 실행: node scripts/resourcePolicyDiff.mjs
 */
import fs from 'fs';

const MAIN_RE = /Free Action|Selected|Charged|Bonus:|Received|Income|↳|Final|Faction|Starting/i;
const CLASS = (l) => {
    const a = l.action || '';
    if (/Built Mine/i.test(a)) return 'mine';
    if (/Trading Station/i.test(a)) return 'TS';
    if (/Research Lab/i.test(a)) return 'lab';
    if (/Planetary Institute|Academy/i.test(a)) return 'big';
    if (/Advanced Research|Advance/i.test(a) && /research/i.test(a)) return 'research';
    if (/Power Action/i.test(a)) return 'powerAct';
    if (/Federation/i.test(a)) return 'fed';
    if (/Pass/i.test(a)) return 'pass';
    if (/Tech Action|Special|Ship|Spade|Terraform|Gaiaform/i.test(a)) return 'other';
    return 'other';
};
const BAND = (b) => {
    if (!b) return null;
    const o = b.o ?? 0, c = b.c ?? 0;
    const ob = o >= 3 ? 'O3+' : o >= 1 ? 'O1-2' : 'O0';
    const cb = c >= 8 ? 'C8+' : c >= 4 ? 'C4-7' : 'C0-3';
    return ob + '/' + cb;
};

function collect(entries) {
    const table = {}; // band -> class -> n
    for (const { log, round } of entries) {
        if (MAIN_RE.test(log.action || '')) continue;
        if ((round ?? 0) < 1) continue;
        const band = BAND(log.base);
        if (!band) continue;
        const cls = CLASS(log);
        table[band] = table[band] || {};
        table[band][cls] = (table[band][cls] || 0) + 1;
    }
    return table;
}

function gather(dir, files, seatFilter) {
    const entries = [];
    let seats = 0;
    for (const f of files) {
        let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
        const bots = new Set(g.botPlayerIds || []);
        for (const [pid] of Object.entries(g.players || {})) {
            if (seatFilter === 'human' && bots.has(pid)) continue;
            if (seatFilter === 'bot' && !bots.has(pid)) continue;
            seats++;
            for (const l of (g.gameLog || [])) {
                if (l.playerId !== pid) continue;
                entries.push({ log: l, round: l.round });
            }
        }
    }
    return { table: collect(entries), seats };
}

const humFiles = fs.readdirSync('data/human-games').filter(f => f.endsWith('.json'));
const botFiles = fs.readdirSync('logs').filter(f => f.includes('final_state'))
    .map(f => ({ f, t: fs.statSync('logs/' + f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 60).map(x => x.f);

const hum = gather('data/human-games', humFiles, 'human');
const prod = gather('data/human-games', humFiles, 'bot');
const cur = gather('logs', botFiles, null);

const CLS = ['mine', 'TS', 'lab', 'big', 'research', 'powerAct', 'fed', 'pass', 'other'];
const pct = (t, band) => {
    const row = t[band] || {}; const n = Object.values(row).reduce((a, b) => a + b, 0) || 1;
    return CLS.map(c => String(Math.round(100 * (row[c] || 0) / n)).padStart(3)).join(' ') + '  (n=' + n + ')';
};
const bands = ['O0/C0-3', 'O0/C4-7', 'O0/C8+', 'O1-2/C0-3', 'O1-2/C4-7', 'O1-2/C8+', 'O3+/C0-3', 'O3+/C4-7', 'O3+/C8+'];
console.log('행동 분포 % — 열:', CLS.join(' '));
for (const b of bands) {
    console.log('\n[' + b + ']');
    console.log('  사람      ', pct(hum.table, b));
    console.log('  봇(프로덕션)', pct(prod.table, b));
    console.log('  봇(현재코드)', pct(cur.table, b));
}
console.log('\n좌석: 사람', hum.seats, '| 봇(프로덕션)', prod.seats, '| 봇(현재코드)', cur.seats);
