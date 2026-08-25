/**
 * 회귀: 연구소/아카데미 건설 시 '가져올 수 있는 기술 타일이 0개'면 선택을 건너뛸 수 있는지.
 * (사용자 2026-08-25: 타일을 못 집으면 pendingTechTileSelection이 안 풀려 턴 종료 불가 — 사람만 갇힘)
 *
 * 사용: PORT=5096 npx tsx script/testSkipTechTileSelection.ts
 */
import { executeSkipTechTileSelection, hasSelectableTechTileForHuman } from '../server/gameState';
import { createInitialPlayerState } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };
const P = 'p1';

function mk(opts: { owned?: string[]; byTrack?: any; pool?: any[]; ship?: string[]; shipPool?: Record<string, number>; adv?: any } = {}): any {
	const p: any = createInitialPlayerState('T');
	p.faction = 'terran';
	p.techTiles = opts.owned ?? [];
	return {
		id: 'g-skip-test', players: { [P]: p }, gameLog: [], map: [],
		techTilesByTrack: opts.byTrack ?? {}, techTilesPool: opts.pool ?? [],
		availableShipTechTileIds: opts.ship, shipTechPool: opts.shipPool,
		advancedTechTilesByTrack: opts.adv ?? {},
		pendingTechTileSelection: { playerId: P, tileId: '', structureType: 'research_lab' },
	};
}

let fail = 0;
const chk = (n: string, c: boolean) => { console.log(`  ${c ? 'OK  ' : '실패'} ${n}`); if (!c) fail++; };

// 1) 남은 타일 전부 보유 → 선택지 없음 → 스킵 성공 + pending 해소
{
	const g = mk({ byTrack: { economy: [{ id: 'tech-1o' }] }, pool: [{ id: 'tech-big-4str' }], owned: ['tech-1o', 'tech-big-4str'] });
	chk('선택지 없음 판정', !hasSelectableTechTileForHuman(g, P));
	chk('스킵 성공 + pending 해소', executeSkipTechTileSelection(ioStub, g, P) === true && g.pendingTechTileSelection === null);
}
// 2) 미보유 트랙 타일 존재 → 스킵 거부 + pending 유지
{
	const g = mk({ byTrack: { economy: [{ id: 'tech-1o' }] } });
	chk('선택지 있음 판정', hasSelectableTechTileForHuman(g, P));
	chk('스킵 거부 + pending 유지', executeSkipTechTileSelection(ioStub, g, P) === false && g.pendingTechTileSelection !== null);
}
// 3) 우주선 기술: 재고 있으면 거부, 재고 0이면 허용
{
	const g = mk({ ship: ['ship-tech-1o3k'], shipPool: { 'ship-tech-1o3k': 1 } });
	chk('우주선 재고 있음 → 거부', executeSkipTechTileSelection(ioStub, g, P) === false);
	const g2 = mk({ ship: ['ship-tech-1o3k'], shipPool: { 'ship-tech-1o3k': 0 } });
	chk('우주선 재고 0 → 허용', executeSkipTechTileSelection(ioStub, g2, P) === true);
}
// 4) 고급 타일이 유일한 선택지(초록연방+덮을타일+L4) → 거부
{
	const g = mk({ owned: ['tech-1o'], adv: { science: { id: 'adv-imm-2vp-mine' } } });
	g.players[P].federations = [{ rewardId: 'fed-8vp', isGreen: true }];
	g.players[P].research = { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 4 };
	chk('고급 타일 선택 가능 → 거부', executeSkipTechTileSelection(ioStub, g, P) === false);
}
// 5) 아이타 교환에서 스킵 → 4토큰 반환 + 교환 모달 복귀
{
	const g = mk({});
	g.pendingTechTileSelection.structureType = 'itars_pi_exchange';
	g.itarsGaiaformerRemainingAfterTech = 3;
	chk('아이타 스킵 → 모달 복귀(3+4=7)', executeSkipTechTileSelection(ioStub, g, P) === true
		&& g.pendingItarsGaiaformerExchange?.tokensRemaining === 7);
}

console.log('');
if (fail > 0) { console.log(`실패 ${fail}건`); process.exit(1); }
console.log('OK: 기술 타일 0개일 때만 건너뛰기가 허용됩니다.');
process.exit(0);
