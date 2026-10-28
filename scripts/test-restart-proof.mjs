#!/usr/bin/env node
/**
 * E2E test: restart-proof monitor via Supabase (src/lib/state-store.ts)
 *
 * Phases (the bash runner restarts the app between them):
 *   phase1 — login, enable monitor → assert the Supabase row exists with
 *            the SEALED token (ciphertext, never plaintext)
 *   phase2 — after app restart + DATA_DIR wipe: monitor resumed from the
 *            cloud row and a cycle completes quests (token unsealed + works)
 *   phase3 — disable → row enabled=false; wipe monitor → row deleted
 *
 * Stack (started by scripts/restart-verify.sh):
 *   mock-discord :9999 · mock-supabase :9870 · app :3458 with
 *   SUPABASE_URL=http://127.0.0.1:9870 SUPABASE_SERVICE_KEY=test-service-key
 *   MONITOR_ENCRYPTION_KEY=e2e-monitor-key
 *
 * Usage: node scripts/test-restart-proof.mjs phase1|phase2|phase3
 */
import fs from 'node:fs'

const APP = process.env.APP_URL || 'http://127.0.0.1:3458'
const STORE_FILE = process.env.STORE_FILE || '/tmp/mock-supabase-store.json'
const PHASE = process.argv[2]
const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'
const TOKEN_HMAC_PART = 'mocktest.hmac123'
const USER_ID = '123456789012345678'
const TRAP_EMAIL = 'should.never.appear.anywhere@example.com'
const TRAP_PHONE = '+15551234567'

let cookie = ''
let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function api(path, opts = {}) {
  const res = await fetch(`${APP}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  })
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}

async function login() {
  const r = await api('/api/token', { method: 'POST', body: JSON.stringify({ token: MOCK_TOKEN }) })
  ok('login succeeds', r.status === 200 && r.body?.success === true, `status=${r.status}`)
}

function readRow() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
    return store.singleton || null
  } catch { return null }
}

// ---------- phase 1: enable → cloud row saved sealed ----------
if (PHASE === 'phase1') {
  console.log('▶ phase 1 — enable monitor, assert sealed cloud row')
  await login()

  const r = await api('/api/quest/monitor', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, intervalHours: 0.05 }),
  })
  ok('monitor enable succeeds', r.status === 200 && r.body?.success === true, `status=${r.status}`)

  // cloud save is awaited by enableMonitor, but give a tiny grace period
  for (let i = 0; i < 10 && !readRow(); i++) await sleep(300)
  const row = readRow()
  ok('supabase row created', row !== null)
  if (row) {
    ok('row.enabled is true', row.enabled === true)
    ok('row.user_id matches', row.user_id === USER_ID, String(row.user_id))
    ok('row.username matches', row.username === 'mocktester')
    ok('row.interval_hours persisted', row.interval_hours === 0.05, String(row.interval_hours))
    ok('token_sealed is enc:v1 ciphertext', typeof row.token_sealed === 'string' && row.token_sealed.startsWith('enc:v1:'), String(row.token_sealed)?.slice(0, 20))
    const parts = String(row.token_sealed).split(':')
    ok('ciphertext has iv+tag+ct parts', parts.length === 5 && parts.slice(2).every((p) => p.length > 8))
    const raw = fs.readFileSync(STORE_FILE, 'utf-8')
    ok('plaintext token NOT in store', !raw.includes(MOCK_TOKEN) && !raw.includes(TOKEN_HMAC_PART))
    ok('trap email/phone NOT in store', !raw.includes(TRAP_EMAIL) && !raw.includes(TRAP_PHONE))
    ok('no email/phone keys in store', !/"email"/.test(raw) && !/"phone"/.test(raw))
  }

  const s = await api('/api/quest/monitor')
  ok('monitor status shows enabled', s.body?.monitor?.enabled === true)
}

// ---------- phase 2: restart + volume wipe → cloud restore ----------
if (PHASE === 'phase2') {
  console.log('▶ phase 2 — volume wiped, monitor must resume from supabase')
  await login() // fresh in-memory session (old one died with the process)

  // cloud restore is async at module init — poll until it lands
  let restored = null
  for (let i = 0; i < 60 && !restored; i++) {
    const s = await api('/api/quest/monitor')
    if (s.body?.monitor?.enabled === true) restored = s.body.monitor
    else await sleep(1000)
  }
  ok('monitor resumed from cloud (toggle ON)', restored !== null)
  if (restored) {
    ok('resumed for the right user', restored.username === 'mocktester' && restored.userId === USER_ID)
    ok('resumed with the saved interval', restored.intervalHours === 0.05, String(restored.intervalHours))
  }

  // the restored monitor should run its missed cycle and complete quests —
  // this proves the token was unsealed correctly and actually works.
  let history = null
  for (let i = 0; i < 300 && !history; i++) {
    const s = await api('/api/quest/monitor')
    const h = s.body?.monitor?.history
    if (Array.isArray(h) && h.length > 0 && h[0].finishedAt > 0) history = h[0]
    else await sleep(2000)
  }
  ok('monitor cycle ran after restore', history !== null)
  if (history) {
    ok('cycle completed quests with the restored token', history.completedCount >= 1, JSON.stringify({ found: history.found, completed: history.completedCount, failed: history.failedCount }))
    ok('cycle trigger was schedule/boot', history.trigger === 'schedule' || history.trigger === 'boot', history.trigger)
  }
}

// ---------- phase 3: disable + wipe propagate to the cloud ----------
if (PHASE === 'phase3') {
  console.log('▶ phase 3 — disable & wipe propagate to supabase')
  await login()

  const r = await api('/api/quest/monitor', { method: 'POST', body: JSON.stringify({ enabled: false }) })
  ok('monitor disable succeeds', r.status === 200 && r.body?.success === true, `status=${r.status}`)
  for (let i = 0; i < 10; i++) {
    const row = readRow()
    if (row && row.enabled === false) break
    await sleep(300)
  }
  const row = readRow()
  ok('row.enabled flipped to false', row?.enabled === false)
  ok('row token wiped on disable', !row?.token_sealed, String(row?.token_sealed))

  const d = await api('/api/quest/monitor', { method: 'DELETE' })
  ok('monitor wipe succeeds', d.status === 200 && d.body?.success === true, `status=${d.status}`)
  for (let i = 0; i < 10 && readRow(); i++) await sleep(300)
  ok('supabase row deleted on full wipe', readRow() === null)
}

if (!PHASE) {
  console.error('usage: node scripts/test-restart-proof.mjs phase1|phase2|phase3')
  process.exit(2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
