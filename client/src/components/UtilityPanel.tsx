/**
 * [사용자 2026-08-11] 편의기능 창 — 맵 우하단(로그를 안 가리게 맵 영역 기준)에 뜨는 보조 패널.
 * 채팅창처럼 헤더를 잡고 이동, X로 접기(메뉴 버튼으로 다시 열기). 순수 클라 기능이라 서버 통신 없음.
 *
 *  1) 남은 땅: 맵에 아직 아무도 안 지은 행성을 유형별로 센다.
 *  2) 거리 측정기: A/B로 칸 두 개를 찍으면 헥스 거리를 보여준다.
 *     최종미션 '의회-아카데미 거리'(fm_pi_academy_distance)와 같은 getDistance를 쓴다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { PLANET_COLORS, getDistance, type GaiaGameState, type HexTile, type PlanetType } from '@shared/gameConfig';

/** 건물을 지을 수 있는 행성만 — space/deep_space·우주선·소행성 등 특수칸 제외 */
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
  measureA: string | null;
  measureB: string | null;
  onClearMeasure: () => void;
}

export function UtilityPanel({ game, onClose, anchorRightPx, measureMode, setMeasureMode, measureA, measureB, onClearMeasure }: UtilityPanelProps) {
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

  const tileLabel = (t: HexTile | null) => (t ? `${t.q},${t.r}` : '—');

  return (
    <div
      ref={rootRef}
      className="fixed z-[121] md:z-30"
      style={pos
        ? { left: pos.x, top: pos.y }
        : { right: anchorRightPx, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
    >
      <div className="w-[236px] bg-black/85 backdrop-blur-md border border-white/15 rounded-xl shadow-2xl overflow-hidden">
        <div
          className="flex items-center justify-between px-2.5 py-1.5 border-b border-white/10 bg-zinc-900/60 cursor-grab active:cursor-grabbing select-none touch-none"
          onPointerDown={startDrag}
          onDoubleClick={() => { setPos(null); try { localStorage.removeItem('gaia-utility-pos'); } catch { /* noop */ } }}
          title="드래그: 위치 이동 · 더블클릭: 기본 위치로"
        >
          <span className="text-[11px] font-black uppercase tracking-widest text-zinc-200 flex items-center gap-1.5">
            <span className="text-zinc-500">⠿</span>편의기능
          </span>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-white transition-colors" aria-label="편의기능 닫기">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 1) 남은 땅 */}
        <div className="px-2.5 py-1.5 border-b border-white/10">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[9px] font-black uppercase tracking-wide text-emerald-400">남은 땅 (유형별)</span>
            <span className="text-[9px] text-zinc-500">합계 {total}</span>
          </div>
          {/* 영어 라벨은 Titanium·Transdim처럼 길어 3열이면 잘린다 → 2열 */}
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {counts.map((c) => (
              <div key={c.type} className="flex items-center gap-1 min-w-0" title={c.label}>
                <span className="w-2 h-2 rounded-full shrink-0 border border-black/40" style={{ background: PLANET_COLORS[c.type] ?? '#888' }} />
                <span className="text-[10px] text-zinc-400 truncate">{c.label}</span>
                <span className={`text-[11px] font-bold ml-auto ${c.n === 0 ? 'text-zinc-600' : 'text-zinc-100'}`}>{c.n}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 2) 거리 측정기 */}
        <div className="px-2.5 py-1.5">
          <div className="text-[9px] font-black uppercase tracking-wide text-sky-400 mb-1">거리 측정기</div>
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
        </div>
      </div>
    </div>
  );
}
