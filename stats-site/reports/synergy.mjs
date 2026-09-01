/** 개인별 상성 분석 — 같이 치면 잘 풀리는(도움) / 안 풀리는(방해) 동반자.
 *  기준: A가 B와 '함께한 판'의 평균 순위 vs 'B 없이 친 판'의 평균 순위 차이(Δ). */
import { gameRanks, pageShell, esc, MIN_GAMES, medalCls, TOP_N } from '../lib/common.mjs';

export const meta = {
  id: 'synergy',
  order: 8,
  title: '개인별 상성 분석',
  emoji: '🤝',
  accent: '#eab0d9',
  description: '같이 치면 잘 풀리는 사람 / 안 풀리는 사람 — 함께한 판의 평균 순위 변화',
};

/** 동반자 표본 최소 판수 — 본인 판수에 비례(÷3), 5~8판 사이로 클램프.
 *  [사용자 2026-09-01] 고정 8판이면 판수 적은 사람은 동반자가 다 잘려 '연관자 없음'처럼 보임. */
const minShared = (myGames) => Math.max(5, Math.min(8, Math.round(myGames / 3)));

export function build({ games }) {
  // pair[A][B] = {n, rankSum, scoreSum}  (A의 성적, B와 함께한 판)
  const pair = {};
  const solo = {}; // A -> {games, wins, rankSum, scoreSum}
  for (const { game: g } of games) {
    const ranks = gameRanks(g);
    for (const a of ranks) {
      const sa = (solo[a.name] ??= { games: 0, wins: 0, rankSum: 0, scoreSum: 0 });
      sa.games++; sa.rankSum += a.rank; sa.scoreSum += a.score; if (a.rank === 1) sa.wins++;
      for (const b of ranks) {
        if (a.name === b.name) continue;
        const p = ((pair[a.name] ??= {})[b.name] ??= { n: 0, rankSum: 0, scoreSum: 0 });
        p.n++; p.rankSum += a.rank; p.scoreSum += a.score;
      }
    }
  }

  const players = Object.entries(solo)
    .filter(([, s]) => s.games >= MIN_GAMES)
    .sort((a, b) => b[1].games - a[1].games);

  const card = ([name, s]) => {
    const shared = minShared(s.games);
    const rows = Object.entries(pair[name] ?? {})
      .filter(([, p]) => p.n >= shared)
      .map(([mate, p]) => {
        const withoutN = s.games - p.n;
        if (withoutN <= 0) return null;
        const withRank = p.rankSum / p.n;
        const withoutRank = (s.rankSum - p.rankSum) / withoutN;
        const withScore = p.scoreSum / p.n;
        const withoutScore = (s.scoreSum - p.scoreSum) / withoutN;
        return {
          mate, n: p.n, withRank, withoutRank, withScore, withoutScore,
          dRank: withoutRank - withRank,       // 양수 = 함께일 때 순위 좋아짐
          dScore: withScore - withoutScore,     // 양수 = 함께일 때 점수 오름
        };
      })
      .filter(Boolean);
    if (rows.length === 0) return '';
    // 순위가 실제로 좋아지는(▲) 사람만 왼쪽, 나빠지는(▼) 사람만 오른쪽 —
    // 표본이 적을 때 같은 사람이 양쪽에 중복 등장하던 혼동 제거.
    const helpers = rows.filter((r) => r.dRank > 0).sort((a, b) => b.dRank - a.dRank).slice(0, TOP_N);
    const hinders = rows.filter((r) => r.dRank < 0).sort((a, b) => a.dRank - b.dRank).slice(0, TOP_N);

    const arrow = (d, digits) => `${d >= 0 ? '▲' : '▼'}${Math.abs(d).toFixed(digits)}`;
    const row = (r, i, good) => `
      <div class="row" title="${esc(r.mate)}와 함께 ${r.n}판 — 순위 ${r.withRank.toFixed(2)}등(없이 ${r.withoutRank.toFixed(2)}) · 점수 ${r.withScore.toFixed(0)}점(없이 ${r.withoutScore.toFixed(0)})">
        <span class="medal ${medalCls(i)}">${i + 1}</span>
        <span class="pname">${esc(r.mate)}</span>
        <span class="svc ${good ? 'good' : 'bad'}"><b>${r.withRank.toFixed(2)}등</b><i>${arrow(r.dRank, 2)}</i></span>
        <span class="svc ${r.dScore >= 0 ? 'good' : 'bad'}"><b>${r.withScore.toFixed(0)}점</b><i>${arrow(r.dScore, 1)}</i></span>
      </div>`;

    return `
  <section class="egg">
    <header class="egg-head">
      <div class="egg-title">
        <h3>${esc(name)}</h3>
        <span class="egg-total">${s.games}판 · 승률 ${((s.wins / s.games) * 100).toFixed(0)}% · 평균 ${(s.rankSum / s.games).toFixed(2)}등 · ${(s.scoreSum / s.games).toFixed(0)}점 · 동반 ${shared}판↑ 기준</span>
      </div>
    </header>
    <div class="boards">
      <div class="board"><h4>같이 하면 잘 풀림 <span class="cond">순위·점수</span></h4>${helpers.length ? helpers.map((r, i) => row(r, i, true)).join('') : '<div class="empty">해당 없음</div>'}</div>
      <div class="board"><h4>같이 하면 안 풀림 <span class="cond">순위·점수</span></h4>${hinders.length ? hinders.map((r, i) => row(r, i, false)).join('') : '<div class="empty">해당 없음</div>'}</div>
    </div>
  </section>`;
  };

  const body = `
  <style>
    /* [사용자] 카드가 좁아 이름이 잘림 → 한 줄에 2장 (좁은 화면 1장) + 카드 안 보드는 세로로 쌓아 이름 칸 확보 */
    .grid { grid-template-columns: repeat(2, 1fr); }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
    .boards { grid-template-columns: 1fr; }
    .pname { font-size: 13px; }
    .svc { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 0; flex-shrink: 0; width: 4.6em; }
    .svc b { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 700; }
    .svc i { font-style: normal; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; }
    .svc.good b { color: var(--accent); } .svc.good i { color: #79c99e; }
    .svc.bad b { color: #e08585; } .svc.bad i { color: #e08585; }
  </style>
  <div class="sec">
    <h2>플레이어별 동반자 상성 (판수 많은 순)</h2>
    <div class="grid">${players.map(card).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b> 기준. 각 행은 <b>그 사람과 함께한 판에서의 내 평균 순위와 평균 점수</b>,
      ▲▼는 그 사람 없이 친 판 대비 변화(▲=함께일 때 더 좋음). 동반자 최소 판수는 본인 판수÷3(5~8판)으로
      카드마다 다름(헤더에 표기), 본인 ${MIN_GAMES}판 이상만 표시. 행에 마우스를 올리면 상세.`,
    bodyHtml: body,
    footNote: '주의: 상관관계일 뿐 인과가 아님 — 같이 친 시기·인원 구성의 영향이 섞여 있음',
  });
}
