import { NextRequest, NextResponse } from 'next/server'
import { getSessionStatus, listActiveSessions } from '@/lib/quest-engine'

// GET /api/debug — engine debugging info
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    if (!sessionId) {
      const sessions = listActiveSessions()
      return NextResponse.json({
        debug: true,
        engine: 'quest-engine v3 (direct REST API)',
        timestamp: new Date().toISOString(),
        activeSessionsCount: sessions.length,
        sessions,
      })
    }

    const status = getSessionStatus(sessionId)
    if (!status) {
      return NextResponse.json(
        { debug: true, error: 'Session not found', sessionId },
        { status: 404 }
      )
    }

    return NextResponse.json({
      debug: true,
      session: status,
      logs: status.logs,
    })
  } catch (error) {
    return NextResponse.json(
      { debug: true, error: String(error) },
      { status: 500 }
    )
  }
}
