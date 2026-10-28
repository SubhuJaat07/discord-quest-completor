#!/usr/bin/env node
/**
 * Badge system E2E — REAL engine tasks (v3.11.0)
 *
 * Stack (see scripts/test-run.sh):
 *   node scripts/mock-discord.js                                   # :9999
 *   node scripts/mock-supabase.js                                  # :9870
 *   DISCORD_API_BASE=http://127.0.0.1:9999/api/v10 \
 *   SUPABASE_URL=http://127.0.0.1:9870 \
 *   SUPABASE_SERVICE_KEY=test-service-key \
 *   MONITOR_ENCRYPTION_KEY=test-key-1234567890 \
 *   QUEST_HEARTBEAT_INTERVAL_MS=3000 QUEST_VIDEO_TICK_MS=400 \
 *   DATA_DIR=./data node .next/standalone/server.js               # :3000
 *
 * Then: node scripts/test-badge-engine.mjs
 *
 * Tests:
 *   1.  Login + GET /api/badges — shape, REAL stats from mock quests
 *   2.  quest_completed → INSTANT earned (q_done is completed+claimed)
 *   3.  account_age → auto-claimed tier row written server-side
 *   4.  orbs → action 'purchase', no engine task possible
 *   5.  POST /api/badges/complete { game_variety } → REAL engine task
 *       starts → quest session runs (video quest, ~5s) → tier Sampler
 *       (2 games) becomes satisfied with REAL data → task completes
 *   6.  Progress never faked: mid-run GET shows real credited numbers
 *   7.  DELETE → task stopped + completion cleared
 *   8.  Legacy cleanup: v3.10.0 row (running, no token_sealed) is
 *       deleted by the runner's boot pass
 */

const APP = process.env.APP_URL || 'http://127.0.0.1:3000'
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:9999'
const SUPA = process.env.SUPA_URL || 'http://127.0.0.1:9870'
const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'
const USER_ID = '123456789012345678'

let cookie = ''
let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
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

async function supa(path, opts = {}) {
  const res = await fetch(`${SUPA}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      apikey: 'test-service-key',
      Authorization: 'Bearer test-service-key',
      ...(opts.headers || {}),
    },
  })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}

async function waitFor(desc, fn, timeoutMs, stepMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  console.log(`  ⏱ timeout waiting: ${desc}`)
  return null
}

// ============================================================

async function main() {
  console.log('── [1] Login + GET /api/badges')
  const login = await api('/api/token', { method: 'POST', body: JSON.stringify({ token: MOCK_TOKEN }) })
  ok('login ok', login.status === 200 && login.body?.success !== false, JSON.stringify(login.body).slice(0, 120))

  const badges1 = await api('/api/badges')
  ok('GET /api/badges 200', badges1.status === 200 && badges1.body?.success === true)
  const b1 = badges1.body
  ok('engine stats are REAL (mock: 1 completed quest)', b1.engineStats?.completedQuests === 1, JSON.stringify(b1.engineStats))
  ok('engine stats: 1 distinct game (Done Game)', b1.engineStats?.distinctGames?.length === 1, JSON.stringify(b1.engineStats?.distinctGames))
  ok('engine stats: 12s credited', b1.engineStats?.creditedSeconds === 12, String(b1.engineStats?.creditedSeconds))
  ok('user id decoded from token', b1.user?.id === USER_ID)

  console.log('── [2] quest_completed — instant (real data already satisfies)')
  const qc = b1.badges?.find((x) => x.id === 'quest_completed')
  ok('quest_completed present', !!qc)
  ok('quest_completed earned for real', qc?.earned === true, JSON.stringify(qc))

  console.log('── [3] account_age — auto, no button, tier recorded')
  const age = b1.badges?.find((x) => x.id === 'account_age')
  ok('account_age action=auto', age?.action === 'auto')
  // mock user snowflake = Dec 2015 → ~10.9y → ALL tiers earned (Primordial)
  ok('account_age earned tier computed from snowflake (Primordial)', age?.earned === true && age?.tierName === 'Primordial', JSON.stringify({ e: age?.earned, t: age?.tierName }))
  ok('account_age auto-recorded in the response (completion present)', !!age?.completion, JSON.stringify(age?.completion))
  const ageRows = await supa(`/rest/v1/badge_completions?user_id=eq.${USER_ID}&badge_id=eq.account_age&select=*`)
  const ageRow = Array.isArray(ageRows.body) ? ageRows.body[0] : null
  ok('account_age completion row written server-side', !!ageRow, JSON.stringify(ageRows.body))

  console.log('── [4] orbs — purchase, no engine task')
  const orbs = b1.badges?.find((x) => x.id === 'orbs')
  ok('orbs action=purchase', orbs?.action === 'purchase')
  const orbsPost = await api('/api/badges/complete', { method: 'POST', body: JSON.stringify({ badgeId: 'orbs' }) })
  ok('orbs POST rejected (400)', orbsPost.status === 400, String(orbsPost.status))
  const agePost = await api('/api/badges/complete', { method: 'POST', body: JSON.stringify({ badgeId: 'account_age' }) })
  ok('account_age POST rejected (400 — nothing to run)', agePost.status === 400, String(agePost.status))

  console.log('── [5] game_variety — REAL engine task → Sampler (2 games)')
  const gvBefore = b1.badges?.find((x) => x.id === 'game_variety')
  ok('game_variety target = Sampler (2 games)', gvBefore?.targetTier?.name === 'Sampler' && gvBefore?.targetTier?.threshold === 2, JSON.stringify(gvBefore?.targetTier))

  const start = await api('/api/badges/complete', { method: 'POST', body: JSON.stringify({ badgeId: 'game_variety' }) })
  ok('POST complete 200 + engine task started', start.status === 200 && start.body?.success === true && start.body?.task?.status === 'running', JSON.stringify(start.body).slice(0, 200))
  ok('task persisted to cloud+disk', start.body?.persisted === 'cloud+disk', String(start.body?.persisted))

  // engine quest should start within a tick (POST kicks immediately)
  const questStarted = await waitFor('engine quest session', async () => {
    const s = await api('/api/quest/status')
    return s?.body?.activeSessions?.length > 0 ? s.body.activeSessions[0] : null
  }, 20000)
  ok('engine quest session is running (server-side)', !!questStarted, JSON.stringify(questStarted).slice(0, 150))

  // mid-run: task shows running + real progress from Discord data
  await sleep(2000)
  const mid = await api('/api/badges')
  const gvMid = mid.body?.badges?.find((x) => x.id === 'game_variety')
  ok('mid-run: task running', gvMid?.task?.status === 'running', JSON.stringify(gvMid?.task))
  ok('mid-run: REAL credited progress visible', (mid.body?.engineStats?.creditedSeconds ?? 0) >= 12, String(mid.body?.engineStats?.creditedSeconds))
  ok('mid-run: current quest attributed to the badge', gvMid?.task?.isCurrentQuest === true, JSON.stringify(gvMid?.currentQuest))

  // wait for the video quest to complete (12 ticks × 400ms ≈ 5-8s) and
  // the runner to land the tier (next 30s tick — cache-busted path)
  const tierEarned = await waitFor('game_variety Sampler earned', async () => {
    const r = await api('/api/badges')
    const gv = r.body?.badges?.find((x) => x.id === 'game_variety')
    return gv?.task?.status === 'completed' && gv?.earned === true && gv?.tierName === 'Sampler' ? gv : null
  }, 90000)
  ok('Sampler earned with REAL Discord data (2 distinct games)', !!tierEarned, JSON.stringify(tierEarned?.task))
  ok('credited seconds grew (real credit)', (tierEarned && (await api('/api/badges')).body?.engineStats?.creditedSeconds > 12) === true)

  const gvRows = await supa(`/rest/v1/badge_completions?user_id=eq.${USER_ID}&badge_id=eq.game_variety&select=*`)
  ok('badge_completions row (tier Sampler) written', Array.isArray(gvRows.body) && gvRows.body[0]?.tier_name === 'Sampler', JSON.stringify(gvRows.body))

  const taskRows = await supa(`/rest/v1/badge_tasks?user_id=eq.${USER_ID}&badge_id=eq.game_variety&select=*`)
  ok('badge_tasks row completed + token sealed', Array.isArray(taskRows.body) && taskRows.body[0]?.status === 'completed' && typeof taskRows.body[0]?.token_sealed === 'string' && taskRows.body[0].token_sealed.startsWith('enc:v1:'), JSON.stringify(taskRows.body?.[0]).slice(0, 150))

  console.log('── [6] DELETE — reset the completion')
  const del = await api('/api/badges/complete?badgeId=game_variety', { method: 'DELETE' })
  ok('DELETE ok', del.status === 200 && del.body?.success === true)
  const after = await api('/api/badges')
  const gvAfter = after.body?.badges?.find((x) => x.id === 'game_variety')
  ok('completion cleared (earned state stays — it is REAL Discord data)', gvAfter?.completion === null && gvAfter?.earned === true, JSON.stringify({ c: gvAfter?.completion, e: gvAfter?.earned }))

  console.log('── [7] quest_completed POST — instant path (already satisfied)')
  const qcPost = await api('/api/badges/complete', { method: 'POST', body: JSON.stringify({ badgeId: 'quest_completed' }) })
  ok('instant complete (no fake wait)', qcPost.status === 200 && qcPost.body?.instant === true, JSON.stringify(qcPost.body).slice(0, 150))

  console.log('── [8] legacy v3.10.0 row cleanup (runner boot pass)')
  // plant a fake legacy row directly in mock supabase
  const planted = await supa('/rest/v1/badge_tasks', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: USER_ID, badge_id: 'game_time', tier_name: 'Casual', status: 'running',
      started_at: new Date().toISOString(), duration_ms: 3600000, completes_at: new Date(Date.now() + 3600000).toISOString(),
      completed_at: null, updated_at: new Date().toISOString(),
      // no token_sealed → legacy
    }),
  })
  ok('legacy row planted', planted.status === 201, String(planted.status))
  console.log('  … waiting 45s for the runner tick + legacy sweep…')
  await sleep(45000)
  const legacyRows = await supa(`/rest/v1/badge_tasks?user_id=eq.${USER_ID}&badge_id=eq.game_time&select=*`)
  ok('legacy fake timer row deleted by runner', Array.isArray(legacyRows.body) && legacyRows.body.length === 0, JSON.stringify(legacyRows.body))

  // ============================================================
  console.log(`\n══════════════════════════════════`)
  console.log(`badge engine E2E: ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log('failures:'); failures.forEach((f) => console.log('  - ' + f)) }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('E2E crashed:', e); process.exit(1) })
