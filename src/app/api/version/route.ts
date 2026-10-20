import { NextResponse } from 'next/server'

// Version tracking - v3.1.0
const VERSION_INFO = {
  version: "3.1.0", // Live timers + Start-All queue + tab-safe restore
  buildNumber: "007",
  buildDate: new Date().toISOString(),
  codename: "ServerQueue",

  features: [
    "⚡ Direct Discord REST API engine (no browser, no Puppeteer)",
    "🛡️ 100% server-side — quests keep running after you close the tab",
    "⏱️ LIVE real-time timers (elapsed counts up, remaining counts down every second)",
    "🚀 Start All — queues every completable quest and runs them ONE BY ONE",
    "📝 Auto-accept — unaccepted quests are enrolled automatically when their turn comes",
    "🔄 Session/queue restore — reopen the page and reattach to running quests",
    "✅ Only server-verified progress from Discord's own heartbeat API",
    "🍪 Persistent cookie-based auth (7-day sessions)"
  ],

  criticalFixes: [
    "✅ FIXED: UI timer never moved (API didn't return the formatted fields the UI read)",
    "✅ FIXED: closing the tab appeared to stop quests (no UI restore existed — engine was always server-side)",
    "✅ FIXED: enrolled/in-progress quests showed 'Unavailable' instead of a Complete/Resume button",
    "✅ FIXED: hardcoded 15:00 total — now uses each quest's real target time"
  ],

  howItWorksNow: [
    "1. Login with your Discord token (verified via /users/@me)",
    "2. Start one quest or Start All (sequential queue, auto-accept)",
    "3. Server sends heartbeats every 90s — Discord credits full elapsed time",
    "4. UI polls /api/quest/status every 3s and ticks the timer every 1s",
    "5. Progress is Discord-verified; quest completes at the real target time",
    "6. Close the tab freely — reopen to reattach to live progress"
  ],

  endpoints: {
    startQuest: "/api/quest/start",
    startAllQueue: "/api/quest/start-all", // NEW! POST start, GET status, DELETE cancel
    questStatus: "/api/quest/status?sessionId=xxx",
    restoreState: "/api/quest/status", // NEW! GET without sessionId → active sessions + queues
    cancelQuest: "/api/quest/cancel?sessionId=xxx",
    verifyDiscord: "/api/quest/discord-verify?questId=xxx",
    tokenAuth: "/api/token",
    version: "/api/version"
  },

  changelog: {
    "1.0.0": "Initial release + cookie persistence fix",
    "2.0.0": "Real Discord API verification, no more fake progress",
    "3.0.0": "VERIFIED direct REST API method — no browser needed",
    "3.1.0": "🚀 Live timers + Start-All sequential queue + auto-accept + tab-close-proof restore"
  },

  disclaimer: "Progress shown is real, Discord-verified time. A 15-min quest takes ~15 min of server time — that's Discord's server-side rule, not a bug."
}

// GET /api/version - Check deployed version
export async function GET() {
  return NextResponse.json({
    ...VERSION_INFO,
    environment: process.env.NODE_ENV || 'development',
    deploymentUrl: process.env.RAILWAY_PUBLIC_URL || 'local',
    status: 'active',
    message: `Discord Quest Tool v${VERSION_INFO.version} (Build ${VERSION_INFO.buildNumber}) - ${VERSION_INFO.codename}`,

    importantNotice: {
      title: "🚀 WHAT'S NEW IN v3.1.0",
      details: [
        "Timer now counts down LIVE every second (was frozen at 15:00 before)",
        "Start All button: queues all quests, runs one-by-one with auto-accept",
        "Quests are 100% server-side — closing the tab does NOT stop them",
        "Reopen the page anytime: running quest/queue is restored automatically"
      ]
    }
  })
}
