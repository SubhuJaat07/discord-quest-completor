import { NextRequest, NextResponse } from 'next/server'
import { getSessionStatus, listActiveSessions, listActiveQueues, formatClock } from '@/lib/quest-engine'
import { getSessionToken, getSessionUser } from '@/lib/session'

// GET /api/quest/status?sessionId=xxx — poll ONE quest session (live timer data)
// GET /api/quest/status — restore: list MY active sessions + queues (for tab-reopen)
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    // ---- Restore mode: no sessionId → return this user's active engine state ----
    if (!sessionId) {
      const token = await getSessionToken()
      if (!token) {
        return NextResponse.json(
          { error: 'Not authenticated', code: 'NOT_AUTHENTICATED' },
          { status: 401 }
        )
      }
      const user = await getSessionUser()
      return NextResponse.json({
        success: true,
        activeSessions: listActiveSessions(user?.id),
        activeQueues: listActiveQueues(user?.id),
        message: 'Server-side engine state for this account — restored on page load.',
      })
    }

    const status = getSessionStatus(sessionId)

    if (!status) {
      return NextResponse.json(
        {
          success: false,
          error: 'Session not found or expired',
          code: 'NOT_FOUND',
          suggestions: ['Session may have completed or been cancelled'],
        },
        { status: 404 }
      )
    }

    const remaining = Math.max(0, status.target - status.progress)

    return NextResponse.json({
      success: true,
      status: status.status,
      method: '⚡ Direct Discord REST API (verified heartbeat method)',

      quest: {
        questId: status.questId,
        questName: status.questName,
        gameName: status.gameName,
        appId: status.appId,
      },

      progress: {
        percent: status.percent,
        source: 'DISCORD_API_REAL',
        elapsedSeconds: status.elapsedSeconds,
        remainingSeconds: remaining,
        totalRequired: status.target,
        currentValue: status.progress,
        beats: status.beats,
        completed: status.status === 'completed',
        completedAt: status.completedAt,
        // Formatted MM:SS fields (the UI timer uses these + its own 1s ticker)
        elapsedFormatted: formatClock(status.elapsedSeconds),
        remainingFormatted: formatClock(remaining),
        totalFormatted: formatClock(status.target),
      },

      engine: {
        method: status.method,
        taskType: status.taskType,
        streamKey: status.streamKey,
        beatsSent: status.beats,
        lastBeatAt: status.lastBeatAt,
      },

      timing: {
        startedAt: status.startedAt,
        currentTime: new Date().toISOString(),
      },

      actions: {
        cancel: `/api/quest/cancel?sessionId=${sessionId}`,
        refresh: `/api/quest/status?sessionId=${sessionId}`,
      },

      logs: status.logs,

      message: status.status === 'completed'
        ? '🎉 Quest completed! Claim your reward in Discord.'
        : `⏳ ${status.percent}% — heartbeats running, server-verified progress.`,
    })
  } catch (error) {
    console.error('[QUEST STATUS] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get status', code: 'STATUS_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}
