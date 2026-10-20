/**
 * 24-Hour Quest Monitor (v3.2.0)
 *
 * A server-side scheduler that:
 *   - every N hours (default 24) fetches the user's quest list,
 *   - if any completable quest is found → auto-accepts (enrolls) it and
 *     completes it via the sequential quest queue (one after another),
 *   - claims rewards when possible (captcha-gated claims are reported),
 *   - keeps a run history (last 20 cycles) and a live "next run" countdown.
 *
 * Runs ENTIRELY on the server — the browser can stay closed for weeks.
 * State survives redeploys/restarts via $DATA_DIR/monitor.json (default ./data,
 * /app/data in Docker — mount it as a volume on Coolify/Railway to keep the
 * monitor across image rebuilds).
 *
 * NOTE: enabling the monitor stores the Discord token in that file, on the
 * user's OWN server only (single-user self-hosted tool).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import {
  verifyToken,
  startQuestQueue,
  getQueueStatus,
  listActiveQueues,
  waitForQueue,
} from './quest-engine'

// ============================================================
// Types
// ============================================================

export interface MonitorHistoryEntry {
  startedAt: number
  finishedAt: number
  trigger: 'schedule' | 'manual' | 'boot'
  found: number
  completedCount: number
  failedCount: number
  completedNames: string[]
  failedNames: string[]
  error?: string
}

export interface MonitorState {
  enabled: boolean
  userId: string
  username: string
  token: string
  intervalHours: number
  nextRunAt: number
  lastRunAt: number | null
  currentlyRunning: boolean
  createdAt: number
  history: MonitorHistoryEntry[]
}

// ============================================================
// Storage — globalThis (HMR-safe) + JSON file on disk
// ============================================================

const DATA_DIR = process.env.DATA_DIR || './data'
const MONITOR_FILE = path.join(DATA_DIR, 'monitor.json')

/** How often the scheduler wakes up to check "is it time?" (drift-proof). */
const CHECK_INTERVAL_MS = 60_000

const g = globalThis as unknown as {
  __questMonitor?: {
    state: MonitorState | null
    timer: ReturnType<typeof setInterval> | null
  }
}

function getState(): MonitorState | null {
  return g.__questMonitor?.state ?? null
}

function persist() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(MONITOR_FILE, JSON.stringify(getState(), null, 2))
  } catch (e) {
    console.error('[monitor] persist failed:', e)
  }
}

function restoreFromDisk() {
  try {
    if (!existsSync(MONITOR_FILE)) return
    const saved = JSON.parse(readFileSync(MONITOR_FILE, 'utf-8'))
    if (!saved || typeof saved !== 'object' || !saved.enabled) return
    g.__questMonitor!.state = saved as MonitorState

    // If the scheduled run was missed while the server was down → run shortly
    // after boot (quest expiry makes "late" better than "skipped").
    if (saved.nextRunAt <= Date.now()) {
      saved.nextRunAt = Date.now() + 20_000
      persist()
      console.log('[monitor] restored — missed run detected, firing in ~20s')
    }
    console.log(`[monitor] restored for @${saved.username} — next run ${new Date(saved.nextRunAt).toISOString()}`)
  } catch (e) {
    console.error('[monitor] restore failed:', e)
  }
}

// Module init (runs once per server process thanks to the globalThis guard)
if (!g.__questMonitor) {
  g.__questMonitor = { state: null, timer: null }
  restoreFromDisk()
  if (getState()?.enabled) ensureScheduler()
}

function ensureScheduler() {
  if (g.__questMonitor!.timer) return
  g.__questMonitor!.timer = setInterval(() => {
    void tick()
  }, CHECK_INTERVAL_MS)
  // Don't block the process from exiting because of the monitor alone
  ;(g.__questMonitor!.timer as any)?.unref?.()
}

/** Scheduler heartbeat: run the cycle when due. */
async function tick() {
  const st = getState()
  if (!st?.enabled || st.currentlyRunning) return
  if (Date.now() < st.nextRunAt) return
  await runMonitorCycle('schedule')
}

// ============================================================
// The monitor cycle
// ============================================================

/**
 * One monitor cycle:
 *   list quests → pick completable ones → sequential queue (auto-accept +
 *   complete each) → record history → schedule the next run.
 *
 * If the user already has a queue running (started manually), the monitor
 * attaches to it and waits instead of starting a duplicate.
 */
export async function runMonitorCycle(
  trigger: 'schedule' | 'manual' | 'boot' = 'schedule',
): Promise<MonitorHistoryEntry | null> {
  const st = getState()
  if (!st || !st.enabled) return null
  if (st.currentlyRunning) return null

  st.currentlyRunning = true
  st.lastRunAt = Date.now()
  persist()
  console.log(`[monitor] cycle start (${trigger})`)

  const entry: MonitorHistoryEntry = {
    startedAt: Date.now(),
    finishedAt: 0,
    trigger,
    found: 0,
    completedCount: 0,
    failedCount: 0,
    completedNames: [],
    failedNames: [],
  }

  try {
    // Attach to a user-started queue if one is already running
    let queueId: string | null = listActiveQueues(st.userId)[0]?.id ?? null
    if (queueId) {
      console.log(`[monitor] attaching to already-running queue ${queueId}`)
    } else {
      const r = await startQuestQueue(st.token, st.userId)
      if (r.success && r.queueId) {
        queueId = r.queueId
      } else {
        // Typical case: "No completable quests found" — totally fine
        entry.error = r.message
      }
    }

    if (queueId) {
      const done = waitForQueue(queueId)
      if (done) {
        // A 15-min quest takes ~15 min — the await is intentional; this runs
        // server-side with no HTTP timeout involved.
        await done
      }
      const status = getQueueStatus(queueId)
      if (status) {
        entry.found = status.total
        entry.completedCount = status.completedCount
        entry.failedCount = status.failedCount
        entry.completedNames = (status.completed || []).map((c: any) => c.name)
        entry.failedNames = (status.failed || []).map(
          (f: any) => `${f.name}${f.error ? ' — ' + f.error : ''}`,
        )
      }
    } else if (!entry.error) {
      entry.error = 'No completable quests found — nothing to do.'
    }
  } catch (e: any) {
    entry.error = e?.message || String(e)
  } finally {
    entry.finishedAt = Date.now()
    const st2 = getState()
    if (st2) {
      st2.history.unshift(entry)
      st2.history = st2.history.slice(0, 20)
      st2.currentlyRunning = false
      st2.nextRunAt = Date.now() + Math.max(0.01, st2.intervalHours) * 3600_000
      persist()
    }
    console.log(
      `[monitor] cycle done (${trigger}): found=${entry.found} ` +
        `completed=${entry.completedCount} failed=${entry.failedCount}` +
        `${entry.error ? ' — ' + entry.error : ''}`,
    )
  }
  return entry
}

// ============================================================
// Public API (used by /api/quest/monitor)
// ============================================================

/** Enable (or re-enable with fresh token) the monitor for the logged-in user. */
export async function enableMonitor(
  token: string,
  user: { id: string; username: string },
  intervalHours = 24,
): Promise<{ success: boolean; message: string }> {
  // Verify the token actually works before committing it to disk
  const verified = await verifyToken(token)
  if (!verified) {
    return { success: false, message: 'Token verification failed — cannot enable the monitor.' }
  }

  const existing = getState()
  const sameUser = existing?.userId === user.id
  const st: MonitorState = {
    enabled: true,
    userId: user.id,
    username: user.username,
    token,
    intervalHours: Math.min(168, Math.max(0.01, intervalHours || 24)),
    nextRunAt: Date.now() + 15_000, // first check shortly after enabling
    lastRunAt: sameUser ? existing!.lastRunAt : null,
    currentlyRunning: false,
    createdAt: sameUser ? existing!.createdAt : Date.now(),
    history: sameUser ? existing!.history : [],
  }
  g.__questMonitor!.state = st
  persist()
  ensureScheduler()

  const hrs = st.intervalHours >= 1 ? `${st.intervalHours}h` : `${Math.round(st.intervalHours * 3600)}s`
  return {
    success: true,
    message: `Monitor ON — every ${hrs} the server fetches new quests, auto-accepts & completes them. First check in ~15s. Runs 24/7 server-side.`,
  }
}

/** Disable the monitor (history is kept, token is wiped). */
export function disableMonitor(): boolean {
  const st = getState()
  if (!st) return false
  st.enabled = false
  st.token = ''
  st.currentlyRunning = false
  persist()
  return true
}

/** Fully wipe the monitor (disable + clear history + delete the file). */
export function clearMonitor(): boolean {
  g.__questMonitor!.state = null
  try {
    if (existsSync(MONITOR_FILE)) writeFileSync(MONITOR_FILE, 'null')
  } catch { /* ignore */ }
  return true
}

/** Silent token refresh: same user logs in with a newer token → update monitor. */
export function updateMonitorToken(token: string, userId: string) {
  const st = getState()
  if (st?.enabled && st.userId === userId && st.token !== token) {
    st.token = token
    persist()
    console.log('[monitor] token refreshed for', userId)
  }
}

/** Serializable monitor status for the API/UI. */
export function getMonitorStatus() {
  const st = getState()
  if (!st) {
    return { enabled: false as const, message: 'Monitor is OFF.' }
  }
  return {
    enabled: st.enabled,
    userId: st.userId,
    username: st.username,
    intervalHours: st.intervalHours,
    nextRunAt: st.enabled ? new Date(st.nextRunAt).toISOString() : null,
    secondsUntilNextRun: st.enabled
      ? Math.max(0, Math.round((st.nextRunAt - Date.now()) / 1000))
      : null,
    lastRunAt: st.lastRunAt ? new Date(st.lastRunAt).toISOString() : null,
    currentlyRunning: st.currentlyRunning,
    history: st.history.slice(0, 10),
    storage: MONITOR_FILE,
  }
}
