// ============================================================
// Database Auto-Init — "ready event" schema bootstrap
// (PRIVATE build, cutiee-bot-live pattern)
// ------------------------------------------------------------
// Problem this solves: a fresh self-hosted Supabase (or a new
// Coolify deploy pointing at one) has NO tables. The monitor
// toggle silently no-ops (cloud save fails) — exactly the
// "settings went gayab after restart" bug.
//
// Solution — same pattern as the cutiee bot live repo: when the
// server boots (the Next.js "ready event" = instrumentation.ts
// register() hook), run idempotent `CREATE TABLE IF NOT EXISTS`
// statements. Missing tables heal themselves; existing tables
// are never touched.
//
// TWO paths, tried in order (v3.10.0 — cutiee parity):
//   1. DIRECT Postgres via DATABASE_URL (pg Client)
//   2. SUPABASE REST via the `exec_sql` RPC — EXACTLY what the
//      cutiee bot live repo does (`supabase.rpc("exec_sql",
//      { query: DDL })`). Needs only SUPABASE_URL +
//      SUPABASE_SERVICE_KEY — the same credentials the Ophelia
//      deployment already has, so copying them into Coolify is
//      enough. No separate Postgres password required.
//
// ENV (set in Coolify):
//   DATABASE_URL    postgres://postgres:<pw>@<host>:5432/postgres
//                   (aliases: POSTGRES_URL, SUPABASE_DB_URL)
//   PGSSL=1         force TLS (also auto-on when the URL has
//                   sslmode=require). Self-hosted on the same
//                   Docker network usually needs NO ssl.
//   OR (path 2 — preferred when only Supabase creds exist):
//   SUPABASE_URL        https://<host> (Kong gateway base)
//   SUPABASE_SERVICE_KEY  service-role key
//
// NOT configured → this module is fully inert (public deploys
// without any of the above are unaffected). Failures NEVER crash
// the app — worst case the REST layer keeps retrying like
// before, and the next restart retries the bootstrap.
//
// Security contract (matches scripts/supabase-schema.sql):
//   - RLS is ENABLED with NO policies on every table → only
//     the service-role key (REST) or the Postgres superuser
//     (this bootstrap) can read/write. The anon key gets nothing.
//   - Only DDL lives here — no user data is ever read.
//   - Errors log a status word + table names, never credentials.
// ============================================================

import { Client } from 'pg'
import { APP_VERSION } from './version'

// Re-exported for backwards compatibility (instrumentation imports it from here).
export { APP_VERSION }

export interface SchemaStatus {
  /** Any bootstrap path configured? (false = feature fully inert) */
  configured: boolean
  /** Connection + DDL succeeded */
  ok: boolean
  /** Tables that exist (created now OR already present) */
  tables: string[]
  /** Short status word for logs/webhook: ok | off | error:<word> */
  status: 'ok' | 'off' | 'error'
  /** Which path ran: 'postgres' (DATABASE_URL) | 'rpc' (exec_sql, cutiee pattern) | 'off' */
  via: 'postgres' | 'rpc' | 'off'
  error?: string
  durationMs: number
  bootId: string
}

// ---------- DDL (idempotent — safe on EVERY boot) ----------

const TABLES: Array<{ name: string; ddl: string[] }> = [
  {
    name: 'monitor_state',
    ddl: [
      `create table if not exists monitor_state (
        id             text primary key,
        enabled        boolean          not null default false,
        token_sealed   text,
        user_id        text,
        username       text,
        interval_hours double precision not null default 24,
        next_run_at    bigint,
        updated_at     timestamptz     not null default now()
      )`,
      `alter table monitor_state enable row level security`,
    ],
  },
  // v3.11.4 — badge_completions + badge_tasks are GONE together with
  // the /badge page: badges are passive Discord telemetry awards (the
  // Quests badge auto-grants when a quest completes), so the app keeps
  // no badge tables. Existing leftover tables in old deploys are
  // harmless and simply stop being touched.
]

// ---------- env helpers ----------

/** Short, log-safe error word (AggregateError messages are often empty). */
function errorWord(e: unknown): string {
  if (e instanceof Error && e.message) return e.message.split('\n')[0].slice(0, 120)
  const err = e as NodeJS.ErrnoException & { errors?: Array<Error | { code?: string; message?: string }> }
  if (err?.code) return String(err.code)
  if (err?.errors?.[0]) {
    const first = err.errors[0]
    const msg = first instanceof Error
      ? first.message
      : String(first.code ?? first.message ?? 'connection failed')
    return msg.split('\n')[0].slice(0, 120)
  }
  return 'unknown error'
}

function databaseUrl(): string {
  const raw = (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.SUPABASE_DB_URL ||
    ''
  ).trim()
  // Only accept Postgres connection strings. Some platforms inject
  // DATABASE_URL for OTHER databases (e.g. `file:/…` sqlite URLs) — those
  // are not ours to touch, so treat them as "not configured" (inert).
  if (raw && !/^postgres(ql|e5)?:\/\//i.test(raw)) {
    console.warn(
      '[db-init] DATABASE_URL is not a postgres:// connection string — table auto-create skipped'
    )
    return ''
  }
  return raw
}

export function databaseConfigured(): boolean {
  return databaseUrl().length > 0 || rpcConfigured()
}

// ---------- Supabase REST config (exec_sql path — cutiee pattern) ----------

function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
}

function supabaseKey(): string {
  return (process.env.SUPABASE_SERVICE_KEY || '').trim()
}

function rpcConfigured(): boolean {
  return supabaseUrl().length > 0 && supabaseKey().length > 0
}

/** TLS decision: explicit PGSSL wins, else sslmode= in the URL. */
function sslConfig(url: string): boolean | { rejectUnauthorized: false } | undefined {
  const v = (process.env.PGSSL || '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'require') {
    return { rejectUnauthorized: false }
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  if (/sslmode=(require|verify-ca|verify-full|prefer)/i.test(url)) {
    return { rejectUnauthorized: false } // self-signed certs OK (self-hosted)
  }
  return undefined
}

// ---------- cached status (for /api/debug + boot webhook) ----------

const g = globalThis as unknown as { __schemaStatus?: SchemaStatus }

export function getSchemaStatus(): SchemaStatus | null {
  return g.__schemaStatus ?? null
}

// ---------- the bootstrap ----------

const CONNECT_TIMEOUT_MS = 8_000
const BOOT_ID = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Ensure every table exists. Runs at most once per process (subsequent
 * calls return the cached status). NEVER throws — always resolves.
 *
 * Path order: DATABASE_URL (direct pg) → SUPABASE_URL+KEY (exec_sql RPC,
 * cutiee pattern) → inert.
 */
export async function ensureDatabaseSchema(): Promise<SchemaStatus> {
  if (g.__schemaStatus) return g.__schemaStatus

  const started = Date.now()
  const url = databaseUrl()

  if (!url) {
    if (rpcConfigured()) {
      // ---- cutiee pattern: DDL via the exec_sql RPC over REST ----
      const status = await ensureViaRpc(started)
      g.__schemaStatus = status
      return status
    }
    const status: SchemaStatus = {
      configured: false,
      ok: false,
      tables: [],
      status: 'off',
      via: 'off',
      durationMs: 0,
      bootId: BOOT_ID,
    }
    g.__schemaStatus = status
    console.log('[db-init] no DATABASE_URL and no SUPABASE_URL/SERVICE_KEY — table auto-create skipped (inert)')
    return status
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: CONNECT_TIMEOUT_MS,
    ssl: sslConfig(url) ?? undefined,
  })

  const ensured: string[] = []
  try {
    await client.connect()
    for (const table of TABLES) {
      for (const stmt of table.ddl) await client.query(stmt)
      ensured.push(table.name)
    }
    await client.end()

    const status: SchemaStatus = {
      configured: true,
      ok: true,
      tables: ensured,
      status: 'ok',
      via: 'postgres',
      durationMs: Date.now() - started,
      bootId: BOOT_ID,
    }
    g.__schemaStatus = status
    console.log(
      `[db-init] schema ready in ${status.durationMs}ms — tables ensured: ${ensured.join(', ')}`
    )
    return status
  } catch (e) {
    const word = errorWord(e)
    try {
      await client.end()
    } catch {
      /* already closed */
    }
    const status: SchemaStatus = {
      configured: true,
      ok: false,
      tables: ensured,
      status: 'error',
      via: 'postgres',
      error: word,
      durationMs: Date.now() - started,
      bootId: BOOT_ID,
    }
    g.__schemaStatus = status
    console.error(`[db-init] schema bootstrap failed: ${word} (tables ensured so far: ${ensured.join(', ') || 'none'})`)
    return status
  }
}

// ---------- exec_sql RPC bootstrap (cutiee-bot-live pattern) ----------

/**
 * Run the DDL through Supabase's exec_sql RPC — the exact mechanism
 * the cutiee bot live repo uses (`supabase.rpc("exec_sql", {query})`).
 * One RPC call per table keeps failures isolated and log lines precise.
 */
async function ensureViaRpc(started: number): Promise<SchemaStatus> {
  const base = supabaseUrl()
  const key = supabaseKey()
  const ensured: string[] = []

  const runOne = async (sql: string): Promise<string | null> => {
    try {
      const res = await fetch(`${base}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      })
      if (res.ok) return null
      // 404/405 style errors carry a PostgREST JSON body — surface a short word
      let word = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { message?: string; code?: string }
        if (body?.code) word = body.code
        else if (body?.message) word = body.message.slice(0, 80)
      } catch {
        /* not JSON — keep HTTP status */
      }
      return word
    } catch (e) {
      return e instanceof Error ? e.name : 'fetch failed'
    }
  }

  for (const table of TABLES) {
    // Multiple statements in one RPC call — the cutiee bot sends a
    // single `query` string containing CREATE + ALTER separated by `;`.
    const sql = table.ddl.join('; ')
    const err = await runOne(sql)
    if (err) {
      const status: SchemaStatus = {
        configured: true,
        ok: false,
        tables: ensured,
        status: 'error',
        via: 'rpc',
        error: `${err} (table: ${table.name})`,
        durationMs: Date.now() - started,
        bootId: BOOT_ID,
      }
      console.error(
        `[db-init] exec_sql RPC failed on ${table.name}: ${err} (ensured so far: ${ensured.join(', ') || 'none'}) `
      )
      return status
    }
    ensured.push(table.name)
  }

  const status: SchemaStatus = {
    configured: true,
    ok: true,
    tables: ensured,
    status: 'ok',
    via: 'rpc',
    durationMs: Date.now() - started,
    bootId: BOOT_ID,
  }
  console.log(
    `[db-init] schema ready via exec_sql RPC in ${status.durationMs}ms — tables ensured: ${ensured.join(', ')}`
  )
  return status
}

// ---------- test hook ----------

/**
 * Run the DDL against an injected pg-like client (unit tests use a fake).
 * Exported ONLY for tests — production code always uses ensureDatabaseSchema().
 */
export async function runDDL(
  query: (sql: string) => Promise<unknown>
): Promise<string[]> {
  const ensured: string[] = []
  for (const table of TABLES) {
    for (const stmt of table.ddl) await query(stmt)
    ensured.push(table.name)
  }
  return ensured
}
