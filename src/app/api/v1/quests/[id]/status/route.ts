import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission } from '@/lib/api-keys'
import { getSessionStatus, listActiveSessions } from '@/lib/quest-engine'

// GET /api/v1/quests/:id/status — quest completion status (direct API engine)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: questId } = await params
    const sessionParam = request.nextUrl.searchParams.get('session')

    // Verify API key
    const apiKey = request.headers.get('x-api-key')
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key required', code: 'API_KEY_REQUIRED' },
        { status: 401 }
      )
    }

    const keyCheck = verifyApiKey(apiKey)
    if (typeof keyCheck === 'object' && 'error' in keyCheck) {
      return NextResponse.json(keyCheck as any, { status: (keyCheck as any).status })
    }

    const keyData = keyCheck as NonNullable<typeof keyCheck>

    if (!hasPermission(keyData, 'quests:status')) {
      return NextResponse.json(
        { error: 'Requires quests:status permission', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    // If specific session requested
    if (sessionParam) {
      const status = getSessionStatus(sessionParam)
      if (!status) {
        return NextResponse.json({
          success: true,
          status: 'session_expired',
          message: 'Session not found or has expired',
          sessionParam,
          suggestions: [
            'Session may have completed or been cancelled',
            'Start a new quest using POST /api/v1/quests/:id/start',
          ],
        })
      }
      return NextResponse.json({
        success: true,
        status: status.status,
        questId,
        progress: {
          percent: status.percent,
          currentValue: status.progress,
          target: status.target,
          beats: status.beats,
          completed: status.status === 'completed',
        },
        session: status,
      })
    }

    // Otherwise list active sessions for this quest
    const all = listActiveSessions().filter((s: any) => s.questId === questId)
    return NextResponse.json({
      success: true,
      questId,
      activeSessions: all.length,
      sessions: all,
    })
  } catch (error) {
    console.error('[V1 QUEST STATUS] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get status', code: 'STATUS_ERROR' },
      { status: 500 }
    )
  }
}
