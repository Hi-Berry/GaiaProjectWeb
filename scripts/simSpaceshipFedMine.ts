/** 우주선 연방 무료광산: 메인 액션 완료 후·먼 거리에도 서버가 건설을 받아주는지 확인. */
import { executeBuildMine } from '../server/gameState';
const io: any = { to: () => ({ emit: () => { } }) };
const mk = () => {
  const p: any = { id: 'p1', name: '나', faction: 'terran', ore: 0, credits: 0, knowledge: 0, qic: 0,
    power1: 0, power2: 0, power3: 0, score: 10,
    research: { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
    techTiles: [], coveredTechTiles: [], federations: [], gaiaformers: 0, pendingTerraformSteps: 0 };
  return { id: 's', currentPhase: 'main', roundNumber: 3, turnOrder: ['p1'], currentPlayerIndex: 0,
    players: { p1: p }, map: [
      { id: 'home', q: 0, r: 0, type: 'terra', sector: 1, structure: 'mine', ownerId: 'p1' },
      { id: 'far', q: 7, r: 0, type: 'volcanic', sector: 5, structure: null, ownerId: null }, // 아주 먼 곳(무한거리 보상 취지)
    ], gameLog: [], roundScoringTiles: [], hasDoneMainAction: true, // 연방 형성으로 이미 메인 액션 완료
    federationPool: {}, botPlayerIds: [], simulation: true } as any;
};
let f = 0; const ck = (l: string, g: any, w: any) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l} → ${JSON.stringify(g)}${ok ? '' : ` / want ${JSON.stringify(w)}`}`); };

const g = mk();
g.pendingSpaceshipFedMine = { playerId: 'p1' };
ck('사전: 메인 액션 이미 완료', g.hasDoneMainAction, true);
ck('사전: 자원 0 (0O 0C 0QIC)', [g.players.p1.ore, g.players.p1.credits, g.players.p1.qic], [0, 0, 0]);
const built = executeBuildMine(io, g, 'p1', 'far');
ck('먼 행성 + 자원 0 + 메인액션 완료여도 서버가 건설 수락', built, true);
ck('타일 반영', [g.map[1].structure, g.map[1].ownerId], ['mine', 'p1']);
ck('pending 해소', g.pendingSpaceshipFedMine, null);
ck('자원 부족분은 면제(음수 안 됨)', g.players.p1.ore >= 0 && g.players.p1.qic >= 0, true);
console.log(`\n${f === 0 ? '전부 통과 — 서버는 정상, 막던 건 클라 게이트' : `${f}건 실패`}`);
process.exit(f === 0 ? 0 : 1);
