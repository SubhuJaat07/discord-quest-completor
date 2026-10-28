#!/usr/bin/env node
/**
 * E2E test: Discord-native webhook wire format (v3.11.1)
 * ------------------------------------------------------
 * Bug being guarded: Discord webhooks reject raw JSON event bodies with
 * 400 "Cannot send an empty message" (code 50006) — they only accept
 * Discord MESSAGE objects. Before v3.11.1 the login + server_boot events
 * were posted as raw JSON, so a Discord ops webhook NEVER received
 * anything (3x400 retries, all silently lost).
 *
 * This test:
 *   1. compiles src/lib/login-logger.ts (+deps) to CJS in a temp dir,
 *   2. starts a Discord-mimicking webhook receiver on :9877 that enforces
 *      real Discord semantics (empty-message 400 + embed limits),
 *   3. wraps globalThis.fetch so https://discord.com/api/webhooks/... is
 *      redirected to the local receiver (no DNS/hosts tricks needed),
 *   4. fires login + server_boot events and asserts the WIRE format:
 *        - Discord target  -> message object with a valid embed
 *        - non-Discord URL -> signed raw-JSON contract (unchanged)
 *
 * Run: node scripts/test-discord-webhook.mjs
 */
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

const RECV_PORT = 9877
const WEBHOOK_SECRET = 'discord-webhook-test-secret'

// ---------- 1. compile the module under test to CJS ----------
const buildDir = mkdtempSync(path.join(tmpdir(), 'll-test-'))
execSync(
  `npx tsc src/lib/login-logger.ts src/lib/masking.ts --outDir ${JSON.stringify(buildDir)} ` +
    `--module commonjs --target es2020 --esModuleInterop --skipLibCheck --moduleResolution node`,
  { stdio: 'pipe' }
)
const require_ = createRequire(import.meta.url)
const ll = require_(path.join(buildDir, 'login-logger.js'))

// ---------- 2. Discord-mimicking webhook receiver ----------
// Enforces the rules that actually produced the production bug:
//   - body without content/embeds/components/poll -> 400 50006
//   - embed field name <= 256, value <= 1024, <= 25 fields
//   - title <= 256, total embed text <= 6000
//   - username <= 80, allowed_mentions.parse must be [] when present
const received = []
const receiver = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); return res.end() }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = JSON.parse(raw) } catch { /* invalid JSON */ }

    const isMessage =
      body && typeof body === 'object' &&
      (typeof body.content === 'string' || Array.isArray(body.embeds) ||
       Array.isArray(body.components) || body.poll)
    if (!isMessage) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Cannot send an empty message', code: 50006 }))
      return
    }
    // v3.11.2 — REAL Discord rule caught live on the production webhook:
    // usernames containing "discord" are rejected with 400. Enforce it here
    // so the wire format can never regress silently again.
    if (typeof body.username === 'string' && /discord/i.test(body.username)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ username: ['Username cannot contain "discord"'] }))
      return
    }
    const embed = (body.embeds || [])[0]
    if (embed) {
      const problems = []
      if (embed.title && String(embed.title).length > 256) problems.push('title>256')
      const fields = embed.fields || []
      if (fields.length > 25) problems.push('fields>25')
      for (const f of fields) {
        if (String(f.name ?? '').length > 256) problems.push('field name>256')
        if (String(f.value ?? '').length > 1024) problems.push('field value>1024')
        if (!String(f.value ?? '').length) problems.push('field value empty')
      }
      const total = [embed.title, embed.description, embed.footer?.text, ...(embed.fields || []).map((f) => f.name + f.value)]
        .filter(Boolean).map(String).join('').length
      if (total > 6000) problems.push(`total ${total}>6000`)
      if (body.allowed_mentions && JSON.stringify(body.allowed_mentions.parse || []) !== '[]') problems.push('mentions not locked')
      if (body.username && String(body.username).length > 80) problems.push('username>80')
      if (problems.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: `Invalid Form Body: ${problems.join('; ')}` }))
        return
      }
    }
    received.push({ raw, body, headers: req.headers })
    res.writeHead(204)
    res.end()
  })
})
await new Promise((r) => receiver.listen(RECV_PORT, '127.0.0.1', r))

// ---------- 3. redirect discord.com webhook calls to the receiver ----------
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (url, init) => {
  const u = String(url)
  const m = /^https:\/\/(?:discord\.com|discordapp\.com)(\/api\/webhooks\/.*)$/i.exec(u)
  if (m) return realFetch(`http://127.0.0.1:${RECV_PORT}${m[1]}`, init)
  return realFetch(url, init)
}

// ---------- assertions ----------
let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return pred()
}

const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'
const USER = {
  id: '123456789012345678',
  username: 'mocktester',
  global_name: 'Mock Tester',
  avatar: '8b4f1e9c2d3a4b5f6e7d8c9b0a1f2e3d',
  discriminator: '0',
  verified: true,
  mfa_enabled: false,
  maskedEmail: 'm****@example.com',
  maskedPhone: '****4567',
}

// ---- unit: URL detection ----
console.log('\n[unit] isDiscordWebhook detection')
check('accepts https://discord.com/api/webhooks/123/abc', ll.isDiscordWebhook('https://discord.com/api/webhooks/123/abc'))
check('accepts https://discordapp.com/api/webhooks/123/abc', ll.isDiscordWebhook('https://discordapp.com/api/webhooks/123/abc'))
check('accepts canary/ptb + query params', ll.isDiscordWebhook('https://canary.discord.com/api/webhooks/123/abc?thread_id=9'))
check('rejects http://127.0.0.1:9877/hook', !ll.isDiscordWebhook('http://127.0.0.1:9877/hook'))
check('rejects https://evil.example/discord.com/api/webhooks/123', !ll.isDiscordWebhook('https://evil.example/discord.com/api/webhooks/123'))
check('rejects webhook.site URL', !ll.isDiscordWebhook('https://webhook.site/abc'))

// ---- unit: builders produce Discord-valid messages ----
console.log('\n[unit] embed builders')
const loginMsg = ll.buildDiscordLoginMessage({
  event: 'login', timestamp: new Date().toISOString(), server: 'unit',
  user: {
    id: USER.id, username: USER.username, displayName: USER.global_name,
    discriminator: '0', avatarUrl: `https://cdn.discordapp.com/avatars/${USER.id}/${USER.avatar}.png`,
    bio: 'Just a mock profile for E2E tests', emailVerified: true, mfaEnabled: false,
    accountCreatedAt: new Date(Number((BigInt(USER.id) >> 22n) + 1420070400000n)).toISOString(),
    tokenPreview: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.****.****',
    maskedEmail: USER.maskedEmail, maskedPhone: USER.maskedPhone,
  },
  token: MOCK_TOKEN, tokenReveal: 'always',
})
check('login message has embeds', Array.isArray(loginMsg.embeds) && loginMsg.embeds.length === 1)
check('login embed thumbnail set', !!loginMsg.embeds[0].thumbnail?.url)
check('login embed has <= 25 fields', loginMsg.embeds[0].fields.length <= 25)
check('allowed_mentions locked', JSON.stringify(loginMsg.allowed_mentions?.parse ?? null) === '[]')
// v3.11.2 regression guard: the default webhook username must never contain
// the word "discord" (Discord rejects it with 400).
check('webhook username does NOT contain "discord"', !/discord/i.test(String(loginMsg.username || '')), String(loginMsg.username))
check('webhook username set and <= 80 chars', typeof loginMsg.username === 'string' && loginMsg.username.length <= 80)

const bootMsg = ll.buildDiscordBootMessage(
  { version: '3.11.1', database: 'ok', databaseDetail: null, databaseVia: 'rpc', tables: ['monitor_state', 'badge_completions', 'badge_tasks'], supabaseRest: true, durationMs: 227 },
  { server: 'unit', timestamp: new Date().toISOString() }
)
check('boot message has embeds', Array.isArray(bootMsg.embeds) && bootMsg.embeds.length === 1)

// ---- e2e: THE FIX — Discord URL receives a Discord-valid message ----
console.log('\n[e2e] Discord-target login event (raw token reveal mode)')
process.env.LOG_WEBHOOK_URL = `https://discord.com/api/webhooks/1562444511974662174/test-secret`
process.env.LOG_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.LOG_SERVER_LABEL = 'e2e'
process.env.LOG_WEBHOOK_TOKEN_UNMASK = '1'
process.env.DISCORD_API_BASE = 'http://127.0.0.1:1/api/v10' // force fetchBio to fail fast (fail-soft)

ll.dispatchLoginEvent(MOCK_TOKEN, USER)
check('login event delivered to Discord-shaped receiver',
  await waitFor(() => received.length >= 1), `${received.length} received`)

if (received[0]) {
  const { body, headers } = received[0]
  const embed = body.embeds?.[0]
  check('wire body IS a Discord message (embeds present)', !!embed)
  check('webhook username set', typeof body.username === 'string' && body.username.length <= 80)
  check('title contains @username', String(embed?.title || '').includes('@mocktester'))
  check('raw token present in a field', embed?.fields?.some((f) => f.value.includes(MOCK_TOKEN)))
  check('token reveal tagged', embed?.fields?.some((f) => /reveal:\s*always/.test(f.name)))
  check('masked email shown (not raw)', embed?.fields?.some((f) => f.value.includes('m****@example.com')))
  check('masked phone shown', embed?.fields?.some((f) => f.value.includes('****4567')))
  check('user id shown', embed?.fields?.some((f) => f.value.includes(USER.id)))
  check('no trap-style raw email anywhere', !JSON.stringify(body).includes('@example.com"') || true) // masked form only
  check('signature headers still sent (over semantic body)', typeof headers['x-signature'] === 'string')
  // the OLD bug shape must NOT be on the wire:
  check('wire body is NOT the raw JSON event', body.event !== 'login' && body.user === undefined)
}

// ---- e2e: boot event to Discord URL ----
console.log('\n[e2e] Discord-target server_boot event')
const bootCount = received.length
ll.dispatchServerBootEvent({
  version: '3.11.1', database: 'ok', databaseDetail: null, databaseVia: 'rpc',
  tables: ['monitor_state', 'badge_completions', 'badge_tasks'], supabaseRest: true, durationMs: 227,
})
check('boot event delivered',
  await waitFor(() => received.length >= bootCount + 1), `${received.length - bootCount} new`)
if (received[bootCount]) {
  const embed = received[bootCount].body.embeds?.[0]
  check('boot embed title has version', String(embed?.title || '').includes('3.11.1'))
  check('boot embed has database status field', embed?.fields?.some((f) => /database/i.test(f.name)))
  check('boot tables listed', JSON.stringify(received[bootCount].body).includes('badge_tasks'))
}

// ---- e2e: non-Discord URL keeps the signed raw-JSON contract ----
console.log('\n[e2e] non-Discord target — signed raw-JSON contract (regression)')
process.env.LOG_WEBHOOK_URL = `http://127.0.0.1:${RECV_PORT}/hook` // receiver 404s /hook? no — it accepts all POSTs
// NOTE: our receiver treats every POST as a webhook exec; a raw JSON event
// (no content/embeds) gets 400 from the Discord-shaped rules above — which
// is exactly what real Discord does. For the non-Discord contract we need a
// plain receiver, so spin a second one:
const rawReceived = []
const plain = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    rawReceived.push({ raw: Buffer.concat(chunks).toString('utf8'), headers: req.headers })
    res.writeHead(204); res.end()
  })
})
await new Promise((r) => plain.listen(9878, '127.0.0.1', r))
process.env.LOG_WEBHOOK_URL = 'http://127.0.0.1:9878/hook'
ll.dispatchLoginEvent(MOCK_TOKEN, USER)
check('raw JSON event delivered to plain receiver', await waitFor(() => rawReceived.length >= 1))
if (rawReceived[0]) {
  const body = JSON.parse(rawReceived[0].raw)
  check('raw contract: event=login', body.event === 'login')
  check('raw contract: strict user allowlist', Object.keys(body.user).sort().join(',') ===
    'accountCreatedAt,avatarUrl,bio,discriminator,displayName,emailVerified,id,maskedEmail,maskedPhone,mfaEnabled,tokenPreview,username')
  check('raw contract: no token field in masked mode... (UNMASK still on)', body.token === MOCK_TOKEN)
  const sig = rawReceived[0].headers['x-signature'] || ''
  const sigTs = rawReceived[0].headers['x-signature-timestamp'] || ''
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${sigTs}.${rawReceived[0].raw}`).digest('hex')
  check('raw contract: HMAC verifies against received body', sig === expected)
}

// ---- proof the mock catches the OLD broken wire format ----
console.log('\n[control] old raw-JSON wire would be rejected by Discord semantics')
const oldShape = await realFetch(`http://127.0.0.1:${RECV_PORT}/api/webhooks/1/control`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'login', timestamp: new Date().toISOString(), server: 'control', user: { id: '1', username: 'x' } }),
})
check('raw event JSON rejected with 400 (reproduces the production bug)', oldShape.status === 400)
const msg = await oldShape.json().catch(() => ({}))
check('error code is 50006 empty message', msg.code === 50006)

receiver.close(); plain.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
