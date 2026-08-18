/**
 * [사용자 2026-08-18] 첫 접속 둘러보기 — 실제 화면 요소를 스포트라이트로 짚어주는 안내.
 *
 * "?" 안내창(텍스트 목록)만으론 "포머 누가 썼는지", "건물 몇 개 지었는지" 같은 질문이 계속 나와서,
 * 답이 있는 자리를 화면에서 직접 가리킨다. 각 단계는 CSS 선택자로 대상을 찾고
 * 화면을 어둡게 덮은 뒤 그 자리만 구멍을 낸다(= box-shadow로 바깥을 덮는 방식).
 *
 * 대상이 없거나(그 종족·모드에서 안 보임) 크기가 0이면(모바일에서 숨김) 그 단계는 건너뛴다.
 * 위치는 매 프레임 다시 재서 맵 드래그·창 크기 변경에도 따라붙는다.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TourStep {
  /** 하이라이트할 요소의 CSS 선택자 (없으면 이 단계는 건너뛴다) */
  sel: string;
  title: string;
  /** 본문 — 강조는 아래 Em/Btn/C 로 감싼다(단색 문장은 눈에 안 들어온다는 사용자 지적). */
  body: ReactNode;
}

/** 본문 강조용 조각들 — 색은 실제 화면 색과 맞춘다(포머 점, 한도 도달 칩 등). */
const TONE = {
  teal: 'text-teal-300',       // 사용 가능 포머
  purple: 'text-purple-300',   // 맵에 설치한 포머
  red: 'text-red-400',         // 파괴된 포머
  rose: 'text-rose-300',       // 건물 한도 도달(더 못 지음)
  amber: 'text-amber-300',     // 주의·설정
  cyan: 'text-cyan-300',       // 버튼·조작 이름
} as const;

/** 강조(흰 글씨) — 문장에서 핵심 명사 */
export const Em = ({ children }: { children: ReactNode }) => (
  <span className="font-bold text-zinc-50">{children}</span>
);
/** 버튼·단축키 이름 */
export const Btn = ({ children }: { children: ReactNode }) => (
  <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-1 py-px font-mono text-[10px] font-bold text-cyan-200">{children}</span>
);
/** 색으로 뜻을 주는 강조 (포머 점 색 등) */
export const C = ({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) => (
  <span className={`font-bold ${TONE[tone]}`}>{children}</span>
);

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 6;          // 구멍을 대상보다 조금 크게
const GAP = 12;         // 구멍과 설명 카드 사이 간격
const CARD_W = 300;

function measure(sel: string): Rect | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;                       // 숨겨진 요소
  if (r.bottom < 0 || r.top > window.innerHeight) return null;        // 화면 밖
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

const same = (a: Rect | null, b: Rect | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1);

export function OnboardingTour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  /** 시작 시점에 '화면에 실제로 있는' 단계만 남긴다 — 진행 표시(2/4)가 건너뛴 단계까지 세지 않게.
   *  데스크톱/모바일에서 서로 없는 요소(좌하단 묶음 vs 하단 탭바)가 자동으로 걸러진다. */
  const [list] = useState<TourStep[]>(() => steps.filter((st) => measure(st.sel)));
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(() => measure(list[0]?.sel ?? ''));
  const rectRef = useRef<Rect | null>(rect);
  rectRef.current = rect;

  const step = list[idx];

  // 위치 추적: 맵을 끌거나 패널이 열려도 구멍이 따라오게 매 프레임 다시 잰다(짧게 쓰는 오버레이라 부담 적음).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = measure(step?.sel ?? '');
      if (!same(next, rectRef.current)) setRect(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step?.sel]);

  const go = useCallback((d: 1 | -1) => {
    setIdx((i) => {
      let n = i + d;
      // 진행 중에 사라진 요소(패널을 닫았다 등)는 지나친다
      while (n >= 0 && n < list.length && !measure(list[n].sel)) n += d;
      if (n >= list.length || n < 0) { onDone(); return i; }
      return n;
    });
  }, [list, onDone]);

  // 보여줄 단계가 하나도 없으면(전부 숨김) 그냥 끝낸다
  useEffect(() => {
    if (list.length === 0) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onDone(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onDone]);

  if (!step || typeof document === 'undefined') return null;

  // 설명 카드 위치: 구멍 아래에 두되 공간이 없으면 위로. 좌우는 화면 안으로 접어 넣는다.
  const vw = window.innerWidth, vh = window.innerHeight;
  const below = rect ? rect.top + rect.height + GAP : vh / 2;
  const putAbove = rect ? below + 190 > vh : false;
  const cardTop = !rect ? Math.max(24, vh / 2 - 90)
    : putAbove ? Math.max(12, rect.top - GAP - 176) : below;
  const cardLeft = !rect ? Math.max(12, vw / 2 - CARD_W / 2)
    : Math.min(Math.max(12, rect.left + rect.width / 2 - CARD_W / 2), vw - CARD_W - 12);

  const total = list.length;
  const isLast = idx >= total - 1;

  return createPortal(
    <div className="fixed inset-0 z-[400]" role="dialog" aria-label="화면 둘러보기">
      {/* 스포트라이트: 구멍 하나만 두고 바깥 전체를 어둡게 덮는다(클릭도 막는다) */}
      {rect ? (
        <div
          className="absolute rounded-lg ring-2 ring-cyan-300/90 tour-pulse"
          style={{
            top: rect.top, left: rect.left, width: rect.width, height: rect.height,
            boxShadow: '0 0 0 9999px rgba(3, 6, 15, 0.74)',
          }}
        />
      ) : (
        <div className="absolute inset-0" style={{ background: 'rgba(3, 6, 15, 0.74)' }} />
      )}

      <div
        className="absolute rounded-xl border border-cyan-400/30 bg-zinc-950/97 px-4 py-3 shadow-2xl backdrop-blur-md"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-black tracking-wide text-cyan-300">{step.title}</span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-zinc-500">{idx + 1} / {total}</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onDone}
            className="text-[10px] font-bold uppercase text-zinc-500 transition-colors hover:text-zinc-300"
          >
            건너뛰기
          </button>
          <div className="ml-auto flex gap-1.5">
            {idx > 0 && (
              <button
                type="button"
                onClick={() => go(-1)}
                className="rounded-full border border-white/15 px-3 py-1 text-[10px] font-bold uppercase text-zinc-300 transition-colors hover:bg-white/10"
              >
                이전
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? onDone() : go(1))}
              className="rounded-full bg-cyan-600 px-3.5 py-1 text-[10px] font-black uppercase text-white shadow-lg transition-colors hover:bg-cyan-500"
            >
              {isLast ? '끝내기' : '다음'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes tourPulse {
          0%, 100% { box-shadow: 0 0 0 9999px rgba(3, 6, 15, 0.74), 0 0 0 0 rgba(34, 211, 238, 0.45); }
          50%      { box-shadow: 0 0 0 9999px rgba(3, 6, 15, 0.74), 0 0 0 7px rgba(34, 211, 238, 0); }
        }
        .tour-pulse { animation: tourPulse 1.9s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) { .tour-pulse { animation: none; } }
      `}</style>
    </div>,
    document.body,
  );
}
