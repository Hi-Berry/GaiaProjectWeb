/**
 * [사용자 2026-11-19] "폰으로 딴거 하고 있을 때 내 폰 위에 알람" — 웹 푸시(PWA).
 *
 * 기존 내 차례 알림(client/src/lib/turnNotify.ts)은 열린 탭이 직접 띄우는 방식이라, 폰에서 다른 앱을 쓰거나
 * 화면이 꺼지면 브라우저가 페이지를 멈춰 알림이 안 왔다. 웹 푸시는 서버 → 구글/애플 푸시 서비스 → 폰으로
 * 가므로 게임 화면이 닫혀 있어도 잠금화면/알림창에 뜬다.
 *
 * 흐름
 *  1. 클라가 알림을 켜면 서비스 워커로 구독을 만들고 `push_subscribe`로 (gameId, playerId, 구독)을 보낸다.
 *  2. 서버는 상태를 내보낼 때마다(emitGameUpdated) '각 플레이어가 지금 처리해야 할 일' 목록을 계산하고,
 *     새로 생긴 일이 있으면 잠깐(PUSH_DELAY_MS) 기다렸다가 아직 그대로면 푸시를 보낸다.
 *  3. 그 사람이 게임 화면을 '보고 있으면'(보이고 + 포커스) 보내지 않는다 — 클라가 `push_presence`로 알려준다.
 *
 * 저장: data/push-subscriptions.json (구독), data/vapid-keys.json (서명 키 — 비밀, 커밋 금지).
 *  키는 환경변수 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 가 있으면 그걸 쓴다. 키가 바뀌면 기존 구독은 전부 무효.
 */
import * as fs from 'fs';
import * as path from 'path';
import webpush from 'web-push';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const KEYS_FILE = path.join(DATA_DIR, 'vapid-keys.json');
/** 구독은 게임 단위라 오래된 건 정리 — 게임이 아무리 길어도 이 정도면 충분 */
const SUB_TTL_MS = 21 * 24 * 60 * 60 * 1000;
/** 상태가 잠깐 스쳐 지나가는 경우(봇이 즉시 처리 등) 오발 방지 + 보고 있는지 판정할 여유 */
const PUSH_DELAY_MS = Number(process.env.PUSH_DELAY_MS ?? 2500);

interface StoredSub {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	gameId: string;
	playerId: string;
	/** 사용자 지정 알림 문구(스텔스용). 비어 있으면 기본 문구 */
	title?: string;
	body?: string;
	updatedAt: number;
}

let vapidPublicKey = '';
let ready = false;
let subs: StoredSub[] = [];
let saveTimer: NodeJS.Timeout | null = null;
let getGameFn: (gameId: string) => any = () => undefined;

/** gameId → (playerId → 지금 처리해야 할 일 키 목록) — 직전 상태와 비교해 '새로 생긴 일'만 알린다 */
const prevAttention = new Map<string, Map<string, Set<string>>>();
/** `${gameId}|${playerId}` → 대기 중인 발송 타이머 */
const pendingTimers = new Map<string, NodeJS.Timeout>();
/** `${gameId}|${playerId}` → (socketId → 화면을 보고 있는지) */
const presence = new Map<string, Map<string, boolean>>();

function log(msg: string) {
	console.log(`[push] ${msg}`);
}

function loadKeys(): { publicKey: string; privateKey: string } {
	const envPub = process.env.VAPID_PUBLIC_KEY;
	const envPriv = process.env.VAPID_PRIVATE_KEY;
	if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv };
	try {
		const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
		if (j?.publicKey && j?.privateKey) return j;
	} catch { /* 없으면 새로 만든다 */ }
	const keys = webpush.generateVAPIDKeys();
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
	log(`새 VAPID 키 생성 → ${KEYS_FILE}`);
	return keys;
}

function loadSubs() {
	try {
		const arr = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
		const now = Date.now();
		subs = Array.isArray(arr) ? arr.filter((s: StoredSub) => s?.endpoint && s?.keys && now - (s.updatedAt ?? 0) < SUB_TTL_MS) : [];
	} catch {
		subs = [];
	}
}

function scheduleSave() {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		try {
			fs.mkdirSync(DATA_DIR, { recursive: true });
			fs.writeFileSync(SUBS_FILE, JSON.stringify(subs), 'utf8');
		} catch (e) {
			log(`구독 저장 실패: ${(e as Error).message}`);
		}
	}, 1000);
}

export function initPush(getGame: (gameId: string) => any) {
	getGameFn = getGame;
	try {
		const keys = loadKeys();
		vapidPublicKey = keys.publicKey;
		// 애플 푸시는 subject가 '@localhost' 같은 값이면 BadJwtToken으로 거절한다 → 실제 형식의 값을 쓴다.
		const subject = process.env.VAPID_SUBJECT || 'mailto:gaia-push@example.com';
		webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
		loadSubs();
		ready = true;
		log(`준비 완료 (구독 ${subs.length}개)`);
	} catch (e) {
		ready = false;
		log(`초기화 실패 — 웹 푸시 비활성: ${(e as Error).message}`);
	}
}

export function getVapidPublicKey(): string | null {
	return ready ? vapidPublicKey : null;
}

function hasSubsForGame(gameId: string): boolean {
	return subs.some(s => s.gameId === gameId);
}

export function addSubscription(input: {
	gameId: string;
	playerId: string;
	subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
	title?: string;
	body?: string;
}): { ok: boolean; error?: string } {
	if (!ready) return { ok: false, error: '서버에서 웹 푸시가 꺼져 있습니다.' };
	const { gameId, playerId, subscription } = input;
	const endpoint = subscription?.endpoint;
	const p256dh = subscription?.keys?.p256dh;
	const auth = subscription?.keys?.auth;
	if (!gameId || !playerId || !endpoint || !p256dh || !auth) return { ok: false, error: '구독 정보가 올바르지 않습니다.' };
	if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return { ok: false, error: '구독 주소가 올바르지 않습니다.' };
	const clip = (s: unknown) => (typeof s === 'string' ? s.slice(0, 120) : '');
	const rec: StoredSub = {
		endpoint,
		keys: { p256dh, auth },
		gameId,
		playerId,
		title: clip(input.title),
		body: clip(input.body),
		updatedAt: Date.now(),
	};
	const i = subs.findIndex(s => s.endpoint === endpoint && s.gameId === gameId && s.playerId === playerId);
	if (i >= 0) subs[i] = rec; else subs.push(rec);
	scheduleSave();
	return { ok: true };
}

/** 알림을 끄면 이 기기(endpoint)의 구독을 지운다. gameId가 없으면 모든 게임에서 지운다. */
export function removeSubscription(endpoint: string, gameId?: string) {
	const before = subs.length;
	subs = subs.filter(s => !(s.endpoint === endpoint && (!gameId || s.gameId === gameId)));
	if (subs.length !== before) scheduleSave();
}

export function setPresence(gameId: string, playerId: string, socketId: string, active: boolean) {
	const k = `${gameId}|${playerId}`;
	let m = presence.get(k);
	if (!m) { m = new Map(); presence.set(k, m); }
	m.set(socketId, active);
}

export function clearSocketPresence(socketId: string) {
	presence.forEach((m, k) => {
		m.delete(socketId);
		if (m.size === 0) presence.delete(k);
	});
}

function isWatching(gameId: string, playerId: string): boolean {
	const m = presence.get(`${gameId}|${playerId}`);
	if (!m) return false;
	let any = false;
	m.forEach(v => { if (v) any = true; });
	return any;
}

type Reason = { key: string; priority: number; title: string; body: string };

/** 각 플레이어가 지금 '처리해야 할 일' — 클라 알림(내 차례·파워 충전·롤백 동의·입찰) 조건과 같게 맞춘다. */
function computeAttention(game: any): Map<string, Reason[]> {
	const out = new Map<string, Reason[]>();
	if (!game || game.replay || game.simulation || game.headless) return out;
	if (game.currentPhase === 'gameEnd' || game.currentPhase === 'lobby') return out;
	const bots: string[] = game.botPlayerIds ?? [];
	const add = (pid: string | undefined | null, r: Reason) => {
		if (!pid || bots.includes(pid) || !game.players?.[pid]) return;
		const arr = out.get(pid) ?? [];
		arr.push(r);
		out.set(pid, arr);
	};
	const nameOf = (pid: string) => game.players?.[pid]?.name ?? '';
	const turnBody = (pid: string) => `${nameOf(pid) ? nameOf(pid) + ', ' : ''}행동할 차례입니다.`;

	// 1) 롤백 동의 요청
	const pr = game.pendingRollback;
	if (pr && Array.isArray(pr.required)) {
		for (const pid of pr.required as string[]) {
			if ((pr.approvals ?? []).includes(pid)) continue;
			add(pid, {
				key: `rollback|${pr.requesterId}|${pr.seq}|${pr.ordinal ?? ''}`,
				priority: 4,
				title: '가이아 프로젝트 — 롤백 동의 요청',
				body: `${pr.requesterName ?? '다른 플레이어'}님이 롤백을 요청했습니다.`,
			});
		}
	}

	// 2) 파워 충전 결정
	const offers: Array<{ responded?: boolean; targetPlayerId?: string }> = game.pendingPowerOffers ?? [];
	const offerTargets = new Set(offers.filter(o => o && !o.responded && o.targetPlayerId).map(o => o.targetPlayerId!));
	offerTargets.forEach(pid => add(pid, {
		key: 'power',
		priority: 3,
		title: '가이아 프로젝트 — 파워 충전 결정',
		body: `${nameOf(pid) ? nameOf(pid) + ', ' : ''}파워 충전 여부를 결정하세요.`,
	}));

	// 3) 종족 입찰 / 낙찰 후 종족 픽
	const fb = game.factionBidding;
	if (game.currentPhase === 'factionBidding' && fb) {
		const bidder = fb.phase === 'pick' ? fb.pickPlayerId : fb.currentBidderId;
		add(bidder, {
			key: `bid|${fb.phase}|${bidder}|${fb.currentHighBid ?? ''}`,
			priority: 2,
			title: '가이아 프로젝트 — 당신 차례',
			body: fb.phase === 'pick' ? '종족을 고를 차례입니다.' : '입찰할 차례입니다.',
		});
	}

	// 4) 보너스 타일 선택
	if (game.pendingBonusSelection) {
		add(game.pendingBonusSelection, {
			key: `bonus|${game.roundNumber}`,
			priority: 1,
			title: '가이아 프로젝트 — 당신 차례',
			body: '보너스 타일을 고를 차례입니다.',
		});
	}

	// 5) 일반 차례 (시작 광산·종족 선택·메인)
	if (game.currentPhase !== 'factionBidding' && Array.isArray(game.turnOrder)) {
		const pid = game.turnOrder[game.currentPlayerIndex];
		add(pid, {
			key: `turn|${game.currentPhase}|${game.roundNumber}|${game.turnEndCount ?? 0}|${game.currentPlayerIndex}`,
			priority: 1,
			title: '가이아 프로젝트 — 당신 차례',
			body: turnBody(pid),
		});
	}
	return out;
}

/** emitGameUpdated에서 매번 호출 — 구독이 있는 게임만 계산하므로 평소 비용은 거의 0 */
export function notePushState(game: any) {
	if (!ready || !game?.id) return;
	const gameId: string = game.id;
	if (!hasSubsForGame(gameId)) { prevAttention.delete(gameId); return; }
	const cur = computeAttention(game);
	const prev = prevAttention.get(gameId);
	const next = new Map<string, Set<string>>();
	cur.forEach((reasons, pid) => next.set(pid, new Set(reasons.map(r => r.key))));
	prevAttention.set(gameId, next);
	if (!prev) return; // 서버 시작/첫 계산에선 보내지 않는다(재시작 시 일제 발송 방지)
	cur.forEach((reasons, pid) => {
		const before = prev.get(pid);
		const fresh = reasons.filter(r => !before?.has(r.key));
		if (fresh.length === 0) return;
		schedulePush(gameId, pid);
	});
}

function schedulePush(gameId: string, playerId: string) {
	const k = `${gameId}|${playerId}`;
	if (pendingTimers.has(k)) return;
	pendingTimers.set(k, setTimeout(() => {
		pendingTimers.delete(k);
		const game = getGameFn(gameId);
		if (!game) return;
		const reasons = computeAttention(game).get(playerId);
		if (!reasons || reasons.length === 0) return; // 그 사이 처리됨
		if (isWatching(gameId, playerId)) return;
		const top = reasons.slice().sort((a, b) => b.priority - a.priority)[0];
		void sendToPlayer(gameId, playerId, top);
	}, PUSH_DELAY_MS));
}

async function sendToPlayer(gameId: string, playerId: string, reason: Reason) {
	const targets = subs.filter(s => s.gameId === gameId && s.playerId === playerId);
	for (const s of targets) {
		const custom = s.title?.trim();
		const payload = JSON.stringify({
			title: custom || reason.title,
			body: custom ? (s.body ?? '') : reason.body,
			url: `/game/${encodeURIComponent(gameId)}`,
			tag: `gaia-${gameId}`,
		});
		try {
			await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 600, urgency: 'high' });
		} catch (e: any) {
			const code = e?.statusCode;
			if (code === 404 || code === 410) {
				// 브라우저가 구독을 해지했거나 만료 — 정리
				removeSubscription(s.endpoint);
			} else {
				log(`발송 실패 ${gameId}/${playerId} (${code ?? 'no status'}): ${e?.body || e?.message}`);
			}
		}
	}
}

/** 설정 화면의 "테스트" — 이 기기에 바로 한 번 보낸다(보고 있어도). */
export async function sendTestPush(gameId: string, playerId: string, endpoint: string): Promise<{ ok: boolean; error?: string }> {
	const s = subs.find(x => x.endpoint === endpoint && x.gameId === gameId && x.playerId === playerId);
	if (!s) return { ok: false, error: '이 기기의 구독을 찾지 못했습니다. 알림을 껐다 켜 주세요.' };
	try {
		const custom = s.title?.trim();
		await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({
			title: custom || '가이아 프로젝트 — 테스트 알림',
			body: custom ? (s.body ?? '') : '폰 알림이 정상적으로 동작합니다.',
			url: `/game/${encodeURIComponent(gameId)}`,
			tag: `gaia-test`,
		}), { TTL: 60, urgency: 'high' });
		return { ok: true };
	} catch (e: any) {
		if (e?.statusCode === 404 || e?.statusCode === 410) removeSubscription(s.endpoint);
		return { ok: false, error: `발송 실패 (${e?.statusCode ?? e?.message})` };
	}
}

/** 게임 삭제 시 정리 */
export function clearGamePush(gameId: string) {
	prevAttention.delete(gameId);
	const before = subs.length;
	subs = subs.filter(s => s.gameId !== gameId);
	if (subs.length !== before) scheduleSave();
}
