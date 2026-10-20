#!/usr/bin/env node
/**
 * E2E test suite — runs against a locally started app + mock Discord.
 *
 * Start the stack first (see scripts/test-run.sh):
 *   node scripts/mock-discord.js                                   # :9999
 *   DISCORD_API_BASE=http://127.0.0.1:9999/api/v10 \
 *   QUEST_HEARTBEAT_INTERVAL_MS=3000 QUEST_VIDEO_TICK_MS=400 \
 *   DATA_DIR=./data node .next/standalone/server.js               # :3000
 *
 * Then: node scripts/test-e2e.mjs
 *
 * Tests:
 *   1. Login + quest list (5 quests, correct statuses)
 *   2. Video quest happy path (auto-accept → video-progress → complete → claim)
 *   3. Video quest REJECTED path (400s → automatic heartbeat fallback → complete)
 *   4. 24h Monitor (enable → auto cycle → queue runs → history recorded)
 *   5. Start All queue (4 quests sequential, one after another)
 */

const APP = process.env.APP_URL || 'http://127.0.0.1:3000'
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:9999'
const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'

let cookie = ''
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
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

async function mock(path, opts = {}) {
  const res = await fetch(`${MOCK}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}

async function pollUntil(name, fn, timeoutMs, intervalMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(intervalMs)
  }
  return null
}

// ============================================================
async function main() {
  console.log('\n🧪 E2E Test Suite — Discord Quest API v3.2.0')
  console.log(`   app: ${APP} · mock: ${MOCK}\n`)

  // ---------- 0. health ----------
  console.log('▶ 0. Health check')
  const health = await api('/api/health')
  ok('GET /api/health responds', health.status === 200 || health.status === 404 ? health.status === 200 : false, `status=${health.status}`)
  if (health.status !== 200) {
    console.log('\nApp not healthy — is the server running? Aborting.')
    process.exit(1)
  }

  // ---------- 1. login + quest list ----------
  console.log('\n▶ 1. Login & quest list')
  const login = await api('/api/token', { method: 'POST', body: JSON.stringify({ token: MOCK_TOKEN }) })
  ok('login succeeds', login.status === 200 && login.body?.success === true, JSON.stringify(login.body).slice(0, 120))
  ok('cookies set (session persisted)', cookie.includes('dqt_session') || cookie.includes('dqt_token'))

  const questsRes = await api('/api/quests')
  const qs = questsRes.body?.quests || []
  ok('quest list returns 5 quests', qs.length === 5, `got ${qs.length}`)
  const byId = Object.fromEntries(qs.map((q) => [q.id, q]))
  ok('q_video_ok → available', byId['q_video_ok']?.status === 'available', byId['q_video_ok']?.status)
  ok('q_video_fail → available', byId['q_video_fail']?.status === 'available', byId['q_video_fail']?.status)
  ok('q_enrolled → enrolled (already accepted)', byId['q_enrolled']?.status === 'enrolled', byId['q_enrolled']?.status)
  ok('q_done → claimed', byId['q_done']?.status === 'claimed', byId['q_done']?.status)

  // ---------- 2. video quest happy path ----------
  console.log('\n▶ 2. Video quest — happy path (auto-accept → video-progress → complete)')
  const start1 = await api('/api/quest/start', { method: 'POST', body: JSON.stringify({ questId: 'q_video_ok' }) })
  ok('quest starts', start1.status === 200 && start1.body?.success === true, JSON.stringify(start1.body).slice(0, 150))
  const sid1 = start1.body?.sessionId
  ok('sessionId returned', !!sid1)

  const done1 = await pollUntil('video quest completes', async () => {
    const s = await api(`/api/quest/status?sessionId=${sid1}`)
    return s.body?.status === 'completed' ? s.body : null
  }, 60_000, 1500)
  ok('video quest COMPLETED within 60s', !!done1, done1 ? '' : 'timeout')

  const stats1 = (await mock('/__stats')).body?.stats || {}
  ok('auto-accept: enroll was called', (stats1['q_video_ok']?.enroll || 0) >= 1)
  ok('video-progress endpoint was used', (stats1['q_video_ok']?.video || 0) >= 10, `video=${stats1['q_video_ok']?.video}`)
  ok('reward claim attempted', (stats1['q_video_ok']?.claim || 0) >= 1)

  // ---------- 3. video quest rejected → heartbeat fallback ----------
  console.log('\n▶ 3. Video quest REJECTED → automatic heartbeat fallback')
  const start2 = await api('/api/quest/start', { method: 'POST', body: JSON.stringify({ questId: 'q_video_fail' }) })
  ok('quest starts', start2.status === 200 && start2.body?.success === true, JSON.stringify(start2.body).slice(0, 150))
  const sid2 = start2.body?.sessionId

  let sawFallback = false
  const done2 = await pollUntil('fallback quest completes', async () => {
    const s = await api(`/api/quest/status?sessionId=${sid2}`)
    if (s.body?.engine?.method === 'heartbeat') sawFallback = true
    return s.body?.status === 'completed' ? s.body : null
  }, 90_000, 1500)
  ok('video quest COMPLETED via heartbeat fallback', !!done2, done2 ? '' : 'timeout')
  ok('engine visibly switched to heartbeat method', sawFallback)

  const stats2 = (await mock('/__stats')).body?.stats || {}
  ok('video-progress was rejected ≥5 times before fallback', (stats2['q_video_fail']?.videoRejected || 0) >= 5, `rejected=${stats2['q_video_fail']?.videoRejected}`)
  ok('heartbeat beats were sent after fallback', (stats2['q_video_fail']?.heartbeat || 0) >= 4, `heartbeat=${stats2['q_video_fail']?.heartbeat}`)
  ok('reward claim attempted', (stats2['q_video_fail']?.claim || 0) >= 1)

  // ---------- 4. 24h monitor ----------
  console.log('\n▶ 4. 24h Monitor — enable → auto cycle → completes remaining quests')
  // remaining completable: q_stream + q_enrolled
  const monEnable = await api('/api/quest/monitor', { method: 'POST', body: JSON.stringify({ enabled: true, intervalHours: 0.02 }) })
  ok('monitor enables', monEnable.status === 200 && monEnable.body?.success === true, JSON.stringify(monEnable.body).slice(0, 150))
  ok('monitor reports enabled', monEnable.body?.monitor?.enabled === true)

  const monDone = await pollUntil('monitor first cycle finishes', async () => {
    const s = await api('/api/quest/monitor')
    const h = s.body?.monitor?.history || []
    return h.length > 0 && h[0].finishedAt ? h[0] : null
  }, 120_000, 3000)
  ok('monitor cycle recorded in history', !!monDone, monDone ? '' : 'timeout (120s)')
  if (monDone) {
    ok('monitor found 2 quests', monDone.found === 2, `found=${monDone.found}`)
    ok('monitor completed both quests', monDone.completedCount === 2, `completed=${monDone.completedCount} failed=${monDone.failedCount} err=${monDone.error || 'none'}`)
  }

  const monStatus = await api('/api/quest/monitor')
  ok('monitor schedules next run', monStatus.body?.monitor?.secondsUntilNextRun > 0, `next in ${monStatus.body?.monitor?.secondsUntilNextRun}s`)

  const stats4 = (await mock('/__stats')).body?.stats || {}
  ok('q_stream completed by monitor', (stats4['q_stream']?.claim || 0) >= 1, `claim=${stats4['q_stream']?.claim}`)
  ok('q_enrolled resumed WITHOUT re-enroll', (stats4['q_enrolled']?.enroll || 0) === 0 && (stats4['q_enrolled']?.claim || 0) >= 1, `enroll=${stats4['q_enrolled']?.enroll} claim=${stats4['q_enrolled']?.claim}`)

  const monOff = await api('/api/quest/monitor', { method: 'POST', body: JSON.stringify({ enabled: false }) })
  ok('monitor disables cleanly', monOff.status === 200 && monOff.body?.monitor?.enabled === false)

  // ---------- 5. Start All queue ----------
  console.log('\n▶ 5. Start All — sequential queue after reset')
  await mock('/__control', { method: 'POST', body: JSON.stringify({ reset: true }) })
  const sa = await api('/api/quest/start-all', { method: 'POST', body: JSON.stringify({}) })
  ok('queue starts', sa.status === 200 && sa.body?.success === true, JSON.stringify(sa.body).slice(0, 150))
  ok('4 quests queued (done/claimed excluded)', sa.body?.queuedCount === 4, `queued=${sa.body?.queuedCount}`)
  const qid = sa.body?.queueId

  const queueDone = await pollUntil('queue finishes', async () => {
    const s = await api(`/api/quest/start-all?queueId=${qid}`)
    return s.body?.status && s.body.status !== 'running' ? s.body : null
  }, 180_000, 3000)
  ok('queue finished', !!queueDone, queueDone ? `status=${queueDone.status}` : 'timeout (180s)')
  if (queueDone) {
    ok('all 4 quests completed sequentially', queueDone.completedCount === 4, `completed=${queueDone.completedCount} failed=${queueDone.failedCount}`)
  }

  const stats5 = (await mock('/__stats')).body?.stats || {}
  ok('every completable quest got claimed', ['q_video_ok', 'q_video_fail', 'q_stream', 'q_enrolled'].every((id) => (stats5[id]?.claim || 0) >= 1), JSON.stringify(stats5))

  // ---------- summary ----------
  console.log('\n' + '='.repeat(60))
  console.log(`📊 RESULT: ${passed} passed · ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  • ${f}`))
  }
  console.log('='.repeat(60) + '\n')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E suite crashed:', e)
  process.exit(1)
})
