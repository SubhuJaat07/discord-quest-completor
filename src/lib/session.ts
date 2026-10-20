// Session & Token Management Utilities
// Cookie-based persistent authentication
// Survives redeloys - token stored securely in httpOnly cookie

import { cookies } from 'next/headers'

export interface SessionData {
  token: string
  user: {
    username: string
    discriminator: string
    avatar?: string
    id: string
  }
  createdAt: number
}

// In-memory storage for sessions (backup)
const sessions = new Map<string, SessionData>()

// Cookie name for session
const SESSION_COOKIE_NAME = 'dqt_session'
const TOKEN_COOKIE_NAME = 'dqt_token'

// Generate a random session ID
export function generateSessionId(): string {
  return 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
}

// Validate Discord token format (basic check)
export function isValidTokenFormat(token: string): boolean {
  const trimmed = token.trim()
  const parts = trimmed.split('.')
  if (parts.length !== 3) return false
  
  const [userId, timestamp, hmac] = parts
  
  return (
    userId.length >= 15 &&
    timestamp.length >= 6 &&
    hmac.length >= 6 &&
    /^[a-zA-Z0-9_\-]+$/.test(userId) &&
    /^[a-zA-Z0-9]+$/.test(timestamp) &&
    /^[a-zA-Z0-9_\-]+$/.test(hmac)
  )
}

// Create a new session AND set cookies
export function createSession(token: string, user: SessionData['user']): string {
  const sessionId = generateSessionId()
  
  // Store in memory
  sessions.set(sessionId, {
    token,
    user,
    createdAt: Date.now()
  })

  console.log(`[SESSION] Created session ${sessionId} for user ${user.username}`)

  cleanupOldSessions()

  return sessionId
}

// Get session from request (reads cookies automatically)
export async function getSessionFromRequest(): Promise<{ sessionId: string; token: string } | null> {
  try {
    const cookieStore = await cookies()
    
    // Try to get session ID from cookie first
    const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value
    
    if (sessionId) {
      // Look up in memory first
      const session = sessions.get(sessionId)
      if (session && Date.now() - session.createdAt < 86400000) { // 24 hours
        return { sessionId, token: session.token }
      }
      
      // If not in memory but we have token cookie, restore session
      const tokenCookie = cookieStore.get(TOKEN_COOKIE_NAME)?.value
      if (tokenCookie) {
        // Restore session to memory
        sessions.set(sessionId, {
          token: tokenCookie,
          user: { username: 'Restored', discriminator: '0', id: 'unknown' },
          createdAt: Date.now()
        })
        return { sessionId, token: tokenCookie }
      }
    }

    // Fallback: try direct token cookie
    const directToken = cookieStore.get(TOKEN_COOKIE_NAME)?.value
    if (directToken) {
      return { sessionId: 'cookie_token', token: directToken }
    }

    return null
  } catch (error) {
    console.error('[SESSION] Error reading cookies:', error)
    return null
  }
}

// Get token from session (now reads from cookies!)
export async function getSessionToken(): Promise<string | null> {
  const session = await getSessionFromRequest()
  return session?.token || null
}

// Get user info from session
export async function getSessionUser(): Promise<SessionData['user'] | null> {
  try {
    const cookieStore = await cookies()
    const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value
    
    if (sessionId) {
      const session = sessions.get(sessionId)
      if (session && Date.now() - session.createdAt < 86400000) {
        return session.user
      }
    }
    
    return null
  } catch {
    return null
  }
}

// Set session cookies (call this after login)
export async function setSessionCookies(sessionId: string, token: string, user: SessionData['user']): Promise<void> {
  try {
    const cookieStore = await cookies()
    
    // Set session ID cookie (httpOnly for security)
    cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400 * 7, // 7 days
      path: '/'
    })
    
    // Set token cookie (also httpOnly) - encrypted would be better but this works
    cookieStore.set(TOKEN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400 * 7, // 7 days
      path: '/'
    })

    // Store in memory too
    sessions.set(sessionId, { token, user, createdAt: Date.now() })
    
    console.log(`[SESSION] Cookies set for session ${sessionId}`)
  } catch (error) {
    console.error('[SESSION] Error setting cookies:', error)
  }
}

// Clear session (logout)
export async function clearSession(): Promise<void> {
  try {
    const cookieStore = await cookies()
    const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value
    
    if (sessionId) {
      sessions.delete(sessionId)
    }
    
    cookieStore.delete(SESSION_COOKIE_NAME)
    cookieStore.delete(TOKEN_COOKIE_NAME)
    
    console.log('[SESSION] Session cleared')
  } catch (error) {
    console.error('[SESSION] Error clearing session:', error)
  }
}

// Delete/clear a session by ID
export function deleteSession(sessionId: string): boolean {
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId)
    return true
  }
  return false
}

// Cleanup old sessions (older than 24 hours)
function cleanupOldSessions() {
  const now = Date.now()
  const maxAge = 86400000 // 24 hours
  
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > maxAge) {
      sessions.delete(id)
    }
  }
}

// Export for use in API routes
export { SESSION_COOKIE_NAME, TOKEN_COOKIE_NAME }
