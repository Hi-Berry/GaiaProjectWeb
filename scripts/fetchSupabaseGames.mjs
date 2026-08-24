// Supabase에 저장된 사람 게임 로그(human_game_sessions)를 data/human-games/ 로 내려받는다 — 증분 방식.
// 사용:  SUPABASE_SERVICE_ROLE_KEY=... node scripts/fetchSupabaseGames.mjs
// (SUPABASE_URL / HUMAN_LOG_SUPABASE_TABLE 는 env로 덮어쓸 수 있음)
//
// [2026-07-16 개편] 기존엔 매번 전 행의 payload(게임당 ~1MB jsonb)를 통째로 받아 로컬 존재 여부를 나중에
// 확인 → 테이블이 커지며 statement timeout(57014) 빈발. 이제 ①경량 인덱스(game_id, completed_at만) 조회
// ②로컬 파일과 대조해 없는 것만 ③건별 payload 다운로드. 이미 다 받은 상태면 인덱스 쿼리 1~2회로 끝.
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rsfrwzesgkdntcketkhd.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const TABLE = process.env.HUMAN_LOG_SUPABASE_TABLE || 'human_game_sessions';
const OUT_DIR = path.join(process.cwd(), 'data', 'human-games');

if (!KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  console.error('   PowerShell:  $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."; node scripts/fetchSupabaseGames.mjs');
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  Accept: 'application/json',
  'Accept-Profile': 'public',
};

const INDEX_PAGE = 1000; // 경량 컬럼만이라 크게 잡아도 가벼움

// [제외] 봇 hang/강제스킵 버그로 오염된 게임 — 연구·학습에 쓰면 안 됨(봇이 중반부터 소멸해 정상 플레이 아님).
// data/excluded-games/ 에 사유와 함께 보관. 여기 gameId를 넣으면 재다운로드 시에도 스킵된다.
const EXCLUDED_GAME_IDS = new Set([
  'na0vujw3', // 2026-07-06: 워치독 income-대기 오발로 봇2명(HH R3·bescods R4) 강제스킵→소멸, R4+ 봇 전멸. 버그샘플.
  'fi1njhdj', // 2026-07-15: 두 사람이 계정 2개씩 쓴 판(chrome·Hi=하이 / 산타·디애박=디애박) — 사람 단위 통계 오염. [사용자 2026-08-24 로컬 파일 삭제]
]);

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    if (i >= tries) throw new Error(`요청 실패: ${res.status} ${body}`);
    console.warn(`  ↻ 재시도 ${i}/${tries - 1} (${res.status})`);
    await new Promise(r => setTimeout(r, 1500 * i));
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 로컬 보유 gameId 집합 (파일명: <date>_<gameId>.json)
  const localIds = new Set(
    fs.readdirSync(OUT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, '').split('_').slice(1).join('_'))
      .filter(Boolean)
  );

  // ① 경량 인덱스 전체 조회 (payload 없음 — 타임아웃 걱정 없는 크기)
  const index = [];
  for (let offset = 0; ; offset += INDEX_PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=game_id,completed_at&order=completed_at.asc&limit=${INDEX_PAGE}&offset=${offset}`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    index.push(...rows);
    if (rows.length < INDEX_PAGE) break;
  }

  // ② 로컬에 없는 것만 추림
  const missing = index.filter(r => r.game_id && !localIds.has(r.game_id) && !EXCLUDED_GAME_IDS.has(r.game_id));
  console.log(`서버 ${index.length}건 | 로컬 보유 ${localIds.size}건 | 새로 받을 것 ${missing.length}건`);

  // ③ 없는 것만 건별 다운로드 (행 1개짜리 쿼리 — 빠르고 타임아웃 없음)
  let written = 0;
  for (const row of missing) {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=payload,completed_at&game_id=eq.${encodeURIComponent(row.game_id)}&limit=1`;
    let rows;
    try { rows = await getJson(url); } catch (e) { console.error(`  ✗ ${row.game_id}: ${e.message}`); continue; }
    const payload = rows?.[0]?.payload;
    if (!payload) { console.error(`  ✗ ${row.game_id}: payload 없음`); continue; }
    const completed = rows[0].completed_at || row.completed_at || '';
    const datePart = String(completed).slice(0, 10) || 'nodate';
    fs.writeFileSync(path.join(OUT_DIR, `${datePart}_${row.game_id}.json`), JSON.stringify(payload, null, 2));
    written++;
    if (written % 10 === 0) console.log(`  … ${written}/${missing.length}`);
  }

  console.log(`✅ 완료: 새로 저장 ${written}건 (서버 총 ${index.length}건, 로컬 ${localIds.size + written}건) → ${OUT_DIR}`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
