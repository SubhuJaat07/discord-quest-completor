import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken, getSessionUser } from '@/lib/session'
import {
  startQuestQueue,
  getQueueStatus,
  cancelQueue,
  listActiveQueues,
} from '@/lib/quest-engine'

// ============================================================
// POST /api/quest/start-all — queue ALL completable quests
// Runs sequentially (one after another), server-side,
// auto-accepting (enrolling) each quest when its turn comes.
// Works even if you close the browser tab.
// ============================================================
export async function POST(request: NextRequest) {
  try {
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

    const result = await startQuestQueue(sessionToken, user.id)

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.message, code: 'QUEUE_ERROR' },
        { status: 400 }
      )
    }

    const queueId = result.queueId!
    return NextResponse.json({
      success: true,
      queueId,
      queuedCount: result.queue?.items.length ?? 0,
      quests: result.queue?.items ?? [],
      message: result.message,
      endpoints: {
        status: `/api/quest/start-all?queueId=${queueId}`,
        cancel: `/api/quest/start-all?queueId=${queueId}`,
      },
      importantNotes: [
        '✅ Quests run ONE AFTER ANOTHER on the server — close this tab freely, the queue keeps going',
        '📝 Each quest is auto-accepted (enrolled) when its turn comes',
        '⏱️ Progress is real server-verified time — a 15-min quest takes ~15 min',
        '🔁 Come back to this page anytime to see live queue progress (auto-restored)',
      ],
    })
  } catch (error) {
    console.error('[QUEST QUEUE START] Error:', error)
    return NextResponse.json(
      { error: 'Failed to start queue', code: 'QUEUE_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// ============================================================
// GET /api/quest/start-all?queueId=xxx — poll queue status
// GET /api/quest/start-all (no queueId) — list MY running queues (restore)
// ============================================================
export async function GET(request: NextRequest) {
  try {
    const queueId = request.nextUrl.searchParams.get('queueId')

    // Restore mode: list active queues for the logged-in user
    if (!queueId) {
      const user = await getSessionUser()
      if (!user) {
        return NextResponse.json(
          { error: 'Not authenticated', code: 'NOT_AUTHENTICATED' },
          { status: 401 }
        )
      }
      return NextResponse.json({
        success: true,
        activeQueues: listActiveQueues(user.id),
      })
    }

    const status = getQueueStatus(queueId)
    if (!status) {
      return NextResponse.json(
        {
          success: false,
          error: 'Queue not found or expired',
          code: 'NOT_FOUND',
          suggestions: ['The queue may have finished, been cancelled, or the server restarted'],
        },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      ...status,
      message: queueMessage(status),
    })
  } catch (error) {
    console.error('[QUEST QUEUE STATUS] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get queue status', code: 'QUEUE_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// ============================================================
// DELETE /api/quest/start-all?queueId=xxx — cancel queue + current quest
// ============================================================
export async function DELETE(request: NextRequest) {
  try {
    const queueId = request.nextUrl.searchParams.get('queueId')
    if (!queueId) {
      return NextResponse.json(
        { error: 'queueId parameter required', code: 'QUEUE_ID_REQUIRED' },
        { status: 400 }
      )
    }

    const cancelled = cancelQueue(queueId)
    if (!cancelled) {
      return NextResponse.json(
        { error: 'Queue not found', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }

    const status = getQueueStatus(queueId)
    return NextResponse.json({
      success: true,
      status: 'cancelled',
      message: '🛑 Queue cancelled. The current quest was stopped; pending quests were not started.',
      completedCount: status?.completedCount ?? 0,
      pendingCount: status?.pendingCount ?? 0,
    })
  } catch (error) {
    console.error('[QUEST QUEUE CANCEL] Error:', error)
    return NextResponse.json(
      { error: 'Failed to cancel queue', code: 'QUEUE_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

function queueMessage(status: any): string {
  switch (status.status) {
    case 'running':
      return status.current
        ? `⏳ Running "${status.current.questName}" — ${status.current.percent}% (${status.current.formattedRemaining} left). ${status.pendingCount} more after this.`
        : `⏳ Queue running — starting next quest... (${status.pendingCount} pending)`
    case 'completed':
      return `🎉 Queue finished! ${status.completedCount} completed, ${status.failedCount} failed.`
    case 'cancelled':
      return `🛑 Queue cancelled — ${status.completedCount} completed before stopping.`
    case 'error':
      return `❌ Queue ended with errors — ${status.failedCount} failed. Check logs.`
    default:
      return `Status: ${status.status}`
  }
}
