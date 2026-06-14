/** B0 검증: 합성 미니 게임에서 extractSimState가 손으로 만든 구조와 일치하는지. */
import { extractSimState } from '../server/ai/simModel';

// 헥스 좌표(axial). 인접 = 거리 1.
function tile(id: string, q: number, r: number, type: string, ownerId?: string, structure?: string) {
    return { id, q, r, type, ownerId: ownerId ?? null, structure: structure ?? null,
        parasiticMine: null, spaceStation: null, hasGaiaformer: false, gaiaformerOwnerId: null };
}
const map = [
    tile('t1', 0, 0, 'terra', 'p1', 'mine'),     // p1 광산
    tile('t2', 1, 0, 'terra', 'p1', 'mine'),     // t1 인접 → 클러스터 {t1,t2} 파워2
    tile('t3', 5, 0, 'desert', 'p1', 'mine'),    // 고립 → 클러스터 {t3} 파워1
    tile('t4', 0, 1, 'terra'),                   // 빈 terra, t1 인접 → 0스텝 슬롯
    tile('t5', 2, 0, 'desert'),                  // 빈 desert, t2 인접
    tile('t6', 9, 9, 'gaia'),                    // 너무 멀어 제외
    tile('s1', 3, 3, 'space'),                   // 우주(비행성)
];
const player = (id: string, faction: string) => ({
    id, faction, research: { terraforming: 0, navigation: 1, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
    ore: 3, credits: 5, knowledge: 2, qic: 1, power1: 2, power2: 0, power3: 0, brainStoneBowl: 0,
    score: 10, techTiles: [], bonusTile: null, gaiaformers: 0, hasPassed: false, artifacts: [], federations: [],
});
const game: any = {
    roundNumber: 2, turnOrder: ['p1', 'p2'],
    players: { p1: player('p1', 'terran'), p2: player('p2', 'xenos') },
    map, powerActions: [{ isUsed: false }, { isUsed: true }], playerFederationHexes: {},
};

const sim = extractSimState(game, 'p1');
const me = sim.players.find(p => p.id === 'p1')!;
console.log('round:', sim.round, '| powerActionsAvail:', sim.powerActionsAvail, '(기대 2,1)');
console.log('mines:', me.mines, '(기대 3) | ts/lab/pi/aca:', me.ts, me.labs, me.pi, me.academies, '(기대 0)');
console.log('research[nav=idx1]:', me.research[1], '(기대 1) | len:', me.research.length, '(기대 6)');
console.log('clusterPowers:', JSON.stringify(me.clusterPowers), '(기대 [2,1])');
console.log('reachableSlots:', JSON.stringify(me.reachableSlots), '(기대 s0>=1[t4 terra], 합 2[t4,t5], t6 제외)');

// 자동 판정
const checks = [
    ['mines=3', me.mines === 3],
    ['구조물0', me.ts === 0 && me.labs === 0 && me.pi === 0 && me.academies === 0],
    ['research6', me.research.length === 6 && me.research[1] === 1],
    ['clusters[2,1]', JSON.stringify(me.clusterPowers) === JSON.stringify([2, 1])],
    ['slots합2', me.reachableSlots.s0 + me.reachableSlots.s1 + me.reachableSlots.s2 === 2],
    ['slot s0>=1', me.reachableSlots.s0 >= 1],
    ['powerAvail1', sim.powerActionsAvail === 1], // 데이터에 unused 1개
    ['players2', sim.players.length === 2],
];
let pass = 0;
for (const [name, ok] of checks) { console.log((ok ? '✅' : '❌') + ' ' + name); if (ok) pass++; }
console.log(`\nB0 검증: ${pass}/${checks.length} 통과`);
process.exit(pass === checks.length ? 0 : 1);
