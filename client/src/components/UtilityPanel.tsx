/**
 * [사용자 2026-08-11] 편의기능 창 — 맵 우하단(로그를 안 가리게 맵 영역 기준)에 뜨는 보조 패널.
 * 채팅창처럼 헤더를 잡고 이동, X로 접기(메뉴 버튼으로 다시 열기). 순수 클라 기능이라 서버 통신 없음.
 *
 *  1) 예상 점수: 지금 당장 패스하면 얼마로 끝나는지 (현재/패스/트랙/미션/자원/비딩).
 *  2) 남은 땅: 맵에 아직 아무도 안 지은 행성을 유형별로 센다.
 *  3) 거리 측정기: A/B로 칸 두 개를 찍으면 헥스 거리를 보여준다.
 *     최종미션 '의회-아카데미 거리'(fm_pi_academy_distance)와 같은 getDistance를 쓴다.
 *
 * [사용자 2026-08-11] 넣을 기능이 계속 늘어날 예정이라 각 항목을 제목 클릭으로 여닫는 접이식으로 둔다.
 *   열림 상태는 항목별로 localStorage에 남아 다음에 열 때 그대로 복원된다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import {
  PLANET_COLORS, FACTIONS, RESEARCH_TRACKS, RESEARCH_TRACK_END_BONUS,
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

/** [사용자 2026-08-11] 예상 점수는 계산 검증 전이라 이 이름들에게만 보인다.
 *  검증이 끝나면 이 배열을 비우면(=[]) 전원에게 열린다. 보안 장치가 아니라 임시 노출 제한이다. */
const SCORE_PREVIEW_NAMES = ['하이'];

/** 지금 패스하면 받게 될 점수 — 서버 정산과 같은 shared 함수만 사용(규칙 복제 금지) */
function projectScore(game: GaiaGameState, pid: string) {
  const p = game.players[pid];
  const passTile = computeBonusTilePassVp(game, pid)?.vp ?? 0;
  const passAdv = computeAdvancedTechPassVp(game, pid).reduce((s, r) => s + r.vp, 0);
  const track = RESEARCH_TRACKS.reduce((s, t) => {
    const lv = p.research?.[t.id as ResearchTrack] ?? 0;
    return s + (lv >= 5 ? RESEARCH_TRACK_END_BONUS[5] : lv >= 4 ? RESEARCH_TRACK_END_BONUS[4] : lv >= 3 ? RESEARCH_TRACK_END_BONUS[3] : 0);
  }, 0);
  const mission = (game.finalMissionIds ?? []).reduce((s, m) => s + getFinalMissionVp(game, pid, m), 0);
  const leftover = Math.floor(endgameLeftoverUnits(game, pid, p) / 3);
  const bid = -(p.factionBidVp ?? 0);
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
  const myName = (playerId && game.players?.[playerId]?.name) ? game.players[playerId].name.trim() : '';
  const canSeeScore = SCORE_PREVIEW_NAMES.length === 0 || SCORE_PREVIEW_NAMES.includes(myName);

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

        {/* 1) 예상 점수 — 지금 패스하면 어떻게 끝나는지. 검증 전이라 지정된 이름에게만 노출 */}
        {canSeeScore && (
        <Section id="score" title="예상 점수 (지금 패스 시)" accent="text-amber-400">
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
                    <span>현재 <b className="text-zinc-300 font-bold">{s.now}</b></span>
                    <span>패스 <b className="text-zinc-300 font-bold">+{s.pass}</b></span>
                    <span>트랙 <b className="text-zinc-300 font-bold">+{s.track}</b></span>
                    <span>미션 <b className="text-zinc-300 font-bold">+{s.mission}</b></span>
                    <span>자원 <b className="text-zinc-300 font-bold">+{s.leftover}</b></span>
                    {s.bid !== 0 && <span>비딩 <b className="text-red-400 font-bold">{s.bid}</b></span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[8px] leading-snug text-zinc-600">
            패스=라운드 부스터+고급기술 · 트랙=3/4/5칸당 4·8·12 · 미션=순위 정산(18/12/6) · 자원=남은 자원÷3
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
