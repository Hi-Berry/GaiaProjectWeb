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

const ADMIN_PASSWORD = '0011';

type EditablePlayerStats = Pick<PlayerState, 'score' | 'credits' | 'ore' | 'knowledge' | 'qic' | 'power1' | 'power2' | 'power3'>;

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
  }, [player.score, player.credits, player.ore, player.knowledge, player.qic, player.power1, player.power2, player.power3]);

  const setField = (field: keyof EditablePlayerStats, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setMessage('');
  };

  const save = async () => {
    const resources: Partial<EditablePlayerStats> = {
      score: toNumber(values.score),
      credits: toNumber(values.credits),
      ore: toNumber(values.ore),
      knowledge: toNumber(values.knowledge),
      qic: toNumber(values.qic),
      power1: toNumber(values.power1),
      power2: toNumber(values.power2),
      power3: toNumber(values.power3),
    };

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
