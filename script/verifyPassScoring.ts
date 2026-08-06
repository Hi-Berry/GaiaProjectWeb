/**
 * 패스 점수 공용 계산기(shared/gameConfig.ts computePassScorePreview) 검증.
 *
 * 배경: 서버 정산(gameState.passRound / applyAdvancedTechTilePassEffect)과 클라 미리보기(Game.tsx)가
 *       각자 계산해 반복적으로 어긋났다 → shared 공용 함수로 통합. 이 스크립트가 그 통합을 검증한다.
 *
 * 세 가지 검사:
 *   A. 실제 게임 로그 대조 — data/human-games의 6라운드 패스 기록(passInfo)과 공용 함수 결과 비교.
 *      단, 저장 로그의 players에는 gaiaformers·virtualMineAsteroid/Proto가 아예 직렬화되지 않으므로
 *      그 값에 의존하는 항목(gaiaformer / mine / planet_type / adv-pass-2vp-asteroid / adv-pass-1vp-type)은
 *      로그만으로 재현이 불가능하다 → 검사 대상에서 제외하고 개수만 보고한다. (B가 그 부분을 담당)
 *   B. 구(舊) 서버 공식 vs 공용 함수 — 리팩터가 서버 정산을 바꾸지 않았는지(회귀 방지).
 *      실제 맵 + 누락 필드(포머·가상광산·기생광산)를 채운 합성 변형까지 전 항목을 강제로 돌린다.
 *   C. 구(舊) 클라 공식 vs 공용 함수 — 통합 전 미리보기가 실제로 어디서 어긋났는지(수정 효과) 보고.
 *      여기서 나오는 차이는 '고쳐진 버그'이므로 실패가 아니다.
 *
 * 사용: npx tsx script/verifyPassScoring.ts [로그디렉터리 ...]   (기본 data/human-games)
 */
import fs from 'fs';
import path from 'path';
import {
	computePassScorePreview,
	getFederationEntries,
	ALL_BONUS_TILES,
	type GaiaGameState,
	type HexTile,
	type PassBonusType,
} from '../shared/gameConfig';

// ---------------------------------------------------------------------------
// 구 공식 (리팩터 직전 코드 그대로 복사) — 회귀 비교용
// ---------------------------------------------------------------------------

/** 구 서버: getMineCountForPassAndBonuses */
function oldServerMineCount(game: any, playerId: string): number {
	const player = game.players[playerId];
	let n = game.map.filter((t: any) => t.ownerId === playerId && t.structure === 'mine').length;
	n += game.map.filter((t: any) => t.parasiticMine?.ownerId === playerId).length;
	if (player?.virtualMineAsteroid) n += 1;
	if (player?.virtualMineProto) n += 1;
	n += game.map.filter((t: any) => t.ownerId === playerId && t.structure === 'lost_planet_mine').length;
	return n;
}

/** 구 서버: countRemainingGaiaformers */
function oldServerGaiaformers(game: any, playerId: string): number {
	const player = game.players[playerId];
	if (!player) return 0;
	return (player.gaiaformers ?? 0) + game.map.filter((t: any) => t.hasGaiaformer && t.gaiaformerOwnerId === playerId).length;
}

function oldServerOccupiedSectors(game: any, playerId: string, lo: number, hi: number): number {
	const out = new Set<number>();
	for (const t of game.map) {
		const occ = (t.ownerId === playerId && !!t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId;
		if (t.sector >= lo && t.sector <= hi && occ) out.add(t.sector);
	}
	return out.size;
}

/** 구 서버: passRound의 보너스 타일 패스 점수 (라운드6 / 1-5 두 곳에 동일 코드로 중복돼 있던 것) */
function oldServerBonusVp(game: any, playerId: string): number {
	const player = game.players[playerId];
	if (!player?.bonusTile) return 0;
	const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
	if (!tile?.passBonus) return 0;
	const playerStructures = game.map.filter((t: any) => t.ownerId === playerId);
	let count = 0;
	switch (tile.passBonus.type) {
		case 'big_building':
			count = playerStructures.filter((t: any) => t.structure === 'academy' || t.structure === 'planetary_institute').length;
			break;
		case 'mine': count = oldServerMineCount(game, playerId); break;
		case 'trading_station': count = playerStructures.filter((t: any) => t.structure === 'trading_station').length; break;
		case 'research_lab': count = playerStructures.filter((t: any) => t.structure === 'research_lab').length; break;
		case 'gaiaformer': count = oldServerGaiaformers(game, playerId); break;
		case 'planet_type': {
			const planetTypes = new Set(
				playerStructures.filter((t: any) => t.type !== 'space' && t.type !== 'deep_space').map((t: any) => t.type)
			);
			if (player.virtualMineAsteroid) planetTypes.add('asteroid');
			if (player.virtualMineProto) planetTypes.add('proto');
			if (playerStructures.some((t: any) => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');
			count = planetTypes.size;
			break;
		}
		case 'gaia': count = playerStructures.filter((t: any) => t.type === 'gaia').length; break;
		case 'bridge_sector': count = oldServerOccupiedSectors(game, playerId, 11, 18); break;
	}
	return count * tile.passBonus.vp;
}

/** 구 서버: applyAdvancedTechTilePassEffect */
function oldServerAdvVp(game: any, playerId: string): Map<string, number> {
	const player = game.players[playerId];
	const out = new Map<string, number>();
	if (!player?.techTiles) return out;
	for (const tileId of player.techTiles) {
		if (tileId === 'adv-pass-1vp-type') {
			// getPlayerPlanetTypesForGeodens
			const types = new Set<string>();
			for (const t of game.map) {
				if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
					if (t.structure === 'lost_planet_mine') types.add('lost_planet');
					else if (t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
				}
			}
			if (player.virtualMineAsteroid) types.add('asteroid');
			if (player.virtualMineProto) types.add('proto');
			out.set(tileId, types.size);
		} else if (tileId === 'adv-pass-3vp-lab') {
			out.set(tileId, game.map.filter((t: any) => t.ownerId === playerId && t.structure === 'research_lab').length * 3);
		} else if (tileId === 'adv-pass-3vp-fed') {
			out.set(tileId, getFederationEntries(player).length * 3);
		} else if (tileId === 'adv-pass-2vp-asteroid') {
			let n = game.map.filter((t: any) => t.ownerId === playerId && t.type === 'asteroid').length;
			if (player.virtualMineAsteroid) n += 1;
			out.set(tileId, n * 2);
		} else if (tileId === 'adv-pass-2vp-outer') {
			out.set(tileId, oldServerOccupiedSectors(game, playerId, 11, 18) * 2);
		}
	}
	return out;
}

/** 구 클라(Game.tsx) 미리보기 공식 */
function oldClientBonusVp(game: any, playerId: string): number {
	const player = game.players[playerId];
	if (!player?.bonusTile) return 0;
	const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
	if (!tile?.passBonus) return 0;
	const { type, vp } = tile.passBonus;
	const owned = game.map.filter((t: any) => t.ownerId === playerId);
	const myMapTiles = owned;
	switch (type) {
		case 'mine': {
			const physical = owned.filter((t: any) => t.structure === 'mine').length
				+ game.map.filter((t: any) => t.parasiticMine?.ownerId === playerId).length;
			const lost = owned.filter((t: any) => t.structure === 'lost_planet_mine').length;
			const virt = (player.virtualMineAsteroid ? 1 : 0) + (player.virtualMineProto ? 1 : 0);
			return (physical + lost + virt) * vp;
		}
		case 'trading_station': return owned.filter((t: any) => t.structure === 'trading_station').length * vp;
		case 'research_lab': return owned.filter((t: any) => t.structure === 'research_lab').length * vp;
		case 'big_building': return owned.filter((t: any) => t.structure === 'planetary_institute' || t.structure === 'academy').length * vp;
		case 'gaiaformer': {
			const activeOnMap = game.map.filter((t: any) => t.hasGaiaformer && player.pendingGaiaformerTiles?.includes(t.id)).length;
			const nextRound = player.gaiaformerPlacedThisRound?.length ?? 0;
			return ((player.gaiaformers ?? 0) + activeOnMap + nextRound) * vp;
		}
		case 'gaia':
			return myMapTiles.filter((t: any) => t.type === 'gaia' && t.structure != null && t.structure !== 'ship').length * vp;
		case 'planet_type': {
			const ptypes = new Set<string>();
			for (const t of myMapTiles) {
				if (t.structure == null || t.structure === 'ship') continue;
				if (t.structure === 'lost_planet_mine') ptypes.add('lost_planet');
				else if (t.type !== 'space' && t.type !== 'deep_space') ptypes.add(t.type);
			}
			if (player.virtualMineAsteroid) ptypes.add('asteroid');
			if (player.virtualMineProto) ptypes.add('proto');
			return ptypes.size * vp;
		}
		case 'bridge_sector':
			return new Set(
				myMapTiles
					.filter((t: any) => t.structure != null && t.structure !== 'ship' && typeof t.sector === 'number' && t.sector >= 11 && t.sector <= 18)
					.map((t: any) => t.sector)
			).size * vp;
	}
	return 0;
}

/**
 * 유일한 '의도된' 정산 변경 판정 — 엠바스 스왑으로 잊혀진 행성이 진짜 행성 헥스 위로 옮겨간 경우.
 *
 * 구 서버는 같은 '행성 유형'을 두 가지 규칙으로 세고 있었다.
 *   · 보너스 타일 planet_type: 소유 타일의 type 집합 + (잊혀진행성 있으면) lost_planet  → 스왑된 칸을 둘 다 셈
 *   · adv-pass-1vp-type / fm_planet_types / 기오덴 의회: lost_planet_mine이면 lost_planet '만'  → 스왑된 칸의 원래 행성 유형을 잃음
 * 엠바스 의회 능력(의회 ↔ 광산 위치 교환)은 lost_planet_mine을 실제 행성(예: proto) 위로 옮길 수 있고,
 * 그 칸은 실제로 그 행성을 점유한 것이므로 두 유형 모두 세는 쪽이 맞다.
 * → 공용 getOwnedPlanetTypes를 그렇게 통일했다. 보너스 타일 값은 구 서버와 동일하게 유지되고,
 *   adv-pass-1vp-type만 스왑된 판에서 +1 (구 서버의 과소 집계를 바로잡은 것).
 */
function hasSwappedLostPlanet(game: any, playerId: string): boolean {
	return game.map.some((t: any) =>
		t.ownerId === playerId && t.structure === 'lost_planet_mine' && t.type !== 'space' && t.type !== 'deep_space');
}
function isIntendedPlanetTypeFix(game: any, playerId: string, kind: PassBonusType | string | undefined): boolean {
	if (kind !== 'planet_type' && kind !== 'adv-pass-1vp-type') return false;
	return hasSwappedLostPlanet(game, playerId);
}

// ---------------------------------------------------------------------------
// 합성 변형: 저장 로그에 없는 필드(포머·가상광산·기생광산)를 채워 전 항목을 강제로 돌린다
// ---------------------------------------------------------------------------
const BONUS_PASS_TILE_IDS = ALL_BONUS_TILES.filter(t => t.passBonus).map(t => t.id);
const ADV_PASS_TILE_IDS = ['adv-pass-1vp-type', 'adv-pass-3vp-lab', 'adv-pass-3vp-fed', 'adv-pass-2vp-asteroid', 'adv-pass-2vp-outer'];

/** 시드 고정 PRNG (재현 가능한 검증을 위해 Math.random 사용 안 함) */
function makeRng(seed: number) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function cloneGame(g: any): any {
	return { ...g, map: g.map.map((t: any) => ({ ...t })), players: Object.fromEntries(Object.entries(g.players).map(([k, v]: any) => [k, { ...v }])) };
}

/** 실제 게임 상태에 '실제로 일어날 수 있는' 누락 필드를 주입한 변형 생성 */
function synthesize(base: any, playerId: string, bonusTileId: string, rng: () => number): any {
	const g = cloneGame(base);
	const p = g.players[playerId];
	p.bonusTile = bonusTileId;
	p.techTiles = Array.from(new Set([...(p.techTiles ?? []), ...ADV_PASS_TILE_IDS]));
	p.gaiaformers = Math.floor(rng() * 4);                       // 개인판 대기 포머 0~3
	p.virtualMineAsteroid = rng() < 0.5;                          // 인공물 가상광산(소행성)
	p.virtualMineProto = rng() < 0.5;                             // 인공물 가상광산(원시)
	p.pendingGaiaformerTiles = [];
	p.gaiaformerPlacedThisRound = [];
	const others = g.turnOrder.filter((id: string) => id !== playerId);
	for (const t of g.map as HexTile[]) {
		// 맵 위 가이아포머: 내 것 / 남의 것 둘 다 (남의 포머를 내 것으로 세면 안 된다)
		if (!t.structure && (t.type === 'transdim' || t.type === 'gaia') && rng() < 0.35) {
			const mine = rng() < 0.6;
			(t as any).hasGaiaformer = true;
			(t as any).gaiaformerOwnerId = mine ? playerId : (others[0] ?? playerId);
			if (mine && rng() < 0.5) p.pendingGaiaformerTiles.push(t.id);
			if (mine && rng() < 0.3) p.gaiaformerPlacedThisRound.push(t.id);
		}
		// 란티다 기생광산: 남의 건물 위에 내 기생광산 (섹터 점유에 포함돼야 한다)
		if (t.structure && t.ownerId && t.ownerId !== playerId && !(t as any).parasiticMine && rng() < 0.15) {
			(t as any).parasiticMine = { ownerId: playerId };
		}
	}
	return g;
}

// ---------------------------------------------------------------------------
const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push(path.resolve('data/human-games'));
let files: string[] = [];
for (const dir of dirs) {
	if (!fs.existsSync(dir)) { console.error(`(skip) 디렉터리 없음: ${dir}`); continue; }
	files = files.concat(fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)));
}

/** 저장 로그에 직렬화되지 않는 필드(gaiaformers·virtualMine*)에 의존해 로그 대조가 불가능한 항목 */
const NOT_REPLAYABLE_BONUS: PassBonusType[] = ['gaiaformer', 'mine', 'planet_type'];
const NOT_REPLAYABLE_ADV = new Set(['adv-pass-1vp-type', 'adv-pass-2vp-asteroid']);

let games = 0, skippedFiles = 0;
// A
let aChecked = 0, aMismatch = 0, aSkipped = 0;
const aByType = new Map<string, number>();
// B
let bChecked = 0, bMismatch = 0, bIntended = 0;
const intendedNotes = new Set<string>();
// C
let cChecked = 0;
const cDiffByType = new Map<string, number>();
const failures: string[] = [];

for (const file of files) {
	let data: any;
	try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { skippedFiles++; continue; }
	if (!data?.map || !data?.players || !Array.isArray(data.gameLog) || !Array.isArray(data.turnOrder)) { skippedFiles++; continue; }
	games++;
	const game = data as GaiaGameState;

	// ---- A. 실제 6라운드 패스 기록과 대조 -------------------------------------
	if (data.roundNumber === 6) {
		for (const entry of data.gameLog as any[]) {
			const info = entry?.passInfo;
			if (!info || entry.round !== 6 || info.tookTileId) continue;
			const playerId: string = entry.playerId;
			const player = data.players?.[playerId];
			if (!player) continue;
			const preview = computePassScorePreview(game, playerId);

			const type = preview.bonusTile?.type;
			if (type && NOT_REPLAYABLE_BONUS.includes(type)) {
				aSkipped++;
			} else {
				aChecked++;
				if (type) aByType.set(type, (aByType.get(type) ?? 0) + 1);
				const expected = info.bonusVp ?? 0;
				if (preview.bonusVp !== expected) {
					aMismatch++;
					failures.push(`[A/bonus] ${path.basename(file)} ${player.name} (${player.faction}) ${type}: 서버기록=${expected} 공용=${preview.bonusVp}`);
				}
			}

			const expectedAdv = new Map<string, number>((info.advTiles ?? []).map((a: any) => [a.tileId, a.vp]));
			const actualAdv = new Map(preview.advTiles.map(a => [a.tileId, a.vp]));
			for (const tileId of new Set([...expectedAdv.keys(), ...actualAdv.keys()])) {
				if (NOT_REPLAYABLE_ADV.has(tileId)) { aSkipped++; continue; }
				aChecked++;
				aByType.set(tileId, (aByType.get(tileId) ?? 0) + 1);
				if (expectedAdv.get(tileId) !== actualAdv.get(tileId)) {
					aMismatch++;
					failures.push(`[A/adv] ${path.basename(file)} ${player.name} (${player.faction}) ${tileId}: 서버기록=${expectedAdv.get(tileId) ?? '없음'} 공용=${actualAdv.get(tileId) ?? '없음'}`);
				}
			}
		}
	}

	// ---- B, C. 구 공식 대조 (실제 상태 + 합성 변형, 전 보너스 타일 강제) ---------
	const rng = makeRng(games * 7919);
	for (const playerId of data.turnOrder as string[]) {
		if (!data.players[playerId]) continue;
		for (const bonusTileId of BONUS_PASS_TILE_IDS) {
			const g = synthesize(data, playerId, bonusTileId, rng);
			const preview = computePassScorePreview(g, playerId);

			// B: 구 서버 vs 공용 — 반드시 일치해야 한다 (아래 '의도된 변경'만 예외)
			bChecked++;
			const oldBonus = oldServerBonusVp(g, playerId);
			if (oldBonus !== preview.bonusVp) {
				if (isIntendedPlanetTypeFix(g, playerId, preview.bonusTile?.type)) {
					bIntended++;
					intendedNotes.add(`${path.basename(file)} ${playerId}: 구서버=${oldBonus} 공용=${preview.bonusVp}`);
				} else {
					bMismatch++;
					failures.push(`[B/bonus] ${path.basename(file)} ${playerId} ${bonusTileId}: 구서버=${oldBonus} 공용=${preview.bonusVp}`);
				}
			}
			const oldAdv = oldServerAdvVp(g, playerId);
			const newAdv = new Map(preview.advTiles.map(a => [a.tileId, a.vp]));
			for (const tileId of new Set([...oldAdv.keys(), ...newAdv.keys()])) {
				bChecked++;
				if (oldAdv.get(tileId) !== newAdv.get(tileId)) {
					if (isIntendedPlanetTypeFix(g, playerId, tileId)) {
						bIntended++;
						intendedNotes.add(`${path.basename(file)} ${playerId} ${tileId}: 구서버=${oldAdv.get(tileId)} 공용=${newAdv.get(tileId)}`);
					} else {
						bMismatch++;
						failures.push(`[B/adv] ${path.basename(file)} ${playerId} ${tileId}: 구서버=${oldAdv.get(tileId)} 공용=${newAdv.get(tileId)}`);
					}
				}
			}

			// C: 구 클라 vs 공용 — 차이 = 통합으로 고쳐진 미리보기 오차
			cChecked++;
			const oldClient = oldClientBonusVp(g, playerId);
			if (oldClient !== preview.bonusVp) {
				const key = preview.bonusTile?.type ?? '?';
				cDiffByType.set(key, (cDiffByType.get(key) ?? 0) + 1);
			}
		}
	}
}

console.log(`로그 파일: ${files.length}개 (파싱/형식 제외 ${skippedFiles}) / 게임 ${games}개`);
console.log('');
console.log(`A. 실제 6라운드 패스 기록 대조: ${aChecked}건 검사, 불일치 ${aMismatch}건 (재현 불가로 제외 ${aSkipped}건)`);
console.log(`   항목별: ${[...aByType.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(없음)'}`);
console.log(`   ※ 제외 사유: 저장 로그의 players에 gaiaformers·virtualMineAsteroid/Proto가 직렬화되지 않아 패스 시점 상태 복원 불가`);
console.log('');
console.log(`B. 구 서버 공식 vs 공용 함수(회귀): ${bChecked}건 검사, 불일치 ${bMismatch}건, 의도된 변경 ${bIntended}건`);
if (bIntended > 0) {
	console.log(`   의도된 변경 = 엠바스 스왑으로 잊혀진 행성이 실제 행성 헥스로 옮겨간 판에서 구 서버가 그 칸의 원래 행성 유형을 잃던 것(과소 집계) 수정:`);
	for (const n of [...intendedNotes].slice(0, 10)) console.log(`     ${n}`);
}
console.log('');
console.log(`C. 구 클라 미리보기 공식 vs 공용 함수: ${cChecked}건 중 차이 ${[...cDiffByType.values()].reduce((a, b) => a + b, 0)}건`);
console.log(`   유형별 차이(=고쳐진 미리보기 오차): ${[...cDiffByType.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(없음)'}`);

if (failures.length > 0) {
	console.log('');
	console.log('--- 실패 상세 (최대 40건) ---');
	for (const f of failures.slice(0, 40)) console.log('  ' + f);
	process.exit(1);
}
console.log('');
console.log('OK: 공용 계산기가 서버 정산 기록·구 서버 공식과 모두 일치합니다.');
