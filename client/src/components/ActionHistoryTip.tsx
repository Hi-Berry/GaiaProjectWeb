/**
 * [사용자 2026-10-06] 액션 칸(파워 액션·우주선 액션)에 마우스를 올리고 잠깐 있으면 1라운드부터 그 칸을 쓴 종족 기록을
 * 툴팁으로 보여 준다. 영역을 벗어나면 사라진다.
 *
 * 기록 출처 = 게임 로그(서버 변경 없이 진행 중인 게임에도 바로 적용). 롤백된 줄(rolledBack)은 제외.
 *  - 파워 액션: action 'Power Action', details의 효과 문구로 칸 식별(서버 executeUsePowerAction 로그 문구와 1:1).
 *  - 우주선 액션: 배 종류마다 한 척이고 칸마다 로그 문구가 고유(서버 executeUseShipAction·소켓 경로 문구)라 문구로 칸 식별.
 *    트왈 #1은 보상을 고를 때 'Twilight: Federation benefit / Spaceship Fed'로 남는다(인공물 경로는 'Artifact: …'라 제외됨).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { FACTIONS, type GaiaGameState as GameState } from '@shared/gameConfig';

export interface ActionUse { round: number; playerId: string; name: string }
export type ActionHistory = Record<string, ActionUse[]>;

const POWER_BY_EFFECT: [RegExp, string][] = [
	[/^\+3 Knowledge/, 'gain-3-knowledge'],
	[/^\+2 Terraform steps/, 'gain-2-steps'],
	[/^\+2 Ore/, 'gain-2-ore'],
	[/^\+7 Credits/, 'gain-7-credits'],
	[/^\+2 Knowledge/, 'gain-2-knowledge'],
	[/^\+1 Terraform step/, 'gain-1-step'],
	[/^\+2 Power tokens/, 'gain-2-tokens'],
];

const SHIP_BY_ACTION: [RegExp, string][] = [
	[/^Twilight: (Federation benefit|Spaceship Fed)/, 'ship:ship_twilight:1'],
	[/^Twilight: TS → Research Lab/, 'ship:ship_twilight:2'],
	[/^Twilight: \+3 Range/, 'ship:ship_twilight:3'],
	[/^Rebellion: Gain tech tile/, 'ship:ship_rebellion:1'],
	[/^Rebellion: Mine → TS/, 'ship:ship_rebellion:2'],
	[/^Rebellion: 2K → 1Q 2C/, 'ship:ship_rebellion:3'],
	[/^TF Mars: Tech tiles \+ 2 VP/, 'ship:ship_tf_mars:1'],
	[/^TF Mars: Gaia Project/, 'ship:ship_tf_mars:2'],
	[/^TF Mars: 3C → 1 Terraform/, 'ship:ship_tf_mars:3'],
	[/^Eclipse: Planet types \+ 2 VP/, 'ship:ship_eclipse:1'],
	[/^Eclipse: 2K\+3P → Research/, 'ship:ship_eclipse:2'],
	[/^Eclipse: 6C → Build mine on asteroid/, 'ship:ship_eclipse:3'],
];

export const powerKey = (actionId: string) => `power:${actionId}`;
export const shipKey = (shipType: string, actionNum: number) => `ship:${shipType}:${actionNum}`;

/** 게임 로그 → 칸별 사용 기록(시간순) */
export function useActionHistory(game: GameState): ActionHistory {
	const log = (game as any).gameLog as any[] | undefined;
	const sig = `${log?.length ?? 0}:${log?.[log.length - 1]?.seq ?? ''}:${log?.filter?.((e: any) => e?.rolledBack).length ?? 0}`;
	return useMemo(() => {
		const out: ActionHistory = {};
		for (const e of log ?? []) {
			if (!e || e.rolledBack || !e.playerId) continue;
			let key: string | null = null;
			if (e.action === 'Power Action') {
				const hit = POWER_BY_EFFECT.find(([re]) => re.test(String(e.details ?? '')));
				if (hit) key = powerKey(hit[1]);
			} else {
				const hit = SHIP_BY_ACTION.find(([re]) => re.test(String(e.action ?? '')));
				if (hit) key = hit[1];
			}
			if (!key) continue;
			(out[key] ??= []).push({ round: Number(e.round ?? 0), playerId: e.playerId, name: e.playerName ?? game.players?.[e.playerId]?.name ?? '?' });
		}
		return out;
	}, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** 길게 누르기로 인정하는 시간·손가락 흔들림 허용치 */
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

/**
 * 액션 칸 래퍼: 마우스는 잠깐 머무르면, 터치는 길게 누르면 사용 기록 툴팁.
 * [사용자 제보 2026-10-09] "폰으로는 잘 안 되고, 어떻게 하는지도 모르겠고, 잠깐 보였다가 사라진다"
 *   툴팁은 마우스 올리기 전용이라 터치로는 열 방법이 없었다. 짧게 누르면 칸 안의 액션 버튼이 눌려(내 차례면 실행)
 *   그 포커스로 잠깐 열렸다가, 다른 곳을 누르면 바로 닫혔다.
 *   → 터치: 길게 누르면(0.45초) 열고 그 누름은 액션으로 넘기지 않는다. 다른 곳을 누를 때까지 열어 둔다.
 *     짧게 누르면 지금처럼 액션 — 그때 생기는 '포커스로 잠깐 열림'은 막는다. 사용법은 모바일 패널 제목 옆에 늘 적어 둔다
 *     (팝업 안내는 짧게 누를 때 뜨는 액션 안내에 바로 덮였다 — 안내는 한 번에 하나만 보인다).
 */
export function ActionHistoryTip({ game, uses, title, children }: { game: GameState; uses: ActionUse[] | undefined; title: string; children: ReactNode }) {
	const round = game.roundNumber ?? 0;
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false); // 길게 눌러 연 상태 — 바깥을 누를 때까지 유지
	const lastPointer = useRef<string>('mouse');
	const timer = useRef<number | null>(null);
	const start = useRef<{ x: number; y: number } | null>(null);
	const swallowClick = useRef(false);
	const triggerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);

	const clearTimer = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
	useEffect(() => () => clearTimer(), []);

	// 길게 눌러 연 뒤엔 바깥을 누르면 닫는다
	useEffect(() => {
		if (!pinned) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (triggerRef.current?.contains(t) || contentRef.current?.contains(t)) return;
			setPinned(false); setOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [pinned]);

	const onPointerDown = (e: React.PointerEvent) => {
		lastPointer.current = e.pointerType;
		if (e.pointerType === 'mouse') return;
		clearTimer();
		start.current = { x: e.clientX, y: e.clientY };
		timer.current = window.setTimeout(() => {
			timer.current = null;
			swallowClick.current = true;
			setPinned(true); setOpen(true);
		}, LONG_PRESS_MS);
	};
	const onPointerMove = (e: React.PointerEvent) => {
		if (e.pointerType === 'mouse' || !start.current || timer.current === null) return;
		if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) clearTimer(); // 스크롤·스와이프
	};
	const onPointerEnd = () => { clearTimer(); start.current = null; };
	// 길게 누른 직후 따라오는 click 은 칸 안 버튼(액션)으로 내려보내지 않는다
	const onClickCapture = (e: React.MouseEvent) => {
		if (swallowClick.current) { swallowClick.current = false; e.preventDefault(); e.stopPropagation(); }
	};
	const onOpenChange = (next: boolean) => {
		if (next) {
			if (lastPointer.current !== 'mouse') return; // 터치의 '포커스로 잠깐 열림'은 막는다 — 터치는 길게 누르기로만 연다
			setOpen(true);
		} else {
			if (pinned) return; // 손가락을 떼며 생기는 닫힘 신호는 무시(바깥을 눌러야 닫힌다)
			setOpen(false);
		}
	};

	return (
		<Tooltip delayDuration={350} disableHoverableContent open={open} onOpenChange={onOpenChange}>
			<TooltipTrigger asChild>
				<div
					ref={triggerRef}
					className="relative h-full border-r last:border-r-0 border-black/30 select-none [-webkit-touch-callout:none]"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerEnd}
					onPointerCancel={onPointerEnd}
					onClickCapture={onClickCapture}
					onContextMenu={(e) => { if (lastPointer.current !== 'mouse') e.preventDefault(); }}
				>{children}</div>
			</TooltipTrigger>
			<TooltipContent ref={contentRef} side="top" className="bg-zinc-950/95 border-white/15 text-zinc-100 px-2.5 py-2 max-w-[220px]">
				<div className="text-[11px] font-black text-amber-200 mb-1">{title}</div>
				{!uses?.length && <div className="text-[10px] text-zinc-500">아직 사용한 사람이 없습니다</div>}
				{!!uses?.length && (
					<div className="space-y-0.5">
						{uses.map((u, i) => {
							const fac = FACTIONS.find((f) => f.id === (game.players?.[u.playerId] as any)?.faction);
							const now = u.round === round;
							return (
								<div key={i} className={`flex items-center gap-1.5 text-[10px] leading-tight ${now ? 'text-zinc-100' : 'text-zinc-400'}`}>
									<span className={`w-6 shrink-0 tabular-nums font-bold ${now ? 'text-amber-300' : 'text-zinc-500'}`}>R{u.round}</span>
									<span className="w-2 h-2 rounded-full shrink-0 border border-white/50" style={{ backgroundColor: fac?.color ?? '#666' }} />
									<span className="truncate">{fac?.name ?? '?'} <span className="text-zinc-500">({u.name})</span></span>
								</div>
							);
						})}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}
