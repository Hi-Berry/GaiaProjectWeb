/**
 * 사람 게임 피처 재구성기 (path 2 파이프라인의 빠진 톱니).
 *
 * 배경: 사용자는 배포사이트에서 1:3을 둠 → Supabase 저장 → fetchSupabaseGames로 data/human-games/*.json
 * (저널 + 최종맵 + 최종점수). 가치망 학습엔 "각 결정시점의 보드 스냅샷 → 최종VP" 쌍이 필요한데,
 * 그 중간 보드는 저장 안 됨. 이 스크립트가 저널을 처음부터 재생해 결정시점 상태를 복원하고,
 * 실제 evaluator가 쓰는 extractFeatures()로 피처를 뽑아(일관성 보장) data/human-features.jsonl을 만든다.
 *
 * 복원 방식:
 *  - 자원/연구/점수/기술타일/연방: 저널의 playerBefore/playerAfter 스냅샷에서 직접 읽음(재생 불필요).
 *  - 건물 수·보유행성·가이아행성: tileId + 액션키워드로 보드 점유를 누적 추적(살짝 재생).
 *  - 가이아포머/탑승우주선: 해당 액션 카운트.
 *  - 상대 대비 피처: 모든 플레이어의 최신 스냅샷 + 누적 보드로 계산.
 *
 * 실행: npx tsx scripts/reconstructHumanFeatures.ts [--validate]
 *   --validate: 기존 human-features.jsonl(이전 재구성기 결과)과 겹치는 게임의 피처를 대조만(쓰기 X).
 *   기본: data/human-games/* 전체 → data/human-features.jsonl 새로 씀(사람 결정만, bot:false).
 */
import fs from 'fs';
import path from 'path';
import { extractFeatures } from '../server/ai/features';

const GAMES_DIR = 'data/human-games';
const OUT = 'data/human-features.jsonl';
const VALIDATE = process.argv.includes('--validate');

type Snap = any;

/** 액션 → 건물 종류(없으면 null). 순서 중요(업글이 mine보다 먼저). */
function structOf(action: string): string | null {
    const a = action;
    if (/Academy/.test(a)) return 'academy';
    if (/Planetary Institute|\bPI\b|PI built|PI Federation/.test(a)) return 'planetary_institute';
    if (/Research Lab|→ Research Lab/.test(a)) return 'research_lab';
    if (/Trading Station|→ TS|Mine → TS/.test(a)) return 'trading_station';
    if (/Mine/.test(a)) return 'mine'; // Built Mine / on Asteroid / on Proto / Parasitic / Starting
    return null;
}
function isBoardTile(id?: string): boolean {
    return !!id && (/^tile-|^internal-|^bridge-/.test(id));
}

function buildBotMap(g: any): Record<string, boolean> {
    const m: Record<string, boolean> = {};
    for (const e of (g.fullGameLog || [])) if (e.playerId != null && e.isBot != null) m[e.playerId] = e.isBot;
    return m;
}

/** 스냅샷(summarizePlayer) → extractFeatures가 읽는 평면 플레이어 객체로. */
function flatPlayer(snap: Snap, gaiaformers: number, ships: number): any {
    const r = snap?.resources || {};
    return {
        name: snap?.name, faction: snap?.faction, score: snap?.score ?? 0,
        ore: r.ore ?? 0, credits: r.credits ?? 0, knowledge: r.knowledge ?? 0, qic: r.qic ?? 0,
        power1: r.power1 ?? 0, power2: r.power2 ?? 0, power3: r.power3 ?? 0, brainStoneBowl: 0,
        research: { ...(snap?.research || {}) },
        techTiles: [...(snap?.techTiles || [])],
        federations: snap?.federations || [],
        spaceshipsEntered: new Array(ships).fill(0),
        gaiaformers,
    };
}

const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
function parseTrack(detail: string): { track: string; lvl: number } | null {
    if (!detail) return null;
    const m = detail.match(new RegExp(`(${TRACKS.join('|')})\\D*?(\\d)`, 'i'));
    if (!m) return null;
    const track = TRACKS.find(t => t.toLowerCase() === m[1].toLowerCase());
    return track ? { track, lvl: Number(m[2]) } : null;
}
function parseVP(detail: string): number {
    if (!detail) return 0;
    const m = detail.match(/([+-]?\d+)\s*VP/);
    return m ? Number(m[1]) : 0;
}

function reconstructGame(g: any, fname: string): { y: number; g: string; round: number; bot: boolean; f: number[] }[] {
    const out: any[] = [];
    const tileType: Record<string, string> = {};
    for (const t of (g.map || [])) if (t.id) tileType[t.id] = t.type;
    const finalScore: Record<string, number> = {};
    for (const id of Object.keys(g.players || {})) finalScore[id] = g.players[id]?.score ?? 0;

    // ★actionJournal은 (봇 제외) 사람 액션만 기록 → 거기 playerId는 전부 사람. (옛 포맷은 fullGameLog가 비어도 여기엔 다 있음.)
    const decisions = [...(g.actionJournal || [])].filter(e => e.playerBefore)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    if (decisions.length === 0) return out;
    const humanIds = new Set(decisions.map(e => e.playerId));

    // 상대(=actionJournal에 없는 플레이어=봇) 보드/연구/VP는 fullGameLog로 추적. (있을 때만; 옛 포맷은 비어 상대피처 0.)
    const flog = [...(g.fullGameLog || [])].filter(e => e.playerId && !humanIds.has(e.playerId))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    const liveMap = new Map<string, { ownerId: string; structure: string; type?: string }>();
    const research: Record<string, Record<string, number>> = {};
    const scoreEst: Record<string, number> = {};
    const gf: Record<string, number> = {};
    const ships: Record<string, number> = {};
    let fp = 0;

    function applyEvent(e: any, trackResearchVP: boolean) {
        const pid = e.playerId; if (!pid) return;
        const st = structOf(e.action || '');
        if (st && isBoardTile(e.tileId)) liveMap.set(e.tileId, { ownerId: pid, structure: st, type: tileType[e.tileId] });
        if (/Placed Gaiaformer/.test(e.action || '')) gf[pid] = (gf[pid] || 0) + 1;
        else if (/Gaiaformer Returned/.test(e.action || '')) gf[pid] = Math.max(0, (gf[pid] || 0) - 1);
        if (/Entered Ship/.test(e.action || '')) ships[pid] = (ships[pid] || 0) + 1;
        if (trackResearchVP) { // 상대만: 연구/점수는 스냅샷이 없어 로그에서 추정
            const tr = (e.action || '').includes('Research') || (e.action || '').includes('Tech') ? parseTrack(e.details || '') : null;
            if (tr) { (research[pid] = research[pid] || {})[tr.track] = Math.max(research[pid][tr.track] || 0, tr.lvl); }
            scoreEst[pid] = (scoreEst[pid] || 0) + parseVP(e.details || '');
        }
    }

    for (const d of decisions) {
        const ts = d.timestamp ?? 0;
        while (fp < flog.length && (flog[fp].timestamp ?? 0) <= ts) applyEvent(flog[fp++], true); // 상대 진행

        const hid = d.playerId;
        const players: Record<string, any> = {};
        // 사람: 자원/연구/점수/기술타일/연방은 정확한 스냅샷, 본인 구조물은 actionJournal 빌드로 누적한 liveMap.
        players[hid] = flatPlayer(d.playerBefore, gf[hid] || 0, ships[hid] || 0);
        // 상대: fullGameLog 추적(없으면 빈값 → 상대대비 4피처만 근사). techTiles/federations는 상대피처에 안 쓰임.
        for (const oid of Object.keys(g.players || {})) {
            if (oid === hid || humanIds.has(oid)) continue;
            players[oid] = { faction: g.players[oid]?.faction, score: scoreEst[oid] || 0, research: research[oid] || {}, techTiles: [], federations: [], spaceshipsEntered: [], gaiaformers: gf[oid] || 0 };
        }
        const pg = { players, map: Array.from(liveMap.values()), roundNumber: d.round ?? 0 } as any;
        out.push({ y: finalScore[hid] ?? 0, g: fname, round: d.round ?? 0, bot: false, f: extractFeatures(pg, hid) });

        // 사람 본인 빌드/가이아포머/우주선을 액션 적용(연구/VP는 스냅샷에서 오므로 추적 안 함).
        applyEvent(d, false);
    }
    return out;
}

// === 메인 ===
const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
let allRows: any[] = [];
const perGameCount: Record<string, number> = {};
for (const f of files) {
    let g: any; try { g = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8')); } catch { continue; }
    const rows = reconstructGame(g, f);
    perGameCount[f] = rows.length;
    allRows = allRows.concat(rows);
}
console.log(`재구성: 게임 ${files.length}개 → 사람 결정샘플 ${allRows.length}`);

if (VALIDATE) {
    // 기존 human-features.jsonl과 겹치는 게임 비교(평균 피처 차이)
    const ref: Record<string, { sum: number[]; n: number }> = {};
    if (fs.existsSync(OUT)) {
        for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
            if (!line.trim()) continue; let r: any; try { r = JSON.parse(line); } catch { continue; }
            if (!Array.isArray(r.f)) continue;
            const a = ref[r.g] || (ref[r.g] = { sum: new Array(r.f.length).fill(0), n: 0 });
            for (let i = 0; i < r.f.length; i++) a.sum[i] += r.f[i]; a.n++;
        }
    }
    const mine: Record<string, { sum: number[]; n: number }> = {};
    for (const r of allRows) { const a = mine[r.g] || (mine[r.g] = { sum: new Array(r.f.length).fill(0), n: 0 }); for (let i = 0; i < r.f.length; i++) a.sum[i] += r.f[i]; a.n++; }
    const common = Object.keys(mine).filter(k => ref[k]);
    console.log(`\n[검증] 겹치는 게임 ${common.length}개 — 게임별 평균피처 L1거리(작을수록 일치):`);
    let totalDist = 0;
    for (const k of common) {
        let d = 0; for (let i = 0; i < mine[k].sum.length; i++) d += Math.abs(mine[k].sum[i] / mine[k].n - ref[k].sum[i] / ref[k].n);
        totalDist += d;
        console.log(`  ${k}: 샘플 내${mine[k].n}/정답${ref[k].n} | L1=${d.toFixed(2)}`);
    }
    if (common.length) console.log(`\n평균 L1거리/게임: ${(totalDist / common.length).toFixed(2)} (33피처 합산; <2면 양호)`);
} else {
    fs.writeFileSync(OUT, allRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log(`저장: ${OUT}`);
    const games = new Set(allRows.map(r => r.g));
    console.log(`게임 ${games.size}개, ${allRows.length}샘플 기록.`);
}
