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
