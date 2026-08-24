import { useState, type PointerEvent } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { getVolumeLevel, setVolumeLevel, playVolumePreview, MAX_VOLUME_LEVEL } from '@/lib/audio';

/** 네이티브 range는 드래그가 슬라이더 밖으로 나가면 포인터/마우스/휠이 맵까지 새는 경우가 있다. */
function stopMapGesture(e: { stopPropagation: () => void }) {
  e.stopPropagation();
}

function captureSliderPointer(e: PointerEvent<HTMLInputElement>) {
  e.stopPropagation();
  e.currentTarget.setPointerCapture(e.pointerId);
}

/**
 * 알림음 볼륨 조절 (0=음소거 ~ 10=최대). 인라인 컴팩트 컨트롤 — 스피커 아이콘 + 0~10 슬라이더 + 숫자.
 * 변경 시 미리듣기 비프 + localStorage 저장. (상태창 하단 footer 등에 배치)
 */
export function VolumeControl({ className = '' }: { className?: string }) {
  const [level, setLevel] = useState(() => getVolumeLevel());

  const change = (n: number) => {
    setLevel(n);
    setVolumeLevel(n);
    if (n > 0) playVolumePreview();
  };

  return (
    <div
      className={`flex items-center gap-1.5 ${className}`}
      title="알림음 크기 (0=음소거)"
      onWheel={stopMapGesture}
      onMouseDown={stopMapGesture}
      onMouseMove={stopMapGesture}
      onPointerDown={stopMapGesture}
      onPointerMove={stopMapGesture}
      onTouchStart={stopMapGesture}
      onTouchMove={stopMapGesture}
    >
      {level === 0
        ? <VolumeX className="w-4 h-4 text-zinc-400 shrink-0" />
        : <Volume2 className="w-4 h-4 text-zinc-400 shrink-0" />}
      <input
        type="range"
        min={0}
        max={MAX_VOLUME_LEVEL}
        step={1}
        value={level}
        onChange={(e) => change(Number(e.target.value))}
        onPointerDown={captureSliderPointer}
        onPointerMove={stopMapGesture}
        onPointerUp={stopMapGesture}
        onMouseDown={stopMapGesture}
        onMouseMove={stopMapGesture}
        onWheel={stopMapGesture}
        onTouchStart={stopMapGesture}
        onTouchMove={stopMapGesture}
        className="w-20 accent-amber-400 cursor-pointer"
        aria-label="볼륨 단계"
      />
      <span className="w-4 text-center text-[10px] font-bold tabular-nums text-amber-300">{level}</span>
    </div>
  );
}
