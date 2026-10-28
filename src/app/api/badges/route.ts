import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken } from '@/lib/session'
import {
  BADGE_CATALOG,
  accountAgeFromSnowflake,
  computeEngineStats,
  computeProgress,
  currentMetricFor,
} from '@/lib/badges'
import type { BadgeTier } from '@/lib/badges'
import { getCompletions, setCompleted, cloudHasCompletion, supabaseConfigured } from '@/lib/badge-store'
import { getTasks, getCachedQuests, currentQuestBadgeId } from '@/lib/badge-tasks'
import { listActiveSessions } from '@/lib/quest-engine'

// Respects DISCORD_API_BASE so mock-discord E2E tests hit the mock too.
const DISCORD_API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10'
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'discord/1.0.90 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36'

/** The live engine quest running for this user (if any) — shown quest-page style. */
interface CurrentQuestView {
  questId: string
  name: string
  gameName: string
  percent: number
  remainingSeconds: number
}

/**
 * GET /api/badges — REAL badge status.
 *
 * Data sources (all live, nothing faked):
 *   1. /users/@me            → user id (snowflake → account age math)
 *   2. /users/{id}/profile   → live profile badges[]
 *   3. /quests/@me (cached)  → completed quests, distinct quest games,
 *                              credited seconds — the same numbers the
 *                              quest page shows. This drives Game Time /
 *                              Game Variety / Streaming / Quests progress.
 *
 * account_age needs no button and no task: the earned tier is computed
 * from the snowflake (exact public math) and auto-recorded server-side.
 */
export async function GET(request: NextRequest) {
  try {
    const token = await getSessionToken()
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated. Please login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    // 1. Identify (needed for the snowflake → account age math)
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: token, 'User-Agent': DESKTOP_UA, Accept: '*/*' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!meRes.ok) {
      return NextResponse.json(
        { success: false, error: `Discord rejected the token (HTTP ${meRes.status}).`, code: 'TOKEN_INVALID' },
        { status: 502 }
      )
    }
    const me = await meRes.json()
    const userId: string = me.id

    // 2. Profile → badges[] (the canonical badge source)
    //    NOTE: /users/@me/profile 400s ("@me is not snowflake") — real ID required.
    const profRes = await fetch(`${DISCORD_API}/users/${userId}/profile?with_mutual_guilds=false`, {
      headers: { Authorization: token, 'User-Agent': DESKTOP_UA, Accept: '*/*' },
      signal: AbortSignal.timeout(15_000),
    })
    let liveBadges: Array<{ id: string; description?: string; icon?: string; link?: string }> = []
    if (profRes.ok) {
      const profile = await profRes.json()
      liveBadges = Array.isArray(profile.badges) ? profile.badges : []
    }
    const liveIds = new Set(liveBadges.map(b => b.id))

    // 3. LIVE quest data — the REAL progress source for engine badges
    //    (shares the runner's 25s cache — no duplicate Discord calls)
    const quests = await getCachedQuests(token, userId)
    const stats = quests ? computeEngineStats(quests) : null

    const age = accountAgeFromSnowflake(userId)

    // ---- account_age: auto-record the earned tier (pure math — real) ----
    // Self-healing: writes when the tier is new OR when the cloud row is
    // missing/stale (e.g. Supabase was unreachable when it first landed).
    const ageProgress = computeProgress(
      BADGE_CATALOG.find(b => b.id === 'account_age')!,
      age.years
    )
    let completions = await getCompletions(userId)
    if (ageProgress.earned && ageProgress.tierName) {
      const cloudSynced = await cloudHasCompletion(userId, 'account_age', ageProgress.tierName)
      if (completions.account_age?.tierName !== ageProgress.tierName || !cloudSynced) {
        await setCompleted(userId, 'account_age', ageProgress.tierName)
        completions = await getCompletions(userId)
      }
    }

    // ---- tasks + live engine quest ----
    const tasks = await getTasks(userId)
    const activeSessions = listActiveSessions(userId)
    const currentBadgeId = currentQuestBadgeId(userId)
    const currentQuest: CurrentQuestView | null =
      activeSessions.length > 0 && activeSessions[0]
        ? {
            questId: activeSessions[0].questId,
            name: activeSessions[0].questName,
            gameName: activeSessions[0].gameName,
            percent: activeSessions[0].percent ?? 0,
            remainingSeconds: activeSessions[0].remainingSeconds ?? 0,
          }
        : null

    // ---- per-badge view model ----
    const badges = BADGE_CATALOG.map(def => {
      const current = currentMetricFor(def, stats, age.years, liveIds)
      const p = computeProgress(def, current)

      const task = tasks[def.id] ?? null
      const completion = completions[def.id] ?? null

      // v3.11.1 HONESTY FIX — "earned" now means the badge is ON the
      // Discord profile (liveBadges from /users/{id}/profile). Quest-engine
      // activity (progress bars) is real, but Discord grants badges through
      // its own pipeline — a daily batch driven by desktop-client telemetry.
      // A finished task therefore shows "Awaiting Discord" until the badge
      // actually lands on the profile. account_age stays snowflake-math
      // (deterministic public data — no grant batch involved).
      const liveEarned =
        def.id === 'account_age' ? p.earned : liveIds.has(def.id)
      const taskCompleted = task?.status === 'completed' || !!completion
      // Activity satisfies the tier (or a task genuinely finished) but the
      // profile does not carry the badge yet -> awaiting Discord's grant.
      const awaitingGrant =
        !liveEarned && def.action === 'engine' && (taskCompleted || p.earned)

      // target tier for the Complete button = next tier not yet earned
      // (account_age gets one too — its "target" is the next anniversary tier,
      //  progress comes from snowflake math; no button, just the bar)
      let targetTier: (BadgeTier & { index: number }) | null = null
      if (def.action === 'engine' || def.action === 'auto') {
        const idx = def.tiers.findIndex(t => t.name === p.tierName) // -1 when nothing earned
        const nextIdx = p.earned ? idx + 1 : Math.max(0, def.tiers.findIndex(t => t.name === p.nextTier?.name))
        targetTier = def.tiers[nextIdx] ? { ...def.tiers[nextIdx], index: nextIdx } : null
      }

      const earned = liveEarned

      return {
        id: def.id,
        name: def.name,
        requirement: def.requirement,
        category: def.category,
        action: def.action,
        metricUnit: def.metricUnit,
        tracking: def.tracking,
        verifiedLive: def.verifiedLive ?? false,
        // v3.11.1: REAL earned state — the badge is on the Discord profile
        // (account_age: deterministic snowflake math). Quest-engine activity
        // alone no longer flips this to true.
        earned,
        liveEarned,
        awaitingGrant,
        tierName: p.tierName,
        currentLabel: p.currentLabel,
        // the tier the Complete button would drive toward
        targetTier: targetTier ? {
          name: targetTier.name,
          threshold: targetTier.threshold,
          thresholdLabel: targetTier.thresholdLabel,
        } : null,
        // REAL progress toward that target tier (0..1)
        targetProgress: (() => {
          if (!targetTier || current === null) return null
          const prevTierIdx = targetTier.index - 1
          const prev = prevTierIdx >= 0 ? def.tiers[prevTierIdx].threshold : 0
          const span = targetTier.threshold - prev
          if (span <= 0) return 1
          return Math.min(Math.max((current - prev) / span, 0), 1)
        })(),
        // task + engine state
        task: task ? {
          status: task.status,
          tierName: task.tierName,
          lastStatus: task.lastStatus,
          lastError: task.lastError,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          isCurrentQuest: currentBadgeId === def.id,
        } : null,
        currentQuest: currentBadgeId === def.id ? currentQuest : null,
        completion: completion ?? null,
      }
    })
    return NextResponse.json({
      success: true,
      user: {
        id: userId,
        username: me.username,
        globalName: me.global_name ?? me.username,
        accountCreated: age.created.toISOString(),
      },
      accountAge: {
        years: age.years,
        label: ageProgress.currentLabel,
        earnedTier: ageProgress.tierName,
        nextTier: ageProgress.nextTier
          ? { name: ageProgress.nextTier.name, thresholdLabel: ageProgress.nextTier.thresholdLabel }
          : null,
        nextTierProgress: ageProgress.nextTierProgress,
      },
      liveBadges,
      badges,
      engineStats: stats ? {
        completedQuests: stats.completedQuests,
        distinctGames: stats.distinctGameNames,
        creditedSeconds: stats.creditedSeconds,
      } : null,
      persistence: {
        supabaseRest: supabaseConfigured(),
        note: supabaseConfigured()
          ? 'badge tasks + completions persist to Supabase (badge_tasks / badge_completions) + disk'
          : 'SUPABASE_URL/SERVICE_KEY not set — badge tasks + completions persist to disk only',
      },
      meta: {
        verifiedAt: new Date().toISOString(),
        note: 'Earned = the badge is on your Discord profile right now (liveBadges). Progress bars show real quest-engine activity — the same numbers the quest page shows. Discord grants profile badges via its own daily batch from desktop-client telemetry, so a finished task shows "Awaiting Discord" until the badge actually lands.',
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[BADGES API] error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
