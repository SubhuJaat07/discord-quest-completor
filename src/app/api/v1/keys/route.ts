import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission, listApiKeysForSession, revokeApiKey, revokeAllKeysForSession, createApiKey } from '@/lib/api-keys'

// GET /api/v1/keys - List API keys for current session
export async function GET(request: NextRequest) {
  try {
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

    // List all keys for this session
    const keys = listApiKeysForSession(keyData.sessionId)

    return NextResponse.json({
      success: true,
      keys: keys.map(k => ({
        name: k.name,
        created: new Date(k.createdAt).toISOString(),
        lastUsed: new Date(k.lastUsedAt).toISOString(),
        totalRequests: k.usageCount,
        permissions: k.permissions,
        isActive: k.isActive
      })),
      total: keys.length,
      active: keys.filter(k => k.isActive).length,
      maxKeysPerSession: 5,
      message: 'API keys for your session'
    })

  } catch (error) {
    console.error('[V1 KEYS GET] Error:', error)
    return NextResponse.json(
      { error: 'Failed to list keys', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}

// POST /api/v1/keys - Create new API key
export async function POST(request: NextRequest) {
  try {
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

    const body = await request.json()
    const { name, permissions } = body

    // Create new key
    const newKey = createApiKey(keyData.sessionId, keyData.user, {
      name: name || `Key (${new Date().toISOString().split('T')[0]})`,
      permissions: permissions || undefined
    })

    if (!newKey) {
      return NextResponse.json(
        { error: 'Max API keys reached (5 per session)', code: 'LIMIT_REACHED' },
        { status: 429 }
      )
    }

    return NextResponse.json({
      success: true,
      apiKey: newKey.key,
      name: newKey.name,
      permissions: newKey.permissions,
      created: new Date(newKey.createdAt).toISOString(),
      expiresIn: '7 days',
      warning: 'Save this key securely. It will not be shown again.',
      message: 'New API key created successfully'
    })

  } catch (error) {
    console.error('[V1 KEYS POST] Error:', error)
    return NextResponse.json(
      { error: 'Failed to create key', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}

// DELETE /api/v1/keys - Revoke an API key
export async function DELETE(request: NextRequest) {
  try {
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

    const { searchParams } = new URL(request.url)
    const keyToRevoke = searchParams.get('key')
    const revokeAll = searchParams.get('all') === 'true'

    if (revokeAll) {
      // Revoke all keys for this session
      const count = revokeAllKeysForSession(keyData.sessionId)
      return NextResponse.json({
        success: true,
        revokedCount: count,
        message: `Revoked ${count} API keys`
      })
    }

    if (!keyToRevoke) {
      return NextResponse.json(
        { error: 'Specify ?key=KEY_TO_REVOKE or ?all=true', code: 'MISSING_PARAM' },
        { status: 400 }
      )
    }

    // Revoke specific key
    const success = revokeApiKey(keyToRevoke, keyData.sessionId)

    if (!success) {
      return NextResponse.json(
        { error: 'Key not found or does not belong to your session', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      revoked: keyToRevoke.substring(0, 12) + '...',
      message: 'API key revoked successfully'
    })

  } catch (error) {
    console.error('[V1 KEYS DELETE] Error:', error)
    return NextResponse.json(
      { error: 'Failed to revoke key', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
