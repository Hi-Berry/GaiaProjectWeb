/**
 * [사용자 2026-11-06] 리플레이 관전 방 조작 막대 — 게임 화면(Game.tsx) 아래쪽에 떠서 한 수씩 앞/뒤로 넘긴다.
 * 상태는 서버 방(server/replay.ts)이 갖고, 여기선 '몇 번째 수로'만 보낸다.
 */
import { useEffect, useRef, useState } from 'react';
import { GameClient } from '@/lib/gameClient';
import type { ReplayInfo } from '@shared/replay';

export function ReplayControls({ roomId, info, round }: { roomId: string; info: ReplayInfo; round: number }) {
  const { index, total } = info;
  const [playing, setPlaying] = useState(false);
  const [showNote, setShowNote] = useState(false);
  // 키를 연달아 누르면 서버 응답(index 갱신) 전에 다음 입력이 온다 → 보낸 목표 위치를 기준으로 이어서 이동
  const targetRef = useRef(index);
  useEffect(() => { targetRef.current = index; }, [index]);
  const go = (i: number) => {
    const t = Math.max(0, Math.min(total, i));
    targetRef.current = t;
    GameClient.replaySeek(roomId, t);
  };
  const step = (d: number) => go(targetRef.current + d);
  // 라운드 이동은 서버가 목표 위치를 알려준다 — 연달아 눌러도 순서대로 이어지게 체인으로 보낸다
  const roundChain = useRef(Promise.resolve());
  const roundStep = (d: 1 | -1) => {
    roundChain.current = roundChain.current.then(async () => {
      targetRef.current = await GameClient.replaySeekRound(roomId, targetRef.current, d);
    });
  };

  useEffect(() => {
    if (!playing) return;
    if (index >= total) { setPlaying(false); return; }
    const t = setTimeout(() => go(index + 1), 800);
    return () => clearTimeout(t);
  }, [playing, index, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? roundStep(1) : step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? roundStep(-1) : step(-1); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(total);
      else if (e.key === ' ') { e.preventDefault(); setPlaying(v => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const btn = 'rounded-md bg-zinc-800 hover:bg-zinc-700 px-2 md:px-2.5 py-1 text-xs md:text-sm font-bold disabled:opacity-40';
  return (
    <div className="fixed top-[72px] left-1/2 -translate-x-1/2 z-[150] w-[min(560px,calc(100vw-16px))] rounded-xl border border-violet-400/40 bg-zinc-950/95 backdrop-blur px-3 py-2 shadow-2xl text-zinc-100">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-black text-violet-300">REPLAY</span>
        <span className="text-zinc-400 tabular-nums">R{round} · {index}/{total}수</span>
        <span className="ml-auto text-zinc-500 hidden md:inline">← → 한 수 · Shift 라운드 · Space 재생</span>
        {info.guessed.length > 0 && (
          <button className="text-zinc-500 underline decoration-dotted" onClick={() => setShowNote(v => !v)}>추정 항목</button>
        )}
      </div>
      {showNote && (
        <p className="mt-1 text-[11px] text-zinc-400">이 기록엔 다음이 저장돼 있지 않아 로그로 추정했습니다: {info.guessed.join(' · ')}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <button className={btn} onClick={() => go(0)} disabled={index === 0} title="처음">⏮</button>
        <button className={btn} onClick={() => roundStep(-1)} disabled={index === 0} title="이전 라운드">«R</button>
        <button className={btn} onClick={() => step(-1)} disabled={index === 0} title="이전 수">◀</button>
        <button className={`${btn} min-w-[40px]`} onClick={() => setPlaying(v => !v)} title="자동 재생">{playing ? '⏸' : '▶▶'}</button>
        <button className={btn} onClick={() => step(1)} disabled={index >= total} title="다음 수">▶</button>
        <button className={btn} onClick={() => roundStep(1)} disabled={index >= total} title="다음 라운드">R»</button>
        <button className={btn} onClick={() => go(total)} disabled={index >= total} title="끝">⏭</button>
        <input type="range" min={0} max={total} value={index} onChange={e => go(Number(e.target.value))} className="flex-1 min-w-0 ml-1" />
      </div>
    </div>
  );
}
