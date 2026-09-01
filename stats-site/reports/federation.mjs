/** 연방 리더보드 — 연방 토큰별 횟수/판당비율 TOP 5. 집계: 게임 종료 시점 보유 토큰(players.federations). */
import { canon, b64img, rankTakers, itemCard, pageShell, MIN_GAMES } from '../lib/common.mjs';

export const meta = {
  id: 'federation',
  order: 3,
  title: '연방 리더보드',
  emoji: '🛰️',
  // [사용자] 연방 아이콘은 제일 좋은 '기술 연방'(우주선 연방 기술 타일 보상, Federation_11) 토큰 이미지로
  iconImg: b64img('Federation_11.gif'),
  accent: '#79c99e',
  description: '연방 토큰별 최다 획득자 — 횟수·판당 비율 TOP 5',
};

const STANDARD = [
  { id: 'fed-7vp-6c', label: '7VP + 6크레딧', img: 1 },
  { id: 'fed-7vp-2o', label: '7VP + 광석 2', img: 2 },
  { id: 'fed-8vp-2token', label: '8VP + 토큰 2', img: 3 },
  { id: 'fed-6vp-2k', label: '6VP + 지식 2', img: 4 },
  { id: 'fed-8vp-1q', label: '8VP + 정큐 1', img: 5 },
  { id: 'fed-12vp', label: '12VP', img: 6 },
];
const SHIP = [
  { id: 'ship-fed-4vp4k', label: '4VP + 지식 4', img: 7 },
  { id: 'ship-fed-8vp8c', label: '8VP + 8크레딧', img: 8 },
  { id: 'ship-fed-3tf-mine', label: '무료 광산 (3테라폼)', img: 9 },
  { id: 'ship-fed-4vp1q2o', label: '4VP + 정큐 1 + 광석 2', img: 10 },
  { id: 'ship-fed-tech', label: '기술 타일', img: 11 },
  { id: 'ship-fed-7vp3p2t', label: '7VP + 토큰 2', img: 12 },
  { id: 'ship-fed-12vp', label: '12VP', img: 13 },
  { id: 'ship-fed-mine-free', label: '무료 광산 (거리 무시)', img: 14 },
];

export function build({ games, gamesPerPlayer }) {
  const take = {}; // rewardId -> name -> count
  for (const { game: g } of games) {
    for (const p of Object.values(g.players)) {
      const name = canon(p.name);
      for (const e of p.federations ?? []) {
        const rid = typeof e === 'string' ? e : e.rewardId;
        (take[rid] ??= {})[name] = (take[rid][name] ?? 0) + 1;
      }
    }
  }
  const stats = Object.fromEntries(Object.entries(take).map(([rid, byName]) => [rid, rankTakers(byName, gamesPerPlayer)]));
  const section = (title, defs) => `
  <div class="sec">
    <h2>${title}</h2>
    <div class="grid">${[...defs].filter((d) => stats[d.id])
      .sort((a, b) => stats[b.id].total - stats[a.id].total)
      .map((d) => itemCard({ label: d.label, imgSrc: b64img(`Federation_${d.img}.gif`), stat: stats[d.id] })).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, iconImg: meta.iconImg, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b> 기준, 연방 토큰별로 누가 많이 먹었나.
      <b>횟수</b>는 총 획득 수, <b>판당 비율</b>은 자기가 뛴 판수로 나눈 값(${MIN_GAMES}판 이상만 순위 진입).`,
    bodyHtml: section('일반 연방', STANDARD) + section('우주선 연방', SHIP),
    footNote: '집계: 게임 종료 시점 보유 연방 토큰 · 글린 전용 의회 연방(1O 1K 2C)은 종족 한정이라 제외',
  });
}
