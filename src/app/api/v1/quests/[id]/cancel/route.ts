import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission } from '@/lib/api-keys'
import { cancelSession, getSession, listActiveSessions } from '@/lib/quest-engine'

// DELETE /api/v1/quests/:id/cancel — cancel active quest session
export async function DELETE(
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

    if (!hasPermission(keyData, 'quests:cancel')) {
      return NextResponse.json(
        { error: 'Requires quests:cancel permission', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    // If specific session ID provided, cancel that exact session
    if (sessionParam) {
      const existing = getSession(sessionParam)
      if (!existing) {
        return NextResponse.json(
          { error: 'Session not found or already expired', code: 'SESSION_NOT_FOUND' },
          { status: 404 }
        )
      }
      if (existing.userId !== keyData.user.id) {
        return NextResponse.json(
          { error: 'You can only cancel your own sessions', code: 'FORBIDDEN' },
          { status: 403 }
        )
      }

      const progress = `${existing.progress}/${existing.target}`
      cancelSession(sessionParam)

      return NextResponse.json({
        success: true,
        status: 'cancelled',
        message: 'Quest session stopped. Server-side progress is preserved.',
        cancelledSession: { sessionId: sessionParam, questId, progress },
      })
    }

    // Otherwise cancel ALL active sessions for this quest owned by this user
    const mine = listActiveSessions().filter(
      (s: any) => s.questId === questId
    )
    let cancelled = 0
    for (const s of mine) {
      const existing = getSession(s.id)
      if (existing && existing.userId === keyData.user.id) {
        cancelSession(s.id)
        cancelled++
      }
    }

    return NextResponse.json({
      success: true,
      status: 'cancelled',
      message: `Cancelled ${cancelled} session(s) for quest ${questId}`,
    })
  } catch (error) {
    console.error('[V1 QUEST CANCEL] Error:', error)
    return NextResponse.json(
      { error: 'Failed to cancel', code: 'CANCEL_ERROR' },
      { status: 500 }
    )
  }
}
