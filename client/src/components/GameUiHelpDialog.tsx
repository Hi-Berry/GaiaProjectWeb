import { Fragment, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getNotifyPref,
  setNotifyPref,
  requestNotifyPermission,
  getNotifyPermission,
  notificationsSupported,
  getNotifyTitle,
  setNotifyTitle,
  getNotifyBody,
  setNotifyBody,
  fireTestNotification,
} from '@/lib/turnNotify';
import { VolumeControl } from '@/components/VolumeControl';
import { GameClient } from '@/lib/gameClient';

interface HelpItem {
  label: string;
  description: string;
  isKey?: boolean;
}

interface HelpSection {
  title: string;
  items: HelpItem[];
}

/** 2열 그리드에 균형 맞게 배치 */
const HELP_COLUMNS: HelpSection[][] = [
  [
    {
      title: '단축키',
      items: [
        { label: 'R', description: '연구 보드', isKey: true },
        { label: 'T', description: '보너스 타일 보드', isKey: true },
        { label: 'F', description: 'Free Actions', isKey: true },
        { label: 'Space', description: '미니보드 핀', isKey: true },
        { label: 'Esc', description: '오버레이 닫기', isKey: true },
      ],
    },
    {
      title: '맵 배너',
      items: [
        { label: 'Round', description: '라운드·메인 액션' },
        { label: 'Confirm', description: '확정·Undo·End Turn' },
        { label: 'Power', description: '파워 제안·알림음' },
      ],
    },
    {
      title: '하단·오버레이',
      items: [
        { label: '보너스', description: '패스 후 선택 패널' },
        { label: '로그', description: '모바일: 우하단 버튼으로 상태창↔로그 토글' },
        { label: '로그%', description: '로그창 상단 슬라이더로 글자 크기 100~300%' },
        { label: '미니창', description: '핀·드래그·리사이즈' },
        { label: 'Income', description: '수익 선택' },
      ],
    },
  ],
  [
    {
      title: '맵 우측',
      items: [
        { label: '메뉴', description: '상태창 on/off' },
        { label: '×2', description: '상세 팝오버 크기', isKey: true },
        { label: '±/휠', description: '줌' },
        { label: '↺', description: '뷰 초기화', isKey: true },
        { label: '?', description: '이 안내', isKey: true },
        { label: '연방', description: '연방 구현 모드' },
      ],
    },
    {
      title: '왼쪽 패널',
      items: [
        { label: 'Free', description: '프리 액션 (F)' },
        { label: 'T/R', description: '보너스·연구 오버레이' },
        { label: 'Layers', description: '미니보드 일괄' },
        { label: '핀', description: '연구·보너스 고정' },
        { label: 'Special', description: '종족 스페셜' },
        { label: '▶', description: '모바일 패널', isKey: true },
      ],
    },
  ],
  [
    {
      title: '오른쪽 상태창',
      items: [
        { label: '클릭', description: '연방·기술·스페셜' },
        { label: '색상●', description: '이름 옆 동그라미 클릭 — 건물·위성 색 변경 (기본값 복원 가능, 내 화면만)' },
        { label: '우클릭', description: '프리액션 자원 변환 O→C·K→C·Q→O' },
        { label: 'hover', description: '맵 강조' },
        { label: '드래그', description: '너비 조절' },
        { label: 'AI', description: '봇 피드백 (L 로그)' },
      ],
    },
    {
      title: '맵·기타',
      items: [
        { label: '드래그', description: '맵 팬' },
        { label: '클릭', description: '행동→Confirm' },
        { label: '방장', description: '플레이어 전환' },
        { label: '관전', description: '조작 불가 배지' },
        { label: '종료', description: '점수 breakdown' },
      ],
    },
  ],
];

function LabelCell({ label, isKey }: { label: string; isKey?: boolean }) {
  if (isKey || label.length <= 6) {
    return (
      <kbd className="inline-block rounded border border-white/15 bg-zinc-800 px-1 py-px font-mono text-[9px] font-bold text-zinc-100 whitespace-nowrap leading-none">
        {label}
      </kbd>
    );
  }
  return <span className="font-semibold text-zinc-200 text-[10px] leading-tight whitespace-nowrap">{label}</span>;
}

function HelpSectionBlock({ section }: { section: HelpSection }) {
  const rows: HelpItem[][] = [];
  for (let i = 0; i < section.items.length; i += 2) {
    rows.push(section.items.slice(i, i + 2));
  }

  return (
    <section className="overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-blue-400">
        {section.title}
      </h3>
      <table className="w-full border-collapse text-[10px]">
        <tbody>
          {rows.map((pair, rowIdx) => (
            <tr key={rowIdx} className="border-b border-white/5 last:border-0 hover:bg-zinc-900/35">
              {pair.map((item) => (
                <Fragment key={item.label}>
                  <td className="w-[2.75rem] max-w-[2.75rem] px-1.5 py-px align-top">
                    <LabelCell label={item.label} isKey={item.isKey} />
                  </td>
                  <td className="min-w-0 px-1 py-px pr-2 align-top leading-snug text-zinc-400">
                    {item.description}
                  </td>
                </Fragment>
              ))}
              {pair.length === 1 && (
                <>
                  <td className="w-[2.75rem] px-1.5 py-px" />
                  <td className="px-1 py-px" />
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NotifyToggle() {
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    setOn(getNotifyPref());
    setTitle(getNotifyTitle());
    setBody(getNotifyBody());
  }, []);

  const supported = notificationsSupported();
  const secure = typeof window !== 'undefined' ? window.isSecureContext : true;

  // 버튼은 항상 클릭 가능 — 안 되는 이유를 메시지로 피드백(비활성화하면 "클릭이 안 된다"로 느껴짐).
  const toggle = async () => {
    setMsg('');
    if (!supported) {
      setMsg('이 브라우저는 알림 API를 지원하지 않습니다.');
      return;
    }
    if (!secure) {
      setMsg('알림은 https 또는 localhost 접속에서만 동작합니다. 지금처럼 http://(IP) 주소면 브라우저가 막습니다 → localhost로 접속해 주세요.');
      return;
    }
    if (on) {
      setNotifyPref(false);
      setOn(false);
      return;
    }
    // 켜는 중: 권한 확인/요청
    let p = getNotifyPermission();
    if (p === 'default') {
      p = await requestNotifyPermission();
    }
    if (p !== 'granted') {
      setMsg(
        p === 'denied'
          ? '브라우저에서 알림이 차단되어 있습니다 — 주소창 자물쇠 아이콘 → 알림 "허용"으로 바꾼 뒤 다시 시도하세요.'
          : '알림 권한이 허용되지 않았습니다. 다시 시도해 주세요.'
      );
      setNotifyPref(false);
      setOn(false);
      return;
    }
    setNotifyPref(true);
    setOn(true);
    setMsg('알림이 켜졌습니다. 탭을 백그라운드에 두면 내 차례에 알림이 뜹니다.');
  };

  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-blue-400">
        알림
      </h3>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-zinc-200">내 차례 데스크톱 알림</div>
          <div className="text-[9px] leading-snug text-zinc-500">
            {msg || '탭을 백그라운드에 둬도 내 차례가 되면 알려줍니다 (보고 있을 땐 안 뜸).'}
          </div>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={on}
          className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-zinc-700'}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[1.125rem]' : 'left-0.5'}`} />
        </button>
      </div>

      {/* 커스텀 문구 (스텔스용) — 비워두면 기본 문구 사용 */}
      <div className="border-t border-white/8 px-2 py-1.5 space-y-1.5">
        <div className="text-[9px] text-zinc-500">알림 문구 (비워두면 기본값). 회사 등에서 무난한 문구로 바꿔두기 좋아요.</div>
        <input
          type="text"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setNotifyTitle(e.target.value); }}
          placeholder="제목 예: Claude 작업이 완료되었습니다."
          className="w-full rounded border border-white/10 bg-zinc-900/70 px-2 py-1 text-[10px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/60 focus:outline-none"
        />
        <input
          type="text"
          value={body}
          onChange={(e) => { setBody(e.target.value); setNotifyBody(e.target.value); }}
          placeholder="내용 (선택) 예: 결과를 확인하세요."
          className="w-full rounded border border-white/10 bg-zinc-900/70 px-2 py-1 text-[10px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/60 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const ok = fireTestNotification();
              setMsg(ok ? '테스트 알림을 보냈습니다 (화면 오른쪽 아래 확인).' : '알림 권한이 없거나 지원되지 않아 테스트할 수 없습니다. 먼저 위 토글로 권한을 허용하세요.');
            }}
            className="rounded border border-blue-500/40 bg-blue-600/20 px-2 py-1 text-[10px] font-semibold text-blue-300 hover:bg-blue-600/30"
          >
            테스트 알림
          </button>
          <button
            type="button"
            onClick={() => { setTitle('Claude 작업이 완료되었습니다.'); setNotifyTitle('Claude 작업이 완료되었습니다.'); setBody(''); setNotifyBody(''); }}
            className="rounded border border-white/10 bg-zinc-800/60 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700/60"
          >
            예시 채우기
          </button>
        </div>
      </div>
    </section>
  );
}

/** 모바일 전용: Info 오버레이(좌하단 i 버튼) 레이아웃 선택 — 가로(드래그 페이지) vs 세로(3창 합쳐 스크롤). localStorage+커스텀이벤트로 Game.tsx와 동기화. */
function TechViewSelector() {
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('info-overlay-layout') === 'vertical') setLayout('vertical');
  }, []);
  const choose = (v: 'horizontal' | 'vertical') => {
    setLayout(v);
    localStorage.setItem('info-overlay-layout', v);
    window.dispatchEvent(new CustomEvent('info-overlay-layout-change', { detail: v }));
  };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-400">
        보드 정보 보기 (좌하단 i 버튼)
      </h3>
      <div className="px-2 py-1.5 space-y-1.5">
        <div className="text-[9px] leading-snug text-zinc-500">기술타일·우주선·라운드 창을 어떻게 볼지 선택합니다.</div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => choose('horizontal')}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${layout === 'horizontal' ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            가로로 보기<div className="text-[8px] font-normal opacity-70 mt-0.5">3페이지 좌우 드래그</div>
          </button>
          <button
            type="button"
            onClick={() => choose('vertical')}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${layout === 'vertical' ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            세로로 보기<div className="text-[8px] font-normal opacity-70 mt-0.5">3창 합쳐 위아래 스크롤</div>
          </button>
        </div>
      </div>
    </section>
  );
}

interface GameUiHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId?: string;
  showTaklonsBrain?: boolean;
  taklonsBrainPriority?: boolean;
}

export function GameUiHelpDialog({ open, onOpenChange, gameId, showTaklonsBrain, taklonsBrainPriority }: GameUiHelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(92vh,820px)] w-[min(96vw,56rem)] max-w-none flex-col gap-0 overflow-hidden border-white/10 bg-zinc-950 p-0 text-zinc-100">
        <DialogHeader className="shrink-0 space-y-0 border-b border-white/10 px-3 py-2 pr-10">
          <DialogTitle className="text-sm font-bold text-white">UI · 단축키 안내</DialogTitle>
          <DialogDescription className="text-[10px] leading-none text-zinc-500">
            웹 클라이언트 UI (게임 규칙 제외)
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-2"
          style={{ maxHeight: 'calc(min(92vh, 820px) - 3.5rem)' }}
        >
          {/* 데스크톱: 차례 알림 토글·문구 / 모바일: 그 자리에 보드 정보 보기(가로·세로) 선택 */}
          <div className="hidden md:block"><NotifyToggle /></div>
          <div className="md:hidden"><TechViewSelector /></div>
          <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
            <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-blue-400">사운드 / 종족</h3>
            <div className="flex items-center justify-between gap-3 px-2 py-1.5">
              <div className="text-[10px] font-semibold text-zinc-200">알림음 크기 (0=음소거)</div>
              <VolumeControl />
            </div>
            {showTaklonsBrain && gameId && (
              <div className="flex items-center justify-between gap-3 border-t border-white/8 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold text-zinc-200">🧠 타클론 파워 소비</div>
                  <div className="text-[9px] leading-snug text-zinc-500">켜짐=큰 파워에 브레인 스톤 먼저 / 꺼짐=일반 토큰 먼저 써 브레인 보존</div>
                </div>
                <button type="button" onClick={() => GameClient.setTaklonsBrainPriority(gameId, !(taklonsBrainPriority ?? true))} className="shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10px] font-bold text-amber-300 hover:text-white">{(taklonsBrainPriority ?? true) ? '브레인 우선' : '브레인 보존'}</button>
              </div>
            )}
          </section>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {HELP_COLUMNS.map((column, colIdx) => (
              <div key={colIdx} className="flex min-w-0 flex-col gap-2">
                {column.map((section) => (
                  <HelpSectionBlock key={section.title} section={section} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
