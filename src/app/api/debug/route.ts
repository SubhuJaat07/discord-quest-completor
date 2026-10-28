import { NextRequest, NextResponse } from 'next/server'
import { getSessionStatus, listActiveSessions } from '@/lib/quest-engine'
import { getSchemaStatus, databaseConfigured } from '@/lib/db-init'
import { supabaseConfigured as restConfigured } from '@/lib/state-store'

// GET /api/debug — engine debugging info
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    if (!sessionId) {
      const sessions = listActiveSessions()
      // v3.9.0: ready-event bootstrap status (private build) — lets you
      // verify from the browser whether the auto table-create ran.
      const schema = getSchemaStatus()
      return NextResponse.json({
        debug: true,
        engine: 'quest-engine v3 (direct REST API)',
        timestamp: new Date().toISOString(),
        activeSessionsCount: sessions.length,
        sessions,
        database: {
          autoInitConfigured: databaseConfigured(),
          supabaseRestConfigured: restConfigured(),
          schema: schema
            ? {
                status: schema.status,
                via: schema.via, // 'postgres' (DATABASE_URL) | 'rpc' (exec_sql, cutiee pattern) | 'off'
                tables: schema.tables,
                durationMs: schema.durationMs,
                error: schema.error ?? null,
                bootId: schema.bootId,
              }
            : 'not run yet (ready event pending or this is a warm worker)',
        },
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
