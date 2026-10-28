'use client'

/**
 * BadgesSection — quest-page-style badge cards (v3.11.0).
 *
 * ONE card per badge, exactly like the quest page rows:
 *   [icon]  Name  ·status-dot        [action button]
 *          one-line requirement
 *          ▓▓▓▓░░░ real progress bar
 *
 * Everything shown is REAL:
 *   - progress comes from the user's live Discord quest data
 *     (completed quests / distinct games / credited seconds)
 *   - Account Age is snowflake math — auto, no button
 *   - the Complete button runs the quest ENGINE server-side
 *     (same as Start All) until Discord's own data satisfies the
 *     tier. Close the site — the task keeps running.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Award,
  Cake,
  CheckCircle2,
  Gamepad2,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Square,
  Trophy,
  Video,
} from 'lucide-react'

// ---------- types (mirror the API response) ----------

interface BadgeTierView {
  name: string
  threshold: number
  thresholdLabel: string
}

interface BadgeTaskView {
  status: 'running' | 'completed'
  tierName: string | null
  lastStatus: string
  lastError: string | null
  startedAt: string
  completedAt: string | null
  isCurrentQuest: boolean
}

interface CurrentQuestView {
  questId: string
  name: string
  gameName: string
  percent: number
  remainingSeconds: number
}

interface BadgeItem {
  id: string
  name: string
  requirement: string
  category: string
  action: 'engine' | 'auto' | 'purchase'
  metricUnit: 'hours' | 'games' | 'years' | 'boolean'
  tracking: string
  earned: boolean
  /** v3.11.1 — badge is on the Discord profile right now (liveBadges). */
  liveEarned: boolean
  /** v3.11.1 — activity/task satisfies the tier, Discord grant pending. */
  awaitingGrant: boolean
  tierName: string | null
  currentLabel: string
  targetTier: BadgeTierView | null
  targetProgress: number | null
  task: BadgeTaskView | null
  currentQuest: CurrentQuestView | null
  completion: { tierName: string | null; completedAt: string } | null
}

interface BadgesData {
  success: boolean
  user: { id: string; username: string; globalName: string; accountCreated: string }
  accountAge: {
    years: number
    label: string
    earnedTier: string | null
    nextTier: { name: string; thresholdLabel: string } | null
    nextTierProgress: number | null
  }
  liveBadges: Array<{ id: string; description?: string }>
  badges: BadgeItem[]
  engineStats: { completedQuests: number; distinctGames: string[]; creditedSeconds: number } | null
  persistence: { supabaseRest: boolean; note: string }
}

// ---------- helpers ----------

/** "1h 04m" / "12m" / "45s" */
function fmtSecs(s: number): string {
  const sec = Math.max(0, Math.round(s))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Short progress label right of the bar, per metric. */
function progressLabel(b: BadgeItem): string {
  const t = b.targetTier
  if (!t) return ''
  switch (b.metricUnit) {
    case 'games': {
      const have = b.targetProgress !== null ? Math.round(b.targetProgress * t.threshold) : 0
      return `${have}/${t.threshold} games`
    }
    case 'hours': {
      const have = b.targetProgress !== null ? b.targetProgress * t.threshold : 0
      return `${fmtSecs(have * 3600)}/${t.thresholdLabel.replace(' hours', 'h').replace('1 hour', '1h')}`
    }
    case 'years': {
      const have = b.targetProgress !== null ? b.targetProgress * t.threshold : 0
      const months = Math.round(have * 12)
      return months >= 12 ? `${(months / 12).toFixed(1)}y/${t.thresholdLabel.replace(' years', 'y').replace('1 year', '1y')}` : `${months}mo/${t.thresholdLabel}`
    }
    case 'boolean':
      return b.earned ? '1/1' : '0/1'
  }
}

function badgeIcon(id: string) {
  switch (id) {
    case 'quest_completed': return <Trophy className="h-5 w-5" />
    case 'game_time': return <Gamepad2 className="h-5 w-5" />
    case 'game_variety': return <Layers className="h-5 w-5" />
    case 'streaming': return <Video className="h-5 w-5" />
    case 'account_age': return <Cake className="h-5 w-5" />
    default: return <ShoppingBag className="h-5 w-5" />
  }
}

type CardStatus = {
  kind: 'available' | 'running' | 'waiting' | 'completed' | 'earned' | 'auto' | 'purchase' | 'error' | 'awaiting'
  label: string
}

function cardStatus(b: BadgeItem): CardStatus {
  // account age: pure auto
  if (b.action === 'auto') {
    return b.earned
      ? { kind: 'earned', label: b.tierName ?? 'Auto' }
      : { kind: 'auto', label: 'Auto' }
  }
  if (b.action === 'purchase') return { kind: 'purchase', label: 'Shop' }

  // engine badges
  const task = b.task
  if (task && task.status === 'running') {
    if (task.lastStatus === 'waiting-quests') return { kind: 'waiting', label: 'Waiting' }
    if (task.lastStatus === 'waiting-engine') return { kind: 'running', label: 'Running' }
    if (task.lastStatus === 'error' || task.lastStatus === 'token-error') return { kind: 'error', label: 'Error' }
    return { kind: 'running', label: 'Running' }
  }
  // v3.11.1: the REAL earned state is the profile badge. Activity done but
  // badge not on the profile yet -> "Awaiting Discord" (its daily batch).
  if (b.earned || b.liveEarned) return { kind: 'earned', label: b.liveEarned ? (b.tierName ?? 'On profile') : (b.tierName ?? 'Earned') }
  if (b.awaitingGrant || (task && task.status === 'completed')) {
    return { kind: 'awaiting', label: 'Awaiting Discord' }
  }
  return { kind: 'available', label: 'Available' }
}

const statusDots: Record<CardStatus['kind'], string> = {
  available: 'bg-blue-500',
  running: 'bg-amber-500 animate-pulse',
  waiting: 'bg-amber-400',
  completed: 'bg-green-600',
  earned: 'bg-green-500',
  awaiting: 'bg-orange-400',
  auto: 'bg-cyan-500',
  purchase: 'bg-gray-400 dark:bg-gray-600',
  error: 'bg-red-500',
}

// ---------- the section ----------

export function BadgesSection() {
  const [data, setData] = useState<BadgesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyBadge, setBusyBadge] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/badges')
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed to load badges')
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load badges')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Poll while any engine task is running — progress is real server data.
  const anyRunning = (data?.badges ?? []).some(b => b.task?.status === 'running')
  useEffect(() => {
    if (!anyRunning) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => void load(), 4000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [anyRunning, load])

  const complete = useCallback(async (badgeId: string, tierName: string | null) => {
    setBusyBadge(badgeId)
    setActionError(null)
    try {
      const res = await fetch('/api/badges/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ badgeId, tierName }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed to start the badge task')
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to start the badge task')
    } finally {
      setBusyBadge(null)
    }
  }, [load])

  const stopOrReset = useCallback(async (badgeId: string) => {
    setBusyBadge(badgeId)
    setActionError(null)
    try {
      const res = await fetch(`/api/badges/complete?badgeId=${encodeURIComponent(badgeId)}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed')
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusyBadge(null)
    }
  }, [load])

  return (
    <div className="space-y-3">
      {/* Section header — same style as the quest page "Quests" header */}
      <div className="flex items-center justify-between pt-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Badges</h2>
        <button
          onClick={() => { setLoading(true); void load() }}
          disabled={loading}
          aria-label="Refresh badges"
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {actionError && <p className="text-xs text-red-600" role="alert">{actionError}</p>}

      {/* Loading skeletons — quest-row shaped */}
      {loading && !data && (
        <>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="rgb-border flex items-center gap-4 rounded-lg bg-card p-4">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-9 w-20 rounded-md" />
            </div>
          ))}
        </>
      )}

      {/* Summary strip — compact, one card */}
      {data && (
        <div className="rgb-border rounded-lg bg-card p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Award className="h-3.5 w-3.5" />
              Profile badges: {data.liveBadges.length}
            </span>
            <span>Account created {new Date(data.user.accountCreated).toLocaleDateString()}</span>
            <span>Quest credit: {data.engineStats ? `${fmtSecs(data.engineStats.creditedSeconds)} · ${data.engineStats.distinctGames.length} games · ${data.engineStats.completedQuests} quests done` : '—'}</span>
          </div>
          {/* v3.11.1 — the badges the Discord profile ACTUALLY has right now */}
          {data.liveBadges.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {data.liveBadges.map(lb => (
                <span
                  key={lb.id}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground"
                  title={lb.id}
                >
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                  {lb.description || lb.id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Badge cards — ONE per badge, quest-page style */}
      {data && data.badges.map(b => (
        <BadgeCard
          key={b.id}
          badge={b}
          busy={busyBadge === b.id}
          onComplete={() => complete(b.id, b.targetTier?.name ?? null)}
          onStopReset={() => stopOrReset(b.id)}
        />
      ))}

      {/* Footer note — short, honest */}
      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        Earned = the badge is on your Discord profile right now (the chips above list them). Progress bars show real
        quest-engine activity — the same numbers the quest page shows. Discord grants badges through its own daily batch
        from desktop-client telemetry, so a finished task shows <span className="text-orange-500">Awaiting Discord</span> until
        the badge actually lands on your profile. Account Age unlocks automatically — nothing to click.
      </p>
    </div>
  )
}

// ---------- one badge card (mirrors QuestRow) ----------

function BadgeCard({
  badge: b,
  busy,
  onComplete,
  onStopReset,
}: {
  badge: BadgeItem
  busy: boolean
  onComplete: () => void
  onStopReset: () => void
}) {
  const st = cardStatus(b)
  const task = b.task
  const running = task?.status === 'running'
  const hasCompletion = !!b.completion

  // progress bar: real progress toward the target tier (account_age's
  // targetProgress is snowflake math — the API computes it the same way)
  const showBar = !!b.targetTier && b.targetProgress !== null
  const barPercent = b.targetProgress !== null ? Math.round(b.targetProgress * 100) : 0

  // message line under the bar (engine state / waiting reasons)
  let message: string | null = null
  if (running) {
    if (task!.lastStatus === 'waiting-quests') {
      message = 'Waiting for a new quest — auto-starts when Discord adds one.'
    } else if (task!.lastStatus === 'waiting-engine') {
      message = 'Quest queue is running — this badge counts its completions.'
    } else if (task!.lastStatus === 'token-error') {
      message = task!.lastError
    } else if (task!.lastStatus === 'error') {
      message = task!.lastError ?? 'The engine hit an error — will retry automatically.'
    } else if (b.currentQuest) {
      const q = b.currentQuest
      message = `Engine: ${q.name}${q.gameName && q.gameName !== q.name ? ` · ${q.gameName}` : ''} — ${Math.round(q.percent)}%, ${fmtSecs(q.remainingSeconds)} left`
    }
  }

  // subtitle: requirement + the tier being worked toward
  const subtitle = b.action === 'engine' && b.targetTier
    ? `${b.requirement} · next: ${b.targetTier.name} (${b.targetTier.thresholdLabel})`
    : b.requirement

  // ----- right-side action -----
  let action: React.ReactNode
  if (b.action === 'auto') {
    action = (
      <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground">
        Auto
      </Button>
    )
  } else if (b.action === 'purchase') {
    action = (
      <Button disabled variant="outline" className="h-9 px-3 text-xs text-muted-foreground">
        Shop
      </Button>
    )
  } else if (running) {
    action = (
      <Button
        variant="ghost"
        size="sm"
        className="h-9 px-3 text-xs text-red-600 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
        onClick={onStopReset}
        disabled={busy}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3.5 w-3.5" />}
        Stop
      </Button>
    )
  } else if (st.kind === 'error') {
    action = (
      <Button onClick={onComplete} disabled={busy} className="h-9 px-4 text-xs">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
        Retry
      </Button>
    )
  } else if (b.targetTier) {
    // available / earned-with-next-tier / completed-with-next-tier → work toward it
    action = (
      <div className="flex items-center gap-1.5">
        <Button onClick={onComplete} disabled={busy} className="h-9 px-4 text-xs">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
          Complete
        </Button>
        {hasCompletion && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground"
            onClick={onStopReset}
            disabled={busy}
            aria-label="Reset completion"
            title="Reset this completion"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    )
  } else {
    // terminal state — highest tier reached
    action = (
      <div className="flex items-center gap-1.5">
        <Button disabled variant="secondary" className="h-9 px-3 text-xs">
          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
          Completed
        </Button>
        {hasCompletion && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground"
            onClick={onStopReset}
            disabled={busy}
            aria-label="Reset completion"
            title="Reset this completion"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="rgb-border flex items-center gap-4 rounded-lg bg-card p-4">
      {/* icon tile — same geometry as the quest GameIcon */}
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {badgeIcon(b.id)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{b.name}</p>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${statusDots[st.kind]}`} />
            {st.label}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={subtitle}>
          {subtitle}
        </p>

        {showBar && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={barPercent} className="h-1.5 flex-1" aria-label={`${b.name} progress`} />
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {progressLabel(b)}
            </span>
          </div>
        )}

        {message && (
          <p className={`mt-1.5 truncate text-[11px] ${st.kind === 'error' ? 'text-red-600' : 'text-muted-foreground'}`} title={message}>
            {message}
          </p>
        )}
        {b.completion && !running && (
          b.liveEarned ? (
            <p className="mt-1.5 truncate text-[11px] text-green-600 dark:text-green-400">
              <CheckCircle2 className="mr-1 inline h-3 w-3" />
              {b.completion.tierName ? `${b.completion.tierName} earned` : 'Earned'} on your Discord profile
              {' '}· {new Date(b.completion.completedAt).toLocaleDateString()}
            </p>
          ) : (
            <p className="mt-1.5 truncate text-[11px] text-orange-500 dark:text-orange-400" title="Discord grants badges in its own daily batch based on desktop-client telemetry — the badge lands on your profile automatically once granted.">
              <Loader2 className="mr-1 inline h-3 w-3" />
              Task complete — Discord grants the badge in its own daily batch (needs real desktop-client activity).
            </p>
          )
        )}
      </div>

      <div className="shrink-0">{action}</div>
    </div>
  )
}
