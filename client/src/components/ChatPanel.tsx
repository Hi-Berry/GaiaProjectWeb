import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, X, Send } from 'lucide-react';
import { GameClient, type GameState, type ChatMessage } from '@/lib/gameClient';
import { FACTIONS } from '@shared/gameConfig';

interface ChatPanelProps {
    gameId: string;
    game: GameState;
    /** 채팅 가능 여부 (게임 참가자 또는 관전자) */
    canChat: boolean;
}

/** 인게임 채팅 — 하단 왼쪽, 최상위 레이어. 접으면 작은 버튼(안 읽음 배지), 펼치면 메시지+입력창. */
export function ChatPanel({ gameId, game, canChat }: ChatPanelProps) {
    // 열림 상태를 localStorage에 보존 → 새로고침/턴 넘어가도 상시 떠 있게
    const [open, setOpen] = useState(() => {
        try { return localStorage.getItem('gaia-chat-open') === '1'; } catch { return false; }
    });
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [unread, setUnread] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const openRef = useRef(open);
    openRef.current = open;

    useEffect(() => {
        try { localStorage.setItem('gaia-chat-open', open ? '1' : '0'); } catch { /* noop */ }
    }, [open]);

    // Enter 키로 채팅 열고 입력창 포커스 (입력칸/다이얼로그에 포커스가 있을 땐 무시)
    useEffect(() => {
        if (!canChat) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Enter' || e.isComposing) return;
            // activeElement는 입력창 blur 직후 body로 바뀌어, 빈 Enter로 닫자마자 다시 열리는 문제가 있었음.
            // 이벤트가 발생한 요소(e.target)로 판정하면 blur 여부와 무관하게 입력창에서의 Enter를 정확히 무시.
            const el = (e.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
            if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [canChat]);

    // id 기준 병합(중복 방지) + 시간순 정렬. 히스토리(game.chatMessages)와 라이브 이벤트를 함께 수용.
    const merge = useCallback((incoming: ChatMessage[]) => {
        if (!incoming?.length) return;
        setMessages((prev) => {
            const byId = new Map(prev.map((m) => [m.id, m]));
            let added = false;
            for (const m of incoming) if (!byId.has(m.id)) { byId.set(m.id, m); added = true; }
            if (!added) return prev;
            return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
        });
    }, []);

    // 접속/재접속 시 게임 상태에 담긴 최근 히스토리 시드
    useEffect(() => {
        if (game.chatMessages?.length) merge(game.chatMessages);
    }, [game.chatMessages, merge]);

    // 라이브 메시지 수신
    useEffect(() => {
        const unsub = GameClient.onChatMessage((m) => {
            merge([m]);
            if (!openRef.current) setUnread((u) => u + 1);
        });
        return () => { unsub(); }; // cleanup은 void 반환이어야 함(unsub은 Socket을 반환하므로 감쌈)
    }, [merge]);

    // 열려 있으면 안 읽음 초기화 + 맨 아래로 스크롤
    useEffect(() => {
        if (!open) return;
        setUnread(0);
        requestAnimationFrame(() => {
            if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
        });
    }, [open, messages]);

    const send = () => {
        const t = draft.trim();
        if (!t) return;
        GameClient.sendChat(gameId, t);
        setDraft('');
        // 연속 채팅 편하도록 입력창 포커스 유지
        inputRef.current?.focus();
    };

    if (!canChat) return null;

    const colorFor = (m: ChatMessage) =>
        m.faction ? FACTIONS.find((f) => f.id === m.faction)?.color ?? '#a1a1aa' : '#a1a1aa';

    return (
        <div className="fixed left-[264px] md:left-[336px] bottom-3 z-[120] flex flex-col items-start" style={{ pointerEvents: 'none' }}>
            {open ? (
                <div
                    className="w-[320px] max-w-[85vw] bg-black/85 backdrop-blur-md border border-white/15 rounded-xl shadow-2xl flex flex-col overflow-hidden"
                    style={{ pointerEvents: 'auto' }}
                >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-zinc-900/60">
                        <span className="text-xs font-black uppercase tracking-widest text-zinc-200">채팅</span>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="text-zinc-400 hover:text-white transition-colors"
                            aria-label="채팅 닫기"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div ref={listRef} className="h-56 overflow-y-auto px-3 py-2 space-y-1 custom-scrollbar">
                        {messages.length === 0 ? (
                            <div className="text-[11px] text-zinc-500 text-center py-8">아직 메시지가 없습니다</div>
                        ) : (
                            messages.map((m) => (
                                <div key={m.id} className="text-[12px] leading-snug break-words">
                                    <span className="font-bold" style={{ color: colorFor(m) }}>
                                        {m.isSpectator ? '👁 ' : ''}{m.name}
                                    </span>
                                    <span className="text-zinc-300">: {m.text}</span>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex items-center gap-1.5 p-2 border-t border-white/10 bg-zinc-900/40">
                        <input
                            ref={inputRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    // 빈 상태에서 Enter면 채팅창 닫기 (열고 닫기 편하게)
                                    if (!draft.trim()) {
                                        e.currentTarget.blur();
                                        setOpen(false);
                                    } else {
                                        send();
                                    }
                                } else if (e.key === 'Escape') {
                                    e.currentTarget.blur();
                                }
                            }}
                            maxLength={300}
                            placeholder="메시지 입력 후 Enter (빈 채로 Enter면 닫힘)"
                            className="flex-1 min-w-0 bg-zinc-900/70 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-primary/50"
                        />
                        <button
                            type="button"
                            onClick={send}
                            disabled={!draft.trim()}
                            className="shrink-0 bg-primary/80 hover:bg-primary disabled:opacity-40 text-white rounded-md p-1.5 transition-colors"
                            aria-label="보내기"
                        >
                            <Send className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    style={{ pointerEvents: 'auto' }}
                    className="relative flex items-center gap-1.5 bg-black/80 backdrop-blur-md border border-white/15 rounded-full pl-3 pr-4 py-2 shadow-2xl hover:bg-zinc-800/90 transition-colors"
                >
                    <MessageCircle className="w-4 h-4 text-primary" />
                    <span className="text-xs font-bold text-zinc-200">채팅</span>
                    {unread > 0 && (
                        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                            {unread > 99 ? '99+' : unread}
                        </span>
                    )}
                </button>
            )}
        </div>
    );
}
