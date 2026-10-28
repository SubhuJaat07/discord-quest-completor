// ============================================================
// Badge Tasks — REAL quest-engine runner (v3.11.0)
// ------------------------------------------------------------
// WHAT CHANGED vs v3.10.0:
//   The old runner was a dashboard clock: click Complete → a
//   timer counted the tier duration and flipped a bit. That
//   looked (and was) fake. This version is engine-driven:
//
//   Clicking Complete starts the SAME quest engine that powers
//   "Start All" (enroll → heartbeat → complete — 100% real
//   Discord API calls, 100% server-side). The badge task only
//   finishes when the user's LIVE /quests/@me data satisfies
//   the tier requirement:
//
//     quest_completed → 1 quest completed/claimed
//     game_variety    → N distinct quest games with credited play
//     game_time       → N hours of credited quest play time
//     streaming       → N hours of credited stream quest time
//
//   Progress is read from DISCORD's servers every tick — the
//   exact same numbers the quest page shows. There is no local
//   counter to drift and nothing that can be faked: if Discord
//   says 12 minutes are credited, the badge shows 12 minutes.
//
//   account_age needs no task at all (snowflake math, auto).
//
// RUNS LIKE A QUEST:
//   - The user can close the site — the runner keeps going.
//   - Restart-proof: the task row + a SEALED token (AES-256-GCM,
//     same contract as the 24h monitor) persist to Supabase +
//     disk; on boot the runner resumes and re-reads progress
//     from Discord (enrolled quests keep their server-side
//     progress, so nothing is lost).
//   - If the 24h monitor / Start All queue is already running
//     for the user, the badge task ATTACHES: it waits and counts
//     the quests the queue completes toward the badge target.
//
//   DISK      $DATA_DIR/badge-tasks.json        (restart bridge)
//   CLOUD     Supabase table `badge_tasks`      (auto-created by
//             db-init on the ready event)
//
// LEGACY CLEANUP:
//   v3.10.0 timer rows (no token_sealed) are deleted on the
//   first boot pass — those were the "stuck" fake tasks.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import {
  BADGE_CATALOG,
  computeEngineStats,
} from './badges.ts'
import type { BadgeDefinition, BadgeTier } from './badges.ts'
import { setCompleted, clearCompleted } from './badge-store.ts'
import { sealToken, unsealToken } from './state-store.ts'
import {
  listQuests,
  startQuest,
  listActiveSessions,
  listActiveQueues,
} from './quest-engine.ts'
import type { ProcessedQuest } from './quest-engine.ts'

const DATA_DIR = process.env.DATA_DIR || './data'
const FILE = path.join(DATA_DIR, 'badge-tasks.json')

// ---------- types ----------

export interface BadgeTask {
  userId: string
  badgeId: string
  tierName: string | null          // tier this task is driving toward
  status: 'running' | 'completed'
  startedAt: string                // ISO
  completedAt: string | null       // ISO
  /** AES-256-GCM sealed token — same contract as monitor_state. */
  tokenSealed: string
  /** running-quest | waiting-engine | waiting-quests | error | token-error */
  lastStatus: string
  lastError: string | null
  updatedAt: string                // ISO
}

/** userId -> (badgeId -> task) */
type TaskMap = Record<string, Record<string, BadgeTask>>

// ---------- Supabase REST ----------

function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
}

function supabaseKey(): string {
  return (process.env.SUPABASE_SERVICE_KEY || '').trim()
}

function authHeaders(): Record<string, string> {
  return {
    apikey: supabaseKey(),
    Authorization: `Bearer ${supabaseKey()}`,
    'Content-Type': 'application/json',
  }
}

const TABLE = 'badge_tasks'
const TIMEOUT_MS = 5000

// ---------- in-memory cache ----------

const g = globalThis as unknown as {
  __badgeTasks?: TaskMap
  __badgeTicker?: ReturnType<typeof setInterval> | null
  __badgeTicking?: boolean
  /** userId -> badgeId whose engine quest is currently attributed */
  __badgeCurrentQuest?: Record<string, string>
  /** userId -> { at, quests } — 25s TTL cache shared with the API route */
  __questCache?: Map<string, { at: number; quests: ProcessedQuest[] }>
}

function cache(): TaskMap {
  if (!g.__badgeTasks) {
    g.__badgeTasks = {}
    try {
      if (existsSync(FILE)) {
        const parsed = JSON.parse(readFileSync(FILE, 'utf-8'))
        if (parsed && typeof parsed === 'object') g.__badgeTasks = parsed as TaskMap
      }
    } catch {
      /* corrupt file — start empty */
    }
  }
  return g.__badgeTasks
}

function persistDisk() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify(cache(), null, 2))
    return true
  } catch {
    return false // read-only fs — memory-only mode
  }
}

// ---------- cloud CRUD ----------

interface CloudRow {
  user_id: string
  badge_id: string
  tier_name: string | null
  status: string
  started_at: string
  completed_at: string | null
  token_sealed: string | null
  last_status: string | null
  last_error: string | null
  updated_at: string | null
}

function rowToTask(r: CloudRow, defaults: Partial<BadgeTask>): BadgeTask {
  return {
    userId: r.user_id,
    badgeId: r.badge_id,
    tierName: typeof r.tier_name === 'string' ? r.tier_name : null,
    status: r.status === 'completed' ? 'completed' : 'running',
    startedAt: r.started_at ?? new Date().toISOString(),
    completedAt: r.completed_at ?? null,
    tokenSealed: typeof r.token_sealed === 'string' ? r.token_sealed : '',
    lastStatus: r.last_status ?? 'starting',
    lastError: r.last_error ?? null,
    updatedAt: r.updated_at ?? new Date().toISOString(),
    ...defaults,
  }
}

async function cloudLoad(userId: string): Promise<Record<string, BadgeTask>> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return {}
  try {
    const res = await fetch(
      `${base}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=*`,
      { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!res.ok) return {}
    const rows = (await res.json()) as Array<CloudRow>
    const out: Record<string, BadgeTask> = {}
    for (const r of rows ?? []) {
      if (typeof r?.badge_id !== 'string') continue
      out[r.badge_id] = rowToTask(r, {})
    }
    return out
  } catch {
    return {}
  }
}

/** All running rows across users — the boot/tick sweep source. */
async function cloudLoadRunning(): Promise<BadgeTask[]> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return []
  try {
    const res = await fetch(
      `${base}/rest/v1/${TABLE}?status=eq.running&select=*`,
      { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!res.ok) return []
    const rows = (await res.json()) as Array<CloudRow>
    return (rows ?? []).map(r => rowToTask(r, {}))
  } catch {
    return []
  }
}

async function cloudSave(task: BadgeTask): Promise<boolean> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return false
  try {
    const res = await fetch(`${base}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { ...authHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: task.userId,
        badge_id: task.badgeId,
        tier_name: task.tierName,
        status: task.status,
        started_at: task.startedAt,
        duration_ms: 0,             // legacy column — unused, kept for compat
        completes_at: task.startedAt, // legacy column — unused
        completed_at: task.completedAt,
        token_sealed: task.tokenSealed,
        last_status: task.lastStatus,
        last_error: task.lastError,
        updated_at: task.updatedAt,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

async function cloudDelete(userId: string, badgeId: string): Promise<boolean> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return false
  try {
    const res = await fetch(
      `${base}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&badge_id=eq.${encodeURIComponent(badgeId)}`,
      { method: 'DELETE', headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    return res.ok
  } catch {
    return false
  }
}

// ---------- quest list cache (shared with the API route) ----------

const QUEST_CACHE_TTL_MS = 25_000

/** Live quest list with a 25s cache — the runner and the API route
 *  share it so a page refresh never doubles Discord API calls. */
export async function getCachedQuests(token: string, userId: string): Promise<ProcessedQuest[] | null> {
  if (!g.__questCache) g.__questCache = new Map()
  const hit = g.__questCache.get(userId)
  if (hit && Date.now() - hit.at < QUEST_CACHE_TTL_MS) return hit.quests
  try {
    const quests = await listQuests(token)
    g.__questCache.set(userId, { at: Date.now(), quests })
    return quests
  } catch {
    // stale data is better than no data — badge progress never lies
    return hit ? hit.quests : null
  }
}

// ---------- target resolution ----------

/** Does the user's REAL data already satisfy this tier? */
export function tierSatisfied(
  def: BadgeDefinition,
  tier: BadgeTier,
  stats: ReturnType<typeof computeEngineStats>
): boolean {
  switch (def.metricUnit) {
    case 'boolean': return stats.completedQuests >= tier.threshold
    case 'games': return stats.distinctGameIds.length >= tier.threshold
    case 'hours': return stats.creditedSeconds >= tier.threshold * 3600
    default: return false
  }
}

/** Pick the quest the engine should run next for this badge. */
function pickQuestFor(
  def: BadgeDefinition,
  tier: BadgeTier,
  quests: ProcessedQuest[]
): ProcessedQuest | null {
  const completable = quests.filter(
    q => q.supported && q.method && !q.completed && !q.claimed && !q.expired &&
      ['available', 'enrolled', 'in_progress'].includes(q.status)
  )
  if (completable.length === 0) return null

  if (def.metricUnit === 'games') {
    // Variety: only quests whose game is NOT yet credited count as new games
    const known = new Set(
      quests
        .filter(q => (q.status === 'completed' || q.status === 'claimed' ||
          (q.status === 'in_progress' && q.progressSeconds > 0)))
        .map(q => q.appId || q.gameName || q.id)
    )
    const fresh = completable.filter(q => !known.has(q.appId || q.gameName || q.id))
    if (fresh.length === 0) return null // every available game already credited — need MORE quests
    // resume in-progress first (f finishes fastest), then video quests, then rest
    const order = (q: ProcessedQuest) =>
      (q.status === 'in_progress' ? 0 : q.status === 'enrolled' ? 1 : 2) * 10 +
      (q.method === 'video' ? 0 : 1)
    return fresh.sort((a, b) => order(a) - order(b))[0]
  }

  // Time / streaming / quest badge: any completable quest adds credit.
  // In-progress first (closest to done), then video (fast), then the rest.
  const order = (q: ProcessedQuest) =>
    (q.status === 'in_progress' ? 0 : q.status === 'enrolled' ? 1 : 2) * 10 +
    (q.method === 'video' ? 0 : 1)
  return completable.sort((a, b) => order(a) - order(b))[0]
}

// ---------- public API ----------

/** All tasks for one user (disk + cloud merge, cloud-wins). */
export async function getTasks(userId: string): Promise<Record<string, BadgeTask>> {
  if (!userId) return {}
  const merged: Record<string, BadgeTask> = { ...(cache()[userId] ?? {}) }
  const cloud = await cloudLoad(userId)
  for (const [badgeId, t] of Object.entries(cloud)) {
    const l = merged[badgeId]
    if (!l || new Date(t.updatedAt) >= new Date(l.updatedAt)) merged[badgeId] = t
    else merged[badgeId] = l
  }
  return merged
}

/** The single running (or completed) task for a badge, if any. */
export async function getTask(userId: string, badgeId: string): Promise<BadgeTask | null> {
  const tasks = await getTasks(userId)
  return tasks[badgeId] ?? null
}

/** Which badgeId the currently-running engine quest belongs to (UI hint). */
export function currentQuestBadgeId(userId: string): string | null {
  return g.__badgeCurrentQuest?.[userId] ?? null
}

/**
 * Start a REAL engine task for a badge tier. The token is sealed
 * (AES-256-GCM) into the task row so the runner keeps working after
 * restarts — same security contract as the 24h monitor.
 */
export async function startTask(
  userId: string,
  badgeId: string,
  tierName: string | null,
  token: string
): Promise<{ task: BadgeTask; cloud: boolean }> {
  const def = BADGE_CATALOG.find(b => b.id === badgeId)
  if (!def || def.action !== 'engine') {
    throw new Error('This badge cannot be started as an engine task.')
  }
  const tier = def.tiers.find(t => t.name === tierName) ?? def.tiers[0] ?? null

  const now = new Date().toISOString()
  const task: BadgeTask = {
    userId,
    badgeId,
    tierName: tier?.name ?? tierName,
    status: 'running',
    startedAt: now,
    completedAt: null,
    tokenSealed: sealToken(token),
    lastStatus: 'starting',
    lastError: null,
    updatedAt: now,
  }

  const store = cache()
  store[userId] = store[userId] ?? {}
  store[userId][badgeId] = task
  persistDisk()
  const cloud = await cloudSave(task)

  // drive immediately — don't wait up to 30s for the first tick
  void tickBadgeTasks().catch(() => {})

  return { task, cloud }
}

/**
 * Cancel/remove a task (Stop / Reset). Also clears any completion the
 * task produced, so Reset works at any lifecycle stage.
 */
export async function cancelTask(
  userId: string,
  badgeId: string
): Promise<{ cloud: boolean }> {
  const store = cache()
  if (store[userId]) {
    delete store[userId][badgeId]
    if (Object.keys(store[userId]).length === 0) delete store[userId]
  }
  if (g.__badgeCurrentQuest?.[userId] === badgeId) delete g.__badgeCurrentQuest[userId]
  persistDisk()
  const cloud = await cloudDelete(userId, badgeId)
  await clearCompleted(userId, badgeId)
  return { cloud }
}

// ---------- the runner (ticker) ----------

const TICK_MS = 30_000

/**
 * One runner pass over every running task:
 *   1. re-read the user's LIVE quest data (cached 25s),
 *   2. if the tier requirement is already satisfied → complete (REAL),
 *   3. else if the engine is busy for this user (Start All / monitor
 *      queue or a live session) → attach & wait — their completions
 *      count toward the badge,
 *   4. else start the next best quest via the engine.
 * Never throws.
 */
export async function tickBadgeTasks(): Promise<number> {
  if (g.__badgeTicking) return 0 // re-entrancy guard
  g.__badgeTicking = true
  let completedCount = 0
  try {
    // sweep source: cloud (authoritative) + disk (cloud-off mode)
    const seen = new Map<string, BadgeTask>()
    for (const t of await cloudLoadRunning()) seen.set(`${t.userId}:${t.badgeId}`, t)
    for (const [userId, tasks] of Object.entries(cache())) {
      for (const [badgeId, t] of Object.entries(tasks)) {
        if (t.status === 'running') {
          const key = `${userId}:${badgeId}`
          if (!seen.has(key)) seen.set(key, { ...t, badgeId })
        }
      }
    }

    for (const task of seen.values()) {
      try {
        const done = await driveTask(task)
        if (done) completedCount++
      } catch (e) {
        console.error(`[badge-tasks] drive error (${task.badgeId}):`, e instanceof Error ? e.message : e)
      }
    }
  } finally {
    g.__badgeTicking = false
  }
  return completedCount
}

/** Drive ONE task one step forward. Returns true when it just completed. */
async function driveTask(task: BadgeTask): Promise<boolean> {
  const def = BADGE_CATALOG.find(b => b.id === task.badgeId)
  if (!def || def.action !== 'engine') {
    // catalog changed under us — drop the row
    await cancelTask(task.userId, task.badgeId)
    return false
  }
  const tier = def.tiers.find(t => t.name === task.tierName) ?? def.tiers[0]
  if (!tier) {
    await cancelTask(task.userId, task.badgeId)
    return false
  }

  // 0. legacy v3.10.0 timer row (running, no sealed token) — the fake
  //    ones. Delete on sight: boot pass AND every tick.
  if (!task.tokenSealed) {
    const store = cache()
    if (store[task.userId]) {
      delete store[task.userId][task.badgeId]
      if (Object.keys(store[task.userId]).length === 0) delete store[task.userId]
    }
    persistDisk()
    await cloudDelete(task.userId, task.badgeId)
    console.log(`[badge-tasks] removed legacy timer task ${task.badgeId} for user ${task.userId} (no sealed token — fake timer)`)
    return false
  }

  // 0b. token — sealed in the row; fail explicit (never silently fake)
  const token = unsealToken(task.tokenSealed)
  if (!token) {
    return await updateTask(task, { lastStatus: 'token-error', lastError: 'Stored token could not be decrypted — log in again and restart the task.' })
  }

  // engine state snapshot (before reading quest data)
  const activeSessions = listActiveSessions(task.userId)
  const ownQuestRunning =
    g.__badgeCurrentQuest?.[task.userId] === task.badgeId && activeSessions.length > 0
  if (ownQuestRunning) {
    return await updateTask(task, { lastStatus: 'running-quest', lastError: null })
  }
  // our own quest session just ended → Discord data changed → bust the
  // cache so the completion check below sees fresh numbers immediately
  if (task.lastStatus === 'running-quest' && g.__questCache?.has(task.userId)) {
    g.__questCache.delete(task.userId)
  }
  const engineBusy =
    listActiveQueues(task.userId).length > 0 || activeSessions.length > 0

  // 1. LIVE progress from Discord's own quest data
  const quests = await getCachedQuests(token, task.userId)
  if (!quests) {
    return await updateTask(task, { lastStatus: 'error', lastError: 'Could not read the quest list from Discord (token invalid or network). Will retry.' })
  }
  const stats = computeEngineStats(quests)

  // 2. requirement met with REAL data → complete
  if (tierSatisfied(def, tier, stats)) {
    const now = new Date().toISOString()
    const finished: BadgeTask = {
      ...task,
      status: 'completed',
      completedAt: now,
      lastStatus: 'completed',
      lastError: null,
      updatedAt: now,
    }
    const store = cache()
    store[task.userId] = store[task.userId] ?? {}
    store[task.userId][task.badgeId] = finished
    persistDisk()
    await cloudSave(finished)
    if (g.__badgeCurrentQuest?.[task.userId] === task.badgeId) delete g.__badgeCurrentQuest[task.userId]
    await setCompleted(task.userId, task.badgeId, tier.name)
    console.log(`[badge-tasks] ${task.badgeId} TIER EARNED for real (${tier.name}) — Discord data: ${stats.completedQuests} quests, ${stats.distinctGameIds.length} games, ${stats.creditedSeconds}s credited`)
    return true
  }

  // 3. engine busy for this user? attach — Start All / monitor completions count
  if (engineBusy) {
    return await updateTask(task, { lastStatus: 'waiting-engine', lastError: null })
  }

  // 4. engine idle → start the next best quest ourselves
  const candidate = pickQuestFor(def, tier, quests)
  if (!candidate) {
    return await updateTask(task, {
      lastStatus: 'waiting-quests',
      lastError: null,
    })
  }

  const r = await startQuest(token, candidate.id, task.userId)
  if (r.success && r.sessionId) {
    if (!g.__badgeCurrentQuest) g.__badgeCurrentQuest = {}
    g.__badgeCurrentQuest[task.userId] = task.badgeId
    return await updateTask(task, {
      lastStatus: 'running-quest',
      lastError: null,
    })
  }
  return await updateTask(task, {
    lastStatus: 'error',
    lastError: r.message || 'The quest engine could not start the next quest.',
  })
}

/** Persist a status change (memory + disk + cloud). */
async function updateTask(
  task: BadgeTask,
  patch: Partial<BadgeTask>
): Promise<boolean> {
  const next: BadgeTask = { ...task, ...patch, updatedAt: new Date().toISOString() }
  const store = cache()
  store[next.userId] = store[next.userId] ?? {}
  store[next.userId][next.badgeId] = next
  persistDisk()
  await cloudSave(next)
  return false
}

/**
 * Start the background runner (called from instrumentation.ts on the
 * ready event). Idempotent. The boot pass also cleans up LEGACY
 * v3.10.0 timer rows (running rows without a sealed token) — the
 * "stuck" fake tasks are deleted, not resumed.
 */
export function startBadgeTaskRunner(): void {
  if (g.__badgeTicker) return
  g.__badgeTicker = setInterval(() => {
    void tickBadgeTasks().catch(() => {})
  }, TICK_MS)
  // boot pass ~10s after start (gives db-init a moment to land tables)
  setTimeout(() => {
    void (async () => {
      await cleanupLegacyTasks()
      await tickBadgeTasks()
    })().catch(() => {})
  }, 10_000)
  console.log('[badge-tasks] REAL engine runner armed (30s tick, restart-proof, quest-jaise)')
}

/**
 * Delete v3.10.0 legacy rows: status 'running' but no token_sealed —
 * those were dashboard-timer tasks (the fake ones). Cloud + disk.
 */
async function cleanupLegacyTasks(): Promise<void> {
  // cloud
  const base = supabaseUrl()
  const key = supabaseKey()
  if (base && key) {
    try {
      const res = await fetch(
        `${base}/rest/v1/${TABLE}?status=eq.running&select=user_id,badge_id,token_sealed`,
        { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }
      )
      if (res.ok) {
        const rows = (await res.json()) as Array<{ user_id: string; badge_id: string; token_sealed: string | null }>
        for (const r of rows ?? []) {
          if (!r?.user_id || !r?.badge_id) continue
          if (typeof r.token_sealed === 'string' && r.token_sealed.length > 0) continue // new-format row
          await cloudDelete(r.user_id, r.badge_id)
          console.log(`[badge-tasks] removed legacy timer task ${r.badge_id} for user ${r.user_id}`)
        }
      }
    } catch {
      /* unreachable — disk sweep still runs */
    }
  }
  // disk
  const store = cache()
  let changed = false
  for (const [userId, tasks] of Object.entries(store)) {
    for (const [badgeId, t] of Object.entries(tasks)) {
      if (t.status === 'running' && (!t.tokenSealed || t.tokenSealed.length === 0)) {
        delete store[userId][badgeId]
        changed = true
      }
    }
    if (Object.keys(store[userId]).length === 0) delete store[userId]
  }
  if (changed) persistDisk()
}

// ---------- test hook ----------

/** Reset the per-process caches (tests only). */
export function __resetForTests(): void {
  g.__badgeTasks = undefined
  g.__badgeCurrentQuest = undefined
  g.__questCache = undefined
  if (g.__badgeTicker) {
    clearInterval(g.__badgeTicker)
    g.__badgeTicker = null
  }
}
