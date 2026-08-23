/**
 * [사용자 2026-08-11] 편의기능 창 — 맵 우하단(로그를 안 가리게 맵 영역 기준)에 뜨는 보조 패널.
 * 채팅창처럼 헤더를 잡고 이동, X로 접기(메뉴 버튼으로 다시 열기). 순수 클라 기능이라 서버 통신 없음.
 *
 *  1) 예상 점수: '지금 이 보드로 게임이 끝나면' 몇 점인지 (현재/패스/트랙/미션/자원/비딩).
 *     최종 예상 점수가 아니다 — 남은 라운드의 패스 보너스·미션 진행분은 안 들어간다.
 *  2) 남은 땅: 맵에 아직 아무도 안 지은 행성을 유형별로 센다.
 *  3) 거리 측정기: A/B로 칸 두 개를 찍으면 헥스 거리를 보여준다.
 *     최종미션 '의회-아카데미 거리'(fm_pi_academy_distance)와 같은 getDistance를 쓴다.
 *
 * [사용자 2026-08-11] 넣을 기능이 계속 늘어날 예정이라 각 항목을 제목 클릭으로 여닫는 접이식으로 둔다.
 *   열림 상태는 항목별로 localStorage에 남아 다음에 열 때 그대로 복원된다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { getStoredSpectatorId } from '@/lib/gameClient';
import {
  PLANET_COLORS, FACTIONS, RESEARCH_TRACKS, RESEARCH_TRACK_END_BONUS, isHiddenSpectatorName,
  computeBonusTilePassVp, computeAdvancedTechPassVp, getFinalMissionVp, endgameLeftoverUnits,
  type GaiaGameState, type HexTile, type PlanetType, type ResearchTrack,
} from '@shared/gameConfig';
import { getDistance } from '@shared/gameConfig';

/** 접이식 항목 — 제목을 누르면 열리고 다시 누르면 닫힌다. 상태는 항목별 localStorage. */
function Section({ id, title, accent, children }: { id: string; title: string; accent: string; children: React.ReactNode }) {
  const key = `gaia-utility-sec-${id}`;
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(key); return v === null ? id === 'score' : v === '1'; } catch { return id === 'score'; }
  });
  useEffect(() => { try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* noop */ } }, [key, open]);
  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1.5 hover:bg-white/5 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0 text-zinc-500" /> : <ChevronRight className="w-3 h-3 shrink-0 text-zinc-500" />}
        <span className={`text-[9px] font-black uppercase tracking-wide ${accent}`}>{title}</span>
      </button>
      {open && <div className="px-2.5 pb-2">{children}</div>}
    </div>
  );
}

/** 예상 점수를 볼 수 있는 이름.
 *
 *  [2026-08-11] 처음엔 '계산 검증 전 임시 제한'이었지만, [2026-08-14 사용자 확정] 검증이 끝난 뒤에도
 *  **의도적으로 이 상태를 유지한다** — 남의 예상 최종 점수가 전원에게 보이면 게임 정보 공개 범위가
 *  바뀌기 때문. 즉 '아직 안 연 것'이 아니라 '안 열기로 한 것'이니 임의로 비우지 말 것.
 *  (열려면 이 배열을 [] 로 두면 전원 노출. 보안 장치는 아니고 화면 노출 제한일 뿐이다.)
 *
 *  좌석이 없는 관전으로 들어가도 보이게 하려고, 이름은 좌석 → spectatorNames[관전ID] 순으로 찾는다. */
const SCORE_PREVIEW_NAMES = ['하이'];
/** [사용자 2026-08-20] 숨은 관전 아이디('---')도 예상 점수를 볼 수 있게 —
 *  관전자 목록에 안 뜨는 아이디라 정보 공개 범위가 넓어지지 않는다(어차피 좌석이 없다). */
const scorePreviewAllowed = (name: string) => SCORE_PREVIEW_NAMES.length === 0
  || SCORE_PREVIEW_NAMES.includes(name) || isHiddenSpectatorName(name);

/** '지금 이 보드로 게임이 끝나면 몇 점인가' — 서버 정산과 같은 shared 함수만 사용(규칙 복제 금지).
 *
 *  ★ 이중계산 주의 (리뷰 2026-08-14): 서버는 각 항목을 **발생 시점에 곧바로 score에 넣는다**.
 *    - 패스 VP: 패스하는 순간 addScore(bonusTilePass) + addScore(techTiles)  → gameState.ts:8501, :2595
 *    - 종료 정산: addScore(researchTracks / remainingResources / finalMissions) + 비딩 차감 → :2084 :2091 :2495 :2094
 *    그래서 이미 반영된 항목을 또 더하면 안 된다:
 *      · 이미 패스한 사람 → pass 제외 (안 그러면 한 명이라도 패스한 뒤부터 순위가 부풀었다)
 *      · 게임 종료 후    → track·mission·leftover·bid 전부 제외 (안 그러면 거의 두 배로 보였다)
 */
function projectScore(game: GaiaGameState, pid: string) {
  const p = game.players[pid];
  const ended = game.currentPhase === 'gameEnd';
  // 패스 점수는 '아직 패스 안 한 사람'에게만 예상치로 더한다.
  const willPass = !ended && !p.hasPassed;
  const passTile = willPass ? (computeBonusTilePassVp(game, pid)?.vp ?? 0) : 0;
  const passAdv = willPass ? computeAdvancedTechPassVp(game, pid).reduce((s, r) => s + r.vp, 0) : 0;
  // 종료 정산 항목은 아직 안 끝났을 때만 예상치로 더한다(끝났으면 score에 이미 들어 있다).
  const track = ended ? 0 : RESEARCH_TRACKS.reduce((s, t) => {
    const lv = p.research?.[t.id as ResearchTrack] ?? 0;
    return s + (lv >= 5 ? RESEARCH_TRACK_END_BONUS[5] : lv >= 4 ? RESEARCH_TRACK_END_BONUS[4] : lv >= 3 ? RESEARCH_TRACK_END_BONUS[3] : 0);
  }, 0);
  const mission = ended ? 0 : (game.finalMissionIds ?? []).reduce((s, m) => s + getFinalMissionVp(game, pid, m), 0);
  const leftover = ended ? 0 : Math.floor(endgameLeftoverUnits(game, pid, p) / 3);
  const bid = ended ? 0 : -(p.factionBidVp ?? 0);
  const now = p.score ?? 0;
  return { now, pass: passTile + passAdv, track, mission, leftover, bid, total: now + passTile + passAdv + track + mission + leftover + bid };
}

/**
 * 건물을 지을 수 있는 칸만 — space/deep_space와 우주선 칸은 제외.
 * [사용자 2026-08-11] 원시행성(proto)·소행성(asteroid)도 광산을 짓는 땅이라 포함한다.
 *   잊혀진 행성(lost_planet)은 빈 우주칸에 '나중에 놓는' 보상이라 처음부터 남은 땅이 아니므로 제외.
 */
const COUNTED_PLANETS: Array<{ type: PlanetType; label: string }> = [
  { type: 'terra', label: 'Terra' },
  { type: 'oxide', label: 'Oxide' },
  { type: 'volcanic', label: 'Volcanic' },
  { type: 'desert', label: 'Desert' },
  { type: 'swamp', label: 'Swamp' },
  { type: 'titanium', label: 'Titanium' },
  { type: 'ice', label: 'Ice' },
  { type: 'gaia', label: 'Gaia' },
  { type: 'transdim', label: 'Transdim' },
  { type: 'proto', label: 'Proto' },
  { type: 'asteroid', label: 'Asteroid' },
];

/** 아직 비어 있는 칸인지 — 건물·기생광산·가이아포머 어느 것도 없어야 '남은 땅' */
function isUnclaimed(t: HexTile): boolean {
  if (t.structure) return false;
  if (t.parasiticMine) return false;
  if (t.hasGaiaformer) return false;
  return true;
}

export interface UtilityPanelProps {
  game: GaiaGameState;
  onClose: () => void;
  /** 맵 영역 오른쪽 끝까지의 거리(px) — 상태창/로그를 안 가리게 기본 위치를 맞춘다 */
  anchorRightPx: number;
  measureMode: 'A' | 'B' | null;
  setMeasureMode: (m: 'A' | 'B' | null) => void;
  /** 내 좌석 강조용 */
  playerId?: string | null;
  measureA: string | null;
  measureB: string | null;
  onClearMeasure: () => void;
}

export function UtilityPanel({ game, onClose, anchorRightPx, playerId, measureMode, setMeasureMode, measureA, measureB, onClearMeasure }: UtilityPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // 위치 드래그 — 채팅창과 동일 방식. null이면 기본(맵 우하단) 앵커.
  const clampPos = (p: { x: number; y: number }) => {
    const vw = window.innerWidth, vh = window.innerHeight, VIS = 80; // 최소 80px는 화면 안(다시 잡을 수 있게)
    return { x: Math.max(0, Math.min(vw - VIS, p.x)), y: Math.max(0, Math.min(vh - VIS, p.y)) };
  };
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { const v = localStorage.getItem('gaia-utility-pos'); return v ? clampPos(JSON.parse(v)) : null; } catch { return null; }
  });
  const posRef = useRef(pos); posRef.current = pos;
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 크기 조절 — 채팅창과 동일하게 폭 + 목록 높이. 앵커가 우하단이라 핸들은 좌측·상단에 둔다.
  const [width, setWidth] = useState(() => { try { const v = Number(localStorage.getItem('gaia-utility-w')); return v >= 200 ? v : 236; } catch { return 236; } });
  const [listHeight, setListHeight] = useState(() => { try { const v = Number(localStorage.getItem('gaia-utility-h')); return v >= 60 ? v : 118; } catch { return 118; } });
  const widthRef = useRef(width); widthRef.current = width;
  const listHeightRef = useRef(listHeight); listHeightRef.current = listHeight;
  useEffect(() => { try { localStorage.setItem('gaia-utility-w', String(width)); } catch { /* noop */ } }, [width]);
  useEffect(() => { try { localStorage.setItem('gaia-utility-h', String(listHeight)); } catch { /* noop */ } }, [listHeight]);

  const startResize = useCallback((e: React.PointerEvent, axis: 'w' | 'h' | 'both') => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, sw = widthRef.current, sh = listHeightRef.current;
    // 우하단 앵커(pos=null)면 CSS right/bottom이 고정이라 보정 불필요.
    // 드래그 위치 모드(pos, left/top 앵커)에선 커진 만큼 x·y를 당겨 '오른쪽·아래변 고정'을 유지한다.
    const baseX = posRef.current?.x ?? null;
    const baseY = posRef.current?.y ?? null;
    const onMove = (ev: PointerEvent) => {
      if (axis !== 'h') {
        const newW = Math.max(200, Math.min(window.innerWidth * 0.9, sw - (ev.clientX - sx))); // 왼쪽으로 끌수록 넓게
        setWidth(newW);
        if (baseX != null) setPos((p) => (p ? { x: Math.max(0, baseX - (newW - sw)), y: p.y } : p));
      }
      if (axis !== 'w') {
        const newH = Math.max(60, Math.min(window.innerHeight * 0.7, sh - (ev.clientY - sy))); // 위로 끌수록 높게
        setListHeight(newH);
        if (baseY != null) setPos((p) => (p ? { x: p.x, y: Math.max(0, baseY - (newH - sh)) } : p));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      try { if (posRef.current) localStorage.setItem('gaia-utility-pos', JSON.stringify(posRef.current)); } catch { /* noop */ }
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  const startDrag = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    const baseX = posRef.current?.x ?? rect?.left ?? 0;
    const baseY = posRef.current?.y ?? rect?.top ?? 0;
    const onMove = (ev: PointerEvent) => setPos(clampPos({ x: baseX + (ev.clientX - sx), y: baseY + (ev.clientY - sy) }));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      try { if (posRef.current) localStorage.setItem('gaia-utility-pos', JSON.stringify(posRef.current)); } catch { /* noop */ }
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const tileById = (id: string | null) => (id ? game.map.find((t) => t.id === id) ?? null : null);
  const ta = tileById(measureA);
  const tb = tileById(measureB);
  const distance = ta && tb ? getDistance(ta, tb) : null;

  const counts = COUNTED_PLANETS.map((p) => ({
    ...p,
    n: game.map.filter((t) => t.type === p.type && isUnclaimed(t)).length,
  }));
  const total = counts.reduce((s, c) => s + c.n, 0);

  // 검증 단계: 지정된 이름의 좌석일 때만 예상 점수를 노출(관전자는 좌석이 없으므로 미노출)
  // [사용자 2026-08-12] 좌석뿐 아니라 관전자 이름으로도 판정한다 — 관전은 playerId가 없어
  //   좌석 이름만 보던 기존 코드에서는 예상 점수가 아예 안 떴다(검증하려고 관전으로 들어가면 못 봄).
  //   관전자 이름은 서버가 game.spectatorNames에 넣어 준다(숨은 관전 아이디는 애초에 안 들어감).
  const myName = (() => {
    const seat = playerId ? game.players?.[playerId]?.name : null;
    if (seat) return seat.trim();
    try {
      const sid = getStoredSpectatorId(game.id);
      if (!sid) return '';
      const names = (game as unknown as { spectatorNames?: Record<string, string> }).spectatorNames;
      if (names?.[sid]) return names[sid].trim();
      // [버그 2026-08-23 사용자 "'---'로 관전 중일 때 종료 점수가 안 보인다"]
      //   숨은 관전('---')은 서버가 이름을 game에 기록하지 않는다(그게 '숨은'의 정의) → spectatorNames로는
      //   영원히 찾을 수 없어, 아래 scorePreviewAllowed의 isHiddenSpectatorName 분기가 발동한 적이 없었다.
      //   이 기기에서 관전 입장할 때 저장한 이름(Lobby가 gaia-playerName에 저장)을 보조로 쓴다.
      //   '---'인 경우에만 인정해 노출 범위가 넓어지지 않게 한다(어차피 화면 노출 제한이지 보안장치가 아님).
      const localName = (localStorage.getItem('gaia-playerName') ?? '').trim();
      return isHiddenSpectatorName(localName) ? localName : '';
    } catch { return ''; }
  })();
  const canSeeScore = scorePreviewAllowed(myName);

  // 예상 점수 — 높은 순으로. 계산 실패(옛 게임 등)해도 패널 전체가 죽지 않게 방어.
  const projections = !canSeeScore ? [] : (game.turnOrder ?? Object.keys(game.players ?? {}))
    .filter((pid) => game.players?.[pid])
    .map((pid) => {
      try { return { pid, s: projectScore(game, pid) }; }
      catch { return { pid, s: { now: game.players[pid].score ?? 0, pass: 0, track: 0, mission: 0, leftover: 0, bid: 0, total: game.players[pid].score ?? 0 } }; }
    })
    .sort((a, b) => b.s.total - a.s.total);

  const tileLabel = (t: HexTile | null) => (t ? `${t.q},${t.r}` : '—');

  return (
    <div
      ref={rootRef}
      className="fixed z-[121] md:z-30"
      style={pos
        ? { left: pos.x, top: pos.y }
        : { right: anchorRightPx, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
      // [사용자 재보고 2026-08-14] 모바일에서 창을 끌면 맵도 같이 움직이던 문제의 진짜 원인.
      //   ★ React 이벤트는 DOM 트리가 아니라 **컴포넌트 트리**를 따라 버블링한다 — createPortal로
      //   body에 옮겨도 GameBoard의 onTouchStart/onTouchMove(:1219-1224)로 그대로 올라간다.
      //   드래그·리사이즈는 pointer 이벤트로 처리하는데, 터치 한 번은 pointer와 touch 이벤트를
      //   둘 다 발생시키므로 pointer 쪽 stopPropagation만으론 touch가 그대로 새어나간다.
      //   → 패널 루트에서 touch/mouse 계열을 직접 끊는다. preventDefault는 하지 않아 패널 내부
      //   스크롤·버튼은 정상 동작한다.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div className="relative bg-black/85 backdrop-blur-md border border-white/15 rounded-xl shadow-2xl overflow-hidden" style={{ width: `${width}px` }}>
        {/* 크기 조절 핸들: 좌측=가로, 상단=세로, 좌상단 코너=동시 (우하단 앵커 기준) */}
        <div onPointerDown={(e) => startResize(e, 'w')} className="absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize hover:bg-primary/40 z-20" title="드래그: 너비 조절" />
        <div onPointerDown={(e) => startResize(e, 'h')} className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/40 z-20" title="드래그: 높이 조절" />
        <div onPointerDown={(e) => startResize(e, 'both')} className="absolute top-0 left-0 w-3 h-3 cursor-nwse-resize z-30" title="드래그: 크기 조절" />
        <div
          className="flex items-center justify-between px-2.5 py-1.5 border-b border-white/10 bg-zinc-900/60 cursor-grab active:cursor-grabbing select-none touch-none"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setPos(null); setWidth(236); setListHeight(118);
            try { localStorage.removeItem('gaia-utility-pos'); localStorage.removeItem('gaia-utility-w'); localStorage.removeItem('gaia-utility-h'); } catch { /* noop */ }
          }}
          title="드래그: 위치 이동 · 더블클릭: 기본 위치·크기로"
        >
          <span className="text-[11px] font-black uppercase tracking-widest text-zinc-200 flex items-center gap-1.5">
            <span className="text-zinc-500">⠿</span>편의기능
          </span>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-white transition-colors" aria-label="편의기능 닫기">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 1) 예상 점수 — '지금 이 보드로 게임이 끝나면' 몇 점인지. 남은 라운드의 패스·미션은 안 들어간다. */}
        {canSeeScore && (
        <Section id="score" title="예상 점수 (지금 끝나면)" accent="text-amber-400">
          <div className="space-y-1">
            {projections.map(({ pid, s }) => {
              const p = game.players[pid];
              const color = FACTIONS.find((f) => f.id === p.faction)?.color ?? '#a1a1aa';
              const isMe = pid === playerId;
              return (
                <div key={pid} className={`rounded border px-1.5 py-1 ${isMe ? 'border-amber-400/40 bg-amber-500/10' : 'border-white/8 bg-zinc-900/50'}`}>
                  <div className="flex items-baseline gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0 border border-black/40" style={{ background: color }} />
                    <span className={`text-[10px] font-bold truncate ${isMe ? 'text-amber-100' : 'text-zinc-300'}`}>{p.name}</span>
                    <span className="ml-auto text-[13px] font-black text-amber-300 leading-none">{s.total}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0 text-[9px] text-zinc-500">
                    {/* 이미 서버 점수에 반영된 항목은 0으로 오므로 숨긴다 — '+0'이 남으면 아직 못 받은 것처럼 보인다 */}
                    <span>현재 <b className="text-zinc-300 font-bold">{s.now}</b></span>
                    {s.pass !== 0 && <span>패스 <b className="text-zinc-300 font-bold">+{s.pass}</b></span>}
                    {s.track !== 0 && <span>트랙 <b className="text-zinc-300 font-bold">+{s.track}</b></span>}
                    {s.mission !== 0 && <span>미션 <b className="text-zinc-300 font-bold">+{s.mission}</b></span>}
                    {s.leftover !== 0 && <span>자원 <b className="text-zinc-300 font-bold">+{s.leftover}</b></span>}
                    {s.bid !== 0 && <span>비딩 <b className="text-red-400 font-bold">{s.bid}</b></span>}
                    {p.hasPassed && game.currentPhase !== 'gameEnd' && <span className="text-zinc-600">패스함</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[8px] leading-snug text-zinc-600">
            패스=라운드 부스터+고급기술 · 트랙=3/4/5칸당 4·8·12 · 미션=순위 정산(18/12/6) · 자원=남은 자원÷3
            <br />이미 받은 점수(패스한 사람의 패스분, 종료 후 정산분)는 '현재'에 들어 있어 다시 더하지 않습니다.
            <br />남은 라운드의 패스·미션 진행분은 빠져 있어 최종 예상치는 아닙니다.
          </div>
        </Section>
        )}

        {/* 2) 남은 땅 */}
        <Section id="land" title={`남은 땅 (합계 ${total})`} accent="text-emerald-400">
          {/* 열 수는 폭에 맞춰 자동 — 넓히면 3·4열로 늘어난다(영어 라벨이 길어 최소 84px 확보).
              [사용자 2026-08-11] 1fr이면 칸이 폭에 맞춰 늘어나 이름과 숫자가 멀어진다 → max-content로 칸을 내용
              크기에 묶고 justify-start. 남는 폭은 열 사이가 아니라 오른쪽에 남는다. */}
          <div
            className="grid gap-x-3 gap-y-0.5 overflow-y-auto custom-scrollbar"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, max-content))', justifyContent: 'start', height: `${listHeight}px` }}
          >
            {counts.map((c) => (
              <div key={c.type} className="flex items-center gap-1 min-w-0" title={c.label}>
                <span className="w-2 h-2 rounded-full shrink-0 border border-black/40" style={{ background: PLANET_COLORS[c.type] ?? '#888' }} />
                <span className="text-[10px] text-zinc-400 truncate">{c.label}</span>
                <span className={`text-[11px] font-bold ml-auto ${c.n === 0 ? 'text-zinc-600' : 'text-zinc-100'}`}>{c.n}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* 3) 거리 측정기 */}
        <Section id="dist" title="거리 측정기" accent="text-sky-400">
          <div className="flex gap-1 mb-1.5">
            {(['A', 'B'] as const).map((k) => {
              const active = measureMode === k;
              const picked = k === 'A' ? ta : tb;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setMeasureMode(active ? null : k)}
                  className={`flex-1 rounded border px-1.5 py-1 text-[10px] font-bold transition-colors ${active
                    ? 'border-sky-400 bg-sky-500/30 text-white animate-pulse'
                    : picked
                      ? 'border-sky-400/40 bg-sky-500/10 text-sky-200'
                      : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
                  title={active ? '맵에서 칸을 고르세요 (다시 누르면 취소)' : `${k} 지점 선택`}
                >
                  {k}<span className="ml-1 font-normal opacity-70">{active ? '선택 중…' : tileLabel(picked)}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={onClearMeasure}
              className="shrink-0 rounded border border-white/10 bg-zinc-800/60 px-1.5 py-1 text-[10px] font-bold text-zinc-400 hover:text-zinc-200"
              title="A·B 선택 모두 지우기"
            >
              취소
            </button>
          </div>
          <div className="rounded bg-zinc-900/60 border border-white/8 px-2 py-1 text-center">
            {distance == null ? (
              <span className="text-[9px] text-zinc-500">A·B를 고르면 거리가 나옵니다</span>
            ) : (
              <span className="text-[11px] text-zinc-300">
                거리 <span className="text-lg font-black text-sky-300 align-middle">{distance}</span>
              </span>
            )}
          </div>
          <div className="mt-1 text-[8px] leading-snug text-zinc-600">최종미션 &apos;의회-아카데미 거리&apos;와 같은 계산입니다. 내 화면에서만 보입니다.</div>
        </Section>
      </div>
    </div>
  );
}
