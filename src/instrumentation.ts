// ============================================================
// instrumentation.ts — the server "ready event" (Next.js hook)
// ------------------------------------------------------------
// Next.js calls register() ONCE when the server process boots
// (node server.js) — the closest thing a web app has to a bot's
// `client.on('ready')`. PRIVATE build: this is where the
// cutiee-bot-live style database bootstrap runs.
//
// Boot sequence (all non-fatal, none of it can crash the server):
//   1. ensureDatabaseSchema() — CREATE TABLE IF NOT EXISTS for
//      every table the app needs (monitor_state) via DATABASE_URL
//      (direct pg) OR the exec_sql RPC (SUPABASE_URL + SERVICE_KEY
//      — the cutiee pattern). Missing tables heal automatically;
//      existing data is never touched. Inert without either config
//      (public deployments are unaffected).
//   2. dispatchServerBootEvent() — when LOG_WEBHOOK_URL is set,
//      a compact signed "server_boot" ping lands on the ops
//      webhook with the boot self-check results. Every deploy
//      pings — no more "deploy hua ya nahi / env lagii ya nahi"
//      guesswork: boot ping aaya = env + egress OK.
//
// v3.11.4 — the badge task runner is GONE together with the
// /badge page: badges are passive Discord telemetry awards (the
// Quests badge auto-grants when a quest completes), so there is
// nothing to run.
//
// The schema work is awaited with a hard cap (connect timeout is
// 8s inside db-init) and the whole chain is wrapped so a hung DB
// can never block request serving.
// ============================================================

export async function register() {
  // Only the Node.js server runtime — never edge/prerender workers.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const started = Date.now()

  // Fire-and-forget chain: the server starts serving immediately;
  // the schema lands seconds later (REST layer retries meanwhile).
  void (async () => {
    try {
      const { ensureDatabaseSchema, databaseConfigured, APP_VERSION } = await import('./lib/db-init')
      const { dispatchServerBootEvent } = await import('./lib/login-logger')

      const schema = await ensureDatabaseSchema()

      dispatchServerBootEvent({
        version: APP_VERSION,
        database: schema.status, // 'ok' | 'off' | 'error'
        databaseDetail: schema.error ?? null,
        databaseVia: schema.via, // 'postgres' | 'rpc' | 'off'
        tables: schema.tables,
        supabaseRest:
          Boolean((process.env.SUPABASE_URL || '').trim()) &&
          Boolean((process.env.SUPABASE_SERVICE_KEY || '').trim()),
        durationMs: Date.now() - started,
      })

      if (schema.status === 'error') {
        console.error('[ready] boot completed with db-init errors — REST retry layer takes over')
      } else if (schema.status === 'ok') {
        console.log(`[ready] database bootstrap complete (via ${schema.via})`)
      } else {
        console.log('[ready] database bootstrap skipped (no DATABASE_URL / SUPABASE creds)')
      }
    } catch (e) {
      // Belt & braces — nothing in the ready hook may ever throw out.
      console.error('[ready] boot hook internal error:', e instanceof Error ? e.name : 'unknown')
    }
  })()
}
