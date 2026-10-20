import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken, getSessionUser } from '@/lib/session'
import { startQuest, getSessionStatus, cancelSession, getSession, formatClock } from '@/lib/quest-engine'

// ============================================================
// POST /api/quest/start  — start a quest via the VERIFIED direct-API method
// Body: { questId: string }
// ============================================================
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const questId: string | undefined = body.questId

    const sessionToken = await getSessionToken()
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Not authenticated. Login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json(
        { error: 'Session expired. Login again.', code: 'SESSION_EXPIRED' },
        { status: 401 }
      )
    }

    if (!questId) {
      return NextResponse.json(
        { error: 'questId is required', code: 'QUEST_ID_REQUIRED' },
        { status: 400 }
      )
    }

    const result = await startQuest(sessionToken, questId, user.id)

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.message, code: 'START_ERROR' },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      sessionId: result.sessionId,
      method: '⚡ Direct Discord REST API (verified heartbeat method)',
      message: result.message,
      questDetails: {
        questId,
        gameName: result.session?.gameName,
        taskType: result.session?.taskType,
        targetSeconds: result.session?.target,
      },
      endpoints: {
        status: `/api/quest/status?sessionId=${result.sessionId}`,
        cancel: `/api/quest/cancel?sessionId=${result.sessionId}`,
        verifyDiscord: `/api/quest/discord-verify?questId=${questId}`,
      },
      importantNotes: [
        '✅ Progress is REAL server-side progress from Discord (progress.<task>.value)',
        '✅ Heartbeats are credited full elapsed time (verified live)',
        '✅ When target reached, a terminal beat completes the quest automatically',
        '🎁 Reward claiming may need a captcha — claim inside Discord app/web if so',
      ],
    })
  } catch (error) {
    console.error('[QUEST START] Error:', error)
    return NextResponse.json(
      { error: 'Failed to start quest', code: 'START_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// ============================================================
// GET /api/quest/start?sessionId=xxx — poll session status
// ============================================================
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId parameter required', code: 'SESSION_ID_REQUIRED' },
      { status: 400 }
    )
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
      completed: status.status === 'completed',
      completedAt: status.completedAt,
      elapsedFormatted: formatClock(status.elapsedSeconds),
      remainingFormatted: formatClock(remaining),
      totalFormatted: formatClock(status.target),
    },
    session: status,
    timing: {
      startedAt: status.startedAt,
      currentTime: new Date().toISOString(),
    },
    actions: {
      cancel: `/api/quest/cancel?sessionId=${sessionId}`,
      refresh: `/api/quest/status?sessionId=${sessionId}`,
    },
    message: statusMessage(status.status, status.percent),
  })
}

// ============================================================
// DELETE /api/quest/start?sessionId=xxx — cancel session
// ============================================================
export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId parameter required', code: 'SESSION_ID_REQUIRED' },
      { status: 400 }
    )
  }

  const existing = getSession(sessionId)
  if (!existing) {
    return NextResponse.json(
      { error: 'Session not found', code: 'NOT_FOUND' },
      { status: 404 }
    )
  }

  cancelSession(sessionId)
  return NextResponse.json({
    success: true,
    status: 'cancelled',
    message: '🛑 Quest session stopped.',
  })
}

function statusMessage(status: string, percent: number): string {
  switch (status) {
    case 'completed': return '🎉 Quest completed! Claim your reward in Discord.'
    case 'running': return `⏳ Heartbeats active — ${percent}% done (server-verified).`
    case 'starting': return '🚀 Starting quest session...'
    case 'enrolling': return '📝 Enrolling quest...'
    case 'completing': return '🎯 Target reached — finalizing...'
    case 'error': return '❌ Session error — check logs.'
    case 'cancelled': return '🛑 Cancelled.'
    default: return `Status: ${status}`
  }
}
