create table if not exists public.human_game_sessions (
  game_id text primary key,
  completed_at timestamptz not null,
  payload jsonb not null,
  inserted_at timestamptz not null default now()
);

create index if not exists human_game_sessions_completed_at_idx
  on public.human_game_sessions (completed_at desc);

create index if not exists human_game_sessions_payload_gin_idx
  on public.human_game_sessions using gin (payload);

-- PostgREST(REST API)에서 insert 가능하도록
grant usage on schema public to service_role;
grant select, insert, update on public.human_game_sessions to service_role;

-- 테이블 생성 직후 API 스키마 캐시 갱신 (Supabase SQL Editor에서 실행)
notify pgrst, 'reload schema';

-- [2026-11-28] 용량 절감: 기록을 압축본(gzip→base64)으로 저장 — 무료 DB 0.5GB 초과(판당 jsonb ~354KB → 압축 ~60KB).
--   서버는 payload_gz만 채우고 payload는 비운다(칸이 없으면 예전처럼 payload). 기존 줄 옮기기: scripts/compressSupabaseGames.mjs
alter table public.human_game_sessions add column if not exists payload_gz text;
alter table public.human_game_sessions alter column payload drop not null;
notify pgrst, 'reload schema';
