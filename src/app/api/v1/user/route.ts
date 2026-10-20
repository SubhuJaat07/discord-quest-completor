import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission, listApiKeysForSession } from '@/lib/api-keys'

// GET /api/v1/user - Get authenticated user info
export async function GET(request: NextRequest) {
  try {
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

    // Check permission
    if (!hasPermission(keyData, 'user:read')) {
      return NextResponse.json(
        { error: 'Requires user:read permission', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    // Return user info
    return NextResponse.json({
      success: true,
      user: {
        id: keyData.user.id,
        username: keyData.user.username,
        discriminator: keyData.user.discriminator,
        avatar: keyData.user.avatar 
          ? `https://cdn.discordapp.com/avatars/${keyData.user.id}/${keyData.user.avatar}`
          : null,
        tag: `${keyData.user.username}#${keyData.user.discriminator}`
      },
      apiKey: {
        name: keyData.name,
        created: new Date(keyData.createdAt).toISOString(),
        lastUsed: new Date(keyData.lastUsedAt).toISOString(),
        totalRequests: keyData.usageCount,
        permissions: keyData.permissions,
        isActive: keyData.isActive
      },
      rateLimit: {
        remaining: Math.max(0, 30 - keyData.requestsThisMinute),
        resetAt: new Date(keyData.rateLimitReset).toISOString(),
        limit: 30
      },
      endpoints: {
        quests: '/api/v1/quests',
        manageKeys: '/api/v1/keys',
        docs: 'https://github.com/your-repo/discord-quest-api#documentation'
      }
    })

  } catch (error) {
    console.error('[V1 USER] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get user info', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
