import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken } from '@/lib/session'
import { listQuests } from '@/lib/quest-engine'

// Fetch REAL Discord Quests from Discord's actual endpoint
// GET /api/quests
export async function GET(request: NextRequest) {
  try {
    const token = await getSessionToken()

    if (!token) {
      return NextResponse.json({
        success: false,
        error: 'Not authenticated. Please login first.',
        code: 'NOT_AUTHENTICATED'
      }, { status: 401 })
    }

    let quests
    try {
      // Uses the CORRECT endpoint: /quests/@me (the old /users/@me/quests → 404)
      quests = await listQuests(token)
    } catch (e: any) {
      console.error('[QUESTS API] Discord error:', e.message)
      return NextResponse.json({
        success: true,
        quests: [],
        error: `Discord API error: ${e.message}`,
        message: 'Unable to fetch quests from Discord. Check your token or login again.',
        code: 'DISCORD_API_ERROR'
      })
    }

    const now = new Date()

    // Map to the frontend's expected shape (with FIXED status logic)
    const processedQuests = quests.map((q) => {
      const progressPercent = Math.min((q.progressSeconds / Math.max(q.targetSeconds, 1)) * 100, 100)
      return {
        id: q.id,
        name: q.name,
        description: `${q.gameName}`,
        status: q.status,
        reward: q.rewardName || 'Quest Reward',
        progress: Math.round(progressPercent),
        totalTime: Math.ceil(q.targetSeconds / 60),
        gameName: q.gameName,
        gameIcon: q.appId ? `https://cdn.discordapp.com/app-icons/${q.appId}/icon.png?size=64` : '🎮',
        appId: q.appId,
        isReal: true,
        canComplete: !q.expired && !q.completed && q.supported,
        supported: q.supported,
        engineMethod: q.method,

        // Real data (FIXED fields)
        taskType: q.taskType,
        taskTargetSeconds: q.targetSeconds,
        progressSeconds: q.progressSeconds,
        remainingSeconds: Math.max(0, q.targetSeconds - q.progressSeconds),
        startsAt: q.startedAt,
        expiresAt: q.expiresAt,
        isExpired: q.expired,
        isCompleted: q.completed,
        isClaimed: q.claimed,
        enrolled: q.enrolled,
        enrolledAt: null,
        completedAt: null,
      }
    })
      .filter((q) => !q.isExpired || q.isCompleted)
      .sort((a, b) => {
        const order: Record<string, number> = { available: 0, enrolled: 1, in_progress: 2, completed: 3, claimed: 4, expired: 5 }
        return (order[a.status] ?? 6) - (order[b.status] ?? 6)
      })

    const summary = {
      total: processedQuests.length,
      available: processedQuests.filter((q) => q.status === 'available' || q.status === 'enrolled').length,
      inProgress: processedQuests.filter((q) => q.status === 'in_progress').length,
      completed: processedQuests.filter((q) => q.status === 'completed' || q.status === 'claimed').length,
      expired: processedQuests.filter((q) => q.status === 'expired').length
    }

    return NextResponse.json({
      success: true,
      quests: processedQuests,
      summary,
      fetchedAt: now.toISOString(),
      message: `Found ${processedQuests.length} quests (${summary.available} available, ${summary.completed} completed)`,
      method: '⚡ Direct Discord REST API'
    })

  } catch (error) {
    console.error('[QUESTS API Error]', error)
    return NextResponse.json({
      success: false,
      quests: [],
      error: process.env.NODE_ENV === 'development' ? String(error) : undefined,
      message: 'Unable to fetch quests. Please try again.'
    })
  }
}
