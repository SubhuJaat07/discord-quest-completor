import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey, hasPermission, getApiKeyToken } from '@/lib/api-keys'

// GET /api/v1/quests - List all available quests
export async function GET(request: NextRequest) {
  try {
    // Verify API key
    const apiKey = request.headers.get('x-api-key')
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key required. Add x-api-key header.', code: 'API_KEY_REQUIRED' },
        { status: 401 }
      )
    }

    const keyCheck = verifyApiKey(apiKey)
    
    if (typeof keyCheck === 'object' && 'error' in keyCheck) {
      return NextResponse.json(keyCheck as any, { status: (keyCheck as any).status })
    }

    const keyData = keyCheck as NonNullable<typeof keyCheck>

    // Check permission
    if (!hasPermission(keyData, 'quests:read')) {
      return NextResponse.json(
        { error: 'Insufficient permissions. Requires quests:read', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    // Get Discord token
    const token = getApiKeyToken(apiKey)
    if (!token) {
      return NextResponse.json(
        { error: 'Session expired. Re-authenticate with POST /api/v1/auth', code: 'SESSION_EXPIRED' },
        { status: 401 }
      )
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const filter = searchParams.get('filter') || 'all' // all | available | completed | expired
    const includeRaw = searchParams.get('raw') === 'true'

    // Fetch quests from Discord
    const questsRes = await fetch('https://discord.com/api/v10/quests/@me', {
      headers: { 
        'Authorization': token,
        'User-Agent': 'DiscordQuestAPI/1.0'
      }
    })

    if (!questsRes.ok) {
      console.error('[V1 QUESTS] Discord error:', questsRes.status)
      return NextResponse.json({
        success: false,
        error: `Discord API error: ${questsRes.status}`,
        code: 'DISCORD_ERROR'
      }, { status: 502 })
    }

    const questsData = await questsRes.json()
    const rawQuests = questsData.quests || []
    const now = new Date()

    // Process quests
    const processedQuests = rawQuests.map((quest: any) => {
      const config = quest.config || {}
      const messages = config.messages || {}
      const application = config.application || {}
      const taskConfig = config.task_config_v2 || {}
      const tasks = taskConfig.tasks || {}
      const userStatus = quest.user_status || {}

      const expiresAt = new Date(config.expires_at)
      const startsAt = new Date(config.starts_at)

      let status: string = 'available'
      const isExpired = now > expiresAt
      
      // Progress tracking - FIXED LOGIC
      const progressSeconds = userStatus.stream_progress_seconds || 0
      const taskEntry = Object.entries(tasks)[0] || ['UNKNOWN', {}]
      const [, taskDetails] = taskEntry
      const targetSeconds = (taskDetails as any)?.target || 900
      const hasProgress = progressSeconds > 0
      const isProgressComplete = progressSeconds >= targetSeconds
      
      // CORRECT completion detection (same fix as main endpoint)
      const claimedReward = userStatus.is_claimed === true
      const hasRealCompletionTimestamp = userStatus.completed_at && 
                                        userStatus.completed_at > 0 && 
                                        typeof userStatus.completed_at === 'number' &&
                                        userStatus.completed_at > 1000000000000
      const isCompleted = claimedReward || (hasRealCompletionTimestamp && isProgressComplete)

      if (isCompleted) status = 'completed'
      else if (isExpired) status = 'expired'
      else if (hasProgress) status = 'in_progress'
      else status = 'available'

      const [taskType] = taskEntry

      return {
        id: quest.id,
        name: messages.quest_name || application.name || 'Unknown Quest',
        description: `${application.name} - ${messages.game_publisher || 'Unknown Publisher'}`,
        status,
        publisher: messages.game_publisher || 'Unknown',
        gameName: application.name || 'Unknown Game',
        appId: application.id,
        
        // Progress info
        progress: Math.round(Math.min((progressSeconds / targetSeconds) * 100, 100)),
        progressSeconds,
        targetSeconds,
        remainingSeconds: Math.max(0, targetSeconds - progressSeconds),
        totalTimeMinutes: Math.ceil(targetSeconds / 60),
        
        // Dates
        startsAt: config.starts_at,
        expiresAt: config.expires_at,
        enrolledAt: userStatus.enrolled_at,
        completedAt: userStatus.completed_at,
        claimedAt: userStatus.claimed_at,
        isClaimed: userStatus.is_claimed || false,
        
        // Assets
        heroImage: config.assets?.hero 
          ? `https://cdn.discordapp.com/quest-assets/${config.assets.hero}` 
          : null,
        gameTile: config.assets?.game_tile 
          ? `https://cdn.discordapp.com/quest-assets/${config.assets.game_tile}` 
          : null,
        gameIcon: application.id 
          ? `https://cdn.discordapp.com/app-icons/${application.id}/icon.png?size=64` 
          : null,
          
        // Colors & Rewards
        primaryColor: config.colors?.primary || '#5865F2',
        reward: extractReward(config.features),
        taskType,
        
        // Actions
        canComplete: !isExpired && !isCompleted && status !== 'completed',
        actions: {
          start: `/api/v1/quests/${quest.id}/start`,
          status: `/api/v1/quests/${quest.id}/status`
        },

        // Include raw data if requested
        ...(includeRaw ? { _raw: quest } : {})
      }
    })

    // Apply filters
    let filteredQuests = processedQuests
    if (filter !== 'all') {
      filteredQuests = processedQuests.filter((q: any) => q.status === filter)
    }

    // Sort by status priority
    const statusOrder: Record<string, number> = { 
      'available': 0, 'in_progress': 1, 'completed': 2, 'expired': 3 
    }
    filteredQuests.sort((a: any, b: any) => 
      (statusOrder[a.status] || 4) - (statusOrder[b.status] || 4)
    )

    // Summary
    const summary = {
      total: processedQuests.length,
      available: processedQuests.filter((q: any) => q.status === 'available').length,
      inProgress: processedQuests.filter((q: any) => q.status === 'in_progress').length,
      completed: processedQuests.filter((q: any) => q.status === 'completed').length,
      expired: processedQuests.filter((q: any) => q.status === 'expired').length
    }

    return NextResponse.json({
      success: true,
      quests: filteredQuests,
      summary,
      fetchedAt: now.toISOString(),
      filterApplied: filter,
      pagination: {
        page: 1,
        perPage: filteredQuests.length,
        total: filteredQuests.length,
        totalPages: 1
      },
      message: `Found ${filteredQuests.length} quests (${summary.available} available)`
    })

  } catch (error) {
    console.error('[V1 QUESTS] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch quests', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}

// Helper to extract reward info
function extractReward(features?: number[]): string {
  if (!features?.length) return 'Rewards'
  
  if (features.includes(15)) return '⊙ 700 Orbs + Profile Decoration'
  if (features.includes(7)) return '⊙ 200 Orbs'
  if (features.includes(3)) return '⊙ 100 Orbs'
  
  return 'Orbs Reward'
}
