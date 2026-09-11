// boardgamers.space(BGS) 공개 API로 특정 유저의 종료된 Gaia Project 게임 전부를 내려받는다 — 증분 방식.
// 사용:  node scripts/fetchBgsGames.mjs hikary27            (기본: hikary27)
//        node scripts/fetchBgsGames.mjs hikary27 --index-only  (목록/ELO 요약만, 무브로그 다운로드 생략)
//
// 출력: data/bgs-games/<user>/games/<gameId>.json   — 게임 전체(data.moveHistory 포함, 원본 그대로)
//       data/bgs-games/<user>/index.json           — 게임별 요약(날짜·종족·점수·순위·ELO 변동·상대)
//       data/bgs-games/<user>/index.csv            — 같은 내용 CSV
//
// API (2026-09 확인):
//   GET /api/user/infoByName/:name                         → { _id, account:{username} }
//   GET /api/game/status/ended?user=<id>&count=100&skip=N  → 게임 목록(플레이어별 score/faction/ranking/elo)
//   GET /api/game/status/ended/count?user=<id>             → 총 게임 수
//   GET /api/gameplay/:gameId                              → 전체 상태(data.moveHistory = 무브 문자열 배열)
//   ※ www. 로 치면 308 → 반드시 https://boardgamers.space 사용. gameplay 응답은 gzip 압축.
import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';

const BASE = 'https://boardgamers.space/api';
const args = process.argv.slice(2);
const USERNAME = args.find((a) => !a.startsWith('--')) || 'hikary27';
const INDEX_ONLY = args.includes('--index-only');
const PAGE = 100;
const DELAY_MS = 400; // 서버 예의

const OUT_DIR = path.join(process.cwd(), 'data', 'bgs-games', USERNAME);
const GAMES_DIR = path.join(OUT_DIR, 'games');
fs.mkdirSync(GAMES_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // fetch가 자동 해제하지 못한 gzip(매직 1f 8b) 대비
      const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      return JSON.parse(text);
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`  ⚠ 재시도 ${i}/${tries}: ${e.message}`);
      await sleep(1500 * i);
    }
  }
}

function summarize(g, userId) {
  const me = g.players.find((p) => p._id === userId);
  const others = g.players.filter((p) => p._id !== userId);
  return {
    gameId: g._id,
    game: g.game?.name,
    createdAt: g.createdAt,
    lastMove: g.lastMove,
    nbPlayers: g.players.length,
    cancelled: !!g.cancelled,
    options: g.game?.options ?? null,
    faction: me?.faction ?? null,
    score: me?.score ?? null,
    ranking: me?.ranking ?? null,
    dropped: !!me?.dropped,
    eloInitial: me?.elo?.initial ?? null,
    eloDelta: me?.elo?.delta ?? null,
    eloAfter: me?.elo ? me.elo.initial + me.elo.delta : null,
    opponents: others.map((p) => ({ name: p.name, faction: p.faction, score: p.score, ranking: p.ranking, eloDelta: p.elo?.delta ?? null })),
  };
}

function toCsv(rows) {
  const cols = ['gameId', 'createdAt', 'lastMove', 'nbPlayers', 'faction', 'score', 'ranking', 'eloInitial', 'eloDelta', 'eloAfter', 'dropped', 'cancelled', 'opponents'];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'opponents' ? r.opponents.map((o) => `${o.name}(${o.faction}:${o.score})`).join(' | ') : r[c])).join(','))].join('\n');
}

(async () => {
  console.log(`▶ BGS 유저 조회: ${USERNAME}`);
  const info = await getJson(`${BASE}/user/infoByName/${encodeURIComponent(USERNAME)}`);
  const userId = info._id;
  console.log(`  id=${userId} (가입 ${info.createdAt})`);

  const total = await getJson(`${BASE}/game/status/ended/count?user=${userId}`);
  console.log(`▶ 종료 게임 총 ${total}개 — ${PAGE}개씩 페이지 순회`);

  const list = [];
  for (let skip = 0; skip < total; skip += PAGE) {
    const page = await getJson(`${BASE}/game/status/ended?user=${userId}&count=${PAGE}&skip=${skip}`);
    list.push(...page);
    console.log(`  목록 ${Math.min(skip + PAGE, total)}/${total}`);
    if (page.length < PAGE) break;
    await sleep(DELAY_MS);
  }
  // 중복 제거(페이지 경계에서 순서 흔들릴 수 있음) + 최신순
  const byId = new Map(list.map((g) => [g._id, g]));
  const games = [...byId.values()].sort((a, b) => new Date(b.lastMove || b.createdAt) - new Date(a.lastMove || a.createdAt));
  const gaia = games.filter((g) => g.game?.name === 'gaia-project');
  console.log(`  고유 ${games.length}개, 그중 gaia-project ${gaia.length}개`);

  const index = gaia.map((g) => summarize(g, userId));
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ user: USERNAME, userId, fetchedAt: new Date().toISOString(), total: index.length, games: index }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'index.csv'), '﻿' + toCsv(index), 'utf8');
  console.log(`✔ index.json / index.csv 저장 (${index.length}개)`);

  if (INDEX_ONLY) return;

  const todo = gaia.filter((g) => !fs.existsSync(path.join(GAMES_DIR, `${g._id}.json`)));
  console.log(`▶ 무브로그 다운로드: 신규 ${todo.length}개 (이미 있음 ${gaia.length - todo.length}개)`);
  let done = 0, fail = 0;
  for (const g of todo) {
    try {
      const full = await getJson(`${BASE}/gameplay/${encodeURIComponent(g._id)}`);
      const moves = full?.data?.moveHistory?.length ?? 0;
      if (!moves) console.warn(`  ⚠ ${g._id}: moveHistory 없음`);
      fs.writeFileSync(path.join(GAMES_DIR, `${g._id}.json`), JSON.stringify(full));
      done++;
      if (done % 10 === 0 || done === todo.length) console.log(`  ${done}/${todo.length} (${g._id}, ${moves} moves)`);
    } catch (e) {
      fail++;
      console.error(`  ❌ ${g._id}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`✔ 완료: 성공 ${done}, 실패 ${fail}, 저장 위치 ${OUT_DIR}`);
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
