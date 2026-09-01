/** 개인별 상성 분석 — 같이 치면 잘 풀리는(도움) / 안 풀리는(방해) 동반자.
 *  기준: A가 B와 '함께한 판'의 평균 순위 vs 'B 없이 친 판'의 평균 순위 차이(Δ). */
import { gameRanks, pageShell, esc, MIN_GAMES } from '../lib/common.mjs';

export const meta = {
  id: 'synergy',
  order: 7,
  title: '개인별 상성 분석',
  emoji: '🤝',
  accent: '#eab0d9',
  description: '같이 치면 잘 풀리는 사람 / 안 풀리는 사람 — 함께한 판의 평균 순위 변화',
};

const MIN_SHARED = 8; // 동반자 표본 최소 판수

const MEDAL = ['gold', 'silver', 'bronze'];

export function build({ games }) {
  // pair[A][B] = {n, rankSum}  (A의 성적, B와 함께한 판)
  const pair = {};
  const solo = {}; // A -> {games, wins, rankSum}
  for (const { game: g } of games) {
    const ranks = gameRanks(g);
    for (const a of ranks) {
      const sa = (solo[a.name] ??= { games: 0, wins: 0, rankSum: 0 });
      sa.games++; sa.rankSum += a.rank; if (a.rank === 1) sa.wins++;
      for (const b of ranks) {
        if (a.name === b.name) continue;
        const p = ((pair[a.name] ??= {})[b.name] ??= { n: 0, rankSum: 0 });
        p.n++; p.rankSum += a.rank;
      }
    }
  }

  const players = Object.entries(solo)
    .filter(([, s]) => s.games >= MIN_GAMES)
    .sort((a, b) => b[1].games - a[1].games);

  const card = ([name, s]) => {
    const rows = Object.entries(pair[name] ?? {})
      .filter(([, p]) => p.n >= MIN_SHARED)
      .map(([mate, p]) => {
        const withAvg = p.rankSum / p.n;
        const withoutN = s.games - p.n;
        const withoutAvg = withoutN > 0 ? (s.rankSum - p.rankSum) / withoutN : null;
        return { mate, n: p.n, withAvg, withoutAvg, delta: withoutAvg == null ? 0 : withoutAvg - withAvg };
      })
      .filter((r) => r.withoutAvg != null);
    if (rows.length === 0) return '';
    const helpers = [...rows].sort((a, b) => b.delta - a.delta).slice(0, 3);
    const hinders = [...rows].sort((a, b) => a.delta - b.delta).slice(0, 3);

    const row = (r, i, good) => `
      <div class="row" title="${esc(r.mate)}와 함께 ${r.n}판: 평균 ${r.withAvg.toFixed(2)}등 · 없이: ${r.withoutAvg.toFixed(2)}등">
        <span class="medal ${MEDAL[i]}">${i + 1}</span>
        <span class="pname">${esc(r.mate)}</span>
        <span class="pval" style="${good ? '' : 'color:#e08585'}">${r.withAvg.toFixed(2)}등</span>
        <span class="psub">${good ? '▲' : '▼'}${Math.abs(r.delta).toFixed(2)}</span>
      </div>`;

    return `
  <section class="egg">
    <header class="egg-head">
      <div class="egg-title">
        <h3>${esc(name)}</h3>
        <span class="egg-total">${s.games}판 · 승률 ${((s.wins / s.games) * 100).toFixed(0)}% · 평균 ${(s.rankSum / s.games).toFixed(2)}등</span>
      </div>
    </header>
    <div class="boards">
      <div class="board"><h4>같이 하면 잘 풀림</h4>${helpers.map((r, i) => row(r, i, true)).join('')}</div>
      <div class="board"><h4>같이 하면 안 풀림</h4>${hinders.map((r, i) => row(r, i, false)).join('')}</div>
    </div>
  </section>`;
  };

  const body = `
  <div class="sec">
    <h2>플레이어별 동반자 상성 (판수 많은 순)</h2>
    <div class="grid">${players.map(card).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b> 기준. 각 칸의 숫자는 <b>그 사람과 함께한 판에서 내 평균 순위</b>,
      ▲▼는 그 사람 없이 친 판 대비 변화량(▲=함께일 때 더 좋음). 같은 판 ${MIN_SHARED}회 이상 동반자만,
      본인 ${MIN_GAMES}판 이상만 표시. 행에 마우스를 올리면 상세.`,
    bodyHtml: body,
    footNote: '주의: 상관관계일 뿐 인과가 아님 — 같이 친 시기·인원 구성의 영향이 섞여 있음',
  });
}
