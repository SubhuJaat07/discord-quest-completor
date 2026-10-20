import { NextRequest, NextResponse } from 'next/server'
import { cancelSession, getSession } from '@/lib/quest-engine'

// DELETE /api/quest/cancel?sessionId=xxx
export async function DELETE(request: NextRequest) {
  try {
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

    const cancelled = cancelSession(sessionId)
    if (!cancelled) {
      return NextResponse.json(
        { error: 'Failed to cancel', code: 'CANCEL_FAILED' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      status: 'cancelled',
      message: '🛑 Quest session stopped. Server-side progress is preserved — you can resume anytime.',
      cancelledSession: {
        sessionId,
        gameName: existing.gameName,
        progress: `${existing.progress}/${existing.target}`,
      },
    })
  } catch (error) {
    console.error('[QUEST CANCEL] Error:', error)
    return NextResponse.json(
      { error: 'Failed to cancel', code: 'CANCEL_ERROR' },
      { status: 500 }
    )
  }
}
