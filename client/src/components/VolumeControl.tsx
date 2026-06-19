import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume2, VolumeX } from 'lucide-react';
import { getVolumeLevel, setVolumeLevel, playVolumePreview, MAX_VOLUME_LEVEL } from '@/lib/audio';

/**
 * 알림음 볼륨 조절 (0=음소거 ~ 10=최대). 우상단 고정 플로팅 컨트롤.
 * 스피커 아이콘 클릭 → 0~10 슬라이더 펼침. 변경 시 미리듣기 비프 + localStorage 저장.
 */
export function VolumeControl() {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(() => getVolumeLevel());

  const change = (n: number) => {
    setLevel(n);
    setVolumeLevel(n);
    if (n > 0) playVolumePreview();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed top-3 right-3 z-[130]">
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950/85 px-2 py-1.5 shadow-lg backdrop-blur-md">
        <button
          type="button"
          className="flex items-center justify-center text-zinc-300 hover:text-white transition-colors"
          onClick={() => setOpen((o) => !o)}
          title="알림음 크기"
          aria-label="알림음 크기"
        >
          {level === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
        {open && (
          <>
            <input
              type="range"
              min={0}
              max={MAX_VOLUME_LEVEL}
              step={1}
              value={level}
              onChange={(e) => change(Number(e.target.value))}
              className="w-28 accent-amber-400 cursor-pointer"
              aria-label="볼륨 단계"
            />
            <span className="w-5 text-center text-[10px] font-bold tabular-nums text-amber-300">{level}</span>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
