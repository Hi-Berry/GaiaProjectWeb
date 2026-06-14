/**
 * 경량 Forward Model — B1~B4: income 적용 + 빠른 전이/정책 + 종료점수 + 다턴 롤아웃.
 * 설계: FORWARD_MODEL_DESIGN.md. SimState(simModel.ts) 위에서 진짜 엔진 없이 R6까지 빠르게 굴린다.
 *
 * 정확도보다 '엔진→VP 인과 방향 + 상대 ordering'이 목적(search용). 우주선/고급타일/종족특능은 coarse/생략.
 */
import type { SimState, SimPlayer } from './simModel';
import { STRUCTURE_INCOME, ECONOMY_INCOME_POWER, getTerraformCost } from '@shared/gameConfig';

// ---------- 복제 (flat, 싸게) ----------
function clonePlayer(p: SimPlayer): SimPlayer {
    return { ...p, research: p.research.slice(), clusterPowers: p.clusterPowers.slice(),
        reachableSlots: { ...p.reachableSlots }, income: { ...p.income }, artifacts: p.artifacts };
}
export function cloneSimState(s: SimState): SimState {
    return { round: s.round, meId: s.meId, powerActionsAvail: s.powerActionsAvail, players: s.players.map(clonePlayer) };
}

// ---------- B1: income ----------
function chargePower(p: SimPlayer, amt: number) {
    let c = Math.min(p.p1, amt); p.p1 -= c; p.p2 += c; amt -= c;
    c = Math.min(p.p2, amt); p.p2 -= c; p.p3 += c;
}
function applyIncome(p: SimPlayer) {
    p.ore += p.income.ore; p.credits += p.income.credits; p.knowledge += p.income.knowledge; p.qic += p.income.qic;
    p.p1 += p.income.powerTokens;
    chargePower(p, p.income.powerCharge);
}
const mineInc = (n: number) => n < STRUCTURE_INCOME.mine.length ? STRUCTURE_INCOME.mine[n] : 0;          // (n+1)번째 광산 ore income
const tsInc = (n: number) => n < STRUCTURE_INCOME.trading_station.length ? STRUCTURE_INCOME.trading_station[n] : 0;

// ---------- B2: 전이 ----------
type SimAction =
    | { t: 'fed' } | { t: 'mine' } | { t: 'pass' }
    | { t: 'up'; k: 'ts' | 'lab' | 'pi' | 'academy' }
    | { t: 'res'; track: number };

function cheapestSlot(p: SimPlayer): 's0' | 's1' | 's2' | null {
    if (p.reachableSlots.s0 > 0) return 's0';
    if (p.reachableSlots.s1 > 0) return 's1';
    if (p.reachableSlots.s2 > 0) return 's2';
    return null;
}
/** 새 파워값을 7미만 최대 클러스터에 더해 7도달 유도; 없으면 새 클러스터. */
function addToCluster(p: SimPlayer, power: number) {
    let bestIdx = -1, bestVal = -1;
    for (let i = 0; i < p.clusterPowers.length; i++) {
        if (p.clusterPowers[i] < 7 && p.clusterPowers[i] > bestVal) { bestVal = p.clusterPowers[i]; bestIdx = i; }
    }
    if (bestIdx >= 0) p.clusterPowers[bestIdx] += power;
    else p.clusterPowers.push(power);
    p.clusterPowers.sort((a, b) => b - a);
}

function canDo(p: SimPlayer, a: SimAction): boolean {
    switch (a.t) {
        case 'mine': {
            const slot = cheapestSlot(p); if (!slot) return false;
            const tf = getTerraformCost(p.research[0] || 0);
            const oreCost = 1 + (slot === 's1' ? tf : slot === 's2' ? tf * 2 : 0);
            return p.ore >= oreCost && p.credits >= 2;
        }
        case 'up': {
            if (a.k === 'ts') return p.mines >= 1 && p.ore >= 2 && p.credits >= 3;
            if (a.k === 'lab') return p.ts >= 1 && p.ore >= 3 && p.credits >= 5;
            if (a.k === 'pi') return p.ts >= 1 && p.pi < 1 && p.ore >= 4 && p.credits >= 6;
            if (a.k === 'academy') return p.labs >= 1 && p.ore >= 6 && p.credits >= 6;
            return false;
        }
        case 'res': {
            const lvl = p.research[a.track] || 0;
            if (lvl >= 5) return false;
            if (lvl === 4 && p.feds < 1) return false; // L5는 초록연방 필요(근사: 연방 보유)
            return p.knowledge >= 4;
        }
        case 'fed': return p.clusterPowers.some(c => c >= 7);
        case 'pass': return true;
    }
}

function apply(p: SimPlayer, a: SimAction) {
    switch (a.t) {
        case 'mine': {
            const slot = cheapestSlot(p)!;
            const tf = getTerraformCost(p.research[0] || 0);
            const oreCost = 1 + (slot === 's1' ? tf : slot === 's2' ? tf * 2 : 0);
            p.ore -= oreCost; p.credits -= 2;
            p.reachableSlots[slot]--;
            p.income.ore += mineInc(p.mines);
            p.mines++;
            addToCluster(p, 1);
            p.score += 2; // 라운드점수 근사
            break;
        }
        case 'up': {
            if (a.k === 'ts') { p.ore -= 2; p.credits -= 3; p.mines--; p.ts++; p.income.ore -= mineInc(p.mines); p.income.credits += tsInc(p.ts - 1); addClusterUp(p, 1); p.score += 3; }
            else if (a.k === 'lab') { p.ore -= 3; p.credits -= 5; p.ts--; p.labs++; p.income.credits -= tsInc(p.ts); p.income.knowledge += 1; addClusterUp(p, 0); p.score += 3; }
            else if (a.k === 'pi') { p.ore -= 4; p.credits -= 6; p.ts--; p.pi++; p.income.credits -= tsInc(p.ts); p.income.powerCharge += 4; addClusterUp(p, 1); p.score += 4; }
            else if (a.k === 'academy') { p.ore -= 6; p.credits -= 6; p.labs--; p.academies++; p.income.knowledge += 2; addClusterUp(p, 1); p.score += 5; }
            break;
        }
        case 'res': {
            p.knowledge -= 4; p.research[a.track]++;
            const lvl = p.research[a.track];
            if (a.track === 4 && lvl < 5) { const ei = ECONOMY_INCOME_POWER[lvl] || ECONOMY_INCOME_POWER[0]; p.income.credits += (ei.credits || 0); p.income.ore += (ei.ore || 0); }
            if (a.track === 5 && lvl < 5) p.income.knowledge += 1; // 과학
            if (lvl === 5) p.score += 8;       // L5 보상 근사
            else if (lvl >= 3) p.score += 1;
            break;
        }
        case 'fed': {
            const i = p.clusterPowers.findIndex(c => c >= 7);
            if (i >= 0) p.clusterPowers.splice(i, 1);
            p.feds++; p.score += 7;            // 연방 보상 근사(VP)
            p.knowledge += 2; p.credits += 2;  // 토큰/자원 보상 근사
            break;
        }
        case 'pass': {
            p.score += 2; p.passed = true;     // 패스 보너스 근사
            break;
        }
    }
}
/** 업그레이드로 클러스터 파워 증가분 반영(연방 클러스터로 빠진 건 무시 근사). */
function addClusterUp(p: SimPlayer, delta: number) {
    if (delta <= 0) return;
    let bestIdx = -1, bestVal = -1;
    for (let i = 0; i < p.clusterPowers.length; i++) if (p.clusterPowers[i] < 7 && p.clusterPowers[i] > bestVal) { bestVal = p.clusterPowers[i]; bestIdx = i; }
    if (bestIdx >= 0) { p.clusterPowers[bestIdx] += delta; p.clusterPowers.sort((a, b) => b - a); }
}

// ---------- 빠른 정책 (playout policy) ----------
function fastPolicy(p: SimPlayer, round: number): SimAction {
    if (canDo(p, { t: 'fed' })) return { t: 'fed' };                                    // 연방 최우선
    // 연구: 지식 남으면 economy(4)·terraforming(0) 우선, 그다음 nav(1)/gaia(3)
    if (p.knowledge >= 8) { for (const tr of [4, 0, 1, 3, 5]) if (canDo(p, { t: 'res', track: tr })) return { t: 'res', track: tr }; }
    // 확장: 광산 (엔진 키우기)
    if (canDo(p, { t: 'mine' })) return { t: 'mine' };
    // 업그레이드: 클러스터 7 근처면 TS/lab으로 밀기 / income
    if (p.mines >= 2 && canDo(p, { t: 'up', k: 'ts' })) return { t: 'up', k: 'ts' };
    if (canDo(p, { t: 'up', k: 'lab' })) return { t: 'up', k: 'lab' };
    if (canDo(p, { t: 'up', k: 'pi' })) return { t: 'up', k: 'pi' };
    if (p.knowledge >= 4) { for (const tr of [4, 0, 1]) if (canDo(p, { t: 'res', track: tr })) return { t: 'res', track: tr }; }
    return { t: 'pass' };
}

// ---------- B3: 종료점수 ----------
export function terminalScore(p: SimPlayer): number {
    let vp = p.score;
    vp += Math.floor((p.ore + p.credits + p.knowledge + p.qic + p.p3) / 3); // 잔여자원
    vp += p.research.reduce((a, b) => a + b, 0) * 1.2;                        // 연구 VP 근사
    vp += p.feds * 4;                                                        // 연방(토큰VP+가치)
    vp += p.mines + p.ts * 1.5 + p.labs * 1.5 + p.pi * 2 + p.academies * 2;   // 구조물/최종미션 근사
    return vp;
}

// ---------- B4: 다턴 롤아웃 ----------
/** SimState를 R6까지 fast정책으로 굴려 (내 종료점수 - 최고 상대 종료점수) 반환. */
export function simRollout(state: SimState): number {
    const s = cloneSimState(state);
    for (let round = s.round; round <= 6; round++) {
        for (const p of s.players) p.passed = false;
        let steps = 0;
        while (steps < 80) {
            let acted = false;
            for (const p of s.players) {
                if (p.passed) continue;
                const a = fastPolicy(p, round);
                apply(p, a);
                acted = true; steps++;
            }
            if (!acted) break;
            if (s.players.every(p => p.passed)) break;
        }
        if (round < 6) for (const p of s.players) applyIncome(p);
    }
    const scores = s.players.map(terminalScore);
    const meIdx = s.players.findIndex(p => p.id === s.meId);
    const me = scores[meIdx];
    const opp = scores.filter((_, i) => i !== meIdx);
    const bestOpp = opp.length ? Math.max(...opp) : 0;
    return me - bestOpp;
}

/** 절대 종료점수(검증·디버그용). */
export function simRolloutAbsoluteScores(state: SimState): number[] {
    const s = cloneSimState(state);
    for (let round = s.round; round <= 6; round++) {
        for (const p of s.players) p.passed = false;
        let steps = 0;
        while (steps < 80) {
            let acted = false;
            for (const p of s.players) { if (p.passed) continue; apply(p, fastPolicy(p, round)); acted = true; steps++; }
            if (!acted || s.players.every(p => p.passed)) break;
        }
        if (round < 6) for (const p of s.players) applyIncome(p);
    }
    return s.players.map(terminalScore);
}
