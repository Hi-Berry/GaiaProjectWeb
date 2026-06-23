import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, X, Send } from 'lucide-react';
import { GameClient, type GameState, type ChatMessage } from '@/lib/gameClient';
import { FACTIONS } from '@shared/gameConfig';
import { playChatSound } from '@/lib/audio';
import { useIsMobile } from '@/hooks/use-mobile';

interface ChatPanelProps {
    gameId: string;
    game: GameState;
    /** 채팅 가능 여부 (게임 참가자 또는 관전자) */
    canChat: boolean;
    /** 내 식별자 (내가 보낸 메시지엔 효과음 안 울리도록) */
    selfId?: string | null;
    /** 모바일 세로: 좌하단 i(Info) 버튼이 숨겨졌을 때 → 채팅을 i 자리(왼쪽 끝)로 당김 */
    infoButtonHidden?: boolean;
}

/** 인게임 채팅 — 하단 왼쪽, 최상위 레이어. 접으면 작은 버튼(안 읽음 배지), 펼치면 메시지+입력창. */
export function ChatPanel({ gameId, game, canChat, selfId, infoButtonHidden }: ChatPanelProps) {
    const isMobile = useIsMobile();
    // 좌하단 앵커 위치: 데스크톱=336px(좌측 툴바 폭), 모바일=i버튼 옆 68px / i버튼 숨김(세로)이면 i 자리 12px
    const anchorLeftPx = isMobile ? (infoButtonHidden ? 12 : 68) : 336;
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
    const selfIdRef = useRef(selfId);
    selfIdRef.current = selfId;

    // 크기 조절(가로=패널 폭, 세로=메시지 영역 높이) — localStorage 보존. 좌하단 앵커라 우측↑폭/상단↑높이.
    const [width, setWidth] = useState(() => { try { const v = Number(localStorage.getItem('gaia-chat-w')); return v >= 220 ? v : 320; } catch { return 320; } });
    const [listHeight, setListHeight] = useState(() => { try { const v = Number(localStorage.getItem('gaia-chat-h')); return v >= 60 ? v : 224; } catch { return 224; } });
    const widthRef = useRef(width); widthRef.current = width;
    const listHeightRef = useRef(listHeight); listHeightRef.current = listHeight;
    useEffect(() => { try { localStorage.setItem('gaia-chat-w', String(width)); } catch { /* noop */ } }, [width]);
    useEffect(() => { try { localStorage.setItem('gaia-chat-h', String(listHeight)); } catch { /* noop */ } }, [listHeight]);

    const startResize = useCallback((e: React.PointerEvent, axis: 'w' | 'h' | 'both') => {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, sw = widthRef.current, sh = listHeightRef.current;
        const onMove = (ev: PointerEvent) => {
            if (axis !== 'h') setWidth(Math.max(220, Math.min(window.innerWidth * 0.9, sw + (ev.clientX - sx))));
            if (axis !== 'w') setListHeight(Math.max(60, Math.min(window.innerHeight * 0.85, sh - (ev.clientY - sy))));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.style.userSelect = '';
        };
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, []);

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
    // 내가 보낸 메시지의 서버 echo가 오면, 먼저 띄운 낙관적(opt-) 항목을 제거해 중복 방지.
    const merge = useCallback((incoming: ChatMessage[]) => {
        if (!incoming?.length) return;
        setMessages((prev) => {
            const byId = new Map(prev.map((m) => [m.id, m]));
            let added = false;
            for (const m of incoming) {
                if (byId.has(m.id)) continue;
                if ((m as any).senderId === selfIdRef.current) {
                    const optKey = Array.from(byId.keys()).find((k) => {
                        const v = byId.get(k);
                        return k.startsWith('opt-') && v?.text === m.text && (v as any)?.senderId === (m as any).senderId;
                    });
                    if (optKey) byId.delete(optKey);
                }
                byId.set(m.id, m); added = true;
            }
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
            if (m.senderId !== selfIdRef.current) playChatSound(); // 내가 보낸 건 제외
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
        // 낙관적 업데이트: 서버 왕복(특히 부하 시 지연) 전에 내 메시지를 즉시 표시. 서버 echo 오면 merge가 opt- 항목 교체.
        const self = selfId ? game.players[selfId] : undefined;
        const optimistic = {
            id: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            senderId: selfId ?? 'me',
            name: self?.name ?? '나',
            faction: self?.faction ?? null,
            isSpectator: !self,
            text: t,
            ts: Date.now(),
        } as ChatMessage;
        setMessages((prev) => [...prev, optimistic].sort((a, b) => a.ts - b.ts));
        setDraft('');
        // 연속 채팅 편하도록 입력창 포커스 유지
        inputRef.current?.focus();
    };

    if (!canChat) return null;

    const colorFor = (m: ChatMessage) =>
        m.faction ? FACTIONS.find((f) => f.id === m.faction)?.color ?? '#a1a1aa' : '#a1a1aa';

    return (
        <div className="fixed bottom-3 z-[120] flex flex-col items-start" style={{ pointerEvents: 'none', left: anchorLeftPx, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}>
            {open ? (
                <div
                    /* 좌측 앵커(모바일 68px·데스크톱 336px)를 뺀 폭으로 우측에 8px 여백 → X 버튼이 화면 밖으로 안 나감 */
                    className="relative bg-black/85 backdrop-blur-md border border-white/15 rounded-xl shadow-2xl flex flex-col overflow-hidden max-w-[calc(100vw-76px)] md:max-w-[calc(100vw-344px)]"
                    style={{ pointerEvents: 'auto', width: `${width}px` }}
                >
                    {/* 크기 조절 핸들: 상단=세로, 우측=가로, 우상단 코너=동시 (좌하단 앵커 기준) */}
                    <div onPointerDown={(e) => startResize(e, 'h')} className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/40 z-20" title="드래그: 높이 조절" />
                    <div onPointerDown={(e) => startResize(e, 'w')} className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize hover:bg-primary/40 z-20" title="드래그: 너비 조절" />
                    <div onPointerDown={(e) => startResize(e, 'both')} className="absolute top-0 right-0 w-3 h-3 cursor-nesw-resize z-30" title="드래그: 크기 조절" />
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

                    <div ref={listRef} className="overflow-y-auto px-3 py-2 space-y-1 custom-scrollbar" style={{ height: `${listHeight}px` }}>
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
                    aria-label="채팅 열기"
                    title="채팅"
                    /* 모바일: 다른 버튼(Info·로그·Menu)과 동일한 동그란 아이콘 버튼. 데스크톱: '채팅' 알약 */
                    className="relative flex items-center justify-center md:justify-start gap-0 md:gap-1.5 h-12 w-12 md:h-auto md:w-auto rounded-full md:pl-3 md:pr-4 md:py-2 border border-white/15 bg-zinc-900/90 md:bg-black/80 backdrop-blur shadow-[0_4px_20px_rgba(0,0,0,0.5)] md:shadow-2xl hover:bg-zinc-800/90 active:scale-95 transition-transform md:transition-colors"
                >
                    <MessageCircle className="w-5 h-5 md:w-4 md:h-4 text-primary" />
                    <span className="hidden md:inline text-xs font-bold text-zinc-200">채팅</span>
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
