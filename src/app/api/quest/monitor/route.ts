import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken, getSessionUser } from '@/lib/session'
import {
  enableMonitor,
  disableMonitor,
  clearMonitor,
  getMonitorStatus,
  runMonitorCycle,
  updateMonitorToken,
} from '@/lib/monitor'

export const dynamic = 'force-dynamic'

// ============================================================
// GET /api/quest/monitor — monitor status (next run, history)
// Also silently refreshes the stored token when the same user
// logs in again with a newer one.
// ============================================================
export async function GET() {
  try {
    const token = await getSessionToken()
    const user = await getSessionUser()
    if (!token || !user) {
      return NextResponse.json(
        { error: 'Not authenticated. Login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    // Keep the monitor's token fresh if the user re-logged-in
    updateMonitorToken(token, user.id)

    return NextResponse.json({
      success: true,
      monitor: getMonitorStatus(),
    })
  } catch (error) {
    console.error('[MONITOR STATUS] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get monitor status', code: 'MONITOR_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// ============================================================
// POST /api/quest/monitor
//   { enabled: true,  intervalHours?: 24 }  → enable (default 24h)
//   { enabled: false }                       → disable
//   { runNow: true }                         → trigger a cycle right now
// ============================================================
export async function POST(request: NextRequest) {
  try {
    const token = await getSessionToken()
    const user = await getSessionUser()
    if (!token || !user) {
      return NextResponse.json(
        { error: 'Not authenticated. Login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const intervalHours = Number(body.intervalHours) || undefined

    // --- Trigger an immediate cycle (fire-and-forget; watch GET for results) ---
    if (body.runNow) {
      const status = getMonitorStatus() as any
      if (!status.enabled) {
        return NextResponse.json(
          { success: false, error: 'Monitor is OFF — enable it first.', code: 'MONITOR_DISABLED' },
          { status: 400 }
        )
      }
      if (status.currentlyRunning) {
        return NextResponse.json({
          success: true,
          message: 'A monitor cycle is already running right now.',
          monitor: getMonitorStatus(),
        })
      }
      void runMonitorCycle('manual')
      return NextResponse.json({
        success: true,
        message: '🫡 Monitor cycle started — fetching quests & completing them now. Watch the history below.',
        monitor: getMonitorStatus(),
      })
    }

    // --- Enable ---
    if (body.enabled === true) {
      const result = await enableMonitor(token, { id: user.id, username: user.username }, intervalHours)
      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.message, code: 'MONITOR_ENABLE_FAILED' },
          { status: 400 }
        )
      }
      return NextResponse.json({
        success: true,
        message: result.message,
        monitor: getMonitorStatus(),
      })
    }

    // --- Disable ---
    if (body.enabled === false) {
      const ok = disableMonitor()
      return NextResponse.json({
        success: ok,
        message: ok
          ? 'Monitor OFF — automatic 24h checks stopped. (Quests started by earlier cycles keep running.)'
          : 'Monitor was already OFF.',
        monitor: getMonitorStatus(),
      })
    }

    return NextResponse.json(
      { error: 'Nothing to do. Use { enabled: true|false } or { runNow: true }.', code: 'BAD_REQUEST' },
      { status: 400 }
    )
  } catch (error) {
    console.error('[MONITOR POST] Error:', error)
    return NextResponse.json(
      { error: 'Monitor operation failed', code: 'MONITOR_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// ============================================================
// DELETE /api/quest/monitor — full wipe (disable + clear history)
// ============================================================
export async function DELETE() {
  try {
    const token = await getSessionToken()
    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated. Login first.', code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }
    clearMonitor()
    return NextResponse.json({
      success: true,
      message: 'Monitor wiped — disabled, history cleared, token removed from disk.',
      monitor: getMonitorStatus(),
    })
  } catch (error) {
    console.error('[MONITOR DELETE] Error:', error)
    return NextResponse.json(
      { error: 'Failed to wipe monitor', code: 'MONITOR_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}
