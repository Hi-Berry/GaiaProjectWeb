/**
 * [사용자 2026-11-06] 끝난 게임 리플레이 — 한 수씩 앞/뒤로 넘기며 맵과 플레이어 상태를 본다.
 *  /replay          게임 목록(이 서버에 저장된 기록)
 *  /replay/:gameId  리플레이 — 서버에 리플레이 관전 방을 열고(server/replay.ts) 숨은 관전자로 실제 게임 화면에 들어간다.
 *                   한 수씩 넘기는 조작은 게임 화면의 ReplayControls.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'wouter';
import { FACTIONS, HIDDEN_SPECTATOR_NAME } from '@shared/gameConfig';
import { GameClient, storeSpectatorId } from '@/lib/gameClient';

const factionColor = (f: string | null) => FACTIONS.find(x => x.id === f)?.color ?? '#888';

type ListItem = { gameId: string; completedAt: string; players: { name: string; faction: string | null; score: number }[] };

function ReplayList() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [id, setId] = useState('');
  useEffect(() => {
    fetch('/api/replay/list').then(r => r.json()).then(setItems).catch(() => setItems([]));
  }, []);
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <h1 className="text-xl font-black">게임 리플레이</h1>
        <form
          className="flex gap-2"
          onSubmit={e => { e.preventDefault(); if (id.trim()) window.location.href = `/replay/${id.trim()}`; }}
        >
          <input
            value={id}
            onChange={e => setId(e.target.value)}
            placeholder="게임 ID (예: xf6d9a5t)"
            className="flex-1 rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
          />
          <button className="rounded bg-primary text-black font-bold px-4 text-sm">열기</button>
        </form>
        {items == null ? (
          <p className="text-zinc-400 text-sm">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="text-zinc-400 text-sm">이 서버에 저장된 게임 기록이 없습니다. 게임 ID로 열어 보세요.</p>
        ) : (
          <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
            {items.map(it => (
              <li key={it.gameId}>
                <Link href={`/replay/${it.gameId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-white/5">
                  <span className="text-xs text-zinc-500 w-24 shrink-0">{it.completedAt.slice(0, 10)}</span>
                  {it.players.map((p, i) => (
                    <span key={i} className="text-sm whitespace-nowrap">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: factionColor(p.faction) }} />
                      {p.name} <span className="text-zinc-500">{p.score}</span>
                    </span>
                  ))}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function Replay() {
  const params = useParams<{ gameId?: string }>();
  const gameId = params.gameId;
  const [error, setError] = useState<string | null>(null);

  // 기록으로 리플레이 관전 방을 열고, 숨은 관전자로 들어가 실제 게임 화면에서 본다
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    (async () => {
      try {
        const { roomId } = await GameClient.replayOpen(gameId);
        const res = await GameClient.watchGame(roomId, HIDDEN_SPECTATOR_NAME);
        storeSpectatorId(roomId, res.spectatorId);
        if (!cancelled) window.location.replace(`/game/${roomId}`);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  if (!gameId) return <ReplayList />;
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 p-6">
      {error
        ? <>불러오기 실패: {error} · <Link href="/replay" className="underline">목록</Link></>
        : '리플레이 준비 중…'}
    </div>
  );
}
