#!/usr/bin/env node
/**
 * Mock Discord API server — for E2E testing the quest engine WITHOUT touching
 * real Discord. Implements the exact endpoints/shapes the engine uses:
 *
 *   GET  /api/v10/users/@me
 *   GET  /api/v10/quests/@me
 *   POST /api/v10/quests/{id}/enroll
 *   POST /api/v10/quests/{id}/heartbeat        (credits elapsed time like real Discord)
 *   POST /api/v10/quests/{id}/video-progress   (can be toggled to reject — tests the fallback)
 *   POST /api/v10/quests/{id}/claim-reward
 *   GET  /api/v10/users/@me/channels           (DM channel for stream_key)
 *
 * Test controls:
 *   POST /__control  { reset?: true, videoRejectAll?: true }
 *   GET  /__stats    → per-quest endpoint call counts (assertions)
 *
 * Usage: node scripts/mock-discord.js  (listens on :9999, token: see MOCK_TOKEN)
 */

const http = require('http')

const PORT = Number(process.env.MOCK_PORT || 9999)
const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'
const USER_ID = '123456789012345678'

/** Heartbeat credit window (matches real Discord's ~2min rule) */
const CREDIT_WINDOW_S = 150

function seedQuests() {
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  return {
    q_video_ok: {
      task: 'WATCH_VIDEO', target: 12, enrolled_at: null, completed_at: null, claimed_at: null,
      progress: 0, lastBeatAt: null, videoReject: false,
      config: {
        id: 'q_video_ok', starts_at: iso(now - 86400000), expires_at: iso(now + 86400000 * 3),
        application: { id: '111111111111111111', name: 'VideoGame Studio' },
        messages: { quest_name: 'Watch Trailer OK', game_title: 'VideoGame OK' },
        task_config_v2: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 12, applications: [{ id: '111111111111111111' }] } } },
        rewards_config: { rewards: [{ type: 1, messages: { name: 'OK Badge' } }] },
      },
    },
    q_video_fail: {
      task: 'WATCH_VIDEO', target: 12, enrolled_at: null, completed_at: null, claimed_at: null,
      progress: 0, lastBeatAt: null, videoReject: true, // simulates Discord rejecting video-progress
      config: {
        id: 'q_video_fail', starts_at: iso(now - 86400000), expires_at: iso(now + 86400000 * 3),
        application: { id: '222222222222222222', name: 'VideoGame Studio 2' },
        messages: { quest_name: 'Watch Trailer FAIL', game_title: 'VideoGame FAIL' },
        task_config_v2: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 12, applications: [{ id: '222222222222222222' }] } } },
        rewards_config: { rewards: [{ type: 1, messages: { name: 'Fail Badge' } }] },
      },
    },
    q_stream: {
      task: 'STREAM_ON_DESKTOP', target: 12, enrolled_at: null, completed_at: null, claimed_at: null,
      progress: 0, lastBeatAt: null, videoReject: false,
      config: {
        id: 'q_stream', starts_at: iso(now - 86400000), expires_at: iso(now + 86400000 * 3),
        application: { id: '333333333333333333', name: 'Stream Studio' },
        messages: { quest_name: 'Stream Quest', game_title: 'Stream Game' },
        task_config_v2: { tasks: { STREAM_ON_DESKTOP: { type: 'STREAM_ON_DESKTOP', target: 12, applications: [{ id: '333333333333333333' }] } } },
        rewards_config: { rewards: [{ type: 1, messages: { name: 'Stream Badge' } }] },
      },
    },
    q_enrolled: {
      task: 'PLAY_ON_DESKTOP', target: 12, enrolled_at: iso(now - 3600000), completed_at: null, claimed_at: null,
      progress: 0, lastBeatAt: null, videoReject: false, // already accepted — tests resume/auto-accept skip
      config: {
        id: 'q_enrolled', starts_at: iso(now - 86400000), expires_at: iso(now + 86400000 * 3),
        application: { id: '444444444444444444', name: 'Play Studio' },
        messages: { quest_name: 'Play Quest (enrolled)', game_title: 'Play Game' },
        task_config_v2: { tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 12, applications: [{ id: '444444444444444444' }] } } },
        rewards_config: { rewards: [{ type: 1, messages: { name: 'Play Badge' } }] },
      },
    },
    q_done: {
      task: 'PLAY_ON_DESKTOP', target: 12, enrolled_at: iso(now - 7200000),
      completed_at: iso(now - 3600000), claimed_at: iso(now - 3500000),
      progress: 12, lastBeatAt: null, videoReject: false,
      config: {
        id: 'q_done', starts_at: iso(now - 86400000 * 2), expires_at: iso(now + 86400000),
        application: { id: '555555555555555555', name: 'Done Studio' },
        messages: { quest_name: 'Done Quest', game_title: 'Done Game' },
        task_config_v2: { tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 12, applications: [{ id: '555555555555555555' }] } } },
        rewards_config: { rewards: [{ type: 1, messages: { name: 'Done Badge' } }] },
      },
    },
  }
}

let quests = seedQuests()
let stats = freshStats()

function freshStats() {
  const s = {}
  for (const id of Object.keys(quests || {})) s[id] = { enroll: 0, heartbeat: 0, video: 0, claim: 0, videoRejected: 0 }
  return s
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function questsPayload() {
  return {
    quests: Object.entries(quests).map(([id, q]) => ({
      id,
      config: q.config,
      user_status: q.enrolled_at
        ? {
            user_id: USER_ID,
            quest_id: id,
            enrolled_at: q.enrolled_at,
            completed_at: q.completed_at,
            claimed_at: q.claimed_at,
            last_stream_heartbeat_at: q.lastBeatAt ? new Date(q.lastBeatAt).toISOString() : null,
            stream_progress_seconds: q.progress,
            progress: {
              [q.task]: {
                value: Math.round(q.progress),
                event_name: q.task.toLowerCase(),
                updated_at: new Date().toISOString(),
                completed_at: q.completed_at,
                heartbeat: { last_beat_at: q.lastBeatAt ? new Date(q.lastBeatAt).toISOString() : null, expires_at: null },
              },
            },
          }
        : null,
    })),
  }
}

function progressResponse(q) {
  return {
    progress: {
      [q.task]: { value: Math.round(q.progress), completed_at: q.completed_at },
    },
    completed_at: q.completed_at,
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  // ---------- test controls (no auth) ----------
  if (path === '/__control' && req.method === 'POST') {
    const body = await readBody(req)
    if (body.reset) { quests = seedQuests(); stats = freshStats() }
    if (typeof body.videoRejectAll === 'boolean') {
      quests.q_video_ok.videoReject = body.videoRejectAll
      quests.q_video_fail.videoReject = body.videoRejectAll
    }
    return json(res, 200, { ok: true, state: { quests: Object.keys(quests).length } })
  }
  if (path === '/__stats') {
    return json(res, 200, { token: MOCK_TOKEN, stats })
  }

  // ---------- auth gate (mirrors Discord) ----------
  const auth = req.headers['authorization'] || ''
  if (auth !== MOCK_TOKEN) {
    return json(res, 401, { message: '401: Unauthorized', code: 0 })
  }

  // ---------- Discord API ----------
  if (path === '/api/v10/users/@me' && req.method === 'GET') {
    return json(res, 200, { id: USER_ID, username: 'mocktester', global_name: 'Mock Tester', avatar: null, discriminator: '0' })
  }

  if (path === '/api/v10/users/@me/channels' && req.method === 'GET') {
    return json(res, 200, [{ id: '999888777666555444', type: 1, recipients: [] }])
  }

  if (path === '/api/v10/quests/@me' && req.method === 'GET') {
    return json(res, 200, questsPayload())
  }

  let m = path.match(/^\/api\/v10\/quests\/([^/]+)\/enroll$/)
  if (m && req.method === 'POST') {
    const q = quests[m[1]]
    if (!q) return json(res, 404, { message: 'Unknown quest' })
    stats[m[1]].enroll++
    if (!q.enrolled_at) q.enrolled_at = new Date().toISOString()
    return json(res, 200, { ok: true })
  }

  m = path.match(/^\/api\/v10\/quests\/([^/]+)\/heartbeat$/)
  if (m && req.method === 'POST') {
    const q = quests[m[1]]
    if (!q) return json(res, 404, { message: 'Unknown quest' })
    stats[m[1]].heartbeat++
    const now = Date.now()
    if (q.lastBeatAt) {
      const gapS = (now - q.lastBeatAt) / 1000
      if (gapS <= CREDIT_WINDOW_S) q.progress = Math.min(q.target, q.progress + gapS)
      // gap > window → zero credit (mirrors real Discord)
    }
    q.lastBeatAt = now
    if (q.progress >= q.target && !q.completed_at) q.completed_at = new Date().toISOString()
    return json(res, 200, progressResponse(q))
  }

  m = path.match(/^\/api\/v10\/quests\/([^/]+)\/video-progress$/)
  if (m && req.method === 'POST') {
    const q = quests[m[1]]
    if (!q) return json(res, 404, { message: 'Unknown quest' })
    const body = await readBody(req)
    if (q.videoReject) {
      stats[m[1]].videoRejected++
      return json(res, 400, { code: 400, message: 'Video progress not accepted for this quest (mock rejection)' })
    }
    stats[m[1]].video++
    q.progress = Math.max(q.progress, Number(body.timestamp) || 0)
    if (q.progress >= q.target && !q.completed_at) q.completed_at = new Date().toISOString()
    return json(res, 200, progressResponse(q))
  }

  m = path.match(/^\/api\/v10\/quests\/([^/]+)\/claim-reward$/)
  if (m && req.method === 'POST') {
    const q = quests[m[1]]
    if (!q) return json(res, 404, { message: 'Unknown quest' })
    stats[m[1]].claim++
    q.claimed_at = new Date().toISOString()
    return json(res, 200, { ok: true })
  }

  return json(res, 404, { message: '404: Not Found', code: 0 })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-discord] listening on http://127.0.0.1:${PORT}`)
  console.log(`[mock-discord] token: ${MOCK_TOKEN}`)
})
