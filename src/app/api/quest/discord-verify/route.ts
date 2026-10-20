import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken } from '@/lib/session'
import { listQuests, getSessionStatus } from '@/lib/quest-engine'

/**
 * REAL Discord Quest Progress Verification
 *
 * Queries Discord's own /quests/@me endpoint (the CORRECT endpoint —
 * /users/@me/quests returns 404) and reports server-verified progress.
 *
 * GET /api/quest/discord-verify?questId=xxx[&sessionId=yyy]
 */
export async function GET(request: NextRequest) {
  try {
    const questId = request.nextUrl.searchParams.get('questId')
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    const token = await getSessionToken()

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated', code: 'NOT_AUTHENTICATED', hint: 'Login with /api/token first' },
        { status: 401 }
      )
    }

    let quests
    try {
      quests = await listQuests(token)
    } catch (e: any) {
      return NextResponse.json(
        { error: `Discord API error: ${e.message}`, code: 'DISCORD_API_ERROR' },
        { status: 502 }
      )
    }

    const session = sessionId ? getSessionStatus(sessionId) : null

    if (!questId) {
      return NextResponse.json({
        success: true,
        verified: true,
        totalQuests: quests.length,
        quests: quests.map((q) => ({
          id: q.id,
          name: q.name,
          status: q.status,
          progress: q.progressSeconds,
          target: q.targetSeconds,
          method: q.method,
        })),
      })
    }

    const quest = quests.find((q) => q.id === questId)
    if (!quest) {
      return NextResponse.json(
        { error: `Quest ${questId} not found`, code: 'QUEST_NOT_FOUND' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      verified: true,
      quest: {
        id: quest.id,
        name: quest.name,
        gameName: quest.gameName,
        status: quest.status,
        taskType: quest.taskType,
        method: quest.method,
      },
      progress: {
        value: quest.progressSeconds,
        target: quest.targetSeconds,
        percent: Math.min(100, Math.round((quest.progressSeconds / Math.max(quest.targetSeconds, 1)) * 10000) / 100),
        completed: quest.completed,
        claimed: quest.claimed,
      },
      session: session
        ? {
            status: session.status,
            engineProgress: session.progress,
            beats: session.beats,
          }
        : null,
      message: quest.completed
        ? '✅ Discord confirms this quest is COMPLETED'
        : `Discord-verified progress: ${quest.progressSeconds}/${quest.targetSeconds}`,
    })
  } catch (error) {
    console.error('[DISCORD VERIFY] Error:', error)
    return NextResponse.json(
      { error: 'Verification failed', code: 'VERIFY_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}
