/** 최종 미션 통계 — 미션별 등장 판수·평균 획득 VP·잘 먹는 사람 TOP 3.
 *  0점 미션은 finalMissionDetails에서 빠지므로 판의 미션 목록을 4인 합집합으로 복원해 0점으로 센다
 *  (scripts/playerFinalMissionReport.mjs와 동일 방식). */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT, canon, pageShell, esc } from '../lib/common.mjs';

export const meta = {
  id: 'missions',
  order: 7,
  title: '최종 미션 통계',
  emoji: '🎯',
  accent: '#f0a6b4',
  description: '최종 미션별 평균 획득 VP와 미션을 잘 먹는 사람 TOP 3',
};

/** missionId → {label, img} — gameConfig FINAL_MISSION_LABELS 순서 = EGS_N.jpg 번호 */
const MISSIONS = [
  { id: 'fm_gaia_planets', label: '가이아 행성 수', img: 1 },
  { id: 'fm_satellites', label: '위성 수', img: 2 },
  { id: 'fm_planet_types', label: '행성 유형 수', img: 3 },
  { id: 'fm_sectors', label: '섹터 수', img: 4 },
  { id: 'fm_federation_buildings', label: '연방 건물 수', img: 5 },
  { id: 'fm_total_structures', label: '총 건물 수', img: 6 },
  { id: 'fm_outer_sectors', label: '외각 섹터 수', img: 7 },
  { id: 'fm_pi_academy_distance', label: '의회-아카데미 거리', img: 8 },
  { id: 'fm_asteroid_buildings', label: '소행성 건물 수', img: 9 },
];
const MIN_APPEAR = 5; // 플레이어 순위 진입 최소 등장 횟수

const missionImgB64 = (n) => {
  const p = path.join(REPO_ROOT, 'client', 'public', 'image', `EGS_${n}.jpg`);
  return fs.existsSync(p) ? `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` : null;
};

const MEDAL = ['gold', 'silver', 'bronze'];

export function build({ games }) {
  const fm = {}; // missionId -> { games, vpAll: number[], byName: name -> {n, sum} }
  let usableGames = 0;
  for (const { game: g } of games) {
    const players = Object.values(g.players).filter((p) => Array.isArray(p.scoreBreakdown?.finalMissionDetails));
    if (players.length === 0) continue; // breakdown 없는 판(미완주·구버전)
    const gameFms = [...new Set(players.flatMap((p) => p.scoreBreakdown.finalMissionDetails.map((d) => d.missionId)))];
    if (gameFms.length === 0) continue;
    usableGames++;
    for (const mid of gameFms) {
      const s = (fm[mid] ??= { games: 0, vpSum: 0, n: 0, byName: {} });
      s.games++;
      for (const p of players) {
        const vp = p.scoreBreakdown.finalMissionDetails.find((d) => d.missionId === mid)?.vp ?? 0;
        s.vpSum += vp; s.n++;
        const b = (s.byName[canon(p.name)] ??= { n: 0, sum: 0 });
        b.n++; b.sum += vp;
      }
    }
  }

  const card = (def) => {
    const s = fm[def.id];
    if (!s) return '';
    const img = missionImgB64(def.img);
    const top = Object.entries(s.byName)
      .map(([name, b]) => ({ name, n: b.n, avg: b.sum / b.n }))
      .filter((r) => r.n >= MIN_APPEAR)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 3);
    const rows = top.length === 0 ? '<div class="empty">표본 부족</div>' : top.map((r, i) => `
      <div class="row">
        <span class="medal ${MEDAL[i]}">${i + 1}</span>
        <span class="pname">${esc(r.name)}</span>
        <span class="pval">${r.avg.toFixed(1)}<em> VP</em></span>
        <span class="psub">/${r.n}회</span>
      </div>`).join('');
    return `
  <section class="egg">
    <header class="egg-head">
      ${img ? `<img class="mission-img" src="${img}" alt="${esc(def.label)}" />` : ''}
      <div class="egg-title">
        <h3>${esc(def.label)}</h3>
        <span class="egg-total">등장 ${s.games}판 · 전체 평균 ${(s.vpSum / s.n).toFixed(1)} VP</span>
      </div>
    </header>
    <div class="boards">
      <div class="board" style="grid-column: 1 / -1;">
        <h4>회당 평균 VP TOP 3 <span class="cond">${MIN_APPEAR}회↑</span></h4>
        ${rows}
      </div>
    </div>
  </section>`;
  };

  const body = `
  <div class="sec">
    <h2>미션별 성적 (등장 많은 순)</h2>
    <div class="grid">${[...MISSIONS].filter((d) => fm[d.id]).sort((a, b) => fm[b.id].games - fm[a.id].games).map(card).join('')}</div>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `최종 점수 내역이 남은 <b>4인 게임 ${usableGames}판</b> 기준(판당 미션 2개).
      기록에 없는 플레이어 점수는 0점으로 계산 — 0점 미션은 저장에서 생략되기 때문.`,
    bodyHtml: body,
    footNote: '집계: scoreBreakdown.finalMissionDetails · 판의 미션 목록은 4인 합집합으로 복원',
  });
}
