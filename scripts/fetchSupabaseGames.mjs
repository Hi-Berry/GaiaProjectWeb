// Supabase에 저장된 사람 게임 로그(human_game_sessions)를 data/human-games/ 로 전부 내려받는다.
// 사용:  SUPABASE_SERVICE_ROLE_KEY=... node scripts/fetchSupabaseGames.mjs
// (SUPABASE_URL / HUMAN_LOG_SUPABASE_TABLE 는 env로 덮어쓸 수 있음)
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

const PAGE = 500;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let offset = 0;
  let total = 0;
  let written = 0;
  let skipped = 0;

  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=game_id,completed_at,payload&order=completed_at.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`❌ 요청 실패: ${res.status} ${body}`);
      process.exit(1);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      total++;
      const payload = row.payload ?? row;
      const gameId = row.game_id || payload?.gameId || `unknown-${total}`;
      const completed = row.completed_at || payload?.completedAt || '';
      const datePart = String(completed).slice(0, 10) || 'nodate';
      const file = path.join(OUT_DIR, `${datePart}_${gameId}.json`);
      if (fs.existsSync(file)) { skipped++; continue; }
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      written++;
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log(`✅ 완료: 총 ${total}건 조회, 새로 저장 ${written}건, 이미 있어서 건너뜀 ${skipped}건 → ${OUT_DIR}`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
