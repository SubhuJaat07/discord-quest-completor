'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Play, RefreshCw, Eye, EyeOff, LogOut } from 'lucide-react'
import { SiteFooter } from '@/components/site-footer'
import { ThemeToggle } from '@/components/theme-toggle'

interface DiscordQuest {
  id: string
  name: string
  description: string
  status: 'available' | 'enrolled' | 'in_progress' | 'completed' | 'claimed' | 'expired'
  reward?: string
  progress?: number
  totalTime?: number
  gameName: string
  gameIcon?: string
  appId?: string
  isReal?: boolean
  canComplete?: boolean
}

interface UserInfo {
  username: string
  discriminator: string
  avatar?: string
  id: string
}

interface QuestStatus {
  id: string
  questId: string
  appName: string
  status: 'initializing' | 'detecting' | 'running' | 'completing' | 'completed' | 'failed' | 'cancelled'
  phase: string
  progress: number
  elapsedSeconds: number
  remainingSeconds: number
  totalSeconds: number
  snapshotAt: number
}

interface QueueSessionStatus {
  id: string
  questId: string
  questName: string
  gameName: string
  status: string
  percent: number
  remainingSeconds: number
  elapsedSeconds: number
  target: number
}

interface QueueStatus {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  total: number
  completedCount: number
  failedCount: number
  pendingCount: number
  current: QueueSessionStatus | null
  completed: Array<{ questId: string; name: string; gameName: string }>
  failed: Array<{ questId: string; name: string; gameName: string; error?: string }>
  pending: Array<{ questId: string; name: string; gameName: string }>
  snapshotAt: number
}

interface MonitorStatusUI {
  enabled: boolean
  intervalHours: number
  nextRunAt: string | null
  lastRunAt: string | null
  currentlyRunning: boolean
  fetchedAt: number
}

type AppState = 'idle' | 'authenticating' | 'fetching_quests' | 'ready' | 'starting_quest' | 'quest_active' | 'queue_active'

const LS_SESSION_KEY = 'dqt_active_session'
const LS_QUEUE_KEY = 'dqt_active_queue'

/** Map a server session snapshot to the UI QuestStatus shape */
function snapshotToQuestStatus(s: any): QuestStatus {
  return {
    id: s.id,
    questId: s.questId,
    appName: s.gameName || s.questName,
    status: s.status === 'running' ? 'running'
      : s.status === 'completing' ? 'completing'
      : s.status === 'completed' ? 'completed'
      : s.status === 'error' ? 'failed'
      : s.status === 'cancelled' ? 'cancelled'
      : 'initializing',
    phase: s.status,
    progress: s.percent ?? 0,
    elapsedSeconds: s.elapsedSeconds ?? 0,
    remainingSeconds: s.remainingSeconds ?? (s.target ?? 900),
    totalSeconds: s.target ?? 900,
    snapshotAt: Date.now(),
  }
}

export default function Home() {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [appState, setAppState] = useState<AppState>('idle')
  const [quests, setQuests] = useState<DiscordQuest[]>([])
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [activeQuestId, setActiveQuestId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Real-time quest status (server snapshots + 1s client interpolation)
  const [questStatus, setQuestStatus] = useState<QuestStatus | null>(null)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  // Sequential queue (Start All)
  const [queueId, setQueueId] = useState<string | null>(null)
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null)
  const queuePollingRef = useRef<NodeJS.Timeout | null>(null)

  // 24h auto-complete monitor
  const [monitorInfo, setMonitorInfo] = useState<MonitorStatusUI | null>(null)
  const [monitorBusy, setMonitorBusy] = useState(false)
  const monitorPollRef = useRef<NodeJS.Timeout | null>(null)

  // 1-second ticker — re-renders so the % counts up in real time between polls
  const [, setTick] = useState(0)

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
      if (queuePollingRef.current) clearInterval(queuePollingRef.current)
      if (monitorPollRef.current) clearInterval(monitorPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (appState !== 'quest_active' && appState !== 'queue_active') return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [appState])

  // Fetch available quests (uses cookies for auth)
  const fetchQuests = useCallback(async () => {
    setAppState('fetching_quests')

    try {
      const response = await fetch('/api/quests')
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch quests')
      }

      if (!data.success && data.code === 'NOT_AUTHENTICATED') {
        throw new Error('Session expired. Please login again.')
      }

      setQuests(data.quests || [])
      setAppState('ready')

      if (data.message && data.quests.length === 0) {
        setError(data.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch quests')
      setAppState('ready')
    }
  }, [])

  // Auto-login: restore session from cookies on page load
  useEffect(() => {
    const checkExistingSession = async () => {
      try {
        const response = await fetch('/api/token', { method: 'GET' })
        const data = await response.json()

        if (data.loggedIn && data.user) {
          setUserInfo(data.user)
          await fetchQuests()
          await restoreEngineState()
        }
      } catch (err) {
        console.error('[Session] Error checking session:', err)
      }
    }

    if (appState === 'idle') {
      checkExistingSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Reattach UI to any server-side running session or queue (tab reopen support) */
  const restoreEngineState = useCallback(async () => {
    try {
      const response = await fetch('/api/quest/status')
      if (!response.ok) return
      const data = await response.json()
      if (!data.success) return

      // 1) Restore a single running quest session
      const savedSessionId = typeof window !== 'undefined' ? localStorage.getItem(LS_SESSION_KEY) : null
      const active = (data.activeSessions || []).find((s: any) => s.id === savedSessionId)
      if (active) {
        setSessionId(active.id)
        setActiveQuestId(active.questId)
        setQuestStatus(snapshotToQuestStatus(active))
        setAppState('quest_active')
        setSuccessMessage('Reattached to your running quest.')
        setTimeout(() => setSuccessMessage(null), 6000)
        return
      }
      if (savedSessionId) localStorage.removeItem(LS_SESSION_KEY)

      // 2) Restore a running Start-All queue
      const savedQueueId = typeof window !== 'undefined' ? localStorage.getItem(LS_QUEUE_KEY) : null
      const activeQueue = (data.activeQueues || []).find((q: any) => q.id === savedQueueId)
      if (activeQueue) {
        setQueueId(activeQueue.id)
        setQueueStatus({ ...activeQueue, snapshotAt: Date.now() })
        setAppState('queue_active')
        setSuccessMessage('Reattached to your running quest queue.')
        setTimeout(() => setSuccessMessage(null), 6000)
        return
      }
      if (savedQueueId) localStorage.removeItem(LS_QUEUE_KEY)
    } catch (err) {
      console.error('[Restore] Error:', err)
    }
  }, [])

  // Poll quest status when active (server snapshot every 3s; the 1s ticker
  // interpolates between snapshots so the % climbs smoothly)
  useEffect(() => {
    if (appState === 'quest_active' && sessionId) {
      pollingRef.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/quest/status?sessionId=${sessionId}`)
          const data = await response.json()

          if (data.success && data.progress) {
            setQuestStatus(prev => prev ? {
              ...prev,
              progress: data.progress.percent,
              elapsedSeconds: data.progress.elapsedSeconds,
              remainingSeconds: data.progress.remainingSeconds,
              totalSeconds: data.progress.totalRequired || prev.totalSeconds,
              status: data.status === 'running' ? 'running' :
                     data.status === 'completing' ? 'completing' :
                     data.status === 'completed' ? 'completed' :
                     data.status === 'error' ? 'failed' :
                     data.status === 'cancelled' ? 'cancelled' :
                     prev.status,
              phase: data.status,
              snapshotAt: Date.now()
            } : prev)

            if (data.status === 'completed' || data.message?.includes('COMPLETE')) {
              clearInterval(pollingRef.current!)
              pollingRef.current = null
              setAppState('ready')
              setActiveQuestId(null)
              setQuestStatus(null)
              setSessionId(null)
              if (typeof window !== 'undefined') localStorage.removeItem(LS_SESSION_KEY)
              setSuccessMessage('Quest completed. Claim your reward in Discord.')

              setQuests(prevQuests =>
                prevQuests.map(q =>
                  q.id === activeQuestId
                    ? { ...q, status: 'completed' as const, progress: 100 }
                    : q
                )
              )

              fetchQuests()
              setTimeout(() => setSuccessMessage(null), 8000)
            } else if (data.status === 'error') {
              clearInterval(pollingRef.current!)
              pollingRef.current = null
              setAppState('ready')
              setActiveQuestId(null)
              setQuestStatus(null)
              setSessionId(null)
              if (typeof window !== 'undefined') localStorage.removeItem(LS_SESSION_KEY)
              setError(data.logs?.slice(-1)?.[0]?.msg || 'Quest failed. Please try again.')
            }
          } else if (!data.success && data.code === 'NOT_FOUND') {
            // Session gone (server restart / already finished) — reset UI
            clearInterval(pollingRef.current!)
            pollingRef.current = null
            setAppState('ready')
            setActiveQuestId(null)
            setQuestStatus(null)
            setSessionId(null)
            if (typeof window !== 'undefined') localStorage.removeItem(LS_SESSION_KEY)
            fetchQuests()
          }
        } catch (err) {
          console.error('Polling error:', err)
        }
      }, 3000)
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [appState, sessionId, activeQuestId, fetchQuests])

  // Poll queue status when Start-All queue is active
  useEffect(() => {
    if (appState === 'queue_active' && queueId) {
      queuePollingRef.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/quest/start-all?queueId=${queueId}`)
          const data = await response.json()

          if (data.success) {
            setQueueStatus({
              id: data.id,
              status: data.status,
              total: data.total,
              completedCount: data.completedCount,
              failedCount: data.failedCount,
              pendingCount: data.pendingCount,
              current: data.current,
              completed: data.completed || [],
              failed: data.failed || [],
              pending: data.pending || [],
              snapshotAt: Date.now(),
            })

            if (data.status !== 'running') {
              clearInterval(queuePollingRef.current!)
              queuePollingRef.current = null
              setAppState('ready')
              setQueueId(null)
              setQueueStatus(null)
              if (typeof window !== 'undefined') localStorage.removeItem(LS_QUEUE_KEY)

              if (data.status === 'completed') {
                setSuccessMessage(`Queue finished: ${data.completedCount} completed${data.failedCount ? `, ${data.failedCount} failed` : ''}.`)
              } else if (data.status === 'cancelled') {
                setError(`Queue stopped. ${data.completedCount} quest(s) were completed.`)
              } else {
                setError(`Queue ended with ${data.failedCount} failure(s).`)
              }
              fetchQuests()
              setTimeout(() => { setSuccessMessage(null); setError(null) }, 8000)
            }
          } else if (data.code === 'NOT_FOUND') {
            clearInterval(queuePollingRef.current!)
            queuePollingRef.current = null
            setAppState('ready')
            setQueueId(null)
            setQueueStatus(null)
            if (typeof window !== 'undefined') localStorage.removeItem(LS_QUEUE_KEY)
            fetchQuests()
          }
        } catch (err) {
          console.error('Queue polling error:', err)
        }
      }, 3000)
    } else {
      if (queuePollingRef.current) {
        clearInterval(queuePollingRef.current)
        queuePollingRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState, queueId])

  // Handle token submission
  const handleTokenSubmit = useCallback(async () => {
    if (!token.trim()) {
      setError('Please enter your Discord token.')
      return
    }

    setError(null)
    setSuccessMessage(null)
    setAppState('authenticating')

    try {
      const response = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed')
      }

      setUserInfo(data.user)
      setToken('')

      await fetchQuests()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authenticate')
      setAppState('idle')
    }
  }, [token])

  // Start a single quest
  const handleStartQuest = useCallback(async (questId: string) => {
    setActiveQuestId(questId)
    setAppState('starting_quest')
    setError(null)
    setSuccessMessage(null)
    setQuestStatus(null)

    try {
      const response = await fetch('/api/quest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questId })
      })

      const data = await response.json()

      if (!response.ok) {
        if (response.status === 409 && data.currentQuest) {
          setError(`A quest is already running: ${data.currentQuest.gameName}.`)
          setAppState('ready')
          setActiveQuestId(null)
          return
        }
        throw new Error(data.error || 'Failed to start quest')
      }

      const newSessionId = data.sessionId
      setSessionId(newSessionId)
      if (typeof window !== 'undefined') localStorage.setItem(LS_SESSION_KEY, newSessionId)
      setAppState('quest_active')

      const totalSeconds = data.questDetails?.targetSeconds || 900
      setQuestStatus({
        id: newSessionId,
        questId,
        appName: data.questDetails?.gameName || quests.find(q => q.id === questId)?.gameName || 'Game',
        status: 'initializing',
        phase: 'starting',
        progress: 0,
        elapsedSeconds: 0,
        remainingSeconds: totalSeconds,
        totalSeconds,
        snapshotAt: Date.now()
      })

      setSuccessMessage('Quest started.')
      setTimeout(() => setSuccessMessage(null), 6000)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start quest')
      setAppState('ready')
      setActiveQuestId(null)
    }
  }, [quests])

  // Start All: queue every completable quest — one after another, auto-accepted
  const handleStartAll = useCallback(async () => {
    setError(null)
    setSuccessMessage(null)
    setAppState('starting_quest')

    try {
      const response = await fetch('/api/quest/start-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start queue')
      }

      const newQueueId: string = data.queueId
      setQueueId(newQueueId)
      if (typeof window !== 'undefined') localStorage.setItem(LS_QUEUE_KEY, newQueueId)
      setQueueStatus({
        id: newQueueId,
        status: 'running',
        total: data.queuedCount || 0,
        completedCount: 0,
        failedCount: 0,
        pendingCount: data.queuedCount || 0,
        current: null,
        completed: [],
        failed: [],
        pending: data.quests || [],
        snapshotAt: Date.now(),
      })
      setAppState('queue_active')
      setSuccessMessage('All quests queued. They complete one by one.')
      setTimeout(() => setSuccessMessage(null), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start queue')
      setAppState('ready')
    }
  }, [])

  // Stop the running queue
  const handleCancelQueue = useCallback(async () => {
    if (!queueId) return

    try {
      const response = await fetch(`/api/quest/start-all?queueId=${queueId}`, { method: 'DELETE' })

      if (response.ok) {
        if (queuePollingRef.current) {
          clearInterval(queuePollingRef.current)
          queuePollingRef.current = null
        }
        setAppState('ready')
        setQueueId(null)
        setQueueStatus(null)
        if (typeof window !== 'undefined') localStorage.removeItem(LS_QUEUE_KEY)
        setError('Queue stopped.')
        setTimeout(() => setError(null), 6000)
      }
    } catch (err) {
      console.error('Cancel queue error:', err)
    }
  }, [queueId])

  // Cancel the active quest
  const handleCancelQuest = useCallback(async () => {
    if (!sessionId) return

    try {
      const response = await fetch(`/api/quest/cancel?sessionId=${sessionId}`, {
        method: 'DELETE'
      })

      if (response.ok) {
        if (pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = null
        }

        setAppState('ready')
        setActiveQuestId(null)
        setQuestStatus(null)
        setSessionId(null)
        if (typeof window !== 'undefined') localStorage.removeItem(LS_SESSION_KEY)
        setError('Quest cancelled.')
        setTimeout(() => setError(null), 6000)
      }
    } catch (err) {
      console.error('Cancel error:', err)
    }
  }, [sessionId])

  // ===== 24h auto-complete monitor =====
  const fetchMonitor = useCallback(async () => {
    try {
      const response = await fetch('/api/quest/monitor')
      if (!response.ok) return
      const data = await response.json()
      if (data.success && data.monitor) {
        const prevLastRun = monitorInfo?.lastRunAt
        const next: MonitorStatusUI = { ...data.monitor, fetchedAt: Date.now() }
        setMonitorInfo(next)
        if (prevLastRun && next.lastRunAt && prevLastRun !== next.lastRunAt && userInfo) {
          fetchQuests()
        }
      }
    } catch { /* silent */ }
  }, [monitorInfo?.lastRunAt, userInfo, fetchQuests])

  // Load monitor state once logged in
  useEffect(() => {
    if (userInfo) void fetchMonitor()
  }, [userInfo, fetchMonitor])

  // Poll monitor every 15s while enabled
  useEffect(() => {
    if (!monitorInfo?.enabled) {
      if (monitorPollRef.current) { clearInterval(monitorPollRef.current); monitorPollRef.current = null }
      return
    }
    monitorPollRef.current = setInterval(() => void fetchMonitor(), 15_000)
    return () => {
      if (monitorPollRef.current) { clearInterval(monitorPollRef.current); monitorPollRef.current = null }
    }
  }, [monitorInfo?.enabled, fetchMonitor])

  const handleMonitorToggle = useCallback(async (enable: boolean) => {
    setMonitorBusy(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch('/api/quest/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enable ? { enabled: true, intervalHours: 24 } : { enabled: false }),
      })
      const data = await response.json()
      if (data.success) {
        if (data.monitor) setMonitorInfo({ ...data.monitor, fetchedAt: Date.now() })
      } else {
        setError(data.error || 'Monitor operation failed')
      }
    } catch {
      setError('Monitor operation failed')
    } finally {
      setMonitorBusy(false)
    }
  }, [])

  // Logout — clear cookies server-side and reset UI
  const handleLogout = useCallback(async () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    if (queuePollingRef.current) {
      clearInterval(queuePollingRef.current)
      queuePollingRef.current = null
    }
    if (monitorPollRef.current) {
      clearInterval(monitorPollRef.current)
      monitorPollRef.current = null
    }

    try {
      await fetch('/api/token', { method: 'DELETE' })
    } catch { /* best-effort */ }

    setToken('')
    setSessionId(null)
    setUserInfo(null)
    setQuests([])
    setAppState('idle')
    setError(null)
    setActiveQuestId(null)
    setQuestStatus(null)
    setSuccessMessage(null)
    setQueueId(null)
    setQueueStatus(null)
    setMonitorInfo(null)
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LS_SESSION_KEY)
      localStorage.removeItem(LS_QUEUE_KEY)
    }
  }, [])

  // Refresh quests
  const handleRefresh = useCallback(() => {
    setError(null)
    fetchQuests()
  }, [fetchQuests])

  // ===== Live progress values (server snapshot + 1s client interpolation) =====
  const secsSinceSnapshot = questStatus
    ? Math.max(0, Math.floor((Date.now() - questStatus.snapshotAt) / 1000))
    : 0
  const livePercent = questStatus
    ? Math.min(100, (questStatus.progress ?? 0) + (secsSinceSnapshot / Math.max(1, questStatus.totalSeconds ?? 900)) * 100)
    : 0

  const qSecsSince = queueStatus
    ? Math.max(0, Math.floor((Date.now() - queueStatus.snapshotAt) / 1000))
    : 0
  const qCurrent = queueStatus?.current ?? null
  const qLivePercent = qCurrent
    ? Math.min(100, (qCurrent.percent ?? 0) + (qSecsSince / Math.max(1, qCurrent.target ?? 900)) * 100)
    : 0

  const nextRunLabel = monitorInfo?.enabled && monitorInfo.nextRunAt
    ? new Date(monitorInfo.nextRunAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null

  const avatarUrl = userInfo
    ? userInfo.avatar
      ? `https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/0.png`
    : ''

  const completableQuests = quests.filter(
    (q) => ['available', 'enrolled', 'in_progress'].includes(q.status) && q.canComplete !== false
  )

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Discord Quests" className="h-7 w-7" />
            <span className="text-[15px] font-semibold">Discord Quests</span>
          </div>

          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            {userInfo && (
              <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Account menu"
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                >
                  <Avatar className="h-8 w-8 border border-border">
                    <AvatarImage src={avatarUrl} alt={userInfo.username} />
                    <AvatarFallback className="bg-muted text-xs font-medium text-muted-foreground">
                      {userInfo.username.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel className="truncate">{userInfo.username}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-600">
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">

        {/* Login */}
        {(appState === 'idle' || appState === 'authenticating') && (
          <div className="mx-auto max-w-sm pt-16">
            <div className="flex flex-col items-center text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Discord Quests" className="h-14 w-14" />
              <h1 className="mt-4 text-xl font-semibold">Discord Quests</h1>
              <p className="mt-1 text-sm text-muted-foreground">Enter your Discord token to continue.</p>
            </div>

            <div className="mt-8 space-y-3">
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Discord token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleTokenSubmit()}
                  disabled={appState === 'authenticating'}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <Button
                className="w-full"
                onClick={handleTokenSubmit}
                disabled={appState === 'authenticating' || !token.trim()}
              >
                {appState === 'authenticating' ? 'Connecting…' : 'Connect'}
              </Button>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <p className="pt-1 text-center text-xs leading-relaxed text-muted-foreground">
                Your token never leaves your server — we never see or store it.{' '}
                <a
                  href="https://github.com/SubhuJaat07/discord-quest-completor"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                >
                  Open source
                </a>
                — inspect the code yourself.
              </p>
            </div>
          </div>
        )}

        {/* Loading quests */}
        {appState === 'fetching_quests' && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
                <Skeleton className="h-12 w-12 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-9 w-20 rounded-md" />
              </div>
            ))}
          </div>
        )}

        {/* Logged-in dashboard */}
        {(appState === 'ready' || appState === 'starting_quest' || appState === 'quest_active' || appState === 'queue_active') && userInfo && (
          <div className="space-y-5">
            {successMessage && <p className="text-sm text-green-600">{successMessage}</p>}
            {error && !successMessage && <p className="text-sm text-red-600">{error}</p>}

            {/* 1. Auto complete every 24 hours */}
            <div className="rgb-border flex items-center justify-between gap-4 rounded-lg bg-card p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Auto complete quests every 24 hours</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {monitorInfo?.enabled
                    ? monitorInfo.currentlyRunning
                      ? 'Running a check now.'
                      : nextRunLabel
                        ? `Next check: ${nextRunLabel}`
                        : 'Quests are found, accepted and completed automatically.'
                    : 'Quests are found, accepted and completed automatically.'}
                </p>
              </div>
              <Switch
                checked={!!monitorInfo?.enabled}
                disabled={monitorBusy}
                onCheckedChange={(v) => handleMonitorToggle(v)}
                aria-label="Auto complete quests every 24 hours"
              />
            </div>

            {/* 2. Start All / live progress */}
            {appState === 'queue_active' && queueStatus ? (
              <div className="rgb-border space-y-3 rounded-lg bg-card p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    Completing {Math.min(queueStatus.completedCount + (qCurrent ? 1 : 0), queueStatus.total)} of {queueStatus.total}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-600"
                    onClick={handleCancelQueue}
                  >
                    Stop
                  </Button>
                </div>
                {qCurrent ? (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-sm text-muted-foreground">{qCurrent.questName || qCurrent.gameName}</p>
                      <p className="shrink-0 text-sm font-medium tabular-nums">{Math.round(qLivePercent)}%</p>
                    </div>
                    <Progress value={qLivePercent} className="h-2" />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Starting next quest…</p>
                )}
              </div>
            ) : appState === 'quest_active' && questStatus ? (
              <div className="rgb-border space-y-3 rounded-lg bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">{questStatus.appName}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-600"
                    onClick={handleCancelQuest}
                  >
                    Cancel
                  </Button>
                </div>
                <Progress value={livePercent} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="capitalize">
                    {questStatus.status === 'running' ? 'Running' : questStatus.status}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">{Math.round(livePercent)}%</span>
                </div>
              </div>
            ) : (
              <Button
                size="lg"
                className="rgb-border rgb-border-dark w-full"
                onClick={handleStartAll}
                disabled={appState === 'starting_quest' || completableQuests.length === 0}
              >
                {appState === 'starting_quest'
                  ? 'Starting…'
                  : completableQuests.length > 0
                    ? `Start All (${completableQuests.length})`
                    : 'Start All'}
              </Button>
            )}

            {/* 3. Quest list */}
            <div className="space-y-3">
              <div className="flex items-center justify-between pt-1">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quests</h2>
                <button
                  onClick={handleRefresh}
                  disabled={appState !== 'ready'}
                  aria-label="Refresh quests"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>

              {quests.length === 0 ? (
                <div className="rgb-border rounded-lg bg-card p-10 text-center">
                  <p className="text-sm font-medium">No quests available</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    New quests will appear here when Discord adds them to your account.
                  </p>
                </div>
              ) : (
                quests.map((quest) => (
                  <QuestRow
                    key={quest.id}
                    quest={quest}
                    appState={appState}
                    activeQuestId={activeQuestId}
                    livePercent={livePercent}
                    queueStatus={queueStatus}
                    qCurrent={qCurrent}
                    qLivePercent={qLivePercent}
                    startingQuestId={appState === 'starting_quest' ? activeQuestId : null}
                    onStart={() => handleStartQuest(quest.id)}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  )
}

// ---------- Quest row ----------

function QuestRow({
  quest,
  appState,
  activeQuestId,
  livePercent,
  queueStatus,
  qCurrent,
  qLivePercent,
  startingQuestId,
  onStart,
}: {
  quest: DiscordQuest
  appState: AppState
  activeQuestId: string | null
  livePercent: number
  queueStatus: QueueStatus | null
  qCurrent: QueueSessionStatus | null
  qLivePercent: number
  startingQuestId: string | null
  onStart: () => void
}) {
  const queueActive = appState === 'queue_active' && !!queueStatus
  const questActive = appState === 'quest_active'

  const isQueueCurrent = queueActive && qCurrent?.questId === quest.id
  const isQueuePending = queueActive
    ? queueStatus!.pending.findIndex((p) => p.questId === quest.id)
    : -1
  const isQueueDone = queueActive && queueStatus!.completed.some((c) => c.questId === quest.id)
  const isQueueFailed = queueActive && queueStatus!.failed.some((f) => f.questId === quest.id)
  const isRunningNow = isQueueCurrent || (questActive && activeQuestId === quest.id)

  // "After #N" — how many quests complete before this one
  const afterNumber = isQueuePending >= 0
    ? queueStatus!.completedCount + queueStatus!.failedCount + (qCurrent ? 1 : 0) + isQueuePending
    : null

  const rowPercent = isQueueCurrent
    ? qLivePercent
    : questActive && activeQuestId === quest.id
      ? livePercent
      : quest.progress ?? 0

  const showProgress =
    isRunningNow ||
    quest.status === 'in_progress' ||
    quest.status === 'completed' ||
    quest.status === 'claimed'

  // ----- right-side action button -----
  let action: React.ReactNode
  if (queueActive) {
    if (isQueueCurrent) {
      action = (
        <Button disabled variant="secondary" className="h-9 px-3 text-xs">
          Running
        </Button>
      )
    } else if (isQueuePending >= 0) {
      action = (
        <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground opacity-70">
          {afterNumber === 0 ? 'Next' : `After #${afterNumber}`}
        </Button>
      )
    } else if (isQueueDone) {
      action = (
        <Button disabled variant="secondary" className="h-9 px-3 text-xs">
          Done
        </Button>
      )
    } else if (isQueueFailed) {
      action = (
        <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground">
          Failed
        </Button>
      )
    } else {
      action = (
        <Button disabled variant="outline" className="h-9 px-3 text-xs opacity-50">
          —
        </Button>
      )
    }
  } else if (isRunningNow) {
    action = (
      <Button disabled variant="secondary" className="h-9 px-3 text-xs">
        Running
      </Button>
    )
  } else if (quest.status === 'completed' || quest.status === 'claimed') {
    action = (
      <Button disabled variant="secondary" className="h-9 px-3 text-xs">
        {quest.status === 'claimed' ? 'Claimed' : 'Completed'}
      </Button>
    )
  } else if (quest.status === 'expired') {
    action = (
      <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground">
        Expired
      </Button>
    )
  } else if (quest.canComplete === false) {
    action = (
      <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground">
        Unavailable
      </Button>
    )
  } else if (['available', 'enrolled', 'in_progress'].includes(quest.status)) {
    const isStarting = startingQuestId === quest.id
    const disabled = appState === 'starting_quest' || appState === 'quest_active' || appState === 'queue_active'
    action = (
      <Button onClick={onStart} disabled={disabled} className="h-9 px-4 text-xs">
        {isStarting ? (
          'Starting…'
        ) : (
          <>
            <Play className="mr-1 h-3.5 w-3.5" />
            Start
          </>
        )}
      </Button>
    )
  } else {
    action = (
      <Button disabled variant="outline" className="h-9 px-3 text-xs opacity-50">
        —
      </Button>
    )
  }

  return (
    <div className="rgb-border flex items-center gap-4 rounded-lg bg-card p-4">
      <GameIcon src={quest.gameIcon} name={quest.gameName || quest.name} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{quest.name}</p>
          <StatusBadge status={quest.status} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {quest.gameName}{quest.reward ? ` · ${quest.reward}` : ''}
        </p>
        {showProgress && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={rowPercent} className="h-1.5 flex-1" />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round(rowPercent)}%
            </span>
          </div>
        )}
      </div>

      <div className="shrink-0">{action}</div>
    </div>
  )
}

// ---------- Game icon (with graceful fallback) ----------

function GameIcon({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const isUrl = src?.startsWith('http')

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {isUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="text-sm font-medium text-muted-foreground">{name.charAt(0).toUpperCase()}</span>
      )}
    </div>
  )
}

// ---------- Status badge ----------

function StatusBadge({ status }: { status: DiscordQuest['status'] }) {
  const labels: Record<string, string> = {
    available: 'Available',
    enrolled: 'Accepted',
    in_progress: 'In progress',
    completed: 'Completed',
    claimed: 'Claimed',
    expired: 'Expired',
  }
  const dots: Record<string, string> = {
    available: 'bg-blue-500',
    enrolled: 'bg-cyan-500',
    in_progress: 'bg-amber-500',
    completed: 'bg-green-500',
    claimed: 'bg-green-600',
    expired: 'bg-gray-400 dark:bg-gray-600',
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${dots[status] || 'bg-gray-300 dark:bg-gray-700'}`} />
      {labels[status] || status}
    </span>
  )
}
