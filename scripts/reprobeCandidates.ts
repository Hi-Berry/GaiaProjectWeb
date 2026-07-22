/**
 * 리프로브(re-probe): 사람 게임 저널의 각 결정 시점 상태를 재구성해 **현재 봇 코드**의
 * getCandidateMoves를 다시 돌리고, 사람이 실제 둔 수가 오늘 코드의 후보에 있는지 판정한다.
 *
 * 왜: 저널에 저장된 후보(e.candidates)는 그 게임 당시 코드가 만든 것 — 이후 채택(acadGateOpen 등)으로
 * 이미 닫힌 갭과 아직 남은 갭이 섞여 있다. 리프로브는 "지금 코드 기준 진짜 갭 랭킹"을 준다.
 *
 * 신뢰 클래스(판정 대상): build_mine(소행성/기생 포함) · upgrade_structure · advance_research.
 * 제외(재구성 불가/저신뢰): form_federation(연방 헥스 미복원) · 우주선/파워액션/특수액션(사용상태 미복원).
 *
 * 재구성 소스:
 *  - 보드: 최종 map을 소유/구조물/포머/기생 제거 후 fullGameLog를 결정 시점까지 재생(대칭 정보).
 *  - 플레이어: actionJournal의 playerBefore 스냅샷(자원/연구/기술타일/연방/부스터) — 결정 직전 상태 그대로.
 *  - 가이아포머 가용수: 연구레벨 부여분 − 배치중(재생 추적) 근사 → 소행성 클래스는 중신뢰로 별도 표기.
 *
 * 실행: npx tsx scripts/reprobeCandidates.ts [--details]
 */
import fs from 'fs';
import { BotLogic } from '../server/ai/bot';
import { setPlayerVariant } from '../server/ai/variant';
import { INITIAL_POWER_ACTIONS } from '../shared/gameConfig';

// --flags '{"x":true}' : 모든 프로브 플레이어에 플래그 적용 후 재채점 (수정 전/후 갭 비교용)
const flagArgIdx = process.argv.indexOf('--flags');
const PROBE_FLAGS: Record<string, boolean | number> | null = flagArgIdx > 0 ? JSON.parse(process.argv[flagArgIdx + 1]) : null;

const DIR = 'data/human-games';
const DETAILS = process.argv.includes('--details');

type Any = any;

// 가이아 연구 레벨별 포머 부여 수 (shared config 기준: L1=1, L2=2, L3=3, L4=3, L5=4 근사)
const FORMERS_BY_LEVEL = [0, 1, 2, 3, 3, 4];

/** fullGameLog 이벤트 → 보드 상태 반영 */
function applyEvent(map: Map<string, Any>, formersActive: Record<string, Set<string>>, e: Any) {
    const tid = e.tileId; if (!tid) return;
    const a = e.action || '';
    const t = map.get(tid); if (!t) return;
    const pid = e.playerId;
    if (/Built Parasitic Mine|Parasitic Mine/i.test(a)) { t.parasiticMine = { ownerId: pid }; return; }
    if (/Placed Starting Mine|Built Mine|Placed Mine|Eclipse: Built mine/i.test(a)) {
        t.ownerId = pid; t.structure = 'mine';
        if (t.hasGaiaformer) { t.hasGaiaformer = false; t.gaiaformerOwnerId = null; formersActive[pid]?.delete(tid); }
        if (t.type === 'transdim') t.type = 'gaia'; // 포머 완성 후 건설
        return;
    }
    if (/Upgraded to Trading/i.test(a)) { t.ownerId = pid; t.structure = 'trading_station'; return; }
    if (/Upgraded to Research Lab/i.test(a)) { t.ownerId = pid; t.structure = 'research_lab'; return; }
    if (/Upgraded to Academy/i.test(a)) { t.ownerId = pid; t.structure = 'academy'; return; }
    if (/Upgraded to Planetary Institute/i.test(a)) { t.ownerId = pid; t.structure = 'planetary_institute'; return; }
    if (/Placed Gaiaformer/i.test(a)) {
        t.hasGaiaformer = true; t.gaiaformerOwnerId = pid;
        (formersActive[pid] = formersActive[pid] || new Set()).add(tid);
        return;
    }
    if (/Lost Planet/i.test(a)) { t.ownerId = pid; t.structure = 'lost_planet_mine'; return; }
    if (/Space Station/i.test(a)) { t.spaceStation = { ownerId: pid }; return; }
}

/** playerBefore 스냅샷(또는 최종 플레이어 객체) → getCandidateMoves가 읽는 플레이어 객체 */
function buildPlayer(pid: string, snap: Any, gaiaformers: number): Any {
    // 저널 스냅샷은 resources 중첩, 최종 players는 평면 — 둘 다 수용
    const r = snap?.resources || snap || {};
    return {
        id: pid, name: snap?.name ?? pid, faction: snap?.faction, score: snap?.score ?? 0,
        ore: r.ore ?? 0, credits: r.credits ?? 0, knowledge: r.knowledge ?? 0, qic: r.qic ?? 0,
        power1: r.power1 ?? 0, power2: r.power2 ?? 0, power3: r.power3 ?? 0,
        brainStoneBowl: snap?.faction === 'taklons' ? 2 : null,
        research: { ...(snap?.research || {}) },
        techTiles: [...(snap?.techTiles || [])], coveredTechTiles: [],
        federations: (snap?.federations || []).map((f: Any) => (typeof f === 'object' ? f : { rewardId: String(f) })),
        bonusTile: snap?.bonusTile, usedBonusAction: false,
        gaiaformers, spaceshipsEntered: [], pendingGaiaformerTiles: [],
        hasPassed: false, navigationBonus: 0,
    };
}

/** 사람 액션 → 오늘 코드 후보 리스트에서의 매칭 (신뢰 클래스만; null=대상 아님) */
function matchNow(e: Any, cands: Any[], geom: Map<string, Any>): { cls: string, hit: boolean } | null {
    const a = e.action || '', d = e.details || '', tid = e.tileId;
    const p = (c: Any) => c.params || {};
    if (/^Built Mine$|^Placed Mine|^Built Mine on/i.test(a)) {
        const isAst = (geom.get(tid) || {}).type === 'asteroid' || /Asteroid/i.test(a);
        return { cls: isAst ? 'asteroid_mine' : 'build_mine', hit: cands.some(c => c.type === 'build_mine' && p(c).tileId === tid) };
    }
    if (/^Built Parasitic Mine/i.test(a)) {
        return { cls: 'parasitic_mine', hit: cands.some(c => c.type === 'build_mine' && p(c).tileId === tid) };
    }
    if (/^Upgraded to Trading/i.test(a)) return { cls: 'upgrade_ts', hit: cands.some(c => c.type === 'upgrade_structure' && p(c).target === 'trading_station' && p(c).tileId === tid) };
    if (/^Upgraded to Research Lab/i.test(a)) return { cls: 'upgrade_lab', hit: cands.some(c => c.type === 'upgrade_structure' && p(c).target === 'research_lab' && p(c).tileId === tid) };
    if (/^Upgraded to Academy/i.test(a)) return { cls: 'upgrade_academy', hit: cands.some(c => c.type === 'upgrade_structure' && String(p(c).target || '').startsWith('academy') && p(c).tileId === tid) };
    if (/^Upgraded to Planetary Institute/i.test(a)) return { cls: 'upgrade_pi', hit: cands.some(c => c.type === 'upgrade_structure' && p(c).target === 'planetary_institute' && p(c).tileId === tid) };
    if (/^Advanced Research/i.test(a)) {
        const m = /^(\w+) to level/i.exec(d); if (!m) return null;
        const tr = m[1];
        return { cls: 'advance_research', hit: cands.some(c => c.type === 'advance_research' && String(p(c).trackId || '').toLowerCase() === tr.toLowerCase()) };
    }
    return null;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const stat: Record<string, { total: number, hit: number, samples: string[] }> = {};
const calib: Record<string, { both: number, liveOnly: number, nowOnly: number, neither: number }> = {};
const astWhy: Record<string, number> = {};
const astSamples: Record<string, string[]> = {};
const piWhy: Record<string, number> = {};
const piSamples: Record<string, string[]> = {};
const acadWhy: Record<string, number> = {};
const acadSamples: Record<string, string[]> = {};
const tsWhy: Record<string, number> = {};
const tsSamples: Record<string, string[]> = {};
let decisions = 0, errors = 0;

for (const f of files) {
    let g: Any; try { g = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); } catch { continue; }
    if (!Array.isArray(g.map) || !g.map.length || !Array.isArray(g.actionJournal)) continue;

    // 보드 초기화: 최종 맵에서 점유 정보 제거
    const map: Any[] = g.map.map((t: Any) => ({
        ...t, ownerId: null, structure: null, parasiticMine: null,
        hasGaiaformer: false, gaiaformerOwnerId: null, spaceStation: null,
    }));
    const byId = new Map<string, Any>(map.map((t: Any) => [t.id, t]));
    const formersActive: Record<string, Set<string>> = {};

    const fl = [...(g.fullGameLog || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const journal = (g.actionJournal || []).filter((e: Any) => e.timestamp != null).sort((a: Any, b: Any) => a.timestamp - b.timestamp);

    // 스냅샷 최신본 추적 (상대 포함) — 초기값은 최종 players(상대 자원은 내 후보 존재에 거의 무영향, 존재 자체가 중요)
    const lastSnap: Record<string, Any> = {};
    for (const [id, p] of Object.entries(g.players || {})) lastSnap[id] = p;
    let fi = 0;
    for (const e of journal) {
        while (fi < fl.length && (fl[fi].timestamp || 0) < e.timestamp) { applyEvent(byId, formersActive, fl[fi]); fi++; }
        if (e.playerBefore) lastSnap[e.playerId] = e.playerBefore;
        if (!e.candidates || e.candidates.length < 2) continue; // 사람 결정 시점만(캡처 존재 = 사람)
        const probe = matchNow(e, [], byId); // 클래스 판별만 먼저
        if (!probe) continue;
        decisions++;

        // 게임 상태 조립
        const pid = e.playerId;
        const players: Record<string, Any> = {};
        for (const [id, s] of Object.entries(lastSnap)) {
            const gl = (s as Any)?.research?.gaiaProject ?? 0;
            const placed = formersActive[id]?.size ?? 0;
            players[id] = buildPlayer(id, s, Math.max(0, FORMERS_BY_LEVEL[Math.min(gl, 5)] - placed));
        }
        if (!players[pid]) continue;
        const turnOrder = Object.keys(players);
        const game: Any = {
            id: `reprobe-${f}`, simulation: true,
            map, players, turnOrder, currentPlayerIndex: turnOrder.indexOf(pid),
            roundNumber: e.round ?? 1, currentPhase: 'main', hasDoneMainAction: false,
            botPlayerIds: [], gameLog: [], passingOrder: [],
            // 슬림 저장이라 게임설정 필드 부재 — 파워액션은 표준 셋 합성(삽 콤보 후보 재현 필수), 나머지는 안전 기본값
            powerActions: (g.powerActions || INITIAL_POWER_ACTIONS).map((x: Any) => ({ ...x, isUsed: false })),
            techTilesByTrack: g.techTilesByTrack || {}, advancedTechTilesByTrack: g.advancedTechTilesByTrack || {},
            techTilesPool: g.techTilesPool || [], finalMissionIds: g.finalMissionIds || [],
            roundMissions: g.roundMissions || [], roundScoringTiles: g.roundScoringTiles || [],
            spaceships: {}, twilightArtifactSlots: [], satellites: {},
            playerFederationHexes: {}, availableBonusTiles: g.availableBonusTiles || [],
            federationPool: g.federationPool || {},
        };
        if (PROBE_FLAGS) setPlayerVariant(pid, { flags: PROBE_FLAGS });
        let cands: Any[] = [];
        try { cands = BotLogic.getCandidateMoves(game, pid) as Any[]; } catch (err) {
            errors++;
            if (errors <= 5) console.log(`[ERR${errors}] ${f} R${e.round} ${e.action}: ${(err as Error)?.stack?.split('\n').slice(0, 3).join(' | ')}`);
            continue;
        }
        if (decisions <= 3) console.log(`[DBG] ${f} R${e.round} ${e.action} → 후보 ${cands.length}개: ${[...new Set(cands.map((c: Any) => c.type))].join(',')}`);
        const res = matchNow(e, cands, byId)!;
        // 캘리브레이션: 라이브 캡처(e.candidates, 당시 코드) 판정과 비교 — 리프로브 재구성 충실도 측정.
        // 라이브 후보는 params가 평면일 수 있어 두 형태 모두 수용.
        const liveCands = (e.candidates || []).map((c: Any) => ({ type: c.type, params: c.params || c }));
        const live = matchNow(e, liveCands, byId)!;
        const cal = (calib[res.cls] = calib[res.cls] || { both: 0, liveOnly: 0, nowOnly: 0, neither: 0 });
        if (live.hit && res.hit) cal.both++;
        else if (live.hit && !res.hit) cal.liveOnly++; // 라이브는 커버였는데 리프로브가 갭 = 재구성 누락(위양성 갭)
        else if (!live.hit && res.hit) cal.nowOnly++;  // 당시 갭 → 오늘 커버 = 그동안의 채택이 닫은 갭
        else cal.neither++;
        const s = (stat[res.cls] = stat[res.cls] || { total: 0, hit: 0, samples: [] });
        s.total++; if (res.hit) s.hit++;
        // PI/아카데미 갭 원인 분류 (라이브 갭 ∧ 리프로브 갭)
        if ((res.cls === 'upgrade_pi' || res.cls === 'upgrade_academy') && !res.hit && !live.hit) {
            const me = players[pid];
            const isPi = res.cls === 'upgrade_pi';
            const mineCnt = map.filter((t: Any) => t.ownerId === pid && (t.structure === 'mine' || t.structure === 'lost_planet_mine')).length;
            const needO = isPi ? 4 : 6, needC = 6;
            const anySame = cands.some((c: Any) => c.type === 'upgrade_structure' && (isPi ? (c.params || c).target === 'planetary_institute' : String((c.params || c).target || '').startsWith('academy')));
            const r = e.round ?? 1;
            const why =
                anySame ? '동종 후보 있음(타일 차이)' :
                (me.ore ?? 0) < needO || (me.credits ?? 0) < needC ? `자원 부족(${needO}O${needC}C)` :
                isPi && r < 4 ? `R${r}<4 종족 게이트` :
                !isPi && r <= 3 && mineCnt < 3 ? `R≤3 광산${mineCnt}<3 게이트` :
                `기타(R${r} 광산${mineCnt})`;
            const W = isPi ? piWhy : acadWhy;
            W[why] = (W[why] || 0) + 1;
            const S = isPi ? piSamples : acadSamples;
            if ((S[why] = S[why] || []).length < 3) S[why].push(`R${r} ${me.faction} 광산${mineCnt} O${me.ore}C${me.credits}`);
        }
        // TS 갭 원인 분류 (라이브 갭 ∧ 리프로브 갭) — 신뢰클래스(위양성 22%) 최대 갭(103게임 213건)의 레버 발굴용
        if (res.cls === 'upgrade_ts' && !res.hit && !live.hit) {
            const me = players[pid];
            const tile = byId.get(e.tileId);
            const r = e.round ?? 1;
            const mineCnt = map.filter((t: Any) => t.ownerId === pid && (t.structure === 'mine' || t.structure === 'lost_planet_mine')).length;
            const tsCnt = map.filter((t: Any) => t.ownerId === pid && t.structure === 'trading_station').length;
            const hexDist = (a: Any, b: Any) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
            // 할인 여부 근사: 상대 건물/기생광산 2칸 이내 (서버 hasNearbyPlayersForDiscount와 동일 기준)
            const discounted = !!tile && map.some((t: Any) =>
                ((t.ownerId && t.ownerId !== pid && t.structure && t.structure !== 'ship') || (t.parasiticMine && t.parasiticMine.ownerId !== pid))
                && hexDist(t, tile) <= 2);
            const needC = discounted ? 3 : 6;
            const anySameTs = cands.some((c: Any) => c.type === 'upgrade_structure' && (c.params || c).target === 'trading_station');
            const mineIsMine = !!tile && tile.ownerId === pid && tile.structure === 'mine';
            const why =
                tsCnt >= 4 ? 'TS 한도(4)' :
                !mineIsMine ? '재구성 불일치(그 타일이 내 광산 아님)' :
                ((me.ore ?? 0) < 2 || (me.credits ?? 0) < needC) ? `자원 부족(2O${needC}C)` :
                anySameTs ? '동종 후보 있음(타일 차이)' :
                `기타(R${r} 광산${mineCnt} TS${tsCnt})`;
            tsWhy[why] = (tsWhy[why] || 0) + 1;
            if ((tsSamples[why] = tsSamples[why] || []).length < 4) tsSamples[why].push(`R${r} ${me.faction} 광산${mineCnt} TS${tsCnt} O${me.ore}C${me.credits}${discounted ? ' 할인' : ''}`);
        }
        // 소행성 갭 원인 분류 (라이브 갭 ∧ 리프로브 갭 = 고신뢰 케이스만)
        if (res.cls === 'asteroid_mine' && !res.hit && !live.hit) {
            const me = players[pid];
            const tile = byId.get(e.tileId);
            const myPl = map.filter((t: Any) => t.ownerId === pid && t.structure);
            const hexDist = (a: Any, b: Any) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
            const dist = (tile && myPl.length) ? Math.min(...myPl.map((p: Any) => hexDist(p, tile))) : 99;
            const navLvl = me.research?.navigation ?? 0;
            const range = [1, 1, 2, 2, 3, 4, 4][Math.min(navLvl, 6)] ?? 1; // getRange 근사
            const needQic = Math.max(0, Math.ceil((dist - range) / 2));
            const anyAstCand = cands.some((c: Any) => byId.get((c.params || c).tileId)?.type === 'asteroid' && c.type === 'build_mine');
            const why =
                anyAstCand ? '소행성 후보 있음(다른 타일) = 타일 선택 차이' :
                me.gaiaformers < 1 ? '포머 0(근사)' :
                (me.ore ?? 0) < 1 || (me.credits ?? 0) < 2 ? '자원 부족(1O2C)' :
                needQic > (me.qic ?? 0) ? `QIC 부족(필요${needQic} 보유${me.qic})` :
                needQic > 1 && (e.round ?? 1) <= 4 ? 'R≤4 2Q+ 원거리 게이트' :
                cands.some((c: Any) => c.type === 'build_mine') ? '다른 광산은 후보 = 탑N/점수컷' : '광산 후보 0(기타 게이트)';
            astWhy[why] = (astWhy[why] || 0) + 1;
            if ((astSamples[why] = astSamples[why] || []).length < 3) astSamples[why].push(`R${e.round} ${me.faction} d${dist} nav${navLvl} gf${me.gaiaformers} O${me.ore}C${me.credits}Q${me.qic}`);
        }
        else if (s.samples.length < 8) {
            const tile = byId.get(e.tileId) || {};
            const r = (e.playerBefore || {}).resources || {};
            s.samples.push(`R${e.round} ${e.action} tile:${tile.type ?? '?'} O${r.ore}C${r.credits}K${r.knowledge}Q${r.qic} 후보${cands.length}(${[...new Set(cands.map((c: Any) => c.type))].slice(0, 5).join('/')})`);
        }
    }
}

console.log(`리프로브 결정 ${decisions} | 상태조립 오류 ${errors}`);
console.log('\n클래스별 (오늘 코드 기준):');
for (const [k, v] of Object.entries(stat).sort((a, b) => (b[1].total - b[1].hit) - (a[1].total - a[1].hit))) {
    const gap = v.total - v.hit;
    console.log(`  ${k.padEnd(16)} 총 ${String(v.total).padStart(4)} | 커버 ${String(v.hit).padStart(4)} | ★갭 ${String(gap).padStart(4)} (${(gap / Math.max(1, v.total) * 100).toFixed(1)}%)`);
    if (DETAILS) v.samples.forEach(s => console.log('      ·', s));
}
console.log('\n캘리브레이션 (라이브캡처=당시코드 vs 리프로브=오늘코드):');
console.log('  liveOnly(당시커버→리프로브갭) = 재구성 위양성 의심 | nowOnly(당시갭→오늘커버) = 채택이 닫은 갭');
for (const [k, v] of Object.entries(calib)) {
    const falsePos = v.liveOnly / Math.max(1, v.both + v.liveOnly);
    console.log(`  ${k.padEnd(16)} both ${String(v.both).padStart(4)} | liveOnly ${String(v.liveOnly).padStart(4)} (위양성률 ${(falsePos * 100).toFixed(0)}%) | nowOnly ${String(v.nowOnly).padStart(3)} | neither ${String(v.neither).padStart(4)}`);
}
console.log('\n소행성 갭 원인 (라이브∧리프로브 교집합):');
for (const [k, v] of Object.entries(astWhy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
    (astSamples[k] || []).forEach(sm => console.log('     ·', sm));
}
for (const [nm, W, S] of [['PI', piWhy, piSamples], ['아카데미', acadWhy, acadSamples], ['TS', tsWhy, tsSamples]] as Array<[string, Record<string, number>, Record<string, string[]>]>) {
    console.log(`\n${nm} 갭 원인 (라이브∧리프로브 교집합):`);
    for (const [k, v] of Object.entries(W).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
        (S[k] || []).forEach(sm => console.log('     ·', sm));
    }
}
console.log('\n주의: asteroid/gaia 관련은 포머 재구성 근사(중신뢰). form_federation/우주선/파워액션은 판정 제외.');
process.exit(0); // index.ts 순환 임포트로 HTTP 서버가 떠 있어 명시 종료 필요
