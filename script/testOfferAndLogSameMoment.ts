/**
 * 파워 수령 창이 뜰 때 그 원인이 된 건설 로그가 이미 보이는지 — 순서/타이밍을 실측한다.
 *
 * 사용자 제보(2026-09-26): "상대방 로그는 뜨지도 않고 파워 받는 창이 뜬다 … 타이밍 이슈인데"
 *
 * 봇끼리 두면 서버가 알아서 수락해 버려 사람용 제안이 아예 안 생긴다.
 * 그래서 사람 좌석 둘(알파·베타)을 직접 몰아 확실히 리치를 만든다.
 *   ① 시작 광산을 서로 2칸 안에 붙여 놓고
 *   ② 알파가 그 광산을 교역소로 올리면 → 베타에게 수동 제안이 간다
 * 그 순간 베타가 받은 상태로 클라이언트와 똑같이 판정해 두 시각을 잰다.
 *   - 제안 창이 뜨는 시각 (pendingPowerOffers 에 내 것이 생긴 첫 브로드캐스트)
 *   - 그 건설 로그가 보이게 되는 시각 (getCommitSeq 기준으로 안 가려지는 첫 브로드캐스트)
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testOfferAndLogSameMoment.ts
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';
import { getCommitSeq } from '@/lib/turnCommit';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });

let gameId = '';
let aId = '';
let bId = '';
let placed = new Set<string>();
let pickedBonus = new Set<string>();
const upgradedBy = new Set<string>();
let finished = false;
const notes: string[] = [];

const dist = (a: any, b: any) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

const done = (ok: boolean, extra: string[] = []) => {
	if (finished) return;
	finished = true;
	for (const l of [...notes, ...extra]) console.log(l);
	A.close(); B.close();
	process.exit(ok ? 0 : 1);
};
setTimeout(() => done(false, ['시간 초과 — 제안을 만들지 못했다']), 120_000);

A.on('connect', () => {
	A.emit('admin_set_mcts_time_ms', { timeMs: 50 }, () => {
		A.emit('admin_set_bot_delay_ms', { delayMs: 0 }, () => {
			A.emit('create_game', { playerName: 'Alpha' }, (res: any) => {
				if (!res?.gameId) done(false, ['create_game 실패']);
				gameId = res.gameId; aId = res.playerId;
				B.emit('join_game', { gameId, playerName: 'Beta' }, (r2: any) => {
					if (r2?.error) done(false, ['join_game 실패: ' + r2.error]);
					bId = r2.playerId;
					A.emit('auto_setup_test', { gameId, selfPlay: false });
				});
			});
		});
	});
});

/** 사람 좌석 공통 진행 — 시작 광산은 상대 사람 좌석에 가장 가까운 내 홈 행성 칸에 놓는다 */
function drive(sock: Socket, me: () => string, other: () => string, game: any) {
	const myTurn = game.turnOrder?.[game.currentPlayerIndex] === me();
	if (!myTurn) return;

	if (game.currentPhase === 'startingMines') {
		const fac = game.players[me()]?.faction;
		const home = FACTIONS.find((f: any) => f.id === fac)?.homePlanet;
		const theirs = (game.map || []).filter((t: any) => t.ownerId === other() && t.structure);
		const free = (game.map || []).filter((t: any) => !t.ownerId && t.type === home && !placed.has(t.id));
		const t = free.sort((x: any, y: any) => {
			const dx = theirs.length ? Math.min(...theirs.map((o: any) => dist(x, o))) : 0;
			const dy = theirs.length ? Math.min(...theirs.map((o: any) => dist(y, o))) : 0;
			return dx - dy;
		})[0];
		if (t) { placed.add(t.id); sock.emit('place_starting_mine', { gameId, tileId: t.id, factionId: fac }); }
		return;
	}
	if (game.currentPhase === 'bonusSelection' && !pickedBonus.has(me())) {
		const t = (game.availableBonusTiles || [])[0];
		if (t) { pickedBonus.add(me()); sock.emit('select_bonus_tile', { gameId, bonusTileId: t.id ?? t }); }
		return;
	}
	if (game.pendingIncomeOrder?.playerId === me()) {
		sock.emit('select_all_income_items', { gameId });
		setTimeout(() => sock.emit('finish_income_selection', { gameId }), 120);
		return;
	}
	if (game.currentPhase !== 'main') return;

	// 상대 2칸 안에 있는 내 광산을 교역소로 올린다 → 나중에 올리는 쪽이 먼저 올린 쪽에게 2파워 제안을 만든다
	if (!upgradedBy.has(me())) {
		const theirs = (game.map || []).filter((t: any) => t.ownerId === other() && t.structure);
		const mine = (game.map || []).filter((t: any) => t.ownerId === me() && t.structure === 'mine');
		const near = mine.find((m: any) => theirs.some((o: any) => dist(m, o) <= 2));
		if (near) {
			upgradedBy.add(me());
			notes.push(`${me() === aId ? '알파' : '베타'} ${near.id} 광산 → 교역소`);
			sock.emit('upgrade_structure', { gameId, tileId: near.id, target: 'trading_station' });
			return;
		}
		if (mine.length && theirs.length) { done(false, ['RETRY 이 맵에선 서로 2칸 안에 올릴 광산이 없다']); return; }
		return;
	}
	if (game.hasDoneMainAction) { sock.emit('end_turn', { gameId }); return; }
	// 이미 올렸는데 이번 턴 액션이 없으면 패스한다(라운드를 굴려 상대 차례가 오게)
	{ const t = (game.availableBonusTiles || [])[0]; if (t) sock.emit('pass_round', { gameId, newBonusTileId: t.id ?? t }); }
}

let lastA: any = null, lastB: any = null;
let ap = '';
// 브로드캐스트가 멎으면 재시도가 영영 안 온다. 조용히 거부되는 end_turn(의회/이클립스 대기 등)을 위해 주기적으로 다시 민다.
setInterval(() => { if (finished) return; if (lastA) drive(A, () => aId, () => bId, lastA); if (lastB) drive(B, () => bId, () => aId, lastB); }, 600);

/** 제안이 뜬 순간, 클라이언트와 똑같은 규칙으로 '남의 로그가 가려져 있는지' 본다 */
function checkOffer(game: any, meId: string) {
	if (finished || !meId) return;
	const offer = (game.pendingPowerOffers ?? []).find((o: any) => o && !o.responded && o.targetPlayerId === meId);
	if (!offer) return;

	const commit = getCommitSeq(game);
	const logs = game.gameLog ?? [];
	const hidden = logs.filter((e: any) => commit !== null && typeof e.seq === 'number' && e.seq > commit && e.playerId !== meId);
	const srcLast = [...logs].reverse().find((e: any) => e.playerId === offer.sourcePlayerId);
	const srcHidden = !!srcLast && commit !== null && typeof srcLast.seq === 'number' && srcLast.seq > commit;

	notes.push(`제안 도착 — 받는 사람 ${game.players[meId]?.name}, 보낸 사람 ${game.players[offer.sourcePlayerId]?.name}, +${offer.amount}파워 VP${offer.vpCost}`);
	const checks: Array<[boolean, string]> = [
		[!!game.pendingTurnEndPlayerId, '제안이 뜬 순간 턴 종료 대기 상태다'],
		[commit === null, `그래서 감출 줄이 없다 (getCommitSeq=${commit})`],
		[hidden.length === 0, `남의 로그가 한 줄도 안 가려져 있다 (가려진 줄 ${hidden.length})`],
		[!srcHidden, `제안을 보낸 사람의 마지막 로그가 보인다 ("${srcLast?.action ?? '없음'}")`],
	];
	done(checks.every(([ok]) => ok), ['', ...checks.map(([ok, m]) => `${ok ? 'PASS' : 'FAIL'}  ${m}`)]);
}

B.on('game_updated', (game: any) => {
	if (finished || !game?.players) return;
	lastB = game;
	drive(B, () => bId, () => aId, game);
	checkOffer(game, bId);
});

A.on('game_updated', (game: any) => {
	if (finished || !game?.players) return;
	lastA = game;
	if (process.env.VERBOSE) {
		const k = `${game.currentPhase}/${game.roundNumber}/${game.turnOrder?.[game.currentPlayerIndex] === aId ? 'A' : game.turnOrder?.[game.currentPlayerIndex] === bId ? 'B' : 'bot'}/${game.hasDoneMainAction}/${(game.pendingPowerOffers ?? []).length}/q${(game.queuedPowerOffers ?? []).length}/pte${game.pendingTurnEndPlayerId ? 'Y' : '.'}`;
		if (k !== ap) { ap = k; console.log('  [A본]', k); }
	}
	drive(A, () => aId, () => bId, game);
	checkOffer(game, aId);
});
A.on('game_error', (e: any) => { if (process.env.VERBOSE) console.log('  [A오류]', e?.message); });
B.on('game_error', (e: any) => { if (process.env.VERBOSE) console.log('  [B오류]', e?.message); });
