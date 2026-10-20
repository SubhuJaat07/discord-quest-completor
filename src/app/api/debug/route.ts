import { NextRequest, NextResponse } from 'next/server'
import { getSessionStatus, listActiveSessions } from '@/lib/quest-engine'
import { getSessionToken } from '@/lib/session'

// GET /api/debug — engine debugging info
//
// SECURITY (v3.5.1):
//   1. Disabled by default — returns 404 like a non-existent route unless
//      DEBUG_ENABLED=true is explicitly set in the environment.
//   2. When enabled, requests must be authenticated (login cookies) —
//      otherwise 401.
//   3. Optional extra lock: set DEBUG_KEY=<secret> and send header
//      'x-debug-key: <secret>' with every request.
//   4. Responses NEVER include tokens or cookie values — only non-secret
//      engine state (quest names, progress, timings, engine logs).
export async function GET(request: NextRequest) {
  // Layer 1 — off by default
  if (process.env.DEBUG_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // Layer 2 — optional shared secret
  const debugKey = process.env.DEBUG_KEY
  if (debugKey && request.headers.get('x-debug-key') !== debugKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Layer 3 — must be a logged-in user
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Not authenticated. Login first.' }, { status: 401 })
  }

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
