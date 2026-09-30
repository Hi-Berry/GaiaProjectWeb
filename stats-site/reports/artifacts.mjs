/** 인공물 리더보드 — 인공물별 횟수/판당비율 TOP 5. 집계: 게임 로그의 art-* 기록(게임·플레이어·인공물당 1회). */
import { canon, b64img, rankTakers, itemCard, pageShell, MIN_GAMES } from '../lib/common.mjs';

export const meta = {
  id: 'artifacts',
  order: 4,
  title: '인공물 리더보드',
  emoji: '🥚', // [사용자] 인공물을 통칭 '계란'이라고 부름 — 계란 아이콘은 인공물 담당
  accent: '#d9a45b',
  description: '인공물(계란)별 최다 획득자 — 횟수·판당 비율 TOP 5',
};

const ARTS = [
  { id: 'art-vp-science', label: '과학 트랙 ×3 VP', img: 1 },
  { id: 'art-7vp-virtual-proto', label: '7VP + 가상광산(프로토)', img: 2 },
  { id: 'art-vp-gaia', label: '가이아 트랙 ×3 VP', img: 3 },
  { id: 'art-fed-once', label: '연방 보상 재수령', img: 4 },
  { id: 'art-imm-2o5c', label: '광석 2 + 크레딧 5', img: 5 },
  { id: 'art-7vp-virtual-asteroid', label: '7VP + 가상광산(소행성)', img: 6 },
  { id: 'art-vp-planet-types', label: '3 + 행성유형 VP', img: 7 },
  { id: 'art-imm-3k1q', label: '지식 3 + 정큐 1', img: 8 },
  { id: 'art-vp-tracks3', label: '3레벨↑ 트랙 ×3 VP', img: 9 },
  { id: 'art-income-1k1o', label: '수익: 지식 1 + 광석 1', img: 10 },
  { id: 'art-imm-3o3c', label: '광석 3 + 크레딧 3', img: 11 },
  { id: 'art-vp-bridge', label: '외곽 구역 ×3 VP', img: 12 },
  { id: 'art-income-2p3', label: '수익: 3그릇 파워 2', img: 13 },
];

export function build({ games, gamesPerPlayer }) {
  const take = {}; // artId -> name -> count
  for (const { game: g } of games) {
    const seen = new Set(); // playerId|artId — 획득+사용 로그 중복 제거
    for (const l of g.gameLog ?? []) {
      if (!/^art-/.test(l.tileId ?? '') || !l.playerId || !g.players[l.playerId]) continue;
      const key = `${l.playerId}|${l.tileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = canon(g.players[l.playerId].name);
      (take[l.tileId] ??= {})[name] = (take[l.tileId][name] ?? 0) + 1;
    }
  }
  const stats = Object.fromEntries(Object.entries(take).map(([rid, byName]) => [rid, rankTakers(byName, gamesPerPlayer)]));

  const body = `
  <div class="sec">
    <h2>인공물 13종</h2>
    <div class="grid">${[...ARTS].filter((d) => stats[d.id])
      .sort((a, b) => stats[b.id].total - stats[a.id].total)
      .map((d) => itemCard({ label: d.label, imgSrc: b64img(`Art${d.img}.png`), stat: stats[d.id] })).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b> 기준, 인공물별로 누가 많이 먹었나.
      <b>횟수</b>는 총 획득 수, <b>판당 비율</b>은 자기가 뛴 판수로 나눈 값(${MIN_GAMES}판 이상만 순위 진입).`,
    bodyHtml: body,
    footNote: '집계: 게임 로그의 인공물 획득/사용 기록 (게임·플레이어·인공물당 1회)',
  });
}
