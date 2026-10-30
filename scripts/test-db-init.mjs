#!/usr/bin/env node
/**
 * v3.11.4 tests — ready-event DB bootstrap (pg + exec_sql RPC).
 * (The old badge-store / badge-task phases are gone together with the
 * /badge page — badges are passive Discord telemetry awards.)
 *
 * Run: node scripts/test-db-init.mjs
 *
 * Phase 1: db-init DDL shape (fake pg client) + inert/error modes
 * Phase 2: db-init via the exec_sql RPC path (cutiee pattern, mock supabase)
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const STORE_FILE = '/tmp/mock-supabase-store.json'
const MOCK_PORT = 9871
const MOCK_KEY = 'test-service-key'

// ---------- 0. compile the modules under test to CJS ----------
// Compiled INSIDE the repo so `pg` resolves from node_modules.
const buildDir = path.join(ROOT, '.tmp-dbinit-build')
fs.rmSync(buildDir, { recursive: true, force: true })
execSync(
  `npx tsc src/lib/db-init.ts src/lib/version.ts --outDir ${JSON.stringify(buildDir)} ` +
    `--module commonjs --target es2020 --esModuleInterop --skipLibCheck --moduleResolution node`,
  { stdio: 'pipe' }
)
const require_ = createRequire(import.meta.url)
const dbInit = require_(path.join(buildDir, 'db-init.js'))

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.error(`  ✗ ${label}`) }
}

// ---------- Phase 1: db-init ----------

console.log('\n[Phase 1] db-init — DDL shape + inert/error modes')

// 1a. DDL statements via the test hook (fake pg client)
const seen = []
const tables = await dbInit.runDDL(async (sql) => { seen.push(sql) })
ok(Array.isArray(tables) && tables.includes('monitor_state'), 'monitor_state is in the DDL list')
ok(!tables.includes('badge_completions') && !tables.includes('badge_tasks'), 'badge tables are GONE from the DDL (v3.11.4 removed the /badge page)')
ok(seen.some(s => /create table if not exists monitor_state/i.test(s)), 'monitor_state: CREATE TABLE IF NOT EXISTS (idempotent)')
ok(seen.some(s => /alter table monitor_state enable row level security/i.test(s)), 'monitor_state: RLS enabled')
ok(seen.some(s => /token_sealed\s+text/i.test(s)), 'monitor_state: token_sealed column present')
ok(!seen.some(s => /badge/i.test(s)), 'no badge DDL statement remains')
ok(seen.filter(s => /create table/i.test(s)).every(s => /if not exists/i.test(s)), 'every CREATE is IF NOT EXISTS — existing data never touched')
ok(seen.length === 2, `DDL runs exactly 2 statements (monitor_state create + RLS) — got ${seen.length}`)

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

// ---------- Phase 2: exec_sql RPC path (mock supabase) ----------

console.log('\n[Phase 2] db-init — exec_sql RPC path (cutiee pattern, mock supabase)')

fs.rmSync(STORE_FILE, { force: true })
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-supabase.js')], {
  env: { ...process.env, PORT: String(MOCK_PORT), API_KEY: MOCK_KEY, STORE_FILE },
  stdio: 'pipe', detached: true,
})
mock.unref()
await new Promise(r => setTimeout(r, 600))
ok(true, 'mock supabase started')

const childEnv = {
  ...process.env,
  SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  SUPABASE_SERVICE_KEY: MOCK_KEY,
  DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_DB_URL: '',
}
const r = spawnSync(process.execPath, ['-e', `
  const d = require(${JSON.stringify(path.join(buildDir, 'db-init.js'))})
  d.ensureDatabaseSchema().then((res) => {
    console.log(JSON.stringify({ status: res.status, via: res.via, tables: res.tables }))
  }).catch((e) => { console.error(e); process.exit(1) })
`], { env: childEnv, stdio: 'pipe', encoding: 'utf-8', cwd: ROOT })
if (r.status !== 0) throw new Error(r.stderr)
const out = JSON.parse(r.stdout.trim().split('\n').pop())
ok(out.status === 'ok' && out.via === 'rpc', 'SUPABASE_URL+KEY only → bootstrap runs via exec_sql RPC (cutiee pattern)')
ok(Array.isArray(out.tables) && out.tables.join(',').includes('monitor_state'), 'RPC path ensured monitor_state')
ok(!String(out.tables).includes('badge'), 'RPC path creates no badge tables')
const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
ok((store.created_tables ?? []).join(',').includes('monitor_state'), 'mock exec_sql saw the monitor_state CREATE TABLE')

// cleanup: kill the detached mock + build dir
try { process.kill(-mock.pid) } catch { /* already gone */ }
fs.rmSync(buildDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
