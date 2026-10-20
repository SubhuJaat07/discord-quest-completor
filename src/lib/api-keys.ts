// API Key Management System for External Access
// Allows third-party apps to use our API without exposing Discord tokens

export interface ApiKeyData {
  key: string
  sessionId: string // Linked Discord session
  user: {
    username: string
    discriminator: string
    id: string
  }
  createdAt: number
  lastUsedAt: number
  usageCount: number
  rateLimitReset: number
  requestsThisMinute: number
  isActive: boolean
  name?: string // Optional label for the API key
  permissions: ApiPermission[]
}

export type ApiPermission = 
  | 'quests:read'      // View quests
  | 'quests:start'     // Start quest completion
  | 'quests:cancel'    // Cancel active quest
  | 'quests:status'    // Get quest status
  | 'user:read'        // Read user info
  | 'admin:manage'     // Manage API keys (future)

export const ALL_PERMISSIONS: ApiPermission[] = [
  'quests:read',
  'quests:start',
  'quests:cancel',
  'quests:status',
  'user:read'
]

// In-memory storage for API keys
const apiKeys = new Map<string, ApiKeyData>()

// Rate limiting configuration
const RATE_LIMIT = {
  requestsPerMinute: 30,
  windowMs: 60000, // 1 minute
  maxKeysPerSession: 5
}

// Generate a secure API key
export function generateApiKey(): string {
  const prefix = 'dqt_' // Discord Quest Tool prefix
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `${prefix}${randomPart}`
}

// Validate API key format
export function isValidApiKeyFormat(key: string): boolean {
  return /^dqt_[a-f0-9]{64}$/.test(key)
}

// Create new API key linked to a session
export function createApiKey(
  sessionId: string,
  user: ApiKeyData['user'],
  options?: { name?: string; permissions?: ApiPermission[] }
): ApiKeyData | null {
  // Check if session exists and is valid
  const { getSessionUser } = require('./session')
  const sessionUser = getSessionUser(sessionId)
  
  if (!sessionUser) {
    return null // Invalid session
  }

  // Limit keys per session
  let keyCount = 0
  for (const [, keyData] of apiKeys.entries()) {
    if (keyData.sessionId === sessionId && keyData.isActive) {
      keyCount++
    }
  }

  if (keyCount >= RATE_LIMIT.maxKeysPerSession) {
    return null // Max keys reached
  }

  const apiKey = generateApiKey()
  
  const keyData: ApiKeyData = {
    key: apiKey,
    sessionId,
    user,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    usageCount: 0,
    rateLimitReset: Date.now() + RATE_LIMIT.windowMs,
    requestsThisMinute: 0,
    isActive: true,
    name: options?.name || `API Key (${new Date().toISOString().split('T')[0]})`,
    permissions: options?.permissions || ALL_PERMISSIONS
  }

  apiKeys.set(apiKey, keyData)
  
  console.log(`[API KEY] Created new key for user ${user.username}: ${apiKey.substring(0, 12)}...`)
  
  return keyData
}

// Verify API key and check rate limits
export function verifyApiKey(key: string): ApiKeyData | { error: string; status: number } {
  if (!key || !isValidApiKeyFormat(key)) {
    return { error: 'Invalid API key format', status: 401 }
  }

  const keyData = apiKeys.get(key)
  
  if (!keyData || !keyData.isActive) {
    return { error: 'API key not found or inactive', status: 401 }
  }

  // Check if key is expired (7 days max lifetime)
  const maxAge = 7 * 24 * 60 * 60 * 1000
  if (Date.now() - keyData.createdAt > maxAge) {
    keyData.isActive = false
    return { error: 'API key expired. Please generate a new one.', status: 401 }
  }

  // Rate limiting check
  const now = Date.now()
  if (now > keyData.rateLimitReset) {
    // Reset rate limit window
    keyData.rateLimitReset = now + RATE_LIMIT.windowMs
    keyData.requestsThisMinute = 1
  } else if (keyData.requestsThisMinute >= RATE_LIMIT.requestsPerMinute) {
    return { 
      error: 'Rate limit exceeded. Please wait before making more requests.', 
      status: 429,
      retryAfter: Math.ceil((keyData.rateLimitReset - now) / 1000)
    }
  } else {
    keyData.requestsThisMinute++
  }

  // Update usage stats
  keyData.lastUsedAt = now
  keyData.usageCount++

  return keyData
}

// Get Discord token from API key
export function getApiKeyToken(key: string): string | null {
  const keyData = apiKeys.get(key)
  if (!keyData || !keyData.isActive) return null
  
  const { getSessionToken } = require('./session')
  return getSessionToken(keyData.sessionId)
}

// Get API key info
export function getApiKeyInfo(key: string): ApiKeyData | null {
  return apiKeys.get(key) || null
}

// List all API keys for a session
export function listApiKeysForSession(sessionId: string): Omit<ApiKeyData, 'key'>[] {
  const keys: Omit<ApiKeyData, 'key'>[] = []
  
  for (const [, keyData] of apiKeys.entries()) {
    if (keyData.sessionId === sessionId) {
      const { key, ...safeData } = keyData
      keys.push(safeData)
    }
  }
  
  return keys
}

// Revoke an API key
export function revokeApiKey(key: string, sessionId: string): boolean {
  const keyData = apiKeys.get(key)
  
  if (!keyData || keyData.sessionId !== sessionId) {
    return false
  }
  
  keyData.isActive = false
  console.log(`[API KEY] Revoked key: ${key.substring(0, 12)}...`)
  
  return true
}

// Revoke all keys for a session
export function revokeAllKeysForSession(sessionId: string): number {
  let count = 0
  
  for (const [key, keyData] of apiKeys.entries()) {
    if (keyData.sessionId === sessionId && keyData.isActive) {
      keyData.isActive = false
      count++
    }
  }
  
  console.log(`[API KEY] Revoked ${count} keys for session ${sessionId}`)
  return count
}

// Cleanup old/inactive keys (run periodically)
export function cleanupOldKeys(): void {
  const now = Date.now()
  const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
  
  for (const [key, keyData] of apiKeys.entries()) {
    const age = now - keyData.createdAt
    
    // Remove if older than 7 days or inactive for 24 hours
    if (age > maxAge || (!keyData.isActive && age > 86400000)) {
      apiKeys.delete(key)
    }
  }
}

// Check if API key has specific permission
export function hasPermission(
  keyData: ApiKeyData, 
  permission: ApiPermission
): boolean {
  return keyData.permissions.includes(permission) || keyData.permissions.includes('admin:manage')
}

// Export stats for monitoring
export function getApiStats(): {
  totalKeys: number
  activeKeys: number
  totalRequestsToday: number
  keysCreatedToday: number
} {
  const now = Date.now()
  const todayStart = new Date().setHours(0, 0, 0, 0)
  
  let totalRequests = 0
  let createdToday = 0
  
  for (const [, keyData] of apiKeys.entries()) {
    totalRequests += keyData.usageCount
    if (keyData.createdAt >= todayStart) {
      createdToday++
    }
  }
  
  return {
    totalKeys: apiKeys.size,
    activeKeys: Array.from(apiKeys.values()).filter(k => k.isActive).length,
    totalRequestsToday: totalRequests,
    keysCreatedToday: createdToday
  }
}
