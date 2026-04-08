/**
 * 종족 비딩(경매) — gameState에서 executeSelectFaction 등을 주입받아 순환 참조 방지
 */
import type { Server as SocketIOServer } from 'socket.io';
import { FACTIONS, type FactionBiddingState } from '@shared/gameConfig';
import type { ServerGameState } from './gameState';

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** 서로 다른 행성 색상을 가진 N개 종족 ID (무작위) */
export function pickDistinctFactionIdsForPlayerCount(n: number): string[] {
	const byColor = new Map<string, string[]>();
	for (const f of FACTIONS) {
		const c = f.color;
		if (!byColor.has(c)) byColor.set(c, []);
		byColor.get(c)!.push(f.id);
	}
	const colors = shuffle(Array.from(byColor.keys()));
	const picked: string[] = [];
	for (const color of colors) {
		if (picked.length >= n) break;
		const ids = byColor.get(color)!;
		picked.push(ids[Math.floor(Math.random() * ids.length)]);
	}
	if (picked.length < n) {
		const rest = FACTIONS.map(f => f.id).filter(id => !picked.includes(id));
		for (const id of shuffle(rest)) {
			if (picked.length >= n) break;
			const fac = FACTIONS.find(f => f.id === id);
			if (!fac) continue;
			if (picked.some(pid => FACTIONS.find(x => x.id === pid)?.color === fac.color)) continue;
			picked.push(id);
		}
	}
	return picked.slice(0, n);
}

function humanIdsWithoutFaction(game: ServerGameState): string[] {
	const bots = game.botPlayerIds ?? [];
	return Object.keys(game.players).filter(
		pid => !bots.includes(pid) && !game.players[pid].faction
	);
}

function sortByTurnOrder(game: ServerGameState, ids: string[]): string[] {
	const order = game.turnOrder ?? Object.keys(game.players);
	return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function nextBidderInOrder(
	baseOrder: string[],
	inAuction: Set<string>,
	afterId: string | null
): string | null {
	if (inAuction.size === 0) return null;
	if (!afterId) {
		for (const id of baseOrder) {
			if (inAuction.has(id)) return id;
		}
		return null;
	}
	const start = baseOrder.indexOf(afterId);
	if (start < 0) return null;
	for (let k = 1; k <= baseOrder.length; k++) {
		const id = baseOrder[(start + k) % baseOrder.length];
		if (inAuction.has(id)) return id;
	}
	return null;
}

export type FactionBiddingDeps = {
	executeSelectFaction: (
		io: SocketIOServer,
		game: ServerGameState,
		playerId: string,
		factionId: string,
		turnOrder?: number,
		options?: { skipBotTrigger?: boolean }
	) => boolean;
	finalizeFactionSelectionToStartingMines: (io: SocketIOServer, game: ServerGameState) => void;
};

/** 봇에게 랜덤 종족·턴 배정 후 풀에서 제거 */
export function assignBotsForFactionBidding(
	game: ServerGameState,
	io: SocketIOServer,
	pool: string[],
	deps: FactionBiddingDeps
): string[] {
	const bots = game.botPlayerIds ?? [];
	const n = Object.keys(game.players).length;
	const turns = shuffle(Array.from({ length: n }, (_, i) => i + 1));
	let ti = 0;
	for (const bid of bots) {
		const p = game.players[bid];
		if (!p || p.faction) continue;
		if (pool.length === 0) break;
		const fi = Math.floor(Math.random() * pool.length);
		const factionId = pool.splice(fi, 1)[0];
		const turnOrder = turns[ti++]!;
		p.factionBidVp = 0;
		deps.executeSelectFaction(io, game, bid, factionId, turnOrder, { skipBotTrigger: true });
	}
	return pool;
}

export function startNewAuctionRound(
	game: ServerGameState,
	io: SocketIOServer,
	remainingFactionIds: string[],
	deps: FactionBiddingDeps
): void {
	const humans = sortByTurnOrder(game, humanIdsWithoutFaction(game));

	if (humans.length === 0) {
		game.factionBidding = null;
		if (Object.values(game.players).every(p => p.faction != null)) {
			deps.finalizeFactionSelectionToStartingMines(io, game);
		}
		return;
	}

	const fb: FactionBiddingState = {
		phase: 'bidding',
		remainingFactionIds: [...remainingFactionIds],
		auctionBaseOrder: [],
		inAuction: [],
		currentBidderId: null,
		currentHighBid: 0,
		leaderId: null,
		pickPlayerId: null,
		pendingWinningBid: 0,
	};
	game.factionBidding = fb;

	if (humans.length === 1) {
		const pid = humans[0]!;
		const lastFac = fb.remainingFactionIds[0];
		if (!lastFac) {
			game.factionBidding = null;
			return;
		}
		const used = new Set(
			Object.values(game.players)
				.map(p => (p as { selectedTurnOrder?: number }).selectedTurnOrder)
				.filter((x): x is number => typeof x === 'number')
		);
		const avail = Array.from({ length: Object.keys(game.players).length }, (_, i) => i + 1).filter(
			o => !used.has(o)
		);
		const turnOrder = avail[0] ?? 1;
		game.players[pid].factionBidVp = 0;
		deps.executeSelectFaction(io, game, pid, lastFac, turnOrder, { skipBotTrigger: true });
		return;
	}

	fb.auctionBaseOrder = humans;
	fb.inAuction = [...humans];
	fb.currentHighBid = 0;
	fb.leaderId = null;
	fb.pickPlayerId = null;
	fb.pendingWinningBid = 0;
	fb.currentBidderId = nextBidderInOrder(fb.auctionBaseOrder, new Set(fb.inAuction), null);
}

export function initFactionBiddingPhase(
	game: ServerGameState,
	io: SocketIOServer,
	deps: FactionBiddingDeps
): void {
	const n = Object.keys(game.players).length;
	let pool = pickDistinctFactionIdsForPlayerCount(n);
	pool = shuffle(pool);
	pool = assignBotsForFactionBidding(game, io, pool, deps);
	startNewAuctionRound(game, io, pool, deps);
}

export function processFactionBidRaise(
	game: ServerGameState,
	playerId: string,
	newBid: number
): string | null {
	const fb = game.factionBidding;
	if (!fb || game.currentPhase !== 'factionBidding' || fb.phase !== 'bidding') return '비딩 단계가 아닙니다.';
	if (fb.currentBidderId !== playerId) return '당신 차례가 아닙니다.';
	const minBid = fb.currentHighBid === 0 ? 1 : fb.currentHighBid + 1;
	if (newBid < minBid) return `최소 ${minBid} 이상 입찰해야 합니다.`;

	fb.currentHighBid = newBid;
	fb.leaderId = playerId;
	const inSet = new Set(fb.inAuction);
	fb.currentBidderId = nextBidderInOrder(fb.auctionBaseOrder, inSet, playerId);
	return null;
}

export function processFactionBidPass(game: ServerGameState, playerId: string): string | null {
	const fb = game.factionBidding;
	if (!fb || game.currentPhase !== 'factionBidding' || fb.phase !== 'bidding') return '비딩 단계가 아닙니다.';
	if (fb.currentBidderId !== playerId) return '당신 차례가 아닙니다.';

	const idx = fb.inAuction.indexOf(playerId);
	if (idx >= 0) fb.inAuction.splice(idx, 1);

	if (fb.inAuction.length === 1) {
		const winner = fb.inAuction[0]!;
		let winBid = fb.currentHighBid;
		if (fb.leaderId == null) winBid = 1;
		fb.phase = 'pick';
		fb.pickPlayerId = winner;
		fb.pendingWinningBid = winBid;
		fb.currentBidderId = null;
		return null;
	}

	if (fb.inAuction.length === 0) return '경매 상태 오류';

	const inSet = new Set(fb.inAuction);
	fb.currentBidderId = nextBidderInOrder(fb.auctionBaseOrder, inSet, playerId);
	if (!fb.currentBidderId) {
		fb.currentBidderId = nextBidderInOrder(fb.auctionBaseOrder, inSet, null);
	}
	return null;
}

export function processFactionBidPick(
	game: ServerGameState,
	io: SocketIOServer,
	playerId: string,
	factionId: string,
	turnOrder: number,
	deps: FactionBiddingDeps
): string | null {
	const fb = game.factionBidding;
	if (!fb || game.currentPhase !== 'factionBidding' || fb.phase !== 'pick') return '선택 단계가 아닙니다.';
	if (fb.pickPlayerId !== playerId) return '낙찰자만 선택할 수 있습니다.';

	if (!fb.remainingFactionIds.includes(factionId)) return '선택할 수 없는 종족입니다.';

	const taken = Object.entries(game.players).some(
		([id, p]) =>
			id !== playerId &&
			(p as { selectedTurnOrder?: number }).selectedTurnOrder === turnOrder
	);
	if (taken) return '이미 사용 중인 턴 순서입니다.';

	const bid = fb.pendingWinningBid;
	game.players[playerId].factionBidVp = bid;

	const ok = deps.executeSelectFaction(io, game, playerId, factionId, turnOrder, { skipBotTrigger: true });
	if (!ok) {
		game.players[playerId].factionBidVp = 0;
		return '종족 선택에 실패했습니다.';
	}

	const nextPool = fb.remainingFactionIds.filter(id => id !== factionId);
	game.factionBidding = null;

	const humansLeft = humanIdsWithoutFaction(game);
	if (humansLeft.length > 0) {
		startNewAuctionRound(game, io, nextPool, deps);
	}

	return null;
}
