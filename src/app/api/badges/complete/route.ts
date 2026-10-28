import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken, getSessionUser } from '@/lib/session'
import { BADGE_CATALOG, computeEngineStats, computeProgress, currentMetricFor } from '@/lib/badges'
import { getTask, startTask, cancelTask, getCachedQuests, tierSatisfied } from '@/lib/badge-tasks'
import { getCompletions, setCompleted } from '@/lib/badge-store'

/**
 * POST /api/badges/complete  — START a REAL engine task (v3.11.0).
 * DELETE /api/badges/complete — Stop the task / Reset the completion.
 *
 * What the button really does now:
 *  - Starts the SAME quest engine that powers "Start All" — real
 *    enroll + heartbeat calls to Discord, 100% server-side. The user
 *    can close the site; the task keeps running and survives restarts
 *    (sealed token in the task row, same contract as the 24h monitor).
 *  - The task only completes when the user's LIVE /quests/@me data
 *    satisfies the tier requirement — checked every 30s by the runner.
 *  - If the requirement is ALREADY satisfied by real data, the route
 *    completes instantly (no fake waiting).
 *
 * Rejected by design:
 *  - account_age → auto badge (snowflake math, nothing to run)
 *  - orbs → shop purchase only
 */

/** Resolve the acting user's Discord ID.
 *  Session store first; after a restart the in-memory store is empty, so we
 *  derive the ID from the token itself — the first dot-segment of a Discord
 *  token is base64(user id), which is public info (login-logger relies on
 *  the same fact). Never calls Discord. */
async function resolveUserId(token: string): Promise<string | null> {
  const sessionUser = await getSessionUser()
  if (sessionUser?.id && /^\d{15,21}$/.test(sessionUser.id)) return sessionUser.id
  try {
    const decoded = Buffer.from(token.split('.')[0], 'base64').toString('utf-8')
    return /^\d{15,21}$/.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function findBadge(badgeId: unknown) {
  if (typeof badgeId !== 'string' || !badgeId.trim()) return null
  return BADGE_CATALOG.find(b => b.id === badgeId.trim()) ?? null
}

export async function POST(request: NextRequest) {
  try {
    const token = await getSessionToken()
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated. Please login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }
    const userId = await resolveUserId(token)
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Session user not found. Please login again.', code: 'NO_SESSION_USER' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const badge = findBadge((body as Record<string, unknown>)?.badgeId)
    if (!badge) {
      return NextResponse.json(
        { success: false, error: 'Unknown badgeId.', code: 'BADGE_NOT_FOUND' },
        { status: 404 }
      )
    }
    if (badge.action !== 'engine') {
      return NextResponse.json(
        {
          success: false,
          error:
            badge.action === 'auto'
              ? `"${badge.name}" unlocks automatically (${badge.requirement.toLowerCase()}) — nothing to run.`
              : `"${badge.name}" is a shop purchase — it cannot be completed through activity.`,
          code: 'BADGE_NOT_ENGINE',
        },
        { status: 400 }
      )
    }

    // Resolve the target tier: explicit tierName wins, else the next
    // unearned tier computed from the user's REAL data.
    const rawTier = (body as Record<string, unknown>)?.tierName
    const quests = await getCachedQuests(token, userId)
    const stats = quests ? computeEngineStats(quests) : null
    const p = computeProgress(badge, currentMetricFor(badge, stats, null, undefined))

    let tierName: string | null =
      typeof rawTier === 'string' && rawTier.trim() ? rawTier.trim().slice(0, 64) : null
    if (!tierName) {
      const idx = def_tier_index(badge, p)
      tierName = badge.tiers[idx]?.name ?? badge.tiers[0]?.name ?? null
    }
    const tier = badge.tiers.find(t => t.name === tierName) ?? badge.tiers[0] ?? null
    if (!tier) {
      return NextResponse.json(
        { success: false, error: 'Badge has no tiers.', code: 'NO_TIER' },
        { status: 400 }
      )
    }

    // INSTANT path — the REAL data already satisfies the requirement
    // (e.g. previously completed quests, or a monitor/queue that just
    // finished the needed work). Record it honestly, run nothing.
    if (stats && tierSatisfied(badge, tier, stats)) {
      const { completion } = await setCompleted(userId, badge.id, tier.name)
      const now = new Date().toISOString()
      return NextResponse.json({
        success: true,
        badgeId: badge.id,
        badgeName: badge.name,
        instant: true,
        message: `Requirement already satisfied by your real Discord data (${tier.name} — ${tier.thresholdLabel}). Discord grants the profile badge in its own daily batch.`,
        task: {
          status: 'completed',
          tierName: tier.name,
          lastStatus: 'completed',
          lastError: null,
          startedAt: now,
          completedAt: now,
        },
        completion,
      })
    }

    // ENGINE path — start the real quest-engine task (server-side,
    // survives the site being closed, restart-proof via sealed token).
    const { task, cloud } = await startTask(userId, badge.id, tier.name, token)
    const existingCompletion = (await getCompletions(userId))[badge.id] ?? null

    return NextResponse.json({
      success: true,
      badgeId: badge.id,
      badgeName: badge.name,
      message: `Running the quest engine for ${tier.name} (${tier.thresholdLabel}) — server-side, works even after you close this site.`,
      task: {
        status: task.status,
        tierName: task.tierName,
        lastStatus: task.lastStatus,
        lastError: task.lastError,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      },
      instant: false,
      completion: existingCompletion,
      persisted: cloud ? 'cloud+disk' : 'disk',
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[BADGES COMPLETE API] error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

/** index of the tier the button should target (next unearned) */
function def_tier_index(
  badge: (typeof BADGE_CATALOG)[number],
  p: ReturnType<typeof computeProgress>,
): number {
  if (p.earned && p.tierName) {
    const idx = badge.tiers.findIndex(t => t.name === p.tierName)
    return Math.min(idx + 1, badge.tiers.length - 1)
  }
  if (p.nextTier) {
    const idx = badge.tiers.findIndex(t => t.name === p.nextTier!.name)
    if (idx >= 0) return idx
  }
  return 0
}

export async function DELETE(request: NextRequest) {
  try {
    const token = await getSessionToken()
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated. Please login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }
    const userId = await resolveUserId(token)
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Session user not found. Please login again.', code: 'NO_SESSION_USER' },
        { status: 401 }
      )
    }

    // badgeId from JSON body OR query string (?badgeId=game_time)
    let badgeId: unknown
    try {
      const body = await request.json()
      badgeId = (body as Record<string, unknown>)?.badgeId
    } catch {
      badgeId = request.nextUrl.searchParams.get('badgeId')
    }
    const badge = findBadge(badgeId)
    if (!badge) {
      return NextResponse.json(
        { success: false, error: 'Unknown badgeId.', code: 'BADGE_NOT_FOUND' },
        { status: 404 }
      )
    }

    // Stop the running task AND clear the completion — one action for both.
    const taskBefore = await getTask(userId, badge.id)
    await cancelTask(userId, badge.id)

    return NextResponse.json({
      success: true,
      badgeId: badge.id,
      badgeName: badge.name,
      cleared: true,
      wasRunning: taskBefore?.status === 'running',
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[BADGES COMPLETE API] delete error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
