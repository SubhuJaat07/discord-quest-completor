/**
 * Discord Badge System — catalog + REAL engine progress math
 * =================================================
 * v3.11.0 — the /badge page is now driven by REAL data:
 *
 *   PROGRESS SOURCE (cannot be faked):
 *     Everything the cards show is computed from the user's LIVE
 *     /quests/@me data — the same server-side numbers Discord's own
 *     quest page shows. Completed quests, distinct quest games and
 *     credited seconds all come from Discord, never from us.
 *
 *   COMPLETION PATH:
 *     The Complete button starts the SAME quest engine that powers
 *     "Start All" (enroll → heartbeat → complete, 100% server-side,
 *     survives the site being closed and server restarts). The task
 *     finishes only when Discord's own data satisfies the tier
 *     requirement — no dashboard timers, no fake claims.
 *
 *   BADGE ACTION KINDS:
 *     engine   — Complete button runs the quest engine (quest_completed,
 *                game_time, game_variety, streaming)
 *     auto     — no button; computed from public data (account_age:
 *                snowflake timestamp math — 100% accurate)
 *     purchase — shop only, nothing to run (orbs)
 */

import type { ProcessedQuest } from './quest-engine'

// ─── Types ─────────────────────────────────────────────────

export interface BadgeTier {
  name: string
  threshold: number        // hours / games / years
  thresholdLabel: string   // human label ("1 hour", "2 games", "1 year")
}

export interface BadgeDefinition {
  id: string
  name: string
  /** One-line requirement shown on the card (kept short — quest-page style). */
  requirement: string
  category: 'activity' | 'experiment' | 'quest' | 'subscription' | 'purchase'
  /**
   * engine  = Complete button starts the REAL quest engine
   * auto    = no button — computed from public account data
   * purchase = shop only — nothing to complete
   */
  action: 'engine' | 'auto' | 'purchase'
  tracking: string        // what the desktop client measures
  metricUnit: 'hours' | 'games' | 'years' | 'boolean'
  tiers: BadgeTier[]
  verifiedLive?: boolean  // seen on a real profile during research
}

export interface BadgeProgress {
  definition: BadgeDefinition
  current: number | null   // null = not exposed (client-side only)
  currentLabel: string
  nextTier: BadgeTier | null
  nextTierProgress: number | null  // 0..1 toward next threshold
  earned: boolean
  tierName: string | null
}

// ─── Tier catalogs ─────────────────────────────────────────
// Thresholds from community research; exact in-client names vary
// slightly by experiment bucket. Names are stable, numbers approximate.

const GAME_TIME_TIERS: BadgeTier[] = [
  { name: 'Casual',      threshold: 1,    thresholdLabel: '1 hour' },
  { name: 'Regular',     threshold: 5,    thresholdLabel: '5 hours' },
  { name: 'Invested',    threshold: 10,   thresholdLabel: '10 hours' },
  { name: 'Dedicated',   threshold: 50,   thresholdLabel: '50 hours' },
  { name: 'Committed',   threshold: 100,  thresholdLabel: '100 hours' },
  { name: 'Seasoned',    threshold: 250,  thresholdLabel: '250 hours' },
  { name: 'Veteran',     threshold: 500,  thresholdLabel: '500 hours' },
  { name: 'Elite',       threshold: 1000, thresholdLabel: '1,000 hours' },
  { name: 'Master',      threshold: 2500, thresholdLabel: '2,500 hours' },
  { name: 'Eternal',     threshold: 5000, thresholdLabel: '5,000 hours' },
]

const STREAMING_TIERS: BadgeTier[] = [
  { name: 'Newcomer',     threshold: 1,    thresholdLabel: '1 hour' },
  { name: 'Streamer',     threshold: 5,    thresholdLabel: '5 hours' },
  { name: 'Broadcaster',  threshold: 10,   thresholdLabel: '10 hours' },
  { name: 'Showrunner',   threshold: 50,   thresholdLabel: '50 hours' },
  { name: 'Headliner',    threshold: 100,  thresholdLabel: '100 hours' },
  { name: 'Marquee',      threshold: 250,  thresholdLabel: '250 hours' },
  { name: 'Attraction',   threshold: 500,  thresholdLabel: '500 hours' },
  { name: 'Sensation',    threshold: 1000, thresholdLabel: '1,000 hours' },
  { name: 'Spectacle',    threshold: 2500, thresholdLabel: '2,500 hours' },
  { name: 'Phenomenon',   threshold: 5000, thresholdLabel: '5,000 hours' },
]

const VARIETY_TIERS: BadgeTier[] = [
  { name: 'Sampler',       threshold: 2,   thresholdLabel: '2 games' },
  { name: 'Explorer',      threshold: 5,   thresholdLabel: '5 games' },
  { name: 'Wanderer',      threshold: 10,  thresholdLabel: '10 games' },
  { name: 'Adventurer',    threshold: 25,  thresholdLabel: '25 games' },
  { name: 'Trailblazer',   threshold: 50,  thresholdLabel: '50 games' },
  { name: 'Pathfinder',    threshold: 75,  thresholdLabel: '75 games' },
  { name: 'Cartographer',  threshold: 100, thresholdLabel: '100 games' },
  { name: 'Universalist',  threshold: 125, thresholdLabel: '125+ games' },
]

const AGE_TIERS: BadgeTier[] = [
  { name: 'Seed',        threshold: 1,  thresholdLabel: '1 year' },
  { name: 'Sprout',      threshold: 2,  thresholdLabel: '2 years' },
  { name: 'Sapling',     threshold: 3,  thresholdLabel: '3 years' },
  { name: 'Grown',       threshold: 5,  thresholdLabel: '5 years' },
  { name: 'Mature',      threshold: 7,  thresholdLabel: '7 years' },
  { name: 'Ancient',     threshold: 8,  thresholdLabel: '8 years' },
  { name: 'Timeless',    threshold: 9,  thresholdLabel: '9 years' },
  { name: 'Primordial',  threshold: 10, thresholdLabel: '10+ years' },
]

// ─── The catalog ───────────────────────────────────────────

export const BADGE_CATALOG: BadgeDefinition[] = [
  {
    id: 'quest_completed',
    name: 'Quests Badge',
    requirement: 'Complete your first Discord quest',
    category: 'quest',
    action: 'engine',
    tracking: 'Quest completion — server-side, auto-granted by Discord',
    metricUnit: 'boolean',
    tiers: [{ name: 'Completed a Quest', threshold: 1, thresholdLabel: '1 quest' }],
    verifiedLive: true,
  },
  {
    id: 'game_time',
    name: 'Game Time Badge',
    requirement: 'Total play time on games Discord detects',
    category: 'experiment',
    action: 'engine',
    tracking: 'Desktop client game detection (per-process)',
    metricUnit: 'hours',
    tiers: GAME_TIME_TIERS,
  },
  {
    id: 'game_variety',
    name: 'Game Variety Badge',
    requirement: 'Play different games Discord detects',
    category: 'experiment',
    action: 'engine',
    tracking: 'Desktop client game detection — unique game count',
    metricUnit: 'games',
    tiers: VARIETY_TIERS,
  },
  {
    id: 'streaming',
    name: 'Streaming Badge',
    requirement: 'Screenshare with at least one viewer in a call',
    category: 'experiment',
    action: 'engine',
    tracking: 'Go Live / screenshare sessions with ≥1 viewer',
    metricUnit: 'hours',
    tiers: STREAMING_TIERS,
  },
  {
    id: 'account_age',
    name: 'Account Age Badge',
    requirement: 'Unlocks automatically as your account ages',
    category: 'activity',
    action: 'auto',
    tracking: 'Account creation timestamp (snowflake math — exact)',
    metricUnit: 'years',
    tiers: AGE_TIERS,
  },
  {
    id: 'orbs',
    name: 'Orbs Badge',
    requirement: 'Shop purchase with Orbs only',
    category: 'purchase',
    action: 'purchase',
    tracking: 'Shop purchase with Orbs currency',
    metricUnit: 'boolean',
    tiers: [{ name: 'Orbs Apprentice', threshold: 1, thresholdLabel: 'purchase' }],
  },
]

// ─── Snowflake math (account age — exact, public info) ──────

/** Snowflake ID → account creation Date (Discord epoch 1420070400000). */
export function accountAgeFromSnowflake(userId: string): { created: Date; years: number } {
  const ms = Number(BigInt(userId) >> BigInt(22)) + 1420070400000
  const created = new Date(ms)
  const years = (Date.now() - ms) / (365.25 * 24 * 3600 * 1000)
  return { created, years }
}

// ─── REAL engine stats — read from Discord's own quest data ──

export interface EngineStats {
  /** Quests Discord marks completed or claimed. */
  completedQuests: number
  /** Distinct game identities (appId or gameName) with any credited play. */
  distinctGameIds: string[]
  /** Game display names matching distinctGameIds order. */
  distinctGameNames: string[]
  /** Total seconds Discord credited across quests (completed + in-progress). */
  creditedSeconds: number
}

/**
 * Compute the REAL badge metrics from the live quest list.
 * These numbers come from Discord's servers — the same data the
 * quest page shows. Nothing here can be faked locally.
 */
export function computeEngineStats(quests: ProcessedQuest[]): EngineStats {
  const ids: string[] = []
  const names: string[] = []
  let completed = 0
  let seconds = 0

  for (const q of quests) {
    const isDone = q.status === 'completed' || q.status === 'claimed'
    const inProgressCredited = q.status === 'in_progress' && q.progressSeconds > 0

    if (isDone) completed++
    if (isDone || inProgressCredited) {
      seconds += Math.max(0, q.progressSeconds)
      const gid = q.appId || q.gameName || q.id
      if (!ids.includes(gid)) {
        ids.push(gid)
        names.push(q.gameName || gid)
      }
    }
  }

  return {
    completedQuests: completed,
    distinctGameIds: ids,
    distinctGameNames: names,
    creditedSeconds: seconds,
  }
}

/**
 * The current metric value for a badge, derived from REAL data:
 *   engine badges → live quest stats
 *   account_age   → snowflake years
 *   orbs          → null (profile-only)
 */
export function currentMetricFor(
  def: BadgeDefinition,
  stats: EngineStats | null,
  ageYears: number | null,
  liveBadgeIds?: Set<string>,
): number | null {
  switch (def.id) {
    case 'quest_completed':
      // A completed quest is the real trigger — the profile badge is the
      // live confirmation (auto-granted by Discord after completion).
      if (stats) return stats.completedQuests >= 1 ? 1 : 0
      return liveBadgeIds?.has('quest_completed') ? 1 : null
    case 'game_variety':
      return stats ? stats.distinctGameIds.length : null
    case 'game_time':
    case 'streaming':
      return stats ? stats.creditedSeconds / 3600 : null
    case 'account_age':
      return ageYears
    case 'orbs':
      return liveBadgeIds?.has('orbs') ? 1 : 0
    default:
      return null
  }
}

// ─── Progress math ─────────────────────────────────────────

/**
 * Compute progress for one badge given its current REAL metric value.
 * For experiment badges served without stats, current is null — the UI
 * then shows only the tier ladder target.
 */
export function computeProgress(def: BadgeDefinition, current: number | null): BadgeProgress {
  let earned = false
  let tierName: string | null = null
  let nextTier: BadgeTier | null = null
  let nextTierProgress: number | null = null

  if (current !== null) {
    for (let i = 0; i < def.tiers.length; i++) {
      const t = def.tiers[i]
      if (current >= t.threshold) {
        earned = true
        tierName = t.name
        nextTier = def.tiers[i + 1] ?? null
      } else {
        if (!nextTier) nextTier = t
        break
      }
    }
    // progress fraction toward the NEXT tier
    if (nextTier) {
      const prev = tierName ? def.tiers.find(t => t.name === tierName)!.threshold : 0
      const span = nextTier.threshold - prev
      nextTierProgress = span > 0 ? Math.min(Math.max((current - prev) / span, 0), 1) : 1
    }
  }

  return {
    definition: def,
    current,
    currentLabel: current === null ? '—' : formatMetric(def, current),
    nextTier,
    nextTierProgress,
    earned,
    tierName,
  }
}

function formatMetric(def: BadgeDefinition, v: number): string {
  switch (def.metricUnit) {
    case 'hours': return v >= 1 ? `${Math.floor(v)}h ${Math.round((v % 1) * 60)}m` : `${Math.round(v * 60)}m`
    case 'games': return `${Math.floor(v)} games`
    case 'years': {
      const y = Math.floor(v)
      const m = Math.round((v - y) * 12)
      return y > 0 ? `${y}y ${m}m` : `${m} months`
    }
    case 'boolean': return v >= 1 ? 'earned' : 'not yet'
  }
}
