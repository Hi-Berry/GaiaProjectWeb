/** 아이타 2TF+무료광산 순서 시뮬레이션.
 *  검증 대상(3a26b8a):
 *   A) 아이타 교환 pending 상태에서 '내 턴이 아니어도' 무료 광산 건설이 되는가 (수정 전엔 턴 게이트에 막힘)
 *   B) 그 건설이 hasDoneMainAction을 소모하지 않는가 (c63201b)
 *   C) 미해소 동안 helperStartNewRoundTurn이 액션 단계(1턴) 시작을 보류하는가
 *   D) 트랙 전진으로 해소되면 플래그가 소비되고 1턴이 시작되는가
 *   E) 회귀: 교환이 아닌 일반 2TF+Mine은 내 턴에만 되고 hasDoneMainAction을 소모하는가
 */
import { executeBuildMine, executeAdvanceTech, helperStartNewRoundTurn } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }) };

function mkPlayer(id: string, faction: string, name: string) {
    return {
        id, name, faction,
        ore: 5, credits: 10, knowledge: 4, qic: 2,
        power1: 2, power2: 0, power3: 0, gaiaformerPower: 0,
        score: 10, research: { terraforming: 1, navigation: 1, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
        techTiles: [] as string[], coveredTechTiles: [] as string[],
        federations: [] as any[], hasPassed: false, gaiaformers: 0,
        pendingTerraformSteps: 0, nextMineFreeFromShipTech: false,
    } as any;
}

/** 아이타(itars)=turnOrder[1] → 라운드 시작 시 현재 턴은 turnOrder[0](다른 사람) = '내 턴 아님' 상황 */
function mkGame(): any {
    const itars = mkPlayer('p_itars', 'itars', '아이타');
    const other = mkPlayer('p_other', 'terran', '상대');
    return {
        id: 'sim1', currentPhase: 'main', roundNumber: 1,
        turnOrder: ['p_other', 'p_itars'], currentPlayerIndex: 0,
        players: { p_itars: itars, p_other: other },
        map: [
            // 아이타 기존 광산(거리 기준점) + 인접 빈 행성(테라포밍 2단계 필요한 타입)
            { id: 't_home', q: 0, r: 0, type: 'terra', sector: 1, structure: 'mine', ownerId: 'p_itars' },
            { id: 't_target', q: 1, r: 0, type: 'volcanic', sector: 1, structure: null, ownerId: null },
        ],
        gameLog: [], roundScoringTiles: [], finalMissionIds: [],
        hasDoneMainAction: false, federationPool: {},
        botPlayerIds: [], simulation: true,
    };
}

let fails = 0;
const check = (label: string, got: any, want: any) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n          got ${JSON.stringify(got)}${ok ? '' : `  / want ${JSON.stringify(want)}`}`);
};

// ---------- 아이타 교환 경로 ----------
console.log('[아이타 PI 교환에서 2TF+무료광산을 받은 직후 상태]');
const g = mkGame();
const itars = g.players.p_itars;
// 타일 선택 직후 서버가 만드는 상태를 그대로 재현
itars.techTiles.push('ship-tech-2tf-mine');
itars.pendingTerraformSteps = 2;
itars.nextMineFreeFromShipTech = true;
g.pendingShipTechMine = { playerId: 'p_itars' };
g.itarsExchangeResumeAfterShipMine = true;
g.itarsGaiaformerRemainingAfterTech = 0;

check('시작: 현재 턴은 아이타가 아님(turnOrder[0]=상대)', g.turnOrder[g.currentPlayerIndex] !== 'p_itars', true);

// C) 액션 단계 시작 보류
helperStartNewRoundTurn(ioStub, g);
check('C) 미해소 동안 액션 단계 시작 보류(actionPhaseStartedRound 미설정)', g.actionPhaseStartedRound ?? null, null);

// A) 내 턴이 아닌데도 건설 성공
const oreBefore = itars.ore, creditsBefore = itars.credits;
const built = executeBuildMine(ioStub, g, 'p_itars', 't_target');
check('A) 내 턴 아님에도 무료 광산 건설 성공', built, true);
check('A) 타일 소유·구조물 반영', [g.map[1].structure, g.map[1].ownerId], ['mine', 'p_itars']);
check('A) 무료라 자원 소모 없음(1O2C 미청구)', [itars.ore === oreBefore, itars.credits === creditsBefore], [true, true]);

// B) 메인 액션 미소모
check('B) hasDoneMainAction 그대로 false', g.hasDoneMainAction, false);
check('   광산 pending 해소 + 트랙 전진 pending 생성', [g.pendingShipTechMine, g.pendingShipTechTrackAdvance?.playerId], [null, 'p_itars']);
check('   보류 플래그는 트랙 전진까지 유지', g.itarsExchangeResumeAfterShipMine, true);

// D) 트랙 전진으로 해소 → 1턴 시작
const advanced = executeAdvanceTech(ioStub, g, 'p_itars', 'science' as any);
check('D) 내 턴 아님에도 보상 트랙 전진 성공', advanced, true);
check('D) science 트랙 1칸 상승', g.players.p_itars.research.science, 1);
check('D) 트랙 전진도 메인 액션 미소모', g.hasDoneMainAction, false);
check('D) 보류 플래그 소비됨', !!g.itarsExchangeResumeAfterShipMine, false);
check('D) 액션 단계(1턴) 시작됨', g.actionPhaseStartedRound, 1);
check('D) 1턴은 원래 시작 플레이어(turnOrder[0])부터', g.turnOrder[g.currentPlayerIndex], 'p_other');

// ---------- E) 회귀: 일반(비교환) 2TF+Mine ----------
console.log('\n[회귀: 연구소 건설로 받은 일반 2TF+Mine — 교환 플래그 없음]');
const g2 = mkGame();
const it2 = g2.players.p_itars;
it2.pendingTerraformSteps = 2; it2.nextMineFreeFromShipTech = true;
g2.pendingShipTechMine = { playerId: 'p_itars' };   // 교환 플래그 없음
const blocked = executeBuildMine(ioStub, g2, 'p_itars', 't_target');
check('E) 교환이 아니면 내 턴 아닐 때 건설 차단(기존 동작)', blocked, false);

g2.currentPlayerIndex = 1; // 아이타 턴
const built2 = executeBuildMine(ioStub, g2, 'p_itars', 't_target');
check('E) 내 턴이면 건설 성공', built2, true);
check('E) 일반 경로는 hasDoneMainAction 소모(기존 동작 유지)', g2.hasDoneMainAction, true);

console.log(`\n${fails === 0 ? '전부 통과' : `${fails}건 실패`}`);
process.exit(fails === 0 ? 0 : 1);
