import { NextResponse } from 'next/server'
import { listActiveSessions } from '@/lib/quest-engine'

// GET /api/health — health check (no browser dependencies)
export async function GET() {
  const startTime = Date.now()

  try {
    const sessions = listActiveSessions()

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      engine: 'direct-api',
      browserRequired: false,
      sessions: {
        active: sessions.length,
      },
      system: {
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        error: String(error),
      },
      { status: 500 }
    )
  }
}
