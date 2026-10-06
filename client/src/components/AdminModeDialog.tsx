import { useEffect, useState } from 'react';
import type { GameState, PlayerState } from '@/lib/gameClient';
import { GameClient } from '@/lib/gameClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getFederationEntries, getRollbackQuota, ROLLBACK_LIMIT_PER_PLAYER } from '@shared/gameConfig';

const ADMIN_PASSWORD = '0011';

type EditablePlayerStats = Pick<PlayerState, 'score' | 'credits' | 'ore' | 'knowledge' | 'qic' | 'power1' | 'power2' | 'power3'>;
type EditableTaklonsBrain = {
  brainStoneBowl?: 1 | 2 | 3;
  brainStoneInGaia?: boolean;
};

interface AdminModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  game: GameState;
}

function toNumber(value: string) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function PlayerAdminEditor({ gameId, playerId, player }: { gameId: string; playerId: string; player: PlayerState }) {
  const [values, setValues] = useState<Record<keyof EditablePlayerStats, string>>({
    score: String(player.score ?? 0),
    credits: String(player.credits ?? 0),
    ore: String(player.ore ?? 0),
    knowledge: String(player.knowledge ?? 0),
    qic: String(player.qic ?? 0),
    power1: String(player.power1 ?? 0),
    power2: String(player.power2 ?? 0),
    power3: String(player.power3 ?? 0),
  });
  const [taklonsBrain, setTaklonsBrain] = useState<EditableTaklonsBrain>({
    brainStoneBowl: (player as any).brainStoneBowl,
    brainStoneInGaia: (player as any).brainStoneInGaia,
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    setValues({
      score: String(player.score ?? 0),
      credits: String(player.credits ?? 0),
      ore: String(player.ore ?? 0),
      knowledge: String(player.knowledge ?? 0),
      qic: String(player.qic ?? 0),
      power1: String(player.power1 ?? 0),
      power2: String(player.power2 ?? 0),
      power3: String(player.power3 ?? 0),
    });
    setTaklonsBrain({
      brainStoneBowl: (player as any).brainStoneBowl,
      brainStoneInGaia: (player as any).brainStoneInGaia,
    });
  }, [player.score, player.credits, player.ore, player.knowledge, player.qic, player.power1, player.power2, player.power3]);

  const setField = (field: keyof EditablePlayerStats, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setMessage('');
  };

  const save = async () => {
    const resources: Partial<EditablePlayerStats & EditableTaklonsBrain> = {
      score: toNumber(values.score),
      credits: toNumber(values.credits),
      ore: toNumber(values.ore),
      knowledge: toNumber(values.knowledge),
      qic: toNumber(values.qic),
      power1: toNumber(values.power1),
      power2: toNumber(values.power2),
      power3: toNumber(values.power3),
    };
    if (player.faction === 'taklons') {
      if (typeof taklonsBrain.brainStoneInGaia === 'boolean') resources.brainStoneInGaia = taklonsBrain.brainStoneInGaia;
      if (taklonsBrain.brainStoneBowl === 1 || taklonsBrain.brainStoneBowl === 2 || taklonsBrain.brainStoneBowl === 3) {
        resources.brainStoneBowl = taklonsBrain.brainStoneBowl;
      }
    }

    try {
      await GameClient.adminSetPlayerState(gameId, playerId, resources, ADMIN_PASSWORD);
      setMessage('저장됨');
    } catch (err: any) {
      setMessage(err?.message || '저장 실패');
    }
  };

  const fields: Array<{ key: keyof EditablePlayerStats; label: string }> = [
    { key: 'score', label: 'VP' },
    { key: 'credits', label: 'C' },
    { key: 'ore', label: 'O' },
    { key: 'knowledge', label: 'K' },
    { key: 'qic', label: 'QIC' },
    { key: 'power1', label: 'P1' },
    { key: 'power2', label: 'P2' },
    { key: 'power3', label: 'P3' },
  ];

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/80 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-black text-white truncate">{player.name}</div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">{player.faction || 'No faction'}</div>
        </div>
        <Button size="sm" className="h-7 text-xs" onClick={save}>
          적용
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {fields.map(({ key, label }) => (
          <div key={key} className="space-y-1">
            <Label className="text-[10px] text-zinc-400">{label}</Label>
            <Input
              type="number"
              value={values[key]}
              onChange={(e) => setField(key, e.target.value)}
              className="h-8 text-xs px-2 bg-zinc-900 border-white/10"
            />
          </div>
        ))}
      </div>

      {player.faction === 'taklons' && (
        <div className="pt-2 border-t border-white/10">
          <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-2">Brainstone</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={Boolean(taklonsBrain.brainStoneInGaia)}
                onChange={(e) => {
                  setTaklonsBrain((prev) => ({
                    ...prev,
                    brainStoneInGaia: e.target.checked,
                    brainStoneBowl: e.target.checked ? 1 : (prev.brainStoneBowl ?? 1),
                  }));
                  setMessage('');
                }}
              />
              Gaia
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <span className="text-zinc-400">Bowl</span>
              <select
                className="h-7 rounded bg-zinc-900 border border-white/10 px-2 text-xs text-zinc-100 disabled:opacity-50"
                value={String(taklonsBrain.brainStoneBowl ?? 1)}
                disabled={Boolean(taklonsBrain.brainStoneInGaia)}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  const bowl = (v === 1 || v === 2 || v === 3) ? (v as 1 | 2 | 3) : 1;
                  setTaklonsBrain((prev) => ({ ...prev, brainStoneBowl: bowl }));
                  setMessage('');
                }}
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </label>

            <span className="text-[10px] text-zinc-500">
              {taklonsBrain.brainStoneInGaia ? 'Gaia' : `Bowl ${taklonsBrain.brainStoneBowl ?? 1}`}
            </span>
          </div>
        </div>
      )}
      {message && <div className="text-[10px] text-zinc-400">{message}</div>}
    </div>
  );
}

/** [사용자 2026-08-31] 좌석별 이어하기 링크(?as=playerId) 복사 — 시크릿 창 등에서 좌석을 잃은 사람 구제용.
 *  링크를 연 기기의 localStorage에 그 좌석 playerId가 심겨 바로 입장된다. 링크 = 좌석 소유권이므로 본인에게만 전달. */
function RejoinLinkPanel({ game }: { game: GameState }) {
  const [copied, setCopied] = useState<string | null>(null);
  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players)).filter((id) => game.players[id]);
  const humans = order.filter((id) => !game.botPlayerIds?.includes(id));

  const copy = async (pid: string) => {
    const url = `${window.location.origin}/game/${game.id}?as=${pid}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(pid);
      setTimeout(() => setCopied((c) => (c === pid ? null : c)), 2000);
    } catch {
      // 클립보드 권한 실패(http 등) 폴백: 프롬프트로 노출해 수동 복사
      window.prompt('아래 링크를 복사하세요', url);
    }
  };

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-blue-300">좌석 이어하기 링크</div>
        <div className="text-[10px] text-zinc-400">시크릿 창을 닫는 등으로 자리를 잃은 사람에게 <b>본인 좌석 링크만</b> 전달하세요. 링크를 열면 그 기기로 좌석이 복구됩니다 (링크 = 좌석 소유권).</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {humans.map((id) => {
          const p = game.players[id];
          return (
            <Button
              key={id}
              size="sm"
              variant="outline"
              className="h-7 text-xs border-blue-500/40 text-blue-200 hover:bg-blue-500/20"
              onClick={() => copy(id)}
            >
              {copied === id ? '복사됨 ✓' : `${p.name} 링크 복사`}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** [사용자 2026-10-06] 좌석 비밀번호 강제 설정 — 이어하기 링크(?as=…)가 길어서, 관리자가 비번을 정해 주고
 *  플레이어는 게임 주소에서 '내 좌석 이어하기'에 이름 + 비번으로 들어오게 한다. 기존 비번은 덮어쓴다. */
function SeatPasswordRow({ game, playerId }: { game: GameState; playerId: string }) {
  const name = game.players[playerId]?.name ?? playerId;
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null); // 마지막으로 설정한 비번(안내 문구용)
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const notice = done ? `게임 주소: ${window.location.origin}/game/${game.id}\n'내 좌석 이어하기'에서 이름: ${name} / 비밀번호: ${done}` : '';

  const save = async () => {
    if (!pw.trim()) { setMessage('비밀번호를 입력하세요'); return; }
    setBusy(true);
    setMessage('');
    try {
      await GameClient.adminSetSeatPassword(game.id, playerId, pw, ADMIN_PASSWORD);
      setDone(pw);
      setPw('');
      setMessage('설정했습니다');
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(notice); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { window.prompt('아래 안내를 복사하세요', notice); }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-zinc-200 w-28 truncate shrink-0" title={name}>{name}</span>
        <Input
          value={pw}
          onChange={(e) => { setPw(e.target.value); setMessage(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder="새 비밀번호"
          autoComplete="off"
          className="h-7 w-32 text-xs bg-zinc-900 border-white/10"
          aria-label={`${name} 좌석 비밀번호`}
        />
        <Button size="sm" className="h-7 text-xs bg-violet-600 hover:bg-violet-500" disabled={busy} onClick={save}>{busy ? '설정 중…' : '설정'}</Button>
        {message && <span className="text-[10px] text-zinc-500">{message}</span>}
      </div>
      {done && (
        <div className="flex flex-wrap items-center gap-2 pl-[7.5rem]">
          <span className="text-[11px] text-violet-200">이름 <b>{name}</b> · 비밀번호 <b>{done}</b></span>
          <Button size="sm" variant="outline" className="h-6 text-[10px] border-violet-500/40 text-violet-200 hover:bg-violet-500/20" onClick={copy}>
            {copied ? '복사됨 ✓' : '안내 문구 복사'}
          </Button>
        </div>
      )}
    </div>
  );
}

function SeatPasswordPanel({ game }: { game: GameState }) {
  const bots = new Set(game.botPlayerIds ?? []);
  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players))
    .filter((id) => game.players[id] && !bots.has(id));
  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-violet-300">좌석 비밀번호 설정</div>
        <div className="text-[10px] text-zinc-400">
          비밀번호를 정해 주면 그 사람은 게임 주소에서 <b>'내 좌석 이어하기'</b>에 <b>자기 이름 + 이 비밀번호</b>로 들어옵니다(이름은 대소문자 무관).
          기존 비밀번호는 덮어씁니다.
        </div>
      </div>
      {order.length === 0 && <div className="text-[10px] text-zinc-500">사람 플레이어가 없습니다.</div>}
      <div className="space-y-1.5">
        {order.map((id) => <SeatPasswordRow key={id} game={game} playerId={id} />)}
      </div>
    </div>
  );
}

function ForceEndGameButton({ gameId, ended }: { gameId: string; ended: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const forceEnd = async () => {
    setBusy(true);
    setMessage('');
    try {
      await GameClient.adminForceEndGame(gameId, ADMIN_PASSWORD);
      setMessage('게임을 종료했습니다. 점수 화면이 표시됩니다.');
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-black text-amber-300">게임 강제 종료</div>
          <div className="text-[10px] text-zinc-400">즉시 최종 점수를 계산하고 점수 화면을 띄웁니다 (테스트용).</div>
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="h-7 text-xs shrink-0"
          disabled={busy || ended}
          onClick={forceEnd}
        >
          {ended ? '이미 종료됨' : busy ? '종료 중…' : '강제 종료'}
        </Button>
      </div>
      {message && <div className="text-[10px] text-zinc-400">{message}</div>}
    </div>
  );
}

function RollbackTurnPanel({ game }: { game: GameState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const rollback = async (targetPlayerId: string) => {
    setBusy(targetPlayerId);
    setMessage('');
    try {
      const name = await GameClient.adminRollbackTurn(game.id, ADMIN_PASSWORD, targetPlayerId);
      setMessage(`${name ?? '플레이어'}의 마지막 턴 시작으로 되돌렸습니다.`);
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(null);
    }
  };

  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players)).filter((id) => game.players[id]);

  return (
    <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-cyan-300">턴 롤백</div>
        <div className="text-[10px] text-zinc-400">선택한 플레이어의 <b>마지막 턴 시작</b>으로 게임 전체를 되감습니다 (그 이후 모든 행동 취소). 실수 복구용.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {order.map((id) => {
          const p = game.players[id];
          const isCurrent = game.turnOrder?.[game.currentPlayerIndex ?? 0] === id;
          return (
            <Button
              key={id}
              size="sm"
              variant="outline"
              className="h-7 text-xs border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/20"
              disabled={busy !== null}
              onClick={() => rollback(id)}
            >
              {busy === id ? '되돌리는 중…' : `${p.name}${isCurrent ? ' (현재)' : ''}`}
            </Button>
          );
        })}
      </div>
      {message && <div className="text-[10px] text-zinc-400">{message}</div>}
    </div>
  );
}

/* [사용자 2026-09-30] "어드민에는 롤백 잔여횟수 표기되고 수정할 수 있게 해줘"
   사람마다 사용/한도/잔여를 보여 주고 잔여를 직접 고친다. 서버는 한도 = 이미 쓴 횟수 + 입력한 잔여로 기록한다. */
function RollbackQuotaRow({ game, playerId }: { game: GameState; playerId: string }) {
  const q = getRollbackQuota(game, playerId);
  const [value, setValue] = useState(String(q.remaining));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // 게임에서 잔여가 바뀌면(롤백 실행 등) 입력칸도 따라간다 — 단 입력 중엔 덮지 않게 저장 직후만
  useEffect(() => { if (!busy) setValue(String(q.remaining)); }, [q.remaining]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: number) => {
    setBusy(true);
    setMessage('');
    try {
      const r = await GameClient.adminSetRollbackRemaining(game.id, playerId, next, ADMIN_PASSWORD);
      setValue(String(r.remaining));
      setMessage(`잔여 ${r.remaining}회로 설정`);
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(false);
    }
  };
  const n = Math.max(0, toNumber(value));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold text-zinc-200 w-28 truncate shrink-0">{game.players[playerId]?.name ?? playerId}</span>
      <span className={`text-[11px] tabular-nums w-40 shrink-0 ${q.exhausted ? 'text-red-300' : 'text-zinc-400'}`}>
        잔여 <b className={q.exhausted ? 'text-red-300' : 'text-amber-200'}>{q.remaining}</b>회 · 사용 {q.used} / 한도 {q.limit}
      </span>
      <Button size="sm" variant="outline" className="h-7 w-7 p-0 border-white/15" disabled={busy || n <= 0} onClick={() => save(n - 1)} aria-label="잔여 1 줄이기">−</Button>
      <Input
        type="number"
        min={0}
        max={99}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(n); }}
        className="h-7 w-16 text-xs bg-zinc-900 border-white/10"
        aria-label="잔여 횟수"
      />
      <Button size="sm" variant="outline" className="h-7 w-7 p-0 border-white/15" disabled={busy || n >= 99} onClick={() => save(n + 1)} aria-label="잔여 1 늘리기">+</Button>
      <Button size="sm" className="h-7 text-xs bg-amber-600 hover:bg-amber-500" disabled={busy} onClick={() => save(n)}>저장</Button>
      {message && <span className="text-[10px] text-zinc-500">{message}</span>}
    </div>
  );
}

function RollbackQuotaPanel({ game }: { game: GameState }) {
  const bots = new Set(game.botPlayerIds ?? []);
  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players))
    .filter((id) => game.players[id] && !bots.has(id));
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-amber-300">롤백 잔여 횟수</div>
        <div className="text-[10px] text-zinc-400">
          기본 한도 {ROLLBACK_LIMIT_PER_PLAYER}회. 동의를 받아 <b>실행된</b> 롤백만 소진됩니다(거절은 세지 않음). 잔여를 고치면 그 사람만 따로 한도가 붙습니다.
        </div>
      </div>
      {order.length === 0 && <div className="text-[10px] text-zinc-500">사람 플레이어가 없습니다.</div>}
      <div className="space-y-1.5">
        {order.map((id) => <RollbackQuotaRow key={id} game={game} playerId={id} />)}
      </div>
    </div>
  );
}

function SetCurrentTurnPanel({ game }: { game: GameState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const setTurn = async (targetPlayerId: string) => {
    setBusy(targetPlayerId);
    setMessage('');
    try {
      await GameClient.adminSetCurrentTurn(game.id, targetPlayerId, ADMIN_PASSWORD);
      setMessage(`${game.players[targetPlayerId]?.name ?? '플레이어'}(으)로 현재 턴을 지정했습니다.`);
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(null);
    }
  };

  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players)).filter((id) => game.players[id]);

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-emerald-300">현재 턴 지정</div>
        <div className="text-[10px] text-zinc-400">현재 행동할 플레이어를 강제로 바꿉니다 (액션 단계만). 대기 중인 선택/이미 패스한 플레이어는 거부됩니다.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {order.map((id) => {
          const p = game.players[id];
          const isCurrent = game.turnOrder?.[game.currentPlayerIndex ?? 0] === id;
          const passed = Boolean((p as any).hasPassed);
          return (
            <Button
              key={id}
              size="sm"
              variant="outline"
              className="h-7 text-xs border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
              disabled={busy !== null || isCurrent || passed}
              onClick={() => setTurn(id)}
            >
              {busy === id ? '지정 중…' : `${p.name}${isCurrent ? ' (현재)' : ''}${passed ? ' (패스)' : ''}`}
            </Button>
          );
        })}
      </div>
      {message && <div className="text-[10px] text-zinc-400">{message}</div>}
    </div>
  );
}

function FederationTogglePanel({ game }: { game: GameState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const toggle = async (targetPlayerId: string, index: number) => {
    const key = `${targetPlayerId}:${index}`;
    setBusy(key);
    setMessage('');
    try {
      const nowGreen = await GameClient.adminToggleFederationGreen(game.id, targetPlayerId, index, ADMIN_PASSWORD);
      setMessage(`${game.players[targetPlayerId]?.name ?? '플레이어'} 연방 #${index + 1} → ${nowGreen ? '초록(사용가능)' : '빨강(사용됨)'}`);
    } catch (err: any) {
      setMessage(err?.message || '실패');
    } finally {
      setBusy(null);
    }
  };

  const order = (game.turnOrder && game.turnOrder.length ? game.turnOrder : Object.keys(game.players)).filter((id) => game.players[id]);
  const anyFed = order.some((id) => getFederationEntries(game.players[id] as any).length > 0);

  return (
    <div className="rounded-xl border border-fuchsia-500/30 bg-fuchsia-950/20 p-3 space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-black text-fuchsia-300">연방 토큰 초록/빨강 토글</div>
        <div className="text-[10px] text-zinc-400">이미 사용해 <b>빨강</b>으로 뒤집힌 연방을 다시 <b>초록(사용가능)</b>으로 되돌립니다 (또는 반대). 클릭할 때마다 토글.</div>
      </div>
      {!anyFed && <div className="text-[10px] text-zinc-500">아직 연방을 형성한 플레이어가 없습니다.</div>}
      <div className="space-y-2">
        {order.map((id) => {
          const p = game.players[id];
          const entries = getFederationEntries(p as any);
          if (entries.length === 0) return null;
          return (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-zinc-300 w-24 truncate shrink-0">{p.name}</span>
              {entries.map((e, i) => {
                const key = `${id}:${i}`;
                return (
                  <Button
                    key={i}
                    size="sm"
                    variant="outline"
                    title={e.rewardId}
                    className={`h-7 text-xs disabled:opacity-40 ${e.isGreen
                      ? 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/20'
                      : 'border-red-500/50 text-red-300 hover:bg-red-500/20'}`}
                    disabled={busy !== null}
                    onClick={() => toggle(id, i)}
                  >
                    {busy === key ? '…' : `#${i + 1} ${e.isGreen ? '초록' : '빨강'}`}
                  </Button>
                );
              })}
            </div>
          );
        })}
      </div>
      {message && <div className="text-[10px] text-zinc-400">{message}</div>}
    </div>
  );
}

export function AdminModeDialog({ open, onOpenChange, game }: AdminModeDialogProps) {
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setPassword('');
      setError('');
    }
  }, [open]);

  const submitPassword = () => {
    if (password === ADMIN_PASSWORD) {
      setUnlocked(true);
      setError('');
      return;
    }
    setError('비밀번호가 맞지 않습니다.');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl bg-zinc-950 border-white/10 text-zinc-100 p-0 overflow-hidden">
        <DialogHeader className="p-5 border-b border-white/10 bg-zinc-900/70">
          <DialogTitle className="font-black uppercase tracking-widest">Admin Mode</DialogTitle>
          <DialogDescription className="text-zinc-400">
            숨겨진 관리자 모드입니다. 플레이어의 점수, 자원, 파워 상태를 직접 변경합니다.
          </DialogDescription>
        </DialogHeader>

        {!unlocked ? (
          <form
            className="p-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitPassword();
            }}
          >
            <div className="space-y-2">
              <Label className="text-xs text-zinc-400">Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
                className="bg-zinc-900 border-white/10"
                autoFocus
              />
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <Button type="submit" className="w-full">
              입장
            </Button>
          </form>
        ) : (
          <ScrollArea className="max-h-[70vh]">
            <div className="p-5 space-y-3">
              <SeatPasswordPanel game={game} />
              <RejoinLinkPanel game={game} />
              <ForceEndGameButton gameId={game.id} ended={game.currentPhase === 'gameEnd'} />
              <SetCurrentTurnPanel game={game} />
              <RollbackTurnPanel game={game} />
              <RollbackQuotaPanel game={game} />
              <FederationTogglePanel game={game} />
              {Object.entries(game.players).map(([pid, player]) => (
                <PlayerAdminEditor key={pid} gameId={game.id} playerId={pid} player={player} />
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
