/**
 * 실제 앱(개발서버)에 소켓으로 붙어 봇 자기대국을 돌리면서
 * "패스 창 미리보기" vs "서버가 로그에 남긴 실제 정산"을 대조하는 end-to-end 확인 스크립트.
 *
 *   · 미리보기 — 클라이언트가 받은 game_updated 상태로 computePassScorePreview()를 계산한다.
 *                Game.tsx의 패스 확인 창이 쓰는 것과 '같은 함수 · 같은 입력'이므로 화면에 뜨는 값과 동일하다.
 *   · 정산     — 그 패스로 서버가 남긴 'Selected Bonus' 로그의 passInfo(bonusVp / advTiles).
 *
 * 사용:
 *   1) 개발서버 기동:  PORT=5001 npm run dev
 *   2) npx tsx script/livePassCheck.ts          (URL=... GAMES=n 로 조정)
 */
import { io } from 'socket.io-client';
import { computePassScorePreview, ALL_BONUS_TILES } from '@shared/gameConfig';

/** 통합 전(구) 클라 미리보기 공식 — 같은 실행에서 "예전이었다면 몇 건이 틀렸나"를 함께 센다 */
function oldClientBonusVp(game: any, playerId: string): number {
	const player = game.players[playerId];
	if (!player?.bonusTile) return 0;
	const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
	if (!tile?.passBonus) return 0;
	const { type, vp } = tile.passBonus;
	const owned = game.map.filter((t: any) => t.ownerId === playerId);
	switch (type) {
		case 'mine': {
			const physical = owned.filter((t: any) => t.structure === 'mine').length
				+ game.map.filter((t: any) => t.parasiticMine?.ownerId === playerId).length;
			const lost = owned.filter((t: any) => t.structure === 'lost_planet_mine').length;
			return (physical + lost + (player.virtualMineAsteroid ? 1 : 0) + (player.virtualMineProto ? 1 : 0)) * vp;
		}
		case 'trading_station': return owned.filter((t: any) => t.structure === 'trading_station').length * vp;
		case 'research_lab': return owned.filter((t: any) => t.structure === 'research_lab').length * vp;
		case 'big_building': return owned.filter((t: any) => t.structure === 'planetary_institute' || t.structure === 'academy').length * vp;
		case 'gaiaformer': {
			const activeOnMap = game.map.filter((t: any) => t.hasGaiaformer && player.pendingGaiaformerTiles?.includes(t.id)).length;
			return ((player.gaiaformers ?? 0) + activeOnMap + (player.gaiaformerPlacedThisRound?.length ?? 0)) * vp;
		}
		case 'gaia': return owned.filter((t: any) => t.type === 'gaia' && t.structure != null && t.structure !== 'ship').length * vp;
		case 'planet_type': {
			const s = new Set<string>();
			for (const t of owned) {
				if (t.structure == null || t.structure === 'ship') continue;
				if (t.structure === 'lost_planet_mine') s.add('lost_planet');
				else if (t.type !== 'space' && t.type !== 'deep_space') s.add(t.type);
			}
			if (player.virtualMineAsteroid) s.add('asteroid');
			if (player.virtualMineProto) s.add('proto');
			return s.size * vp;
		}
		case 'bridge_sector':
			return new Set(owned
				.filter((t: any) => t.structure != null && t.structure !== 'ship' && typeof t.sector === 'number' && t.sector >= 11 && t.sector <= 18)
				.map((t: any) => t.sector)).size * vp;
	}
	return 0;
}

const URL = process.env.URL || 'http://localhost:5001';
const GAMES = parseInt(process.env.GAMES || '1', 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || String(25 * 60 * 1000), 10);
/** 봇 사고시간(ms). 낮출수록 한 판이 빨라 6라운드까지 완주시키기 쉽다(0이면 서버 기본값 유지) */
const MCTS_MS = parseInt(process.env.MCTS_MS || '0', 10);

type Row = { ok: boolean; line: string };
const rows: Row[] = [];
let passEvents = 0, okCount = 0, badCount = 0;
const seenLogKeys = new Set<string>();
const byRound = new Map<number, number>();
const bonusTypesSeen = new Map<string, number>();
const advTilesSeen = new Map<string, number>();

type Snapshot = {
	bonusVp: number;
	adv: Map<string, number>;
	tileId?: string;
	type?: string;
	count?: number;
	/** 통합 전 구 클라 공식이 같은 상태에서 보였을 값 */
	oldBonusVp: number;
};
/** 구 공식이었다면 틀렸을 건수 (유형별) */
const wouldHaveBeenWrong = new Map<string, number>();

function runOneGame(index: number): Promise<void> {
	return new Promise((resolve) => {
		const socket = io(URL, { transports: ['websocket'] });
		/** 플레이어별: '그 사람 턴일 때' 클라 상태로 계산해 둔 미리보기 (= 패스 창에 뜰 값) */
		const previewAtTurn = new Map<string, Snapshot>();
		let finished = false;
		const done = () => { if (finished) return; finished = true; socket.close(); resolve(); };

		socket.on('connect', () => {
			const start = () => socket.emit('create_game', { playerName: `Verifier${index}` }, (res: any) => {
				if (!res?.gameId) { console.error('create_game 실패'); return done(); }
				// SEAT_FACTIONS=lantids,terran,... 로 좌석 종족 고정 가능
				//   (란티다 기생광산·가이아포머처럼 '옛 미리보기가 틀렸던' 조건을 일부러 만들 때 사용)
				const seat = (process.env.SEAT_FACTIONS || '').split(',').map(s => s.trim()).filter(Boolean);
				socket.emit('auto_setup_test', {
					gameId: res.gameId,
					selfPlay: true,
					...(seat.length ? { fixedSetup: { seatFactions: seat } } : {}),
				});
			});
			if (MCTS_MS > 0) {
				// 개발서버 한정(AI_TUNING_TOKEN 미설정 시 토큰 불필요): 봇을 빠르게 돌려 6라운드까지 완주시킨다
				socket.emit('admin_set_mcts_time_ms', { timeMs: MCTS_MS }, () => {
					socket.emit('admin_set_bot_delay_ms', { delayMs: 0 }, () => start());
				});
			} else start();
		});

		socket.on('game_updated', (game: any) => {
			if (!game?.players || !Array.isArray(game.gameLog)) return;

			// 1) 새로 들어온 패스 로그를 먼저 대조한다 (이 상태는 이미 '패스 후')
			for (const entry of game.gameLog) {
				if (!entry?.passInfo) continue;
				const key = `${game.id}|${entry.seq ?? entry.timestamp}|${entry.playerId}`;
				if (seenLogKeys.has(key)) continue;
				seenLogKeys.add(key);

				const pid = entry.playerId;
				const name = game.players[pid]?.name ?? pid;
				const faction = game.players[pid]?.faction ?? '?';
				const pre = previewAtTurn.get(pid);
				passEvents++;
				byRound.set(entry.round, (byRound.get(entry.round) ?? 0) + 1);

				if (!pre) {
					rows.push({ ok: false, line: `[턴 상태 못 잡음] r${entry.round} ${name}(${faction})` });
					badCount++;
					continue;
				}

				const serverBonus = entry.passInfo.bonusVp ?? 0;   // 서버는 0이면 필드를 생략
				const serverAdv = new Map<string, number>((entry.passInfo.advTiles ?? []).map((a: any) => [a.tileId, a.vp]));
				if (pre.type) bonusTypesSeen.set(pre.type, (bonusTypesSeen.get(pre.type) ?? 0) + 1);

				let ok = pre.bonusVp === serverBonus;
				const advParts: string[] = [];
				for (const id of new Set([...pre.adv.keys(), ...serverAdv.keys()])) {
					const mine = pre.adv.get(id), srv = serverAdv.get(id);
					if (mine !== srv) ok = false;
					advTilesSeen.set(id, (advTilesSeen.get(id) ?? 0) + 1);
					advParts.push(`${id.replace('adv-pass-', '')} 창=${mine ?? '-'}/로그=${srv ?? '-'}`);
				}
				// 같은 상태에서 구 클라 공식이었다면 어긋났을 건수
				let oldNote = '';
				if (pre.oldBonusVp !== serverBonus) {
					const k = pre.type ?? '?';
					wouldHaveBeenWrong.set(k, (wouldHaveBeenWrong.get(k) ?? 0) + 1);
					oldNote = ` ⟵ 구공식이면 ${pre.oldBonusVp} (어긋남)`;
				}
				const detail = `보너스[${pre.type ?? '없음'}${pre.count != null ? ` ${pre.count}개` : ''}] 창=${pre.bonusVp} 로그=${serverBonus}${oldNote}`
					+ (advParts.length ? ` | 고급 ${advParts.join(' ')}` : '');
				rows.push({ ok, line: `r${entry.round} ${name}(${faction}) ${detail}` });
				ok ? okCount++ : badCount++;
			}

			// 2) 현재 턴 플레이어의 미리보기를 갱신 (패스 창을 열면 보게 될 값)
			const curId = game.turnOrder?.[game.currentPlayerIndex];
			if (curId && game.players[curId] && game.currentPhase === 'main') {
				try {
					const p = computePassScorePreview(game, curId);
					previewAtTurn.set(curId, {
						bonusVp: p.bonusVp,
						adv: new Map(p.advTiles.map(a => [a.tileId, a.vp])),
						tileId: p.bonusTile?.tileId,
						type: p.bonusTile?.type,
						count: p.bonusTile?.count,
						oldBonusVp: oldClientBonusVp(game, curId),
					});
				} catch { /* 전환 중 상태는 건너뜀 */ }
			}

			if (game.currentPhase === 'gameEnd') done();
		});

		socket.on('connect_error', (e: any) => { console.error('연결 실패:', e?.message); done(); });
		setTimeout(() => { if (!finished) { console.error(`(게임 ${index}: 시간 초과)`); done(); } }, TIMEOUT_MS);
	});
}

(async () => {
	for (let i = 1; i <= GAMES; i++) {
		console.log(`--- 게임 ${i}/${GAMES} 진행 중 (${URL}) ---`);
		await runOneGame(i);
		console.log(`    누적: 패스 ${passEvents}건 / 일치 ${okCount} / 불일치 ${badCount}`);
	}
	console.log('');
	console.log(`패스 이벤트 ${passEvents}건 — 일치 ${okCount}, 불일치 ${badCount}`);
	console.log(`라운드별: ${[...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => `r${r}=${n}`).join(', ')}`);
	console.log(`보너스 타일 유형: ${[...bonusTypesSeen.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(없음)'}`);
	console.log(`고급 패스 타일: ${[...advTilesSeen.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(없음)'}`);
	const wrongTotal = [...wouldHaveBeenWrong.values()].reduce((a, b) => a + b, 0);
	console.log(`통합 전(구 클라 공식)이었다면 어긋났을 패스: ${wrongTotal}건` +
		(wrongTotal ? ` — ${[...wouldHaveBeenWrong.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}` : ''));
	console.log('');
	console.log('--- 샘플 (앞 15건) ---');
	for (const r of rows.slice(0, 15)) console.log(`  ${r.ok ? 'OK  ' : '불일치'} ${r.line}`);
	const bad = rows.filter(r => !r.ok);
	if (bad.length) {
		console.log('');
		console.log('--- 불일치 전체 ---');
		for (const r of bad) console.log(`  ${r.line}`);
		process.exit(1);
	}
	console.log('');
	console.log('OK: 모든 패스에서 패스 창 미리보기 = 서버 로그 정산');
	process.exit(0);
})();
