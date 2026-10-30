-- ============================================================
-- Restart-proof state tables (private build)
--
-- NOTE (v3.10.0): you normally DON'T need to run this by hand.
-- The app auto-creates every table on boot via the
-- instrumentation.ts ready hook (cutiee-bot-live pattern — see
-- src/lib/db-init.ts) using EITHER a direct DATABASE_URL
-- connection OR the exec_sql RPC with SUPABASE_URL +
-- SUPABASE_SERVICE_KEY (the cutiee bot's exact mechanism — no
-- separate Postgres password needed). This file stays as the
-- reference schema / manual fallback for the Supabase SQL editor.
--
-- RLS is enabled with NO policies → only the service-role key
-- (SUPABASE_SERVICE_KEY, server-side only) can read/write these
-- tables. The anon key can do nothing.
--
-- token_sealed always holds AES-256-GCM ciphertext
-- ("enc:v1:<iv>:<tag>:<ct>") — never a plaintext token.
-- ============================================================

create table if not exists monitor_state (
  id             text primary key,
  enabled        boolean          not null default false,
  token_sealed   text,
  user_id        text,
  username       text,
  interval_hours double precision not null default 24,
  next_run_at    bigint,
  updated_at     timestamptz     not null default now()
);

alter table monitor_state enable row level security;

-- ============================================================
-- Badges (v3.11.4): no badge tables — the /badge page is gone.
-- Badges are passive Discord telemetry awards; the Quests badge
-- auto-grants to the profile when a quest completes. Leftover
-- badge_completions / badge_tasks tables in old deploys are
-- harmless and simply unused.
-- ============================================================
