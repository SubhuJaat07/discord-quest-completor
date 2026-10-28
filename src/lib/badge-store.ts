// ============================================================
// Badge completion store — disk + Supabase (private build)
// ------------------------------------------------------------
// Persistence for the /badge page "Complete" button:
//
//   DISK      $DATA_DIR/badge-completions.json
//   CLOUD     Supabase table `badge_completions` (auto-created by
//             db-init on the ready event — see src/lib/db-init.ts)
//
// IMPORTANT (what this IS and IS NOT):
//   This is DASHBOARD-SIDE tracking only. Discord grants real
//   profile badges automatically through telemetry — there is no
//   claim API (verified live: every badge endpoint 404s). The
//   Complete button lets the user mark a badge task as done on
//   THEIR dashboard (progress bookkeeping), it does not touch
//   Discord's servers at all.
//
// Security contract (same as state-store.ts):
//   - No tokens, no emails — only (user_id, badge_id, tier, date).
//   - Service key used server-side only, never logged.
//   - RLS with no policies on the table → service-role only.
//   - Cloud failures degrade to disk; disk failures degrade to
//     memory. Nothing ever throws to an API route.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

const DATA_DIR = process.env.DATA_DIR || './data'
const FILE = path.join(DATA_DIR, 'badge-completions.json')

// ---------- types ----------

export interface BadgeCompletion {
  tierName: string | null
  completedAt: string // ISO
}

/** userId -> (badgeId -> completion) */
type CompletionMap = Record<string, Record<string, BadgeCompletion>>

// ---------- Supabase REST config (same helpers as state-store) ----------

function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
}

function supabaseKey(): string {
  return (process.env.SUPABASE_SERVICE_KEY || '').trim()
}

export function supabaseConfigured(): boolean {
  return supabaseUrl().length > 0 && supabaseKey().length > 0
}

function authHeaders(): Record<string, string> {
  return {
    apikey: supabaseKey(),
    Authorization: `Bearer ${supabaseKey()}`,
    'Content-Type': 'application/json',
  }
}

const TABLE = 'badge_completions'
const TIMEOUT_MS = 5000

// ---------- in-memory cache (HMR + request dedupe safe) ----------

const g = globalThis as unknown as { __badgeCompletions?: CompletionMap }

function cache(): CompletionMap {
  if (!g.__badgeCompletions) {
    g.__badgeCompletions = {}
    // Seed from disk on first touch (fast path for every request).
    try {
      if (existsSync(FILE)) {
        const parsed = JSON.parse(readFileSync(FILE, 'utf-8'))
        if (parsed && typeof parsed === 'object') g.__badgeCompletions = parsed as CompletionMap
      }
    } catch {
      /* corrupt file — start empty, it rewrites on next change */
    }
  }
  return g.__badgeCompletions
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

// ---------- public API ----------

/** All completions for one user (disk cache + cloud merge, cloud-wins). */
export async function getCompletions(userId: string): Promise<Record<string, BadgeCompletion>> {
  if (!userId) return {}
  const local = { ...(cache()[userId] ?? {}) }
  const cloud = await cloudLoad(userId)
  const merged: Record<string, BadgeCompletion> = { ...local }
  for (const [badgeId, c] of Object.entries(cloud)) {
    const l = merged[badgeId]
    // keep whichever record is newer (undo on one side must win too)
    if (!l || new Date(c.completedAt) >= new Date(l.completedAt)) merged[badgeId] = c
    else merged[badgeId] = l
  }
  return merged
}

/** Mark a badge complete. Returns the stored record. */
export async function setCompleted(
  userId: string,
  badgeId: string,
  tierName: string | null
): Promise<{ completion: BadgeCompletion; cloud: boolean }> {
  const completion: BadgeCompletion = {
    tierName,
    completedAt: new Date().toISOString(),
  }
  const store = cache()
  store[userId] = store[userId] ?? {}
  store[userId][badgeId] = completion
  persistDisk()
  const cloud = await cloudSave(userId, badgeId, completion)
  return { completion, cloud }
}

/** Undo a completion (removes it from disk + cloud). */
export async function clearCompleted(
  userId: string,
  badgeId: string
): Promise<{ cloud: boolean }> {
  const store = cache()
  if (store[userId]) {
    delete store[userId][badgeId]
    if (Object.keys(store[userId]).length === 0) delete store[userId]
  }
  persistDisk()
  const cloud = await cloudDelete(userId, badgeId)
  return { cloud }
}

/**
 * True when the CLOUD row already exists with this exact tier.
 * Used by the account-age auto-claim to self-heal disk-vs-cloud drift:
 * a record that only ever landed on disk (Supabase was unreachable at
 * the time) is re-saved to the cloud on the next visit.
 */
export async function cloudHasCompletion(
  userId: string,
  badgeId: string,
  tierName: string
): Promise<boolean> {
  const cloud = await cloudLoad(userId)
  return cloud[badgeId]?.tierName === tierName
}

// ---------- cloud (PostgREST subset, no SDK) ----------

async function cloudLoad(userId: string): Promise<Record<string, BadgeCompletion>> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return {}
  try {
    const res = await fetch(
      `${base}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=badge_id,tier_name,completed_at`,
      { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!res.ok) return {} // table missing / unreachable — disk still works
    const rows = (await res.json()) as Array<{ badge_id: string; tier_name: string | null; completed_at: string }>
    const out: Record<string, BadgeCompletion> = {}
    for (const r of rows) {
      if (typeof r?.badge_id === 'string') {
        out[r.badge_id] = {
          tierName: typeof r.tier_name === 'string' ? r.tier_name : null,
          completedAt: r.completed_at ?? new Date().toISOString(),
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

async function cloudSave(userId: string, badgeId: string, c: BadgeCompletion): Promise<boolean> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return false
  try {
    const res = await fetch(`${base}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { ...authHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: userId,
        badge_id: badgeId,
        tier_name: c.tierName,
        completed_at: c.completedAt,
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
      { method: 'DELETE',
        headers: authHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    return res.ok
  } catch {
    return false
  }
}
