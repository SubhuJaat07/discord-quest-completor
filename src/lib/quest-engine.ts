/**
 * Discord Quest Engine — Direct REST API method (v3.0.0)
 *
 * ✅ VERIFIED WORKING (live-tested 2026-10-12):
 *   - GET  /api/v10/quests/@me                    → list quests
 *   - POST /api/v10/quests/{id}/enroll             { location: 11 }
 *   - POST /api/v10/quests/{id}/heartbeat          { stream_key, terminal }
 *   - POST /api/v10/quests/{id}/video-progress     { timestamp }
 *   - POST /api/v10/quests/{id}/claim-reward       { platform: 0, location: 11 }
 *
 * METHOD (empirically verified against Discord's servers):
 *   The /heartbeat endpoint credits FULL elapsed wall-clock time between two
 *   consecutive beats, provided the gap stays inside the credit window
 *   (~2 minutes; 100s gaps credited, 150s gaps not). Each beat's response
 *   returns the authoritative server-side progress. When progress reaches
 *   the target, Discord itself sets completed_at. A final terminal beat
 *   closes the session.
 *
 *   Video quests instead accept a client-reported timestamp via
 *   /video-progress and can jump straight to the target.
 *
 * NO BROWSER, NO PUPPETEER — pure REST, Docker/容器 friendly.
 */

// ============================================================
// Types
// ============================================================

export interface DiscordQuestTask {
  type: string
  target: number
  applications?: Array<{ id: string }>
}

export interface DiscordQuest {
  id: string
  config: {
    id: string
    starts_at: string
    expires_at: string
    application?: { id: string; name: string; link?: string }
    messages: Record<string, string>
    task_config_v2?: { tasks: Record<string, DiscordQuestTask | null>; join_operator?: string }
    task_config?: { tasks: Record<string, DiscordQuestTask | null>; join_operator?: string }
    rewards_config?: {
      rewards: Array<{ type: number; messages: Record<string, string> }>
    }
  }
  user_status: QuestUserStatus | null
}

export interface QuestUserStatus {
  user_id: string
  quest_id: string
  enrolled_at: string | null
  completed_at: string | null
  claimed_at: string | null
  last_stream_heartbeat_at: string | null
  stream_progress_seconds: number
  progress: Record<string, {
    value: number
    event_name: string
    updated_at: string
    completed_at: string | null
    heartbeat?: { last_beat_at: string; expires_at: string | null }
  }>
}

export interface ProcessedQuest {
  id: string
  questId: string
  name: string
  gameName: string
  appId: string
  taskType: string
  targetSeconds: number
  progressSeconds: number
  status: 'available' | 'enrolled' | 'in_progress' | 'completed' | 'claimed' | 'expired'
  enrolled: boolean
  completed: boolean
  claimed: boolean
  expired: boolean
  expiresAt: string
  startedAt: string
  rewardName?: string
  supported: boolean
  method: 'heartbeat' | 'video' | null
}

export type SessionStatus =
  | 'starting'
  | 'enrolling'
  | 'running'
  | 'completing'
  | 'completed'
  | 'error'
  | 'cancelled'

/** Outcome resolved when a session finishes (used by the queue). */
export interface SessionOutcome {
  status: 'completed' | 'error' | 'cancelled'
  error?: string
}

export interface QuestSession {
  id: string
  questId: string
  questName: string
  gameName: string
  appId: string
  userId: string
  token: string
  taskType: string
  method: 'heartbeat' | 'video'
  target: number
  progress: number
  status: SessionStatus
  streamKey: string | null
  channelId: string | null
  startedAt: number
  lastBeatAt: number | null
  beats: number
  completedAt: string | null
  error: string | null
  logs: Array<{ t: number; msg: string }>
  _timer: ReturnType<typeof setInterval> | null
  _stuck: number
  _fails: number
  _done?: Promise<SessionOutcome>
  _resolveDone?: (o: SessionOutcome) => void
}

// ============================================================
// Constants
// ============================================================

const API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10'

/** Desktop Electron UA — required for quest endpoints to behave like the real client. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'discord/1.0.90 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36'

/** Heartbeat interval. MUST stay well inside the ~2min server credit window. */
const HEARTBEAT_INTERVAL_MS = Number(process.env.QUEST_HEARTBEAT_INTERVAL_MS || 90_000)

/** Video progress tick — matches real client pacing. */
const VIDEO_TICK_MS = Number(process.env.QUEST_VIDEO_TICK_MS || 1_100)

/** Quest content location enum: 11 = QUEST_HOME_DESKTOP. */
const LOCATION_QUEST_HOME_DESKTOP = 11
/** Platform enum: 0 = DESKTOP. */
const PLATFORM_DESKTOP = 0

const SUPPORTED_TASKS = [
  'WATCH_VIDEO',
  'WATCH_VIDEO_ON_MOBILE',
  'PLAY_ON_DESKTOP',
  'STREAM_ON_DESKTOP',
  'PLAY_ACTIVITY',
]

// ============================================================
// HTTP helper with rate-limit handling
// ============================================================

interface DiscordResponse<T = any> {
  ok: boolean
  status: number
  body: T | null
}

async function dFetch(
  token: string,
  path: string,
  init: { method?: string; body?: any } = {},
  attempt = 0,
): Promise<DiscordResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: token,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://discord.com',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })

  // Rate limited → wait and retry (max 3)
  if (res.status === 429 && attempt < 3) {
    let retryAfter = 5
    try {
      retryAfter = (await res.json()).retry_after || 5
    } catch { /* ignore */ }
    await sleep(Math.min(retryAfter + 1, 30) * 1000)
    return dFetch(token, path, init, attempt + 1)
  }

  let body: any = null
  const text = await res.text().catch(() => '')
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { ok: res.ok, status: res.status, body }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Format seconds as MM:SS (or H:MM:SS when over an hour). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// ============================================================
// Quest listing & parsing (fixes the old broken parsing)
// ============================================================

export async function listQuests(token: string): Promise<ProcessedQuest[]> {
  const res = await dFetch(token, '/quests/@me')
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
  const quests: DiscordQuest[] = res.body?.quests || []
  const now = Date.now()
  return quests.map((q) => parseQuest(q, now)).filter(Boolean) as ProcessedQuest[]
}

function parseQuest(q: DiscordQuest, now: number): ProcessedQuest | null {
  try {
    const cfg = q.config || ({} as any)
    const us: QuestUserStatus | null = q.user_status || null
    const tc = cfg.task_config_v2 || cfg.task_config || { tasks: {} }
    const tasks = tc.tasks || {}

    // Pick the best supported task (video first — fastest completion)
    let taskType = ''
    let task: DiscordQuestTask | null = null
    for (const type of ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY']) {
      const t = tasks[type]
      if (t) { taskType = type; task = t; break }
    }

    const expiresAt = cfg.expires_at || ''
    const expired = expiresAt ? new Date(expiresAt).getTime() <= now : false
    const enrolled = !!us?.enrolled_at
    const completed = !!us?.completed_at
    const claimed = !!us?.claimed_at

    // FIX: real progress lives in user_status.progress.<TASK>.value
    // (the old code read stream_progress_seconds which stays 0 for desktop quests)
    let progressSeconds = 0
    if (taskType && us?.progress?.[taskType]) {
      progressSeconds = us.progress[taskType].value || 0
    }

    let status: ProcessedQuest['status']
    if (claimed) status = 'claimed'
    else if (completed) status = 'completed'
    else if (expired) status = 'expired'
    else if (enrolled && progressSeconds > 0) status = 'in_progress'
    else if (enrolled) status = 'enrolled'
    else status = 'available'

    const reward = cfg.rewards_config?.rewards?.[0]?.messages?.name

    return {
      id: q.id,
      questId: q.id,
      name: cfg.messages?.quest_name || cfg.messages?.game_title || 'Unknown Quest',
      gameName: cfg.messages?.game_title || cfg.application?.name || 'Unknown Game',
      appId: task?.applications?.[0]?.id || cfg.application?.id || '',
      taskType,
      targetSeconds: task?.target || 900,
      progressSeconds,
      status,
      enrolled,
      completed,
      claimed,
      expired,
      expiresAt,
      startedAt: cfg.starts_at || '',
      rewardName: reward,
      supported: !!task && SUPPORTED_TASKS.includes(taskType),
      method: taskType.startsWith('WATCH_VIDEO') ? 'video' : taskType ? 'heartbeat' : null,
    }
  } catch {
    return null
  }
}

// ============================================================
// Enroll / claim
// ============================================================

export async function enrollQuest(token: string, questId: string): Promise<DiscordResponse> {
  return dFetch(token, `/quests/${questId}/enroll`, {
    method: 'POST',
    body: { location: LOCATION_QUEST_HOME_DESKTOP },
  })
}

export interface ClaimResult {
  ok: boolean
  requiresCaptcha: boolean
  captchaSitekey?: string
  message: string
}

export async function claimReward(token: string, questId: string): Promise<ClaimResult> {
  const res = await dFetch(token, `/quests/${questId}/claim-reward`, {
    method: 'POST',
    body: { platform: PLATFORM_DESKTOP, location: LOCATION_QUEST_HOME_DESKTOP },
  })

  if (res.ok) {
    return { ok: true, requiresCaptcha: false, message: 'Reward claimed successfully.' }
  }

  const body: any = res.body
  // Discord gates reward claiming behind hCaptcha — must be solved in a real browser.
  if (body?.captcha_key?.includes('captcha-required') || body?.captcha_sitekey) {
    return {
      ok: false,
      requiresCaptcha: true,
      captchaSitekey: body.captcha_sitekey,
      message:
        'Quest is complete. Discord requires a captcha to claim the reward — ' +
        'open Discord (app or discord.com), go to the quest, and click "Claim Reward" there.',
    }
  }

  return {
    ok: false,
    requiresCaptcha: false,
    message: `Claim failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
  }
}

// ============================================================
// Channel discovery for stream_key
// ============================================================

/**
 * stream_key format: `call:{channelId}:1`
 * Verified working with a DM channel id; guild voice channel ids also work
 * (the browser extension uses either). Falls back to the quest id itself.
 */
async function findChannelId(token: string, questId: string): Promise<string> {
  // 1. Any DM channel
  try {
    const res = await dFetch(token, '/users/@me/channels')
    if (res.ok && Array.isArray(res.body) && res.body.length > 0) {
      return res.body[0].id
    }
  } catch { /* continue */ }

  // 2. Any guild voice channel
  try {
    const res = await dFetch(token, '/users/@me/guilds')
    if (res.ok && Array.isArray(res.body)) {
      for (const g of res.body.slice(0, 5)) {
        const chRes = await dFetch(token, `/guilds/${g.id}/channels`)
        if (chRes.ok && Array.isArray(chRes.body)) {
          const voice = chRes.body.find((c: any) => c.type === 2)
          if (voice) return voice.id
        }
      }
    }
  } catch { /* continue */ }

  // 3. Fallback (extension's fallback) — the API accepted this shape too
  return questId
}

// ============================================================
// Session manager
// ============================================================

const sessions = new Map<string, QuestSession>()

function log(session: QuestSession, msg: string) {
  const line = `[quest-engine] [${session.questId}] ${msg}`
  console.log(line)
  session.logs.push({ t: Date.now(), msg })
  if (session.logs.length > 200) session.logs.shift()
}

export async function startQuest(
  token: string,
  questId: string,
  userId: string,
): Promise<{ success: boolean; sessionId?: string; message: string; session?: QuestSession }> {
  // Prevent double-start of same quest
  for (const s of sessions.values()) {
    if (s.questId === questId && !['completed', 'error', 'cancelled'].includes(s.status)) {
      return {
        success: false,
        message: `Quest already running (session ${s.id}, progress ${s.progress}/${s.target}).`,
      }
    }
  }

  // Fetch quest details
  const quests = await listQuests(token).catch(() => [])
  const quest = quests.find((q) => q.id === questId)
  if (!quest) return { success: false, message: `Quest ${questId} not found in /quests/@me.` }
  if (quest.completed) return { success: false, message: 'Quest is already completed.' }
  if (quest.expired) return { success: false, message: 'Quest has expired.' }
  if (!quest.method) return { success: false, message: 'Quest has no supported task type.' }

  const session: QuestSession = {
    id: `qs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    questId,
    questName: quest.name,
    gameName: quest.gameName,
    appId: quest.appId,
    userId,
    token,
    taskType: quest.taskType,
    method: quest.method,
    target: quest.targetSeconds,
    progress: quest.progressSeconds,
    status: 'starting',
    streamKey: null,
    channelId: null,
    startedAt: Date.now(),
    lastBeatAt: null,
    beats: 0,
    completedAt: null,
    error: null,
    logs: [],
    _timer: null,
    _stuck: 0,
    _fails: 0,
  }
  // Completion promise — awaited by the sequential queue
  session._done = new Promise<SessionOutcome>((res) => {
    session._resolveDone = res
  })
  sessions.set(session.id, session)

  // Enroll if needed
  if (!quest.enrolled) {
    session.status = 'enrolling'
    log(session, `Not enrolled — enrolling (location=${LOCATION_QUEST_HOME_DESKTOP})`)
    const enrollRes = await enrollQuest(token, questId)
    if (!enrollRes.ok && enrollRes.status !== 409) {
      session.status = 'error'
      session.error = `Enroll failed: ${enrollRes.status} ${JSON.stringify(enrollRes.body).slice(0, 200)}`
      log(session, session.error)
      sessions.delete(session.id)
      session._resolveDone?.({ status: 'error', error: session.error })
      return { success: false, message: session.error }
    }
    log(session, 'Enrolled successfully')
  }

  // Resolve channel for stream key
  session.channelId = await findChannelId(token, questId)
  session.streamKey = `call:${session.channelId}:1`
  log(session, `stream_key=${session.streamKey} method=${session.method} target=${session.target}s`)

  // Start the loop
  session.status = 'running'
  if (session.method === 'video') {
    runVideoLoop(session)
  } else {
    runHeartbeatLoop(session)
  }

  return {
    success: true,
    sessionId: session.id,
    message: `Quest "${quest.name}" started via direct API (${session.method} method). ETA ~${Math.ceil((session.target - session.progress) / 60)} min.`,
    session,
  }
}

/**
 * Heartbeat loop — the verified method. Credits full elapsed time per beat.
 * v3.2.0: full error bodies logged + fail-fast after repeated hard rejections
 * (previously a quest could silently retry forever while the UI showed "running").
 */
function runHeartbeatLoop(session: QuestSession) {
  const beat = async () => {
    if (session.status !== 'running') return
    try {
      const res = await dFetch(session.token, `/quests/${session.questId}/heartbeat`, {
        method: 'POST',
        body: { stream_key: session.streamKey, terminal: false },
      })

      if (!res.ok) {
        log(session, `heartbeat HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
        if (res.status === 401 || res.status === 403) {
          session.status = 'error'
          session.error = `Heartbeat rejected (${res.status}) — token may be invalid or quest access suspended.`
          clearInterval(session._timer!)
          session._resolveDone?.({ status: 'error', error: session.error })
          return
        }
        if (res.status >= 400 && res.status !== 429) {
          session._fails++
          if (session._fails >= 6) {
            session.status = 'error'
            session.error =
              `Heartbeat failed ${session._fails} consecutive times — last response: ` +
              `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
            clearInterval(session._timer!)
            log(session, `ERROR: ${session.error}`)
            session._resolveDone?.({ status: 'error', error: session.error })
            return
          }
        }
        return // transient error — try again next tick
      }

      session._fails = 0
      session.beats++
      session.lastBeatAt = Date.now()
      const prog = res.body?.progress?.[session.taskType]
      const prev = session.progress
      if (prog) {
        session.progress = prog.value ?? session.progress
        session.completedAt = prog.completed_at ?? session.completedAt
      }

      if (session.beats <= 2 || session.progress !== prev) {
        log(session, `beat #${session.beats}: progress ${session.progress}/${session.target}`)
      }

      // Stuck detection (no credit for 4 consecutive beats within window)
      if (session.progress === prev) {
        session._stuck++
        if (session._stuck >= 4) {
          log(session, 'WARNING: progress not increasing across beats')
          session._stuck = 0
        }
      } else {
        session._stuck = 0
      }

      if (session.completedAt || session.progress >= session.target) {
        await finishQuest(session)
      }
    } catch (e: any) {
      log(session, `beat error: ${e.message}`)
    }
  }

  // fire immediately, then on interval
  beat()
  session._timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
}

/**
 * Video loop — timestamps are client-reported, can advance ~1s per tick.
 *
 * v3.2.0 FIX for "video quest accepted but never completes":
 *   1. Full Discord error bodies are logged (was: status only — failures were
 *      invisible and the quest retried forever while showing "running").
 *   2. Integer timestamps (fractional values can be rejected).
 *   3. Server-reported progress is preferred when present (authoritative).
 *   4. After 5 consecutive hard rejections (4xx, non-rate-limit), the session
 *      automatically FALLS BACK to the verified heartbeat method with a
 *      stream_key — many video quests credit via stream heartbeats too, so
 *      the quest still completes instead of stalling forever.
 */
function runVideoLoop(session: QuestSession) {
  const tick = async () => {
    if (session.status !== 'running') return
    try {
      const next = Math.min(session.target, Math.round(session.progress) + 1)
      const res = await dFetch(session.token, `/quests/${session.questId}/video-progress`, {
        method: 'POST',
        body: { timestamp: next },
      })
      if (!res.ok) {
        log(session, `video-progress HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
        if (res.status === 401 || res.status === 403) {
          session.status = 'error'
          session.error = `Video progress rejected (${res.status}) — token may be invalid.`
          clearInterval(session._timer!)
          session._resolveDone?.({ status: 'error', error: session.error })
          return
        }
        if (res.status >= 400 && res.status !== 429) {
          session._fails++
          if (session._fails >= 5) {
            log(
              session,
              `video-progress rejected ${session._fails}x — switching to HEARTBEAT method (fallback)`,
            )
            clearInterval(session._timer!)
            session.method = 'heartbeat'
            session.beats = 0
            session._fails = 0
            session._stuck = 0
            runHeartbeatLoop(session)
            return
          }
        }
        return // transient error — try again next tick
      }

      session._fails = 0
      session.beats++
      session.lastBeatAt = Date.now()

      // Prefer the server-reported progress when present (authoritative);
      // otherwise trust the accepted client-reported timestamp.
      const prog = res.body?.progress?.[session.taskType]
      if (prog && typeof prog.value === 'number') {
        session.progress = Math.max(session.progress, prog.value)
        session.completedAt = prog.completed_at ?? session.completedAt
      } else {
        session.progress = Math.max(session.progress, next)
        if (res.body?.completed_at) session.completedAt = res.body.completed_at
      }

      if (session.beats <= 2 || session.progress >= session.target) {
        log(session, `video tick #${session.beats}: progress ${session.progress}/${session.target}`)
      }

      if (session.completedAt || session.progress >= session.target) {
        await finishQuest(session)
      }
    } catch (e: any) {
      log(session, `video tick error: ${e.message}`)
    }
  }

  tick()
  session._timer = setInterval(tick, VIDEO_TICK_MS)
}

/** Final terminal beat to close the session. */
async function finishQuest(session: QuestSession) {
  session.status = 'completing'
  log(session, `Target reached (${session.progress}/${session.target}) — sending terminal beat`)
  if (session._timer) clearInterval(session._timer)

  try {
    if (session.method === 'heartbeat') {
      await dFetch(session.token, `/quests/${session.questId}/heartbeat`, {
        method: 'POST',
        body: { stream_key: session.streamKey, terminal: true },
      })
    } else {
      await dFetch(session.token, `/quests/${session.questId}/video-progress`, {
        method: 'POST',
        body: { timestamp: session.target },
      })
    }
  } catch { /* non-fatal */ }

  session.status = 'completed'
  session.completedAt = new Date().toISOString()
  log(session, 'QUEST COMPLETED 🎉')

  // Try auto-claim (will hit captcha in most cases — that's expected)
  const claim = await claimReward(session.token, session.questId)
  log(session, `claim attempt: ${claim.message}`)

  // GC: drop the finished session from memory after 1h (24/7 server hygiene)
  scheduleSessionCleanup(session)

  session._resolveDone?.({ status: 'completed' })
}

/** Keep finished/error sessions readable for a while, then GC them (24/7 runs). */
function scheduleSessionCleanup(session: QuestSession) {
  const t: any = setTimeout(() => sessions.delete(session.id), 60 * 60 * 1000)
  t?.unref?.()
}

export function getSession(sessionId: string): QuestSession | null {
  return sessions.get(sessionId) ?? null
}

export function getSessionStatus(sessionId: string) {
  const s = sessions.get(sessionId)
  if (!s) return null
  const remaining = Math.max(0, s.target - s.progress)
  return {
    id: s.id,
    questId: s.questId,
    questName: s.questName,
    gameName: s.gameName,
    appId: s.appId,
    status: s.status,
    method: s.method,
    taskType: s.taskType,
    progress: s.progress,
    target: s.target,
    remainingSeconds: remaining,
    percent: Math.min(100, Math.round((s.progress / Math.max(s.target, 1)) * 10000) / 100),
    beats: s.beats,
    streamKey: s.streamKey,
    startedAt: new Date(s.startedAt).toISOString(),
    elapsedSeconds: Math.floor((Date.now() - s.startedAt) / 1000),
    formattedElapsed: formatClock(Math.floor((Date.now() - s.startedAt) / 1000)),
    formattedRemaining: formatClock(remaining),
    formattedTotal: formatClock(s.target),
    lastBeatAt: s.lastBeatAt ? new Date(s.lastBeatAt).toISOString() : null,
    completedAt: s.completedAt,
    error: s.error,
    logs: s.logs.slice(-30),
    endpoints: {
      refresh: `/api/quest/status?sessionId=${s.id}`,
      cancel: `/api/quest/cancel?sessionId=${s.id}`,
    },
  }
}

export function cancelSession(sessionId: string): boolean {
  const s = sessions.get(sessionId)
  if (!s) return false
  if (s._timer) clearInterval(s._timer)
  s.status = 'cancelled'
  log(s, 'Session cancelled by user')
  s._resolveDone?.({ status: 'cancelled' })
  sessions.delete(sessionId)
  return true
}

export function listActiveSessions(userId?: string) {
  return Array.from(sessions.values())
    .filter((s) => {
      if (userId && s.userId !== userId) return false
      return !['completed', 'error', 'cancelled'].includes(s.status)
    })
    .map((s) => getSessionStatus(s.id))
}

/** Verify a token against /users/@me. */
export async function verifyToken(token: string) {
  const res = await dFetch(token, '/users/@me')
  if (!res.ok) return null
  return res.body as { id: string; username: string; global_name?: string; avatar?: string }
}

/**
 * Detailed token verification — returns the HTTP status too, so auth routes
 * can give precise error messages (401 vs 403 vs 429...).
 * Uses DISCORD_API_BASE + the engine's rate-limit-aware fetch.
 */
export async function verifyTokenDetailed(token: string): Promise<{
  ok: boolean
  status: number
  user: { id: string; username: string; global_name?: string; avatar?: string; discriminator?: string } | null
}> {
  const res = await dFetch(token, '/users/@me')
  if (!res.ok || !res.body) {
    return { ok: false, status: res.status, user: null }
  }
  const b = res.body as any
  return {
    ok: true,
    status: res.status,
    user: {
      id: b.id,
      username: b.username,
      global_name: b.global_name,
      avatar: b.avatar,
      discriminator: b.discriminator ?? '0',
    },
  }
}

// ============================================================
// Sequential Quest Queue — "Start All"
// Runs quests ONE AFTER ANOTHER on the server. Each quest is
// auto-accepted (enrolled) when its turn comes. Fully
// independent of any browser tab.
// ============================================================

export interface QueueItem {
  questId: string
  name: string
  gameName: string
}

export interface QueueResultItem extends QueueItem {
  error?: string
}

export interface QuestQueue {
  id: string
  userId: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  items: QueueItem[]
  currentSessionId: string | null
  completed: QueueItem[]
  failed: QueueResultItem[]
  startedAt: number
  finishedAt: number | null
  logs: Array<{ t: number; msg: string }>
  /** Resolved when the queue finishes (awaited by the 24h monitor). */
  _done?: Promise<void>
  _resolveDone?: () => void
}

const queues = new Map<string, QuestQueue>()

function qlog(queue: QuestQueue, msg: string) {
  const line = `[quest-queue] [${queue.id}] ${msg}`
  console.log(line)
  queue.logs.push({ t: Date.now(), msg })
  if (queue.logs.length > 200) queue.logs.shift()
}

/**
 * Start a sequential queue with ALL completable quests.
 * Auto-accepts (enrolls) quests that aren't accepted yet.
 */
export async function startQuestQueue(
  token: string,
  userId: string,
): Promise<{ success: boolean; queueId?: string; message: string; queue?: QuestQueue }> {
  // One running queue per user
  for (const q of queues.values()) {
    if (q.userId === userId && q.status === 'running') {
      return {
        success: false,
        message: `A queue is already running (${q.completed.length}/${q.items.length + q.completed.length + q.failed.length} done). Cancel it first or let it finish.`,
      }
    }
  }

  const quests = await listQuests(token).catch(() => [])
  const candidates = quests.filter(
    (q) => q.supported && q.method && !q.completed && !q.claimed && !q.expired,
  )
  if (candidates.length === 0) {
    return { success: false, message: 'No completable quests found (all done, claimed, expired or unsupported).' }
  }

  const queue: QuestQueue = {
    id: `qq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    userId,
    status: 'running',
    items: candidates.map((c) => ({ questId: c.id, name: c.name, gameName: c.gameName })),
    currentSessionId: null,
    completed: [],
    failed: [],
    startedAt: Date.now(),
    finishedAt: null,
    logs: [],
  }
  queues.set(queue.id, queue)

  // Completion promise — awaited by the 24h monitor
  queue._done = new Promise<void>((resolve) => {
    queue._resolveDone = resolve
  })

  qlog(queue, `Queue started — ${queue.items.length} quests, one-by-one, auto-accept on`)

  // Fire-and-forget: the queue runs entirely server-side
  void runQueue(queue, token)

  return {
    success: true,
    queueId: queue.id,
    queue,
    message: `Queued ${queue.items.length} quests — running sequentially on the server. Each quest is auto-accepted when its turn comes.`,
  }
}

/** Internal: run the queue loop — one quest at a time. */
async function runQueue(queue: QuestQueue, token: string) {
  while (queue.items.length > 0 && queue.status === 'running') {
    const item = queue.items[0]
    qlog(queue, `→ Starting "${item.name}" (auto-accept if not enrolled)`)

    const r = await startQuest(token, item.questId, queue.userId)
    if (!r.success || !r.sessionId || !r.session) {
      queue.failed.push({ ...item, error: r.message })
      qlog(queue, `✗ "${item.name}": ${r.message}`)
      queue.items.shift()
      continue
    }

    queue.currentSessionId = r.sessionId
    // Safety timeout: target + 10 min buffer, so a stuck session can't hang the queue forever
    const timeoutMs = (r.session.target + 600) * 1000
    let timedOut = false
    const outcome: SessionOutcome = await Promise.race([
      r.session._done!,
      sleep(timeoutMs).then(() => {
        timedOut = true
        return {
          status: 'error' as const,
          error: `Timed out after ${Math.round(timeoutMs / 60000)} min without completing`,
        }
      }),
    ])
    queue.currentSessionId = null
    if (timedOut && sessions.has(r.sessionId)) {
      cancelSession(r.sessionId) // stop the still-running session
    }

    if (outcome.status === 'completed') {
      queue.completed.push(item)
      qlog(queue, `✓ "${item.name}" completed`)
    } else {
      queue.failed.push({ ...item, error: outcome.error || outcome.status })
      qlog(queue, `✗ "${item.name}": ${outcome.status}${outcome.error ? ' — ' + outcome.error : ''}`)
    }
    queue.items.shift()
  }

  queue.finishedAt = Date.now()
  queue.currentSessionId = null
  if (queue.status === 'running') {
    queue.status =
      queue.failed.length > 0 && queue.completed.length === 0 && queue.items.length === 0
        ? 'error'
        : 'completed'
  }
  qlog(
    queue,
    `Queue ${queue.status}: ${queue.completed.length} completed, ${queue.failed.length} failed, ${queue.items.length} left unprocessed`,
  )
  queue._resolveDone?.()
}

/** Await a queue's completion — used by the 24h monitor. Resolves immediately for finished queues. */
export function waitForQueue(queueId: string): Promise<void> | null {
  const q = queues.get(queueId)
  if (!q) return null
  if (!q._done) {
    // Queue already finished before a waiter attached
    return Promise.resolve()
  }
  return q._done
}

/** Serializable queue status for the API/UI. */
export function getQueueStatus(queueId: string) {
  const q = queues.get(queueId)
  if (!q) return null
  const total = q.completed.length + q.failed.length + q.items.length
  const current = q.currentSessionId ? getSessionStatus(q.currentSessionId) : null
  return {
    id: q.id,
    status: q.status,
    total,
    completedCount: q.completed.length,
    failedCount: q.failed.length,
    pendingCount: q.items.length,
    current,
    currentSessionId: q.currentSessionId,
    completed: q.completed,
    failed: q.failed,
    pending: q.items,
    startedAt: new Date(q.startedAt).toISOString(),
    finishedAt: q.finishedAt ? new Date(q.finishedAt).toISOString() : null,
    queueElapsedSeconds: Math.floor((Date.now() - q.startedAt) / 1000),
    formattedQueueElapsed: formatClock(Math.floor((Date.now() - q.startedAt) / 1000)),
    logs: q.logs.slice(-30),
    endpoints: {
      refresh: `/api/quest/start-all?queueId=${q.id}`,
      cancel: `/api/quest/start-all?queueId=${q.id}`,
    },
  }
}

/** Cancel a running queue + its current session. Pending items stay for review. */
export function cancelQueue(queueId: string): boolean {
  const q = queues.get(queueId)
  if (!q) return false
  if (q.currentSessionId) {
    cancelSession(q.currentSessionId)
    q.currentSessionId = null
  }
  q.status = 'cancelled'
  q.finishedAt = Date.now()
  qlog(q, `Queue cancelled by user — ${q.items.length} quests left pending`)
  return true
}

/** List running queues for a user (restore support). */
export function listActiveQueues(userId?: string) {
  return Array.from(queues.values())
    .filter((q) => q.status === 'running' && (!userId || q.userId === userId))
    .map((q) => getQueueStatus(q.id))
}
