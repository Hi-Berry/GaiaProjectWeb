import { Fragment, useEffect, useState } from 'react';
import { applyViewportMeta, canOfferPcViewMode, isPcViewMode, setPcViewMode } from '@/lib/viewMode';
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
        { label: '≡', description: '맵 컨트롤 열기/닫기 (안에 상태창 on/off)', isKey: true },
        { label: '×2', description: '상세 팝오버 크기', isKey: true },
        { label: '휠/핀치', description: '줌 (PC는 ± 버튼도)' },
        { label: '↺', description: '뷰 초기화 (PC 전용 버튼)', isKey: true },
        { label: '⊞', description: '구역(섹터) 구분선 on/off', isKey: true },
        { label: '자', description: '편의기능 — 남은 땅 · 거리 측정기' },
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
        { label: '롤백', description: '로그 항목 → "여기로 롤백 요청" (참가자 전원 동의 시 그 턴 시작으로 되돌림)' },
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

/** [사용자] 자주 묻는 질문 — 비직관적 조작 위주. 도움말 하단 접이식(details) 목록으로 표시. */
const FAQ_ITEMS: { q: string; a: string }[] = [
  { q: '프리액션(자원 변환)은 어떻게 하나요?', a: '방법이 세 가지예요.\n① 상태창의 "FA OFF" 버튼을 눌러 "FA ON"으로 바꾼 뒤 자원(O·K·Q·C)·파워 그릇 숫자를 클릭하면 즉시 변환됩니다("FA ON"에서 다시 누르면 이번 턴 프리액션이 모두 취소=Undo All).\n② 상태창의 자원 글자를 우클릭해도 변환됩니다(O→C·K→C·Q→O).\n③ 왼쪽 "Free" 버튼이나 F 키로 Free Action 창을 열어 직접 할 수도 있어요.' },
  { q: '연방은 어떻게 만드나요?', a: '우측 "연방" 버튼으로 연방 모드에 들어간 뒤, 내 건물들을 잇는 빈 칸(우주)을 클릭하면 위성이 놓이며 연방이 형성됩니다. 파워 합이 7 이상 되도록 빈 칸만 클릭해도 연방이 만들어져요.' },
  { q: '기술 타일은 어떻게 쓰나요?', a: '상태창을 클릭해 상세를 연 뒤 기술 타일 이미지를 클릭하거나, 스페셜 액션 영역에서 눌러 사용하세요.' },
  { q: '이전 턴으로 되돌리고 싶어요 (롤백).', a: '로그에서 되돌리고 싶은 지점의 항목을 열어 "↩ 여기로 롤백 요청"을 누르면, 참가자 전원(사람)이 동의할 때 그 턴 시작으로 되돌아갑니다. 봇은 자동 동의.' },
  { q: '파워 충전(누수) 창이 떴어요.', a: '상대가 건물을 지으면 인접한 내게 파워 충전 제안이 옵니다. VP를 깎지 않는 무료 충전은 자동 수락되고, VP를 깎는 유료 충전만 수락/거절을 직접 고릅니다. 처리 전엔 다른 사람 액션이 잠깐 대기합니다.' },
  { q: '내 차례 알림음이 안 들려요.', a: '우측 상단 ? 안내창의 "알림음 크기"가 0이면 무음입니다. 탭을 다른 창에 둔 채로도 알림을 받으려면 같은 창의 "내 차례 데스크톱 알림"을 켜세요(https 또는 localhost 접속에서만 동작).' },
  { q: '발타크 포머는 QIC로 어떻게 바꾸나요?', a: '직접 바꾸려면 "FA ON"을 켜고 초록색 포머 동그라미를 클릭하거나, Free Action 창에서 "1 포머 → 1 QIC" 버튼을 누르세요. 그리고 사용하지 않은 포머는 패스하면 자동으로 QIC로 전환됩니다.' },
  { q: '타클론인데 파워 충전 창이 매번 뜨고 선택지가 있어요.', a: '타클론은 VP를 안 깎는 무료 충전이라도 자동 수락되지 않습니다 — 어떻게 받느냐로 결과가 달라지기 때문이에요.\n· "Brain First"(기본 켜짐): 이번 충전에서 브레인 스톤부터 한 그릇 올립니다. 끄면 일반 토큰이 먼저 올라가고 브레인은 제자리예요.\n· 브레인 스톤은 쓸 때 파워 3개 값이라, 3그릇에 올려두면 큰 액션 하나를 혼자 감당합니다. 대신 한 번 쓰면 1그릇으로 내려가요.\n· 쓰는 쪽 기본값은 이 안내창의 "브레인 우선 / 브레인 보존" 버튼에서 바꿉니다(우선=큰 파워에 브레인부터, 보존=일반 토큰부터 써서 브레인 아끼기).' },
  { q: '타클론 의회(PI)를 지으면 뭐가 달라지나요?', a: '파워를 받을 때마다 그릇1에 파워 토큰이 1개씩 더 생깁니다. 수락 창에 "+1 Token (PI)"로 표시돼요.\n· "PI 1st" 버튼으로 순서를 고릅니다. 켜면 토큰을 먼저 만든 뒤 충전해서 그 토큰까지 이번 충전에 올라가고, 끄면 받을 파워를 먼저 받은 뒤 토큰이 추가됩니다(그 토큰은 이번엔 안 올라감).\n· 풀파워라 받을 파워가 0이면 "파워 먼저"로는 아무 일도 안 일어나므로 토큰 먼저로 고정됩니다. 이때도 수락하면 토큰 1개는 얻으니 "+0 Power" 제안도 받을 가치가 있어요.' },
  { q: '가이아 포머는 누가 썼는지 어떻게 아나요?', a: '상태창의 각 플레이어 카드에 포머가 점으로 늘 표시됩니다.\n· 청록색 = 아직 안 쓴 포머, 보라색 = 맵에 설치한 포머(발타크가 QIC로 바꿔 잠긴 것 포함), 빨간색 = 파괴된 포머, "No GF" = 가이아 트랙이 낮아 포머가 아예 없음.\n· 맵에서는 설치된 포머가 그 사람의 종족 색으로 그려집니다. 로그의 "Placed Gaiaformer" 항목으로 누가 언제 놓았는지도 볼 수 있어요.' },
  { q: '건물을 몇 개 지었는지 어디서 보나요?', a: '상태창의 각 플레이어 카드 위쪽에 M · TS · Lab · PI · A 칩으로 늘 표시됩니다(광산 8 · 교역소 4 · 연구소 3 · 의회 1 · 아카데미 2).\n· 한도를 다 채운 칩은 붉게 채워집니다 — 그 건물은 더 못 짓는다는 뜻이에요. 하나도 없으면 점선으로 흐리게 표시됩니다.\n· A 칩의 "0+1"은 좌/우 아카데미를 나눠 센 것이고, M 숫자는 실제 광산 토큰(보드 광산 + 란티다 기생광산)만 셉니다. 잊혀진 행성과 인공물 가상 광산은 별도 토큰이라 한도에서 빠져요.' },
  { q: '구역(섹터) 구분은 어떻게 보나요?', a: '맵 우측 상단 ≡(메뉴)를 눌러 컨트롤을 펼친 뒤 ⊞ 격자 버튼을 켜세요. 섹터 경계선만 그려집니다(같은 섹터 안쪽 선은 생략) — 안쪽 10개 타일과 외각이 한눈에 구분돼요. 켜둔 상태는 브라우저에 저장돼 다음 판에도 유지됩니다.' },
  { q: '다른 기기에서 이어하려면? (컴퓨터↔폰)', a: '두 가지 방법이 있어요.\n① 이 도움말 위의 "다른 기기로 이어하기 → 링크 복사"로 링크를 받아, 폰 등 다른 기기 브라우저에 붙여넣어 열면 그 자리 그대로 이어집니다(링크를 아는 사람은 그 자리를 조작할 수 있으니 같이 하는 사람에게만 공유).\n② 방을 만들 때 좌석 비밀번호를 정해뒀다면, 다른 기기에서 게임을 열고 "내 자리로 이어하기"에 이름·비번을 넣어 복귀할 수도 있어요.' },
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

/** 데스크톱 전용: 남의 상태창 카드 옆 '남은 특수 액션' 스트립 표시 여부.
 *  [2026-08-07 사용자] 정신 사나울 수 있어 끌 수 있게. 기본 ON. localStorage+커스텀이벤트로 Game.tsx와 동기화. */
function SpecialActionStripToggle() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('special-action-strip') === 'off') setOn(false);
  }, []);
  const choose = (v: boolean) => {
    setOn(v);
    localStorage.setItem('special-action-strip', v ? 'on' : 'off');
    window.dispatchEvent(new CustomEvent('special-action-strip-change', { detail: v }));
  };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-cyan-400">
        남은 특수 액션 표시
      </h3>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-zinc-200">다른 사람 카드 옆에 표시</div>
          <div className="text-[9px] leading-snug text-zinc-500">
            아직 안 쓴 특수 액션(기술타일 3O·1Q+5C, 아카데미 QIC, 보너스 타일, 종족 스페셜)을 카드 왼쪽에 띄웁니다.
          </div>
        </div>
        <button
          type="button"
          onClick={() => choose(!on)}
          className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold transition-colors ${on ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
        >
          {on ? '표시' : '숨김'}
        </button>
      </div>
    </section>
  );
}

/** 좌하단 액션 버튼 묶음(Free Actions / Tactical Overview / Research Board / 특수 액션) 표시 여부.
 *  [2026-08-18 사용자] **기본 표시**. (2026-08-14엔 기본 숨김이었다.)
 *  꺼도 기능은 다른 경로로 다 쓸 수 있다(키보드 F/T/R, 미니창 고정, 데스크톱 사이드바). */
function LeftActionButtonsToggle() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('left-action-buttons') === 'off') setOn(false);
  }, []);
  const choose = (v: boolean) => {
    setOn(v);
    localStorage.setItem('left-action-buttons', v ? 'on' : 'off');
    window.dispatchEvent(new CustomEvent('left-action-buttons-change', { detail: v }));
  };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-cyan-400">
        좌하단 액션 버튼
      </h3>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-zinc-200">Free Actions · Tactical · Research 버튼 묶음</div>
          <div className="text-[9px] leading-snug text-zinc-500">
            기본 표시. 숨겨도 단축키(F·T·R)와 미니창 고정으로 똑같이 쓸 수 있습니다.
          </div>
        </div>
        <button
          type="button"
          onClick={() => choose(!on)}
          className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold transition-colors ${on ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
        >
          {on ? '표시' : '숨김'}
        </button>
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

/** 모바일 전용: 화면 줌 ON/OFF — ON이면 브라우저 핀치줌(페이지 전체 확대)을 켜고 맵 자체 줌 기능은 끈다. localStorage+커스텀이벤트로 GameBoard와 동기화. */
function PinchZoomSelector() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('page-pinch-zoom') === 'on') setOn(true);
  }, []);
  const choose = (v: boolean) => {
    setOn(v);
    localStorage.setItem('page-pinch-zoom', v ? 'on' : 'off');
    // [2026-08-11] meta를 직접 쓰지 않는다 — PC 모드도 같은 meta를 쓰므로 나중에 바꾼 쪽이 상대 설정을 지웠다.
    applyViewportMeta();
    window.dispatchEvent(new CustomEvent('page-pinch-zoom-change', { detail: v }));
  };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-400">
        화면 줌 (손가락 확대)
      </h3>
      <div className="px-2 py-1.5 space-y-1.5">
        <div className="text-[9px] leading-snug text-zinc-500">ON이면 두 손가락으로 화면 전체를 확대합니다. 맵 자체 줌(핀치·버튼)은 꺼집니다.</div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => choose(true)}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${on ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            줌 ON<div className="text-[8px] font-normal opacity-70 mt-0.5">페이지 전체 핀치줌</div>
          </button>
          <button
            type="button"
            onClick={() => choose(false)}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${!on ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            줌 OFF<div className="text-[8px] font-normal opacity-70 mt-0.5">맵만 줌 (기존 방식)</div>
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * [사용자 2026-08-11] 폴드 펼침·태블릿처럼 '모바일로 잡히지만 화면은 넉넉한' 기기용 보기 방식 선택.
 * PC 모드는 viewport 폭을 1280으로 선언해 md: 레이아웃을 켠다 → 상태창 아래에 로그가 같이 나온다.
 * 일반 폰에는 아예 안 보인다(canOfferPcViewMode). 켠 뒤엔 되돌릴 수 있게 항상 보인다.
 */
function ViewModeSelector() {
  const [show, setShow] = useState(false);
  const [pc, setPc] = useState(false);
  useEffect(() => {
    setShow(canOfferPcViewMode());
    setPc(isPcViewMode());
  }, []);
  if (!show) return null;
  const choose = (v: boolean) => { setPcViewMode(v); setPc(v); };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-sky-400">
        보기 방식 (큰 화면 기기)
      </h3>
      <div className="px-2 py-1.5 space-y-1.5">
        <div className="text-[9px] leading-snug text-zinc-500">
          PC 모드는 상태창 아래에 로그가 같이 나옵니다. 글자가 작아지면 화면 줌을 켜서 확대하세요.
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => choose(false)}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${!pc ? 'border-sky-400/60 bg-sky-500/20 text-sky-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            모바일 모드<div className="text-[8px] font-normal opacity-70 mt-0.5">상태창 / 로그 탭 전환</div>
          </button>
          <button
            type="button"
            onClick={() => choose(true)}
            className={`flex-1 rounded border px-2 py-1.5 text-[10px] font-bold transition-colors ${pc ? 'border-sky-400/60 bg-sky-500/20 text-sky-200' : 'border-white/10 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`}
          >
            PC 모드<div className="text-[8px] font-normal opacity-70 mt-0.5">상태창 아래 로그 같이</div>
          </button>
        </div>
      </div>
    </section>
  );
}

/** 다른 기기로 이어하기: 좌석 소유권(localStorage playerId)을 ?as= 링크로 옮긴다 (Game.tsx의 파라미터 처리와 한 쌍) */
function ContinueOnDeviceSection({ gameId, playerId }: { gameId: string; playerId: string }) {
  const [msg, setMsg] = useState('');
  const link = `${window.location.origin}/game/${gameId}?as=${playerId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMsg('복사됐습니다 — 폰/다른 기기 브라우저에 붙여넣어 열면 이 자리 그대로 이어집니다.');
    } catch {
      setMsg(link); // 클립보드 불가(비보안 컨텍스트 등) 시 링크 자체를 표시
    }
  };
  return (
    <section className="mb-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
      <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-400">
        다른 기기로 이어하기
      </h3>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-zinc-200">이어하기 링크 복사</div>
          <div className="text-[9px] leading-snug break-all text-zinc-500">
            {msg || '컴퓨터↔폰 이동용. 링크를 아는 사람은 이 자리를 조작할 수 있으니 같이 하는 사람에게만 공유하세요.'}
          </div>
        </div>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[10px] font-bold text-emerald-200 hover:bg-emerald-500/25"
        >
          링크 복사
        </button>
      </div>
    </section>
  );
}

interface GameUiHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId?: string;
  playerId?: string | null;
  showTaklonsBrain?: boolean;
  taklonsBrainPriority?: boolean;
  /** 관리자 모드 진입(모바일용 — PC는 Ctrl+Alt+A 단축키) */
  onOpenAdmin?: () => void;
}

export function GameUiHelpDialog({ open, onOpenChange, gameId, playerId, showTaklonsBrain, taklonsBrainPriority, onOpenAdmin }: GameUiHelpDialogProps) {
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
          <div className="hidden md:block"><NotifyToggle /><SpecialActionStripToggle /></div>
          <div className="md:hidden"><TechViewSelector /><PinchZoomSelector /></div>
          {/* 좌하단 액션 버튼은 데스크톱·모바일(가로) 양쪽에 뜨므로 md 분기 밖에 둔다 */}
          <LeftActionButtonsToggle />
          {/* md:hidden 밖에 둔다 — PC 모드를 켜면 md:가 켜져 이 안에 있으면 되돌릴 버튼이 사라진다 */}
          <ViewModeSelector />
          {gameId && playerId && <ContinueOnDeviceSection gameId={gameId} playerId={playerId} />}
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
          {/* [사용자 2026-08-18] 화면 둘러보기 다시 보기 — GameBoard가 'start-ui-tour'를 받아 스포트라이트 안내를 켠다. */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('start-ui-tour'))}
            className="mt-2 flex w-full items-center gap-2 rounded-md border border-cyan-400/25 bg-cyan-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-cyan-500/20"
          >
            <span className="text-[11px] font-black text-cyan-300">화면 둘러보기</span>
            <span className="text-[9px] leading-snug text-zinc-400">건물 개수·포머·프리액션이 화면 어디 있는지 직접 짚어드립니다 (5단계)</span>
            <span className="ml-auto text-[10px] font-bold text-cyan-300">시작 →</span>
          </button>

          {/* [사용자] 자주 묻는 질문 — 도움말 하단 접이식 목록 */}
          <section className="mt-2 overflow-hidden rounded-md border border-white/8 bg-zinc-900/25">
            <h3 className="border-b border-white/8 bg-zinc-900/80 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-400">자주 묻는 질문 (FAQ)</h3>
            <div className="divide-y divide-white/5">
              {FAQ_ITEMS.map((it, i) => (
                <details key={i} className="group px-2 py-1.5">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-bold text-zinc-200 marker:content-none">
                    <span className="inline-block text-amber-400/70 transition-transform group-open:rotate-90">▶</span>
                    {it.q}
                  </summary>
                  <p className="mt-1 whitespace-pre-line pl-4 text-[10px] leading-relaxed text-zinc-400">{it.a}</p>
                </details>
              ))}
            </div>
          </section>
          {/* 관리자 모드 진입 — 모바일은 키보드 단축키(Ctrl+Alt+A)를 쓸 수 없어 버튼 제공(사용자). PC에도 노출 무방. */}
          {onOpenAdmin && (
            <div className="mt-2 border-t border-white/10 pt-2 text-center">
              <button
                type="button"
                onClick={() => { onOpenChange(false); onOpenAdmin(); }}
                className="rounded-md border border-white/15 bg-zinc-900/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:text-white hover:border-white/30"
              >
                관리자 모드
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
