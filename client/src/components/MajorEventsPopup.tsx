/**
 * [사용자 2026-10-12] 주요 이벤트 알려주기 — 내 턴이 끝난 뒤 다시 내 턴이 오기 전에
 *   ① 누군가 연방을 선언했거나 ② 내가 타 있는 우주선에 누군가 입장했으면,
 * 내 턴이 시작될 때 화면 가운데에 팝업으로 알려 준다. '확인'을 눌러 닫은 뒤 턴을 진행한다.
 *
 * - 출처: 게임 로그(롤백된 줄 제외). 연방 = 'Federation' 줄(보상 = 그 줄 tileId 또는 바로 뒤 'Federation Reward' 줄),
 *   우주선 = 'Entered Ship' 줄(tileId = 우주선 칸) 중 지금 내가 탑승 중인 배.
 * - '어디까지 봤나'는 기기에 저장(gaia-<게임>-<좌석>-majorEventsSeq). 처음 열면 현재 위치로만 맞추고 띄우지 않는다
 *   (새로고침·중간 입장 때 지난 일이 한꺼번에 뜨지 않게).
 * - 설정: '?' 안내창 > 화면 표시 > '주요 이벤트 알려주기'(major-event-popup, 기본 켜짐).
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FACTIONS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, type GaiaGameState as GameState } from '@shared/gameConfig';
import { raceFaceSrc } from '@/lib/racePortrait';

const SHIP_NAME: Record<string, string> = { ship_twilight: '트와일라잇', ship_rebellion: '리벨리온', ship_tf_mars: 'TF 마스', ship_eclipse: '이클립스' };
const SHIP_IMG: Record<string, string> = { ship_rebellion: '/map/ts_112.png', ship_tf_mars: '/map/ts_113.png', ship_eclipse: '/map/ts_114.png', ship_twilight: '/map/ts_115.png' };

function fedRewardImg(rewardId?: string): string | null {
	if (!rewardId) return null;
	if (rewardId === GLEENS_FEDERATION_REWARD.id) return '/image/Federation_15.gif';
	const fi = FEDERATION_REWARDS.findIndex((f) => f.id === rewardId);
	if (fi !== -1) return `/image/Federation_${fi + 1}.gif`;
	const si = SPACESHIP_FEDERATION_REWARDS.findIndex((f) => f.id === rewardId);
	if (si !== -1) return `/image/Federation_${si + 7}.gif`;
	return null;
}
const isRewardId = (s?: string) => !!s && /^(gleens-fed-|ship-fed-|fed-)/i.test(s);

export const MAJOR_EVENT_POPUP_KEY = 'major-event-popup';
const enabled = () => { try { return localStorage.getItem(MAJOR_EVENT_POPUP_KEY) !== 'off'; } catch { return true; } };

interface MajorEvent { kind: 'federation' | 'ship'; playerId: string; name: string; faction?: string; round: number; img: string | null; shipType?: string; detail?: string }

export function MajorEventsPopup({ game, playerId }: { game: GameState; playerId: string | null }) {
	const [on, setOn] = useState(enabled);
	const [events, setEvents] = useState<MajorEvent[] | null>(null);
	const wasMyTurnStart = useRef(false);
	useEffect(() => {
		const f = (e: Event) => setOn(!!(e as CustomEvent).detail);
		window.addEventListener(`${MAJOR_EVENT_POPUP_KEY}-change`, f);
		return () => window.removeEventListener(`${MAJOR_EVENT_POPUP_KEY}-change`, f);
	}, []);

	const log = ((game as any).gameLog ?? []) as any[];
	const maxSeq = log.reduce((m, e) => (typeof e?.seq === 'number' && e.seq > m ? e.seq : m), -1);
	const me = playerId ? game.players?.[playerId] : undefined;
	const myTurnStart = !!me && game.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex ?? -1] === playerId
		&& !game.hasDoneMainAction && !(me as any).hasPassed;
	const key = playerId ? `gaia-${game.id}-${playerId}-majorEventsSeq` : '';

	useEffect(() => {
		if (!playerId || !me) return;
		const read = () => { try { const v = localStorage.getItem(key); return v == null ? null : Number(v); } catch { return null; } };
		const write = (n: number) => { try { localStorage.setItem(key, String(n)); } catch { /* 저장 실패는 무시 */ } };
		let seen = read();
		if (seen == null) { write(maxSeq); return; } // 처음 열었을 때: 지금 위치로만 맞춤
		const rising = myTurnStart && !wasMyTurnStart.current;
		wasMyTurnStart.current = myTurnStart;
		if (!rising) return;
		const myShips = new Set<string>(((me as any).spaceshipsEntered ?? []) as string[]);
		const found: MajorEvent[] = [];
		for (let i = 0; i < log.length; i++) {
			const e = log[i];
			if (!e || e.rolledBack || typeof e.seq !== 'number' || e.seq <= seen || e.playerId === playerId || !e.playerId) continue;
			const p: any = game.players?.[e.playerId];
			const base = { playerId: e.playerId, name: p?.name ?? e.playerName ?? '?', faction: p?.faction, round: Number(e.round ?? game.roundNumber ?? 0) };
			if (e.action === 'Federation') {
				let rid: string | undefined = isRewardId(e.tileId) ? e.tileId : undefined;
				if (!rid) { const nx = log.slice(i + 1, i + 4).find((x) => x?.playerId === e.playerId && x?.action === 'Federation Reward'); rid = isRewardId(nx?.tileId) ? nx.tileId : undefined; }
				found.push({ ...base, kind: 'federation', img: fedRewardImg(rid), detail: String(e.details ?? '') });
			} else if (e.action === 'Entered Ship' && myShips.has(e.tileId)) {
				const st = game.map?.find((t: any) => t.id === e.tileId)?.type as string | undefined;
				found.push({ ...base, kind: 'ship', shipType: st, img: st ? SHIP_IMG[st] ?? null : null });
			}
		}
		write(maxSeq);
		if (found.length && on) setEvents(found);
	}, [myTurnStart, maxSeq, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!events) return null;
	return (
		<Dialog open onOpenChange={(o) => { if (!o) setEvents(null); }}>
			<DialogContent className="max-w-md bg-zinc-950 border-white/15 text-zinc-100">
				<DialogHeader>
					<DialogTitle className="text-amber-300">내 턴 전에 일어난 일</DialogTitle>
					<DialogDescription className="text-zinc-400">지난 내 턴 이후 다른 플레이어의 주요 행동입니다.</DialogDescription>
				</DialogHeader>
				<div className="space-y-2 max-h-[55vh] overflow-y-auto">
					{events.map((ev, i) => {
						const fac = FACTIONS.find((f) => f.id === ev.faction);
						const face = ev.faction ? raceFaceSrc(ev.faction) : null;
						return (
							<div key={i} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
								<div className="w-10 h-12 shrink-0 rounded-md overflow-hidden border-2" style={{ borderColor: fac?.color ?? '#666' }}>
									{face ? <img src={face} alt={fac?.name ?? ''} className="w-full h-full object-cover" /> : <div className="w-full h-full" style={{ backgroundColor: fac?.color ?? '#444' }} />}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-[11px] text-zinc-400">R{ev.round} · <span className="font-bold" style={{ color: fac?.color ?? '#ddd' }}>{fac?.name ?? '?'}</span> ({ev.name})</div>
									<div className="text-sm font-black text-zinc-100">
										{ev.kind === 'federation' ? '연방을 선언했습니다' : `${SHIP_NAME[ev.shipType ?? ''] ?? '내가 탄'} 우주선에 입장했습니다`}
									</div>
									{ev.kind === 'federation' && ev.detail && <div className="text-[10px] text-zinc-500 truncate">{ev.detail}</div>}
								</div>
								{ev.img && (
									<img src={ev.img} alt="" className={`shrink-0 object-contain ${ev.kind === 'ship' ? 'w-14 h-14 -rotate-90' : 'w-12 h-12'}`} />
								)}
							</div>
						);
					})}
				</div>
				<Button className="w-full mt-1 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black" onClick={() => setEvents(null)}>확인</Button>
			</DialogContent>
		</Dialog>
	);
}
