import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission, getApiKeyToken } from '@/lib/api-keys'
import { startQuest, getSessionStatus } from '@/lib/quest-engine'

// POST /api/v1/quests/:id/start — start quest via verified direct-API method
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: questId } = await params

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

    if (!hasPermission(keyData, 'quests:start')) {
      return NextResponse.json(
        { error: 'Requires quests:start permission', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    const token = getApiKeyToken(apiKey)
    if (!token) {
      return NextResponse.json(
        { error: 'Session expired. Re-authenticate.', code: 'SESSION_EXPIRED' },
        { status: 401 }
      )
    }

    const result = await startQuest(token, questId, keyData.user.id)

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.message,
        code: 'START_FAILED'
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      sessionId: result.sessionId,
      message: result.message,
      technicalDetails: {
        method: 'Direct Discord REST API (verified heartbeat)',
        engine: 'quest-engine v3',
        noBrowser: true,
      },
      endpoints: {
        status: `/api/v1/quests/${questId}/status?session=${result.sessionId}`,
        cancel: `/api/v1/quests/${questId}/cancel?session=${result.sessionId}`,
      },
    })
  } catch (error) {
    console.error('[V1 QUEST START] Error:', error)
    return NextResponse.json(
      { error: 'Failed to start quest', code: 'START_ERROR', details: String(error) },
      { status: 500 }
    )
  }
}

// GET /api/v1/quests/:id/start?session=xxx — poll status
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = request.nextUrl.searchParams.get('session')
  if (!session) {
    return NextResponse.json({ error: 'session query param required' }, { status: 400 })
  }
  const status = getSessionStatus(session)
  if (!status) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, session: status })
}
