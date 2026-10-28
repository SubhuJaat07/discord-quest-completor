'use client'

/**
 * /badge — Discord badge system explorer (read-only) on its own page.
 * Same layout/style as the main site (header + max-w-2xl + footer).
 * The main dashboard UI is untouched — this feature lives here only.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Award, LogIn } from 'lucide-react'
import { SiteFooter } from '@/components/site-footer'
import { ThemeToggle } from '@/components/theme-toggle'
import { BadgesSection } from '@/components/badges-section'

export default function BadgePage() {
  const [authState, setAuthState] = useState<'checking' | 'logged_in' | 'logged_out'>('checking')

  useEffect(() => {
    let cancelled = false
    fetch('/api/token')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        setAuthState(j.loggedIn ? 'logged_in' : 'logged_out')
      })
      .catch(() => { if (!cancelled) setAuthState('logged_out') })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header — same as main page */}
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Discord Quests" className="h-7 w-7" />
            <span className="text-[15px] font-semibold">Discord Quests</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        {/* Page title */}
        <div className="mb-5 flex flex-col items-start gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Award className="h-5 w-5" />
            Badge System
          </h1>
          <p className="text-sm text-muted-foreground">
            How Discord profile badges complete — live data from your profile, read-only.
          </p>
        </div>

        {/* Auth gate */}
        {authState === 'checking' && (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-36" />
                  <Skeleton className="h-2.5 w-52" />
                </div>
              </div>
            ))}
          </div>
        )}

        {authState === 'logged_out' && (
          <div className="rgb-border rounded-lg bg-card p-10 text-center">
            <p className="text-sm font-medium">Login required</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect with your Discord token on the main page to see your live badges
              and tier progress here.
            </p>
            <Button asChild className="mt-4" variant="outline" size="sm">
              <Link href="/">
                <LogIn className="mr-2 h-4 w-4" />
                Go to login
              </Link>
            </Button>
          </div>
        )}

        {authState === 'logged_in' && <BadgesSection />}
      </main>

      <SiteFooter />
    </div>
  )
}
