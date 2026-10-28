#!/usr/bin/env node
/**
 * v3.10.0 tests — ready-event DB bootstrap (pg + exec_sql RPC), badge
 * completion store, and the quest-jaise background badge task runner.
 *
 * Run: node --experimental-strip-types scripts/test-db-init.mjs
 *
 * Phase 1: db-init DDL shape (fake pg client) + inert/error modes + RPC path
 * Phase 2: badge-store against mock-supabase (cloud + disk + restart sim)
 * Phase 3: badge-tasks — durations, background completion, restart-resume
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const STORE_FILE = '/tmp/mock-supabase-store.json'
const DATA_DIR = '/tmp/test-badge-data'
const MOCK_PORT = 9871
const MOCK_KEY = 'test-service-key'

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.error(`  ✗ ${label}`) }
}

// ---------- Phase 1: db-init ----------

console.log('\n[Phase 1] db-init — DDL shape + inert/error modes')
const dbInit = await import('../src/lib/db-init.ts')

// 1a. DDL statements via the test hook (fake pg client)
const seen = []
const tables = await dbInit.runDDL(async (sql) => { seen.push(sql) })
ok(tables.includes('monitor_state') && tables.includes('badge_completions') && tables.includes('badge_tasks'), 'all three tables in the DDL list')
ok(seen.some(s => /create table if not exists monitor_state/i.test(s)), 'monitor_state: CREATE TABLE IF NOT EXISTS (idempotent)')
ok(seen.some(s => /create table if not exists badge_completions/i.test(s)), 'badge_completions: CREATE TABLE IF NOT EXISTS (idempotent)')
ok(seen.some(s => /create table if not exists badge_tasks/i.test(s)), 'badge_tasks: CREATE TABLE IF NOT EXISTS (idempotent)')
ok(seen.some(s => /alter table monitor_state enable row level security/i.test(s)), 'monitor_state: RLS enabled')
ok(seen.some(s => /alter table badge_completions enable row level security/i.test(s)), 'badge_completions: RLS enabled')
ok(seen.some(s => /alter table badge_tasks enable row level security/i.test(s)), 'badge_tasks: RLS enabled')
ok(seen.some(s => /primary key \(user_id, badge_id\)/i.test(s)), 'badge_completions: composite PK (user_id, badge_id)')
ok(seen.some(s => /token_sealed\s+text/i.test(s)), 'monitor_state: token_sealed column present')
ok(seen.some(s => /duration_ms\s+bigint/i.test(s)) && seen.some(s => /completes_at\s+timestamptz/i.test(s)), 'badge_tasks: duration_ms + completes_at columns present')
ok(seen.filter(s => /create table/i.test(s)).every(s => /if not exists/i.test(s)), 'every CREATE is IF NOT EXISTS — existing data never touched')
ok(seen.length === 6, `DDL runs exactly 6 statements (3 tables × create + RLS) — got ${seen.length}`)

// 1b. Inert mode: no DATABASE_URL and no Supabase creds → status 'off', never throws
delete process.env.DATABASE_URL
delete process.env.POSTGRES_URL
delete process.env.SUPABASE_DB_URL
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_KEY
globalThis.__schemaStatus = undefined // reset the once-per-process cache (test only)
const off = await dbInit.ensureDatabaseSchema()
ok(off.status === 'off' && off.configured === false && off.via === 'off', 'no DATABASE_URL + no Supabase creds → status "off" (fully inert)')

// 1c. Error mode: unreachable DB → status 'error', NEVER throws
process.env.DATABASE_URL = 'postgres://nobody:nopass@127.0.0.1:1/postgres'
globalThis.__schemaStatus = undefined // reset again for the error-mode run
const err = await dbInit.ensureDatabaseSchema()
ok(err.status === 'error' && err.configured === true && err.via === 'postgres', 'unreachable DB → status "error" (not a crash)')
ok(typeof err.error === 'string' && err.error.length > 0, 'error status carries a short detail word')

// ---------- Phase 2: badge-store (mock supabase + restarts) ----------

console.log('\n[Phase 2] badge-store — cloud + disk persistence across restarts')

// Clean state
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.rmSync(STORE_FILE, { force: true })
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-supabase.js')], {
  env: { ...process.env, PORT: String(MOCK_PORT), API_KEY: MOCK_KEY, STORE_FILE },
  stdio: 'pipe', detached: true,
})
mock.unref()
// give the mock a moment
await new Promise(r => setTimeout(r, 600))
ok(true, 'mock supabase started')

const childEnv = {
  ...process.env,
  SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  SUPABASE_SERVICE_KEY: MOCK_KEY,
  DATA_DIR,
}

function runChild(code, envOverride) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    env: envOverride ?? childEnv, stdio: 'pipe', encoding: 'utf-8', cwd: ROOT,
  })
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

// 2a. Complete a badge (process 1)
let out = runChild(`
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  const r = await s.setCompleted('123', 'game_time', 'Casual')
  console.log(JSON.stringify(r))
`)
ok(out.completion?.tierName === 'Casual', 'setCompleted returns the record with tierName')
ok(out.completion?.completedAt != null, 'setCompleted returns completedAt (ISO)')
ok(out.cloud === true, 'cloud save reported true (mock supabase reachable)')

// 2b. REST wire format on the mock store
const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
const row = store.badge_completions?.['123:game_time']
ok(row?.user_id === '123' && row?.badge_id === 'game_time', 'REST row stored under composite key')
ok(row?.tier_name === 'Casual', 'REST row uses snake_case tier_name')
ok(!('token' in (store.badge_completions ?? {})), 'no token material anywhere in the table')

// 2c. Disk fallback file written
const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'badge-completions.json'), 'utf-8'))
ok(disk?.['123']?.['game_time']?.tierName === 'Casual', 'disk file written (camelCase local format)')

// 2d. NEW PROCESS (restart simulation): cloud+disk merge returns the record
out = runChild(`
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  const r = await s.getCompletions('123')
  console.log(JSON.stringify(r))
`)
ok(out?.['game_time']?.tierName === 'Casual', 'restart → getCompletions returns the record (persisted)')
ok(Object.keys(out).length === 1, 'exactly one completion for the user')

// 2e. Second badge, then undo the first (process 3)
out = runChild(`
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  await s.setCompleted('123', 'streaming', null)
  const r = await s.clearCompleted('123', 'game_time')
  const g = await s.getCompletions('123')
  console.log(JSON.stringify({ r, g }))
`)
ok(out.r?.cloud === true, 'undo reports cloud delete ok')
ok(out.g?.['game_time'] == null, 'game_time completion gone after undo')
ok(out.g?.['streaming'] != null, 'streaming completion still there')

// 2f. Wire check: undo propagated to the mock table
const store2 = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
ok(!store2.badge_completions?.['123:game_time'], 'cloud row deleted after undo')
ok(store2.badge_completions?.['123:streaming'] != null, 'cloud row for streaming kept')

// 2g. Supabase NOT configured → disk-only mode still works
out = runChild(`
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  const r = await s.setCompleted('u9', 'quest_completed', 'Completed a Quest')
  const g = await s.getCompletions('u9')
  console.log(JSON.stringify({ cloud: r.cloud, tier: g['quest_completed']?.tierName }))
`, { ...childEnv, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' })
ok(out.cloud === false, 'no supabase env → cloud=false (degraded, not broken)')
ok(out.tier === 'Completed a Quest', 'no supabase env → disk-only completion still readable')

// cleanup: kill the detached mock
try { process.kill(-mock.pid) } catch { /* already gone */ }

// ---------- Phase 3: badge-tasks (quest-jaise background runner) ----------

console.log('\n[Phase 3] badge-tasks — durations, background completion, restart-resume')

// Fresh mock for this phase
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.rmSync(STORE_FILE, { force: true })
const mock2 = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-supabase.js')], {
  env: { ...process.env, PORT: String(MOCK_PORT), API_KEY: MOCK_KEY, STORE_FILE },
  stdio: 'pipe', detached: true,
})
mock2.unref()
await new Promise(r => setTimeout(r, 600))

// 3a. Duration derivation mirrors real tier requirements
out = runChild(`
  const { taskDurationMs, BADGE_CATALOG } = await import('${ROOT}/src/lib/badge-tasks.ts')
  const { BADGE_CATALOG: CAT } = await import('${ROOT}/src/lib/badges.ts')
  const gt = CAT.find(b => b.id === 'game_time')
  const quest = CAT.find(b => b.id === 'quest_completed')
  const age = CAT.find(b => b.id === 'account_age')
  const variety = CAT.find(b => b.id === 'game_variety')
  console.log(JSON.stringify({
    gameTime1h: taskDurationMs(gt, gt.tiers[0]),
    quest15m: taskDurationMs(quest, quest.tiers[0]),
    ageInstant: taskDurationMs(age, age.tiers[0]),
    variety2games: taskDurationMs(variety, variety.tiers[0]),
  }))
`)
ok(out.gameTime1h === 3_600_000, 'Game Time tier-1 (1 hour) → 3,600,000 ms')
ok(out.quest15m === 900_000, 'Quests badge → 15 min (one quest task)')
ok(out.ageInstant === 0, 'Account Age → instant (time already elapsed)')
ok(out.variety2games === 3_600_000, 'Game Variety tier-1 (2 games) → 1 hour (2 × 30 min)')

// 3b. Start a SHORT task (BADGE_TASK_MAX_MINUTES cap drives it to ~3s),
//     let it elapse "offline", then a NEW PROCESS tick completes it — the
//     restart-resume guarantee (user closed the site + server restarted).
out = runChild(`
  const t = await import('${ROOT}/src/lib/badge-tasks.ts')
  const r = await t.startTask('42', 'quest_completed', 'Completed a Quest')
  console.log(JSON.stringify({ status: r.task.status, durationMs: r.task.durationMs, cloud: r.cloud }))
`, { ...childEnv, BADGE_TASK_MAX_MINUTES: String(3 / 60) })
ok(out.status === 'running' && out.cloud === true, 'startTask → running task saved to cloud')
ok(out.durationMs > 0 && out.durationMs <= 200_000, 'capped duration applied from BADGE_TASK_MAX_MINUTES')

// wire check: the task row landed in badge_tasks with snake_case columns
const store3 = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
const taskRow = store3.badge_tasks?.['42:quest_completed']
ok(taskRow?.status === 'running' && typeof taskRow?.duration_ms === 'number', 'REST row in badge_tasks (snake_case, running)')
ok(taskRow?.completes_at != null, 'REST row carries completes_at')

// wait for the (short) task to elapse, then "boot a new server" — the
// catch-up tick lands the completion in badge_completions.
await new Promise(r => setTimeout(r, Math.min(3200, Math.max(2500, out.durationMs + 300))))
out = runChild(`
  const t = await import('${ROOT}/src/lib/badge-tasks.ts')
  const n = await t.tickBadgeTasks()
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  const completions = await s.getCompletions('42')
  console.log(JSON.stringify({ completed: n, quest: completions['quest_completed'] != null, tier: completions['quest_completed']?.tierName }))
`)
ok(out.completed >= 1, 'tickBadgeTasks completed the elapsed task (background)')
ok(out.quest === true && out.tier === 'Completed a Quest', 'completion landed in badge_completions with tier')

// 3c. Instant badge (Account Age) completes synchronously on start
out = runChild(`
  const t = await import('${ROOT}/src/lib/badge-tasks.ts')
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  const r = await t.startTask('42', 'account_age', 'Seed')
  const completions = await s.getCompletions('42')
  console.log(JSON.stringify({ status: r.task.status, instant: r.task.durationMs === 0, landed: completions['account_age'] != null }))
`)
ok(out.status === 'completed' && out.instant === true && out.landed === true, 'instant badge (Account Age) → completed + landed immediately')

// 3d. Cancel removes both the task AND the completion (undo at any stage)
out = runChild(`
  const t = await import('${ROOT}/src/lib/badge-tasks.ts')
  const s = await import('${ROOT}/src/lib/badge-store.ts')
  await t.startTask('42', 'game_time', 'Casual')
  await t.cancelTask('42', 'account_age')
  const tasks = await t.getTasks('42')
  const completions = await s.getCompletions('42')
  console.log(JSON.stringify({ running: tasks['game_time']?.status, ageGone: completions['account_age'] == null }))
`)
ok(out.running === 'running', 'game_time task still running')
ok(out.ageGone === true, 'cancel removed the completed account_age task + completion')

// 3e. db-init via the exec_sql RPC path (cutiee pattern) against the mock
fs.rmSync(STORE_FILE, { force: true })
out = runChild(`
  const d = await import('${ROOT}/src/lib/db-init.ts')
  const r = await d.ensureDatabaseSchema()
  console.log(JSON.stringify({ status: r.status, via: r.via, tables: r.tables }))
`, {
  ...childEnv,
  DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_DB_URL: '',
})
ok(out.status === 'ok' && out.via === 'rpc', 'SUPABASE_URL+KEY only → bootstrap runs via exec_sql RPC (cutiee pattern)')
ok(Array.isArray(out.tables) && out.tables.join(',').includes('badge_tasks'), 'RPC path ensured badge_tasks')
const store4 = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
ok((store4.created_tables ?? []).join(',').includes('monitor_state'), 'mock exec_sql saw the monitor_state CREATE TABLE')

// cleanup: kill the phase-3 mock
try { process.kill(-mock2.pid) } catch { /* already gone */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
