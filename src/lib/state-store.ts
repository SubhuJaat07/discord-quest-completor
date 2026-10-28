// ============================================================
// Monitor state store — disk + Supabase (private build)
// ------------------------------------------------------------
// Restart-proof persistence for the 24h Auto-Monitor:
//
//   DISK      $DATA_DIR/monitor.json  — token sealed (AES-256-GCM)
//   CLOUD     Supabase table `monitor_state` — toggle state + the
//             SEALED token ciphertext, so a restart that wipes the
//             whole data directory (no persistent volume) still
//             resumes the monitor.
//
// Security contract:
//   1. The token NEVER leaves this server in plaintext — what goes
//      to Supabase is `enc:v1:<iv>:<tag>:<ct>` ciphertext. Supabase
//      (or anyone reading that table) sees an opaque blob.
//   2. The sealing key comes from MONITOR_ENCRYPTION_KEY (env) — for
//      volume-less restarts this env var is REQUIRED, otherwise the
//      auto-generated key file is wiped together with the volume and
//      unsealing fails closed (monitor stays off, never crashes).
//   3. The Supabase service key is used server-side only and is
//      never logged. Failures log a status word, nothing else.
//   4. Cloud rows carry no email/phone — the monitor never sees them.
//
// Wire format (Supabase, snake_case columns):
//   id='singleton', enabled, token_sealed, user_id, username,
//   interval_hours, next_run_at (epoch ms), updated_at
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

const DATA_DIR = process.env.DATA_DIR || './data'

// ---------- token sealing (AES-256-GCM) ----------

const ENC_PREFIX = 'enc:v1:'
const KEY_FILE = path.join(DATA_DIR, '.monitor-key')

let cachedKey: Buffer | null = null

function getMonitorKey(): Buffer {
  if (cachedKey) return cachedKey
  const envKey = process.env.MONITOR_ENCRYPTION_KEY
  if (envKey && envKey.length >= 8) {
    cachedKey = scryptSync(envKey, 'dqc-monitor-key-v1', 32)
    return cachedKey
  }
  try {
    if (existsSync(KEY_FILE)) {
      const k = Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'hex')
      if (k.length === 32) {
        cachedKey = k
        return cachedKey
      }
    }
    mkdirSync(DATA_DIR, { recursive: true })
    const k = randomBytes(32)
    writeFileSync(KEY_FILE, k.toString('hex') + '\n', { mode: 0o600 })
    cachedKey = k
  } catch {
    // Read-only fs: per-process key — state only survives this process.
    cachedKey = randomBytes(32)
  }
  return cachedKey
}

/** Seal a token for storage (disk or cloud): enc:v1:<iv>:<tag>:<ct> */
export function sealToken(plain: string): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getMonitorKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/** Unseal a stored token. null = wrong key / corrupted → fail closed. */
export function unsealToken(stored: string): string | null {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored // legacy plaintext (pre-encryption file) — migrated on next persist
  }
  try {
    const [iv, tag, ct] = stored.slice(ENC_PREFIX.length).split(':')
    const decipher = createDecipheriv('aes-256-gcm', getMonitorKey(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf-8')
  } catch {
    return null
  }
}

// ---------- Supabase REST (PostgREST subset, no SDK needed) ----------

function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
}

function supabaseKey(): string {
  return (process.env.SUPABASE_SERVICE_KEY || '').trim()
}

export function supabaseConfigured(): boolean {
  return supabaseUrl().length > 0 && supabaseKey().length > 0
}

function authHeaders(): Record<string, string> {
  return {
    apikey: supabaseKey(),
    Authorization: `Bearer ${supabaseKey()}`,
    'Content-Type': 'application/json',
  }
}

const ROW_ID = 'singleton'
const TABLE = 'monitor_state'
const TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 2

export interface CloudMonitorRow {
  enabled: boolean
  tokenSealed: string
  userId: string
  username: string
  intervalHours: number
  nextRunAt: number
}

/** Upsert the singleton row (fire-safe: throws to caller on hard failure). */
export async function cloudSaveMonitor(row: CloudMonitorRow): Promise<boolean> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return false

  const body = JSON.stringify({
    id: ROW_ID,
    enabled: row.enabled,
    token_sealed: row.tokenSealed,
    user_id: row.userId,
    username: row.username,
    interval_hours: row.intervalHours,
    next_run_at: row.nextRunAt,
    updated_at: new Date().toISOString(),
  })

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}/rest/v1/${TABLE}`, {
        method: 'POST',
        headers: { ...authHeaders(), Prefer: 'resolution=merge-duplicates' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) return true
      console.error(`[monitor] cloud save failed: HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
    } catch {
      console.error(`[monitor] cloud save unreachable (attempt ${attempt}/${MAX_ATTEMPTS})`)
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/** Load the singleton row. null = no row / not configured / unreachable. */
export async function cloudLoadMonitor(): Promise<CloudMonitorRow | null> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return null

  try {
    const res = await fetch(
      `${base}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=id,enabled,token_sealed,user_id,username,interval_hours,next_run_at`,
      { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    if (!res.ok) {
      console.error(`[monitor] cloud load failed: HTTP ${res.status}`)
      return null
    }
    const rows = (await res.json()) as any[]
    if (!Array.isArray(rows) || rows.length === 0) return null
    const r = rows[0]
    return {
      enabled: r.enabled === true,
      tokenSealed: typeof r.token_sealed === 'string' ? r.token_sealed : '',
      userId: typeof r.user_id === 'string' ? r.user_id : '',
      username: typeof r.username === 'string' ? r.username : '',
      intervalHours: Number(r.interval_hours) > 0 ? Number(r.interval_hours) : 24,
      nextRunAt: Number(r.next_run_at) || 0,
    }
  } catch {
    console.error('[monitor] cloud load unreachable')
    return null
  }
}

/** Remove the singleton row entirely (full monitor wipe). */
export async function cloudClearMonitor(): Promise<void> {
  const base = supabaseUrl()
  if (!base || !supabaseKey()) return
  try {
    const res = await fetch(`${base}/rest/v1/${TABLE}?id=eq.${ROW_ID}`, {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) console.error(`[monitor] cloud clear failed: HTTP ${res.status}`)
  } catch {
    console.error('[monitor] cloud clear unreachable')
  }
}
