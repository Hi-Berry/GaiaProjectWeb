import { useEffect, useState } from 'react';

/**
 * [임시 디버그] 화면 어디를 클릭하면 그 지점의 최상위 요소 스택(태그·id·class·z-index·position·
 * pointer-events·크기)을 좌하단에 표시. "우측 맵 클릭 안 됨" 같은 오버레이 가로채기 원인 진단용.
 * capture 단계 pointerdown을 듣고 document.elementsFromPoint로 실제 쌓인 요소들을 보여준다.
 * 오버레이 자체는 pointer-events:none 이라 클릭을 막지 않는다. 진단 끝나면 제거할 것.
 */
export function ClickDebugOverlay() {
  const [info, setInfo] = useState<string>('클릭하면 여기에 클릭 지점 요소가 표시됩니다');

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const els = document.elementsFromPoint(e.clientX, e.clientY).slice(0, 5);
      const lines = els.map((el, i) => {
        const t = el.tagName.toLowerCase();
        const he = el as HTMLElement;
        const id = he.id ? `#${he.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return `${i}: ${t}${id}${cls}\n   z:${cs.zIndex} pos:${cs.position} pe:${cs.pointerEvents} ${Math.round(r.width)}x${Math.round(r.height)}`;
      });
      setInfo(`@(${Math.round(e.clientX)},${Math.round(e.clientY)})\n${lines.join('\n')}`);
    };
    document.addEventListener('pointerdown', onDown, true); // capture: 무엇이 막든 먼저 잡음
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  return (
    <div className="fixed bottom-2 left-2 z-[9999] max-w-[92vw] whitespace-pre-wrap rounded-md bg-black/85 px-2 py-1.5 font-mono text-[10px] leading-tight text-lime-300 pointer-events-none shadow-xl ring-1 ring-lime-400/40">
      <div className="text-amber-300 font-bold mb-0.5">[클릭 디버그] 0=최상위(클릭 받는 요소)</div>
      {info}
    </div>
  );
}
