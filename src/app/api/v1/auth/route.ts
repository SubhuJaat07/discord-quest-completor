import { NextRequest, NextResponse } from 'next/server'
import { 
  isValidTokenFormat, 
  createSession, 
  setSessionCookies,
  getSessionUser,
  getSessionToken 
} from '@/lib/session'
import { createApiKey, verifyApiKey, getApiStats } from '@/lib/api-keys'
import { verifyTokenDetailed } from '@/lib/quest-engine'

// POST /api/v1/auth - Create session + API key using Discord token
export async function POST(request: NextRequest) {
  try {
    // Check for API key in headers (for re-authentication)
    const existingKey = request.headers.get('x-api-key')
    
    if (existingKey) {
      const keyCheck = verifyApiKey(existingKey)
      
      if (typeof keyCheck !== 'object' || 'error' in keyCheck) {
        return NextResponse.json(
          { error: 'Invalid or expired API key', code: 'INVALID_API_KEY' },
          { status: 401 }
        )
      }
      
      // Return existing session info
      return NextResponse.json({
        success: true,
        apiKey: existingKey,
        user: keyCheck.user,
        permissions: keyCheck.permissions,
        usage: {
          totalRequests: keyCheck.usageCount,
          lastUsed: new Date(keyCheck.lastUsedAt).toISOString()
        },
        stats: getApiStats(),
        message: 'API key is valid',
        endpoint: '/api/v1/quests',
        documentation: 'See README.md for API usage'
      })
    }

    // New authentication with Discord token
    const body = await request.json()
    const { token, appName, permissions } = body

    if (!token || typeof token !== 'string') {
      return NextResponse.json(
        { error: 'Discord token is required', code: 'TOKEN_REQUIRED' },
        { status: 400 }
      )
    }

    const trimmedToken = token.trim()

    if (!isValidTokenFormat(trimmedToken)) {
      return NextResponse.json(
        { error: 'Invalid Discord token format. Expected user token (base64.base64.base64)', code: 'INVALID_TOKEN_FORMAT' },
        { status: 400 }
      )
    }

    // Verify token via the engine (respects DISCORD_API_BASE, rate-limit aware)
    let userInfo
    try {
      const verification = await verifyTokenDetailed(trimmedToken)

      if (!verification.ok) {
        const errorMap: Record<number, { error: string; code: string }> = {
          401: { error: 'Token verification failed', code: 'AUTH_FAILED' },
          403: { error: 'Token blocked or account locked', code: 'TOKEN_BLOCKED' },
          429: { error: 'Rate limited by Discord', code: 'RATE_LIMITED' }
        }

        const errorInfo = errorMap[verification.status] || { 
          error: `Discord API error: ${verification.status}`, 
          code: 'DISCORD_ERROR' 
        }

        return NextResponse.json(errorInfo, { status: verification.status })
      }

      userInfo = verification.user
    } catch (error) {
      console.error('[V1 AUTH] Discord API error:', error)
      return NextResponse.json(
        { error: 'Failed to connect to Discord servers', code: 'CONNECTION_ERROR' },
        { status: 502 }
      )
    }

    // Create session
    const sessionId = createSession(trimmedToken, {
      username: userInfo.username,
      discriminator: userInfo.discriminator,
      avatar: userInfo.avatar,
      id: userInfo.id
    })

    // CRITICAL: Set cookies so token persists across restarts!
    await setSessionCookies(sessionId, trimmedToken, {
      username: userInfo.username,
      discriminator: userInfo.discriminator,
      avatar: userInfo.avatar,
      id: userInfo.id
    })

    console.log(`[V1 AUTH] Session ${sessionId} created and cookies set for user ${userInfo.username}`)

    // Create API key
    const apiKeyData = createApiKey(sessionId, {
      username: userInfo.username,
      discriminator: userInfo.discriminator,
      id: userInfo.id
    }, {
      name: appName || `External App (${new Date().toISOString().split('T')[0]})`,
      permissions: permissions || undefined // Use all default permissions
    })

    if (!apiKeyData) {
      return NextResponse.json(
        { error: 'Failed to create API key. Max keys per session reached.', code: 'KEY_LIMIT_REACHED' },
        { status: 429 }
      )
    }

    // Return success with API key
    return NextResponse.json({
      success: true,
      sessionId,
      apiKey: apiKeyData.key,
      user: {
        username: userInfo.username,
        discriminator: userInfo.discriminator,
        id: userInfo.id,
        avatar: userInfo.avatar ? `https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}` : null
      },
      permissions: apiKeyData.permissions,
      rateLimit: {
        requestsPerMinute: 30,
        windowSeconds: 60
      },
      endpoints: {
        quests: '/api/v1/quests',
        questStart: '/api/v1/quests/:id/start',
        questStatus: '/api/v1/quests/:id/status',
        questCancel: '/api/v1/quests/:id/cancel',
        userInfo: '/api/v1/user',
        manageKeys: '/api/v1/keys'
      },
      message: 'Authentication successful! Use the API key for subsequent requests.',
      documentation: 'Add "x-api-key: YOUR_KEY" header to all requests',
      expiresIn: '7 days',
      stats: getApiStats()
    })

  } catch (error) {
    console.error('[V1 AUTH] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}

// GET /api/v1/auth - Check auth status with API key
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key')
    
    if (!apiKey) {
      return NextResponse.json({
        authenticated: false,
        message: 'Provide x-api-key header or POST your Discord token',
        endpoints: {
          authenticate: 'POST /api/v1/auth',
          documentation: 'See README.md'
        }
      })
    }

    const keyCheck = verifyApiKey(apiKey)
    
    if (typeof keyCheck === 'object' && !('error' in keyCheck)) {
      return NextResponse.json({
        authenticated: true,
        user: keyCheck.user,
        permissions: keyCheck.permissions,
        usage: {
          totalRequests: keyCheck.usageCount,
          lastUsed: new Date(keyCheck.lastUsedAt).toISOString(),
          created: new Date(keyCheck.createdAt).toISOString()
        },
        rateLimit: {
          remaining: Math.max(0, 30 - keyCheck.requestsThisMinute),
          resetAt: new Date(keyCheck.rateLimitReset).toISOString()
        },
        stats: getApiStats()
      })
    } else {
      return NextResponse.json(
        { 
          authenticated: false, 
          error: (keyCheck as any).error,
          code: (keyCheck as any).code || 'AUTH_FAILED'
        },
        { status: (keyCheck as any).status || 401 }
      )
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
