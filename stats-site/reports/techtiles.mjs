/** 일반 기술 타일 리더보드 — 타일별 누가 잘 챙겨가는지 (횟수·판당 비율 TOP 3).
 *  집계: 게임 종료 시점 보유(players.techTiles, 고급 타일로 덮인 것도 획득으로 침). */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT, canon, rankTakers, itemCard, pageShell, MIN_GAMES } from '../lib/common.mjs';

export const meta = {
  id: 'techtiles',
  order: 5, // 고급 타일(6) 앞
  title: '기술 타일 리더보드',
  emoji: '🔬',
  accent: '#7fb8e8',
  description: '일반 기술 타일별 최다 획득자 — 횟수·판당 비율 TOP 3',
};

const TILES = [
  { id: 'tech-inc-1o-1p', label: '수익: 광석 1 + 충전 1', img: 'TechTile_B2.png' },
  { id: 'tech-inc-4c', label: '수익: 크레딧 4', img: 'TechTile_B1.png' },
  { id: 'tech-inc-1k-1c', label: '수익: 지식 1 + 크레딧 1', img: 'TechTile_B7.png' },
  { id: 'tech-imm-7vp', label: '즉시 7VP', img: 'TechTile_B8.png' },
  { id: 'tech-imm-1k-planet', label: '행성유형당 지식 1', img: 'TechTile_B3.png' },
  { id: 'tech-imm-1o-1q', label: '광석 1 + 정큐 1', img: 'TechTile_B4.png' },
  { id: 'tech-gaia-3vp', label: '가이아 광산마다 3VP', img: 'TechTile_B6.png' },
  { id: 'tech-big-4str', label: '대형건물 연방가 4', img: 'TechTile_B5.png' },
  { id: 'tech-act-4p', label: '액션: 파워 4', img: 'TechTile_B9.png' },
];

const techImgB64 = (file) => {
  const p = path.join(REPO_ROOT, 'client', 'public', 'tech', file);
  return fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null;
};

export function build({ games, gamesPerPlayer }) {
  const take = {}; // tileId -> name -> count
  for (const { game: g } of games) {
    for (const p of Object.values(g.players)) {
      const name = canon(p.name);
      for (const tid of p.techTiles ?? []) {
        if (!/^tech-/.test(tid)) continue; // 고급(adv-)·우주선(ship-tech-) 제외
        (take[tid] ??= {})[name] = (take[tid][name] ?? 0) + 1;
      }
    }
  }
  const stats = Object.fromEntries(Object.entries(take).map(([rid, byName]) => [rid, rankTakers(byName, gamesPerPlayer)]));

  const body = `
  <div class="sec">
    <h2>일반 기술 타일 9종 (많이 나간 순)</h2>
    <div class="grid">${[...TILES].filter((d) => stats[d.id])
      .sort((a, b) => stats[b.id].total - stats[a.id].total)
      .map((d) => itemCard({ label: d.label, imgSrc: techImgB64(d.img), stat: stats[d.id] })).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b> 기준, 일반 기술 타일별로 누가 잘 챙겨가는지.
      <b>횟수</b>는 총 획득 수, <b>판당 비율</b>은 자기가 뛴 판수로 나눈 값(${MIN_GAMES}판 이상만 순위 진입).`,
    bodyHtml: body,
    footNote: '집계: 게임 종료 시점 보유 기술 타일(고급 타일로 덮인 것도 획득으로 포함)',
  });
}
