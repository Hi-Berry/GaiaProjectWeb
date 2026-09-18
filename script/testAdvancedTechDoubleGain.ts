/**
 * 회귀: 연구소 1개(기술 타일 선택 1회)로 고급 타일 + 일반 타일을 둘 다 먹던 버그.
 * (사용자 2026-09-18: "연구소 짓고 고급 기술 누르고 다른 기술 타일도 누르니 둘 다 먹어졌다")
 *
 * 원인: 소켓 select_advanced_tech_tile이 커버 단계로 넘어가면서 pendingTechTileSelection을
 *       비우지 않아, 이어서 select_tech_tile이 살아있는 pending을 한 번 더 소비했다.
 *
 * 사용: npx tsx script/testAdvancedTechDoubleGain.ts
 */
import {
	executeSelectAdvancedTechTileForHuman,
	executeCoverAdvancedTechTile,
	executeSelectTechTile,
} from '../server/gameState';
import { createInitialPlayerState } from '../shared/gameConfig';
import * as fs from 'fs';

/** 서버 모듈이 이벤트 루프를 잡고 있어도 바로 보이도록 동기 출력 */
const out = (s: string) => fs.writeSync(1, `${s}\n`);

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };
const P = 'p1';
const ADV = 'adv-imm-2vp-mine';   // science 트랙 4–5 사이 고급 타일
const OWNED = 'tech-inc-4c';      // 이미 보유한 일반 타일(고급 타일로 덮을 대상)
const TRACK_TILE = 'tech-imm-7vp'; // economy 트랙에 놓인 일반 타일(추가로 먹으면 버그)

function mk(): any {
	const p: any = createInitialPlayerState('T');
	p.faction = 'terran';
	p.techTiles = [OWNED];
	p.coveredTechTiles = [];
	p.federations = [{ rewardId: 'fed-8vp', isGreen: true }];
	p.research = { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 4 };
	return {
		id: 'g-adv-double', players: { [P]: p }, gameLog: [], map: [],
		roundNumber: 1, roundScoringTiles: [{ id: '', label: '', condition: '', vp: 0 }], usedRoundMissions: [],
		currentPhase: 'main', turnOrder: [P], currentPlayerIndex: 0, hasDoneMainAction: true,
		techTilesByTrack: { economy: [{ id: TRACK_TILE }] },
		techTilesPool: [],
		advancedTechTilesByTrack: { science: { id: ADV } },
		pendingTechTileSelection: { playerId: P, tileId: 'tile-1', structureType: 'research_lab' },
		pendingAdvancedTechCover: null,
	};
}

let fail = 0;
const chk = (n: string, c: boolean) => { out(`  ${c ? 'OK  ' : '실패'} ${n}`); if (!c) fail++; };

// 1) 고급 타일 선택 → 커버 대기로 전환되고 표준 타일 선택 대기는 해소돼야 한다
{
	const g = mk();
	const ok = executeSelectAdvancedTechTileForHuman(ioStub, g, P, ADV, 'science');
	chk('고급 타일 선택 성공', ok === true);
	chk('커버 대기 설정', g.pendingAdvancedTechCover?.advancedTileId === ADV);
	chk('표준 타일 선택 대기 해소', g.pendingTechTileSelection === null);
	chk('우주선 타일 목록 정리', g.availableShipTechTileIds === undefined);
}

// 2) 커버 대기 중 일반 타일을 또 눌러도 아무것도 획득되지 않아야 한다 (버그 재현 지점)
{
	const g = mk();
	executeSelectAdvancedTechTileForHuman(ioStub, g, P, ADV, 'science');
	executeSelectTechTile(ioStub, g, P, TRACK_TILE, 'economy');
	chk('일반 타일 미획득', !g.players[P].techTiles.includes(TRACK_TILE));
	chk('보유 타일 1개 유지', g.players[P].techTiles.length === 1);
	chk('트랙 전진 없음', g.players[P].research.economy === 0);
	chk('보드 타일 그대로', g.techTilesByTrack.economy[0]?.id === TRACK_TILE);
	chk('커버 대기 유지', g.pendingAdvancedTechCover?.advancedTileId === ADV);
}

// 3) 커버 확정 → 고급 타일 1개만 추가(보유 2개: 덮인 일반 1 + 고급 1), 초록 연방 1개 소모
{
	const g = mk();
	executeSelectAdvancedTechTileForHuman(ioStub, g, P, ADV, 'science');
	executeSelectTechTile(ioStub, g, P, TRACK_TILE, 'economy'); // 무시돼야 함
	const ok = executeCoverAdvancedTechTile(ioStub, g, P, OWNED);
	chk('커버 확정 성공', ok === true);
	chk('보유 타일 = 일반1 + 고급1', g.players[P].techTiles.length === 2 && g.players[P].techTiles.includes(ADV));
	chk('덮임 처리', g.players[P].coveredTechTiles.includes(OWNED));
	chk('초록 연방 1개 소모', g.players[P].federations.filter((f: any) => f.isGreen).length === 0);
	chk('트랙 전진 대기 1회만', g.pendingAdvancedTechTrackAdvance?.playerId === P);
	chk('모든 타일 선택 대기 해소', g.pendingTechTileSelection === null && g.pendingAdvancedTechCover === null);
}

// 4) 반대 순서: 일반 타일을 먼저 가져갔으면 고급 타일 선택은 거부돼야 한다
{
	const g = mk();
	executeSelectTechTile(ioStub, g, P, TRACK_TILE, 'economy');
	chk('일반 타일 획득', g.players[P].techTiles.includes(TRACK_TILE) && g.players[P].research.economy === 1);
	const ok = executeSelectAdvancedTechTileForHuman(ioStub, g, P, ADV, 'science');
	chk('고급 타일 선택 거부', ok === false && !g.pendingAdvancedTechCover);
	chk('보유 타일 2개 유지(일반2, 고급 없음)', g.players[P].techTiles.length === 2 && !g.players[P].techTiles.includes(ADV));
}

// 5) 덮을 일반 타일이 없으면 고급 타일 선택 자체를 거부(커버 단계 갇힘 방지)
{
	const g = mk();
	g.players[P].techTiles = [];
	const ok = executeSelectAdvancedTechTileForHuman(ioStub, g, P, ADV, 'science');
	chk('덮을 타일 없음 → 거부 + pending 유지', ok === false && g.pendingTechTileSelection !== null);
}

out(fail === 0 ? '\n전부 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
