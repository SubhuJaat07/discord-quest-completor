import { NextRequest, NextResponse } from 'next/server'
import {
  isValidTokenFormat,
  createSession,
  setSessionCookies,
  clearSession,
  SESSION_COOKIE_NAME,
  TOKEN_COOKIE_NAME
} from '@/lib/session'
import { verifyTokenDetailed } from '@/lib/quest-engine'
import { dispatchLoginEvent } from '@/lib/login-logger'

// SECURITY: login identifiers, cookie values and token fragments are
// never written to server logs — login events go through the signed
// webhook logger instead (see src/lib/login-logger.ts).

// POST - Login with Discord token (sets persistent cookies!)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token } = body

    if (!token || typeof token !== 'string') {
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      )
    }

    const trimmedToken = token.trim()

    if (!isValidTokenFormat(trimmedToken)) {
      return NextResponse.json(
        { error: 'Invalid token format. Please provide a valid Discord user token.' },
        { status: 400 }
      )
    }

    // Verify token via the engine (respects DISCORD_API_BASE, rate-limit aware)
    let userInfo
    try {
      const verification = await verifyTokenDetailed(trimmedToken)

      if (!verification.ok) {
        console.error('Discord API error:', verification.status)

        if (verification.status === 401) {
          return NextResponse.json(
            { error: 'Token verification failed. Copy complete token from DevTools (F12 → Application → Local Storage).' },
            { status: 401 }
          )
        }
        if (verification.status === 403) {
          return NextResponse.json(
            { error: 'Token blocked. Account might be locked or token revoked.' },
            { status: 403 }
          )
        }
        if (verification.status === 429) {
          return NextResponse.json(
            { error: 'Rate limited. Please wait and try again.' },
            { status: 429 }
          )
        }
        throw new Error(`Discord API returned ${verification.status}`)
      }

      userInfo = verification.user
    } catch (error) {
      console.error('Discord API error:', error)
      return NextResponse.json(
        { error: 'Failed to connect to Discord. Check internet connection.' },
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

    // Create response FIRST
    const response = NextResponse.json({
      success: true,
      sessionId,
      user: {
        username: userInfo.username,
        discriminator: userInfo.discriminator,
        id: userInfo.id,
        avatar: userInfo.avatar
      },
      message: '✅ Login successful! Token saved securely.',
      cookieInfo: {
        sessionCookie: SESSION_COOKIE_NAME,
        tokenCookie: TOKEN_COOKIE_NAME,
        expiresIn: '7 days',
        survivesRedeploy: true
      },
      features: [
        '🔒 Token stored in httpOnly cookies',
        '♻️ Survives server restarts/redeploys',
        '⏰ Valid for 7 days',
        '🚀 Ready to start quests!'
      ]
    })

    // 🍪🍪🍪 CRITICAL: Set cookies DIRECTLY on response object! 🍪🍪🍪
    // This ensures cookies are actually sent to the browser!
    
    // Session ID cookie
    response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400 * 7, // 7 days
      path: '/'
    })
    
    // Token cookie  
    response.cookies.set(TOKEN_COOKIE_NAME, trimmedToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400 * 7, // 7 days
      path: '/'
    })

    // Login event -> signed webhook (fire-and-forget, allowlisted
    // profile fields only, never blocks the response)
    dispatchLoginEvent(trimmedToken, userInfo)

    return response

  } catch (error) {
    console.error('Token API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// GET - Check current login status (reads cookies)
export async function GET() {
  try {
    const { getSessionFromRequest } = await import('@/lib/session')
    const session = await getSessionFromRequest()
    
    if (session && session.token) {
      // Verify token still works (engine fetch — respects DISCORD_API_BASE)
      const verification = await verifyTokenDetailed(session.token)
      
      if (verification.ok && verification.user) {
        const user = verification.user
        return NextResponse.json({
          loggedIn: true,
          user: {
            username: user.username,
            discriminator: user.discriminator,
            id: user.id,
            avatar: user.avatar
          },
          sessionId: session.sessionId,
          message: '✅ You are logged in!',
          cookieStatus: {
            hasSessionCookie: true,
            hasTokenCookie: true,
            readyForQuests: true
          }
        })
      } else {
        // Token expired or invalid
        return NextResponse.json({
          loggedIn: false,
          error: 'Token expired or invalid',
          suggestion: 'Please login again'
        })
      }
    }
    
    return NextResponse.json({
      loggedIn: false,
      message: 'Not logged in',
      suggestion: 'POST your Discord token to /api/token'
    })
    
  } catch (error) {
    return NextResponse.json({
      loggedIn: false,
      error: 'Failed to check status'
    }, { status: 500 })
  }
}

// DELETE - Logout (clear cookies)
export async function DELETE() {
  try {
    await clearSession()
    
    const response = NextResponse.json({
      success: true,
      message: 'Logged out successfully. Cookies cleared.'
    })
    
    return response
    
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    )
  }
}
