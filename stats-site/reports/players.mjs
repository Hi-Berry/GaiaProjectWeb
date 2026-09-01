/** 개인별 통계 · ELO — 우리 게임 로그(전원 사람 4인) 기반. ELO는 판별 4인 쌍대결 방식(시간순). */
import { gameRanks, gameTime, pageShell, esc, MIN_GAMES } from '../lib/common.mjs';

export const meta = {
  id: 'players',
  order: 1,
  title: '개인별 통계',
  emoji: '📈',
  accent: '#8ab4f8',
  description: '판수·승률·평균 점수·평균 순위 + ELO 레이팅 (우리 로그 기반)',
};

const ELO_START = 1500;
const ELO_K = 32; // 4인전: 상대별 K/3로 분배

export function build({ games }) {
  // 시간순 정렬 (ELO는 순서에 민감)
  const ordered = [...games].sort((a, b) => gameTime(a) - gameTime(b));

  const st = {}; // name -> {games, wins, scoreSum, rankSum, best, elo, bidSum, bidGames}
  const get = (name) => (st[name] ??= { games: 0, wins: 0, scoreSum: 0, rankSum: 0, best: 0, bestFaction: '', elo: ELO_START, bidSum: 0, bidGames: 0 });

  for (const entry of ordered) {
    const ranks = gameRanks(entry.game);
    // 기본 집계
    for (const r of ranks) {
      const s = get(r.name);
      s.games++; s.scoreSum += r.score; s.rankSum += r.rank;
      if (r.rank === 1) s.wins++;
      if (r.score > s.best) { s.best = r.score; s.bestFaction = r.faction; }
      s.bidSum += r.bid;
      if (ranks.biddingUsed) s.bidGames++; // 비딩 쓴 판만 평균 분모 (비딩 없던 판으로 희석 방지)
    }
    // ELO: 쌍대결 (이긴 쪽 1, 동점 0.5), 게임 시작 시점 레이팅으로 일괄 계산 후 반영
    const before = Object.fromEntries(ranks.map((r) => [r.name, get(r.name).elo]));
    const delta = Object.fromEntries(ranks.map((r) => [r.name, 0]));
    for (let i = 0; i < ranks.length; i++) {
      for (let j = i + 1; j < ranks.length; j++) {
        const a = ranks[i], b = ranks[j];
        const ea = 1 / (1 + 10 ** ((before[b.name] - before[a.name]) / 400));
        const sa = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
        const k = ELO_K / (ranks.length - 1);
        delta[a.name] += k * (sa - ea);
        delta[b.name] += k * ((1 - sa) - (1 - ea));
      }
    }
    for (const r of ranks) get(r.name).elo += delta[r.name];
  }

  const rows = Object.entries(st).map(([name, s]) => ({
    name, ...s,
    winRate: s.wins / s.games, avgScore: s.scoreSum / s.games, avgRank: s.rankSum / s.games,
    avgBid: s.bidGames > 0 ? s.bidSum / s.bidGames : null,
    avgScorePreBid: (s.scoreSum + s.bidSum) / s.games,
  })).sort((a, b) => b.elo - a.elo);

  const tr = (r, i) => `
    <tr class="${i === 0 ? 'top1' : ''}">
      <td>${i + 1}</td>
      <td class="name l">${esc(r.name)}${r.games < MIN_GAMES ? ' <span class="dim">°</span>' : ''}</td>
      <td class="hi">${Math.round(r.elo)}</td>
      <td>${r.games}</td>
      <td>${r.wins}</td>
      <td>${(r.winRate * 100).toFixed(1)}%</td>
      <td>${r.avgScore.toFixed(1)}</td>
      <td>${r.avgScorePreBid.toFixed(1)}</td>
      <td>${r.avgBid == null ? '<span class="dim">–</span>' : r.avgBid.toFixed(1)}</td>
      <td>${r.avgRank.toFixed(2)}</td>
      <td class="dim">${r.best}</td>
    </tr>`;

  const body = `
  <div class="sec">
    <h2>ELO 랭킹 · 개인 성적</h2>
    <div class="tblwrap">
      <table class="tbl">
        <thead><tr>
          <th>#</th><th class="l">플레이어</th><th>ELO</th><th>판수</th><th>승</th><th>승률</th><th>평균 점수</th><th>평균 점수(비딩 전)</th><th>평균 비딩</th><th>평균 순위</th><th>최고점</th>
        </tr></thead>
        <tbody>${rows.map(tr).join('')}</tbody>
      </table>
    </div>
    <p class="legend">ELO: 시작 ${ELO_START}, 판마다 4인 쌍대결(승 1 / 동점 0.5)로 갱신 (K=${ELO_K}, 상대별 분배) —
      게임 시간순 반영. ° = ${MIN_GAMES}판 미만(레이팅 미확정).
      평균 비딩은 비딩을 쓴 판만 분모(–&nbsp;= 비딩 판 없음), 평균 점수(비딩 전)는 최종 점수에 비딩을 되돌린 값.
      열 제목을 클릭하면 정렬됩니다.</p>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b>의 우리 로그 기준 — 동점은 같은 순위로 처리.`,
    bodyHtml: body,
    footNote: '집계: 게임 종료 시점 최종 점수(저장 로그)',
  });
}
