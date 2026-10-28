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
-- Badge dashboard completions (v3.9.0, private build)
-- What the user marked "Complete" on the /badge page — pure
-- dashboard-side tracking. No tokens, no credentials: only
-- (user_id, badge_id, tier label, timestamp). The real Discord
-- badge is granted by Discord's own telemetry pipeline.
-- ============================================================

create table if not exists badge_completions (
  user_id      text        not null,
  badge_id     text        not null,
  tier_name    text,
  completed_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

alter table badge_completions enable row level security;

-- ============================================================
-- REAL engine badge tasks (v3.11.0, private build)
-- The /badge page's Complete button starts the SAME quest engine
-- that powers Start All (enroll → heartbeat → complete — real
-- Discord API calls, 100% server-side). One row per (user, badge):
--   status      running | completed
--   tier_name   the tier the engine is driving toward
--   token_sealed AES-256-GCM sealed token (same contract as
--               monitor_state) so the runner survives restarts
--   last_status running-quest | waiting-engine | waiting-quests |
--               error | token-error | completed
-- The task only completes when the user's LIVE /quests/@me data
-- satisfies the tier requirement — progress is never faked.
-- (duration_ms / completes_at are v3.10.0 legacy columns, unused.)
-- ============================================================

create table if not exists badge_tasks (
  user_id      text        not null,
  badge_id     text        not null,
  tier_name    text,
  status       text        not null default 'running',
  started_at   timestamptz not null default now(),
  duration_ms  bigint      not null default 0,
  completes_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (user_id, badge_id)
);

alter table badge_tasks enable row level security;

-- v3.11.0 columns (idempotent — safe on existing tables)
alter table badge_tasks add column if not exists token_sealed text;
alter table badge_tasks add column if not exists last_status text;
alter table badge_tasks add column if not exists last_error text;
