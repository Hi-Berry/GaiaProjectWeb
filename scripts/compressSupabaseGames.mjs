// [사용자 2026-11-28 "로그 너무 많이 쌓여서 문제 되는거 아닌지"] Supabase 무료 DB 0.5GB 초과(511MB 중 human_game_sessions 485MB)
// → 이미 저장된 기록(jsonb payload)을 압축본(payload_gz: gzip→base64)으로 옮기고 payload를 비운다. 판당 ~354KB → ~60KB.
//
// 전제: ① 표에 payload_gz 칸이 있고 payload가 null 허용(scripts/createHumanGameSessions.sql 아래쪽 ALTER)
//       ② 압축본을 읽는 코드(server/replay.ts, scripts/fetchSupabaseGames.mjs)가 모든 서버·맥에 먼저 배포돼 있을 것
//       ③ data/human-games 에 원본이 다 있을 것(먼저 node scripts/fetchSupabaseGames.mjs)
// 한 줄씩: payload 읽기 → payload_gz 쓰기 → payload_gz 다시 읽어 풀어서 원본과 똑같은지 확인 → 그때만 payload 비우기.
// 끝나면 SQL 편집기에서 `vacuum full public.human_game_sessions;` 를 돌려야 디스크 용량이 실제로 줄어든다(그 전엔 빈 공간으로만 남음).
//
// 사용: SUPABASE_SERVICE_ROLE_KEY=... node scripts/compressSupabaseGames.mjs            ← 몇 줄 바뀔지만 보여 줌(아무것도 안 바꿈)
//       SUPABASE_SERVICE_ROLE_KEY=... node scripts/compressSupabaseGames.mjs --apply --limit 5   ← 5줄만 실제로
//       SUPABASE_SERVICE_ROLE_KEY=... node scripts/compressSupabaseGames.mjs --apply             ← 전부
import * as zlib from 'zlib';

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rsfrwzesgkdntcketkhd.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = process.env.HUMAN_LOG_SUPABASE_TABLE || 'human_game_sessions';
const APPLY = process.argv.includes('--apply');
const li = process.argv.indexOf('--limit');
const LIMIT = li > 0 ? Number(process.argv[li + 1]) : Infinity;
if (!KEY) { console.error('❌ SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.'); process.exit(1); }

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' };
const rest = `${SUPABASE_URL}/rest/v1/${TABLE}`;

async function req(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
    const body = await res.text().catch(() => '');
    if (i >= tries) throw new Error(`${res.status} ${body.slice(0, 200)}`);
    await new Promise(r => setTimeout(r, 1500 * i));
  }
}

async function main() {
  // 아직 압축 안 된 줄(payload가 남아 있는 줄)의 ID만 — payload 자체는 안 받는다
  const ids = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await req(`${rest}?select=game_id&payload=not.is.null&order=completed_at.asc&limit=1000&offset=${offset}`);
    ids.push(...rows.map(r => r.game_id));
    if (rows.length < 1000) break;
  }
  const todo = ids.slice(0, LIMIT);
  console.log(`압축 안 된 줄 ${ids.length}개${APPLY ? ` → 이번에 ${todo.length}개 옮김` : ' (확인만 — 바꾸려면 --apply)'}`);
  if (!APPLY) return;

  let done = 0, before = 0, after = 0;
  for (const id of todo) {
    const q = `${rest}?game_id=eq.${encodeURIComponent(id)}`;
    try {
      const [row] = await req(`${q}&select=payload`);
      if (!row?.payload) { console.log(`  - ${id}: 이미 비어 있음`); continue; }
      const json = JSON.stringify(row.payload);
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
      await req(q, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ payload_gz: gz }) });
      const [back] = await req(`${q}&select=payload_gz`);
      const roundTrip = back?.payload_gz ? zlib.gunzipSync(Buffer.from(back.payload_gz, 'base64')).toString('utf8') : '';
      if (roundTrip !== json) { console.error(`  ✗ ${id}: 다시 읽은 압축본이 원본과 다름 — payload 그대로 둠`); continue; }
      await req(q, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ payload: null }) });
      done++; before += json.length; after += gz.length;
      if (done % 25 === 0 || done === todo.length) console.log(`  … ${done}/${todo.length}  (원본 ${(before / 1048576).toFixed(0)}MB → 압축 ${(after / 1048576).toFixed(0)}MB)`);
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
    }
  }
  console.log(`✅ ${done}줄 옮김. 디스크를 실제로 줄이려면 SQL 편집기에서: vacuum full public.${TABLE};`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
