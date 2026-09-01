/** 종족별 통계 — 우리 게임 로그(전원 사람 4인) 기반: 등장·승률·평균 점수·평균 순위·최고점. */
import { gameRanks, pageShell, esc } from '../lib/common.mjs';
import { factionKo, factionFaceB64 } from '../lib/factions.mjs';

export const meta = {
  id: 'factions',
  order: 2,
  title: '종족별 통계',
  emoji: '👽',
  accent: '#c792ea',
  description: '종족별 등장 횟수·승률·평균 점수·평균 순위 (우리 로그 기반)',
};

export function build({ games }) {
  const st = {}; // factionId -> {n, wins, scoreSum, rankSum, best, bestBy, bidSum, bidGames}
  for (const { game: g } of games) {
    const ranks = gameRanks(g);
    for (const r of ranks) {
      if (!r.faction) continue;
      const s = (st[r.faction] ??= { n: 0, wins: 0, scoreSum: 0, rankSum: 0, best: 0, bestBy: '', bidSum: 0, bidGames: 0 });
      s.n++; s.scoreSum += r.score; s.rankSum += r.rank;
      if (r.rank === 1) s.wins++;
      if (r.score > s.best) { s.best = r.score; s.bestBy = r.name; }
      s.bidSum += r.bid;
      if (ranks.biddingUsed) s.bidGames++;
    }
  }
  const rows = Object.entries(st).map(([id, s]) => ({
    id, ...s, winRate: s.wins / s.n, avgScore: s.scoreSum / s.n, avgRank: s.rankSum / s.n,
    avgBid: s.bidGames > 0 ? s.bidSum / s.bidGames : null,
    avgScorePreBid: (s.scoreSum + s.bidSum) / s.n,
  })).sort((a, b) => b.winRate - a.winRate || a.avgRank - b.avgRank);

  const tr = (r, i) => {
    const face = factionFaceB64(r.id);
    return `
    <tr class="${i === 0 ? 'top1' : ''}">
      <td>${i + 1}</td>
      <td class="name l">${face ? `<img class="face" src="${face}" alt="" />` : ''}${esc(factionKo(r.id))}</td>
      <td>${r.n}</td>
      <td>${r.wins}</td>
      <td class="hi">${(r.winRate * 100).toFixed(1)}%</td>
      <td>${r.avgScore.toFixed(1)}</td>
      <td>${r.avgScorePreBid.toFixed(1)}</td>
      <td>${r.avgBid == null ? '<span class="dim">–</span>' : r.avgBid.toFixed(1)}</td>
      <td>${r.avgRank.toFixed(2)}</td>
      <td class="dim">${r.best} (${esc(r.bestBy)})</td>
    </tr>`;
  };

  const body = `
  <div class="sec">
    <h2>종족 성적 (승률순)</h2>
    <div class="tblwrap">
      <table class="tbl">
        <thead><tr>
          <th>#</th><th class="l">종족</th><th>등장</th><th>승</th><th>승률</th><th>평균 점수</th><th>평균 점수(비딩 전)</th><th>평균 비딩</th><th>평균 순위</th><th>최고점 (기록자)</th>
        </tr></thead>
        <tbody>${rows.map(tr).join('')}</tbody>
      </table>
    </div>
    <p class="legend">4인전 기대 승률은 25% — 그보다 높으면 강세 종족. 동점은 같은 순위로 처리.
      평균 비딩은 비딩을 쓴 판만 분모(– = 비딩 판 없음), 평균 점수(비딩 전)는 최종 점수에 비딩을 되돌린 값.
      열 제목을 클릭하면 정렬됩니다.</p>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b>의 우리 로그 기준, 종족을 잡은 사람의 성적으로 집계.`,
    bodyHtml: body,
    footNote: '집계: 게임 종료 시점 최종 점수(저장 로그)',
  });
}
