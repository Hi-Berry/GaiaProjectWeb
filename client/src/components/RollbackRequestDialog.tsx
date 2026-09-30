import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROLLBACK_REASONS, ROLLBACK_REASON_TEXT_MAX, type RollbackReasonCode } from '@shared/gameConfig';

/**
 * [사용자 2026-09-30] 롤백 요청 창.
 *   "롤백 요청 뜨는 창에 사유 탭이 있어서 1. 파워 수락 여부 변경 … 6. 기타 직접 입력 이렇게 뜨게 해서
 *    다른 사람들한테 왜 롤백 요청하는지 뜨고 보고 수락/거절할 수 있게 해줘"
 *   예전엔 window.confirm 한 줄이라 사유를 적을 곳이 없었다. 몇 번째 롤백인지("(1/3)")도 여기서 보인다.
 */
export function RollbackRequestDialog({
  open,
  onOpenChange,
  targetLabel,
  ordinal,
  limit,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 클릭한 로그 요약 — 어느 지점으로 되돌리는지 */
  targetLabel: string;
  /** 이번 요청이 몇 번째인지(실행되면 소진) */
  ordinal: number;
  limit: number;
  onSubmit: (reason: { code: RollbackReasonCode; text?: string }) => Promise<void>;
}) {
  const [code, setCode] = useState<RollbackReasonCode | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 창을 새로 열 때마다 이전 선택을 비운다 — 지난번 사유가 남아 그대로 나가면 안 된다
  useEffect(() => {
    if (open) { setCode(null); setText(''); setError(''); setBusy(false); }
  }, [open]);

  const needsText = code === 'custom';
  const canSubmit = !!code && (!needsText || text.trim().length > 0) && !busy;

  const submit = async () => {
    if (!code) { setError('사유를 골라 주세요.'); return; }
    if (needsText && !text.trim()) { setError('기타 사유를 입력해 주세요.'); return; }
    setBusy(true);
    setError('');
    try {
      await onSubmit(needsText ? { code, text: text.trim() } : { code });
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message || '요청에 실패했습니다.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-md bg-zinc-950 border-amber-500/40 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-amber-300 font-black">
            ↩ 롤백 요청 <span className="text-amber-200/90">({ordinal}/{limit})</span>
          </DialogTitle>
          <DialogDescription className="text-zinc-300 leading-relaxed">
            <span className="font-bold text-white">[{targetLabel}]</span> 이 로그가 속한 턴의 시작으로 되돌립니다.
            그 이후 행동은 모두 사라지고 그 턴부터 다시 진행됩니다. 다른 플레이어 전원이 동의해야 실행됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-widest text-zinc-500 font-bold">사유</div>
          <div role="radiogroup" aria-label="롤백 사유" className="grid gap-1.5">
            {ROLLBACK_REASONS.map((r, i) => {
              const on = code === r.code;
              return (
                <button
                  key={r.code}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => { setCode(r.code); setError(''); }}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${on
                    ? 'border-amber-400 bg-amber-500/15 text-amber-100'
                    : 'border-white/10 bg-black/30 text-zinc-300 hover:border-amber-500/40'}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? 'border-amber-300' : 'border-zinc-500'}`}>
                    {on && <span className="h-2 w-2 rounded-full bg-amber-300" />}
                  </span>
                  <span className="text-zinc-500 tabular-nums">{i + 1}.</span>
                  <span className="font-medium">{r.label}</span>
                </button>
              );
            })}
          </div>
          {needsText && (
            <Input
              autoFocus
              value={text}
              maxLength={ROLLBACK_REASON_TEXT_MAX}
              onChange={(e) => { setText(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
              placeholder="다른 사람들에게 보일 사유를 적어 주세요"
              className="bg-zinc-900 border-white/10"
            />
          )}
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="text-[11px] text-zinc-500">
            동의를 받아 실행되면 1회가 소진됩니다. 거절되면 횟수는 그대로입니다.
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" className="flex-1 border-white/15" disabled={busy} onClick={() => onOpenChange(false)}>취소</Button>
          <Button className="flex-1 bg-amber-600 hover:bg-amber-500 text-white font-bold" disabled={!canSubmit} onClick={submit}>
            {busy ? '요청 중…' : '롤백 요청'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
