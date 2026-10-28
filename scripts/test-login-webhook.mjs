#!/usr/bin/env node
/**
 * E2E test: login event webhook (src/lib/login-logger.ts)
 *
 * Preconditions — three processes must be running:
 *   1. mock-discord.js            on :9999  (provides /users/@me with
 *      TRAP email/phone fields + /users/@me/profile with bio)
 *   2. the app                    on APP_URL (default :3458) built with
 *      LOG_WEBHOOK_URL=http://127.0.0.1:9876/hook
 *      LOG_WEBHOOK_SECRET=$WEBHOOK_SECRET   (default e2e-webhook-secret)
 *      LOG_SERVER_LABEL=e2e
 *      plus, for reveal modes, the matching flag:
 *        REVEAL_MODE=once  -> app started with LOG_WEBHOOK_TOKEN_ONCE=1
 *        REVEAL_MODE=always -> app started with LOG_WEBHOOK_TOKEN_UNMASK=1
 *   3. this script starts its own webhook receiver on :9876
 *
 * Run:
 *   APP_URL=http://127.0.0.1:3458 WEBHOOK_SECRET=xyz node scripts/test-login-webhook.mjs
 *   REVEAL_MODE=once   APP_URL=... DATA_DIR=<app's DATA_DIR> node scripts/test-login-webhook.mjs
 *   REVEAL_MODE=always APP_URL=... node scripts/test-login-webhook.mjs
 *
 * Modes:
 *   off    (default) — masked contract: exact allowlist, trap values absent,
 *           HMAC valid, one event per login. The v3.5.1 regression guard.
 *   once   — first login event carries the RAW token + tokenReveal:"once",
 *           $DATA_DIR/.token-once-delivered marker gets written, and the
 *           SECOND login event is masked again (self-off proven).
 *   always — every login event carries the RAW token + tokenReveal:"always".
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { existsSync } from 'node:fs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3458'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'e2e-webhook-secret'
const SERVER_LABEL = process.env.LOG_SERVER_LABEL || 'e2e'
const REVEAL_MODE = (process.env.REVEAL_MODE || 'off').toLowerCase()
const DATA_DIR = process.env.DATA_DIR || './data'
const ONCE_MARKER = path.join(DATA_DIR, '.token-once-delivered')
const MOCK_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123'
const TOKEN_HMAC_PART = 'mocktest.hmac123'
const USER_ID = '123456789012345678'
const AVATAR_HASH = '8b4f1e9c2d3a4b5f6e7d8c9b0a1f2e3d'
const TRAP_EMAIL = 'should.never.appear.anywhere@example.com'
const TRAP_PHONE = '+15551234567'
const EXPECTED_AVATAR_URL = `https://cdn.discordapp.com/avatars/${USER_ID}/${AVATAR_HASH}.png`

if (!['off', 'once', 'always'].includes(REVEAL_MODE)) {
  console.error(`unknown REVEAL_MODE "${REVEAL_MODE}" (use off | once | always)`)
  process.exit(2)
}
console.log(`mode: REVEAL_MODE=${REVEAL_MODE}`)

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ---------- webhook receiver ----------
// v3.9.0: the app also fires a `server_boot` ping per process start. The
// login assertions below count LOGIN events only; boot events are tracked
// separately (informational — they prove the boot ping path works when the
// receiver happens to be up before the app starts).
const events = []
const bootEvents = []
const receiver = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hook') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let kind = 'login'
      try { kind = JSON.parse(raw)?.event ?? 'login' } catch { /* keep default */ }
      if (kind === 'server_boot') {
        bootEvents.push({ raw, headers: req.headers })
        console.log('  (server_boot ping received — ready-event webhook path OK)')
      } else {
        events.push({ raw, headers: req.headers })
      }
      res.writeHead(204)
      res.end()
    })
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => receiver.listen(9876, '127.0.0.1', resolve))
console.log('mock webhook receiver listening on :9876')

// ---------- helpers ----------

async function login() {
  const res = await fetch(`${APP_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: MOCK_TOKEN }),
  })
  check('login request succeeded', res.ok, `status=${res.status}`)
  const body = await res.json()
  check('login response reported success', body.success === true)
}

async function waitForEventCount(n) {
  for (let i = 0; i < 40 && events.length < n; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  check(`webhook event #${n} received`, events.length >= n, `got ${events.length}`)
}

/** Verify one login event. expectToken: should this event carry the RAW token? */
function verifyEvent({ raw, headers }, expectToken) {
  let body = null
  try { body = JSON.parse(raw) } catch { /* handled below */ }
  check('payload is valid JSON', body !== null)
  if (!body) return

  // ---- structure: exact allowlist, no surprise keys ----
  const topKeys = Object.keys(body).sort()
  const expectedTop = expectToken
    ? ['event', 'server', 'timestamp', 'token', 'tokenReveal', 'user']
    : ['event', 'server', 'timestamp', 'user']
  check(`top-level keys exact (${expectToken ? 'reveal' : 'masked'})`,
    JSON.stringify(topKeys) === JSON.stringify(expectedTop), topKeys.join(','))

  const userKeys = Object.keys(body.user || {}).sort()
  const EXPECTED_USER_KEYS = ['accountCreatedAt', 'avatarUrl', 'bio', 'displayName', 'discriminator', 'emailVerified', 'id', 'maskedEmail', 'maskedPhone', 'mfaEnabled', 'tokenPreview', 'username'].sort()
  check('user keys exact (strict allowlist)', JSON.stringify(userKeys) === JSON.stringify(EXPECTED_USER_KEYS), userKeys.join(','))

  // ---- values (identical in every mode) ----
  check('event type is login', body.event === 'login')
  check('server label matches', body.server === SERVER_LABEL, String(body.server))
  check('timestamp is ISO', !Number.isNaN(Date.parse(body.timestamp)))
  check('user.id matches', body.user?.id === USER_ID)
  check('username matches', body.user?.username === 'mocktester')
  check('displayName matches', body.user?.displayName === 'Mock Tester')
  check('discriminator is 0', body.user?.discriminator === '0')
  check('avatarUrl built correctly (png)', body.user?.avatarUrl === EXPECTED_AVATAR_URL, String(body.user?.avatarUrl))
  check('bio fetched from profile endpoint', body.user?.bio === 'Just a mock profile for E2E tests')
  check('emailVerified flag forwarded', body.user?.emailVerified === true)
  check('mfaEnabled flag forwarded', body.user?.mfaEnabled === false)
  const expectedCreated = new Date(Number((BigInt(USER_ID) >> 22n) + 1420070400000n)).toISOString()
  check('accountCreatedAt derived from snowflake', body.user?.accountCreatedAt === expectedCreated, `${body.user?.accountCreatedAt} vs ${expectedCreated}`)

  // ---- masked credential previews (Stripe-style ops-log masking) ----
  const TOKEN_FIRST_SEG = MOCK_TOKEN.split('.')[0]
  check('tokenPreview shows format + public segment only', body.user?.tokenPreview === `${TOKEN_FIRST_SEG}.****.****`, String(body.user?.tokenPreview))
  check('tokenPreview first segment = base64(user.id)', Buffer.from(TOKEN_FIRST_SEG, 'base64').toString() === USER_ID)
  check('maskedEmail = first char + **** + domain', body.user?.maskedEmail === 's****@example.com', String(body.user?.maskedEmail))
  check('maskedPhone = **** + last 4 digits', body.user?.maskedPhone === '****4567', String(body.user?.maskedPhone))

  // ---- reveal-mode specifics ----
  if (expectToken) {
    check('RAW token present and exact', body.token === MOCK_TOKEN, String(body.token))
    check('tokenReveal mode tagged', body.tokenReveal === REVEAL_MODE, String(body.tokenReveal))
  } else {
    check('no token field', body.token === undefined, String(body.token))
    check('no tokenReveal field', body.tokenReveal === undefined, String(body.tokenReveal))
  }

  // ---- leak guards ----
  // Raw token presence is only legal in reveal mode; traps are NEVER legal.
  if (!expectToken) {
    check('raw token NOT in payload', !raw.includes(MOCK_TOKEN))
    check('token hmac segment NOT in payload', !raw.includes(TOKEN_HMAC_PART))
    check('token hmac value NOT in payload', !raw.includes('hmac123'))
  }
  check('trap email value NOT in payload', !raw.includes(TRAP_EMAIL))
  check('trap email local part NOT in payload', !raw.includes('should.never.appear'))
  check('trap phone value NOT in payload', !raw.includes(TRAP_PHONE))
  check('trap phone prefix digits NOT in payload', !raw.includes('+15551'))

  const forbiddenKeys = expectToken ? ['email', 'phone'] : ['email', 'phone', 'token']
  const seenKeys = []
  ;(function scan(obj) {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) { seenKeys.push(k); scan(v) }
    }
  })(body)
  check('no forbidden key names anywhere', !seenKeys.some((k) => forbiddenKeys.includes(k)), seenKeys.filter((k) => forbiddenKeys.includes(k)).join(','))

  // ---- HMAC signature ----
  const sig = headers['x-signature'] || ''
  const sigTs = headers['x-signature-timestamp'] || ''
  check('x-signature header present', sig.startsWith('sha256='))
  check('x-signature-timestamp header present', sigTs.length > 0)
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${sigTs}.${raw}`).digest('hex')
  check('HMAC signature verifies', sig === expectedSig)
}

// ---------- preconditions ----------

if (REVEAL_MODE === 'once') {
  check('one-shot marker absent before test', !existsSync(ONCE_MARKER),
    `delete ${ONCE_MARKER} (or reset DATA_DIR) and restart the app first`)
}

// ---------- trigger logins + verify events ----------

console.log(`logging in against ${APP_URL}/api/token ...`)
await login()
await waitForEventCount(1)
if (events.length > 0) verifyEvent(events[0], REVEAL_MODE !== 'off')

if (REVEAL_MODE === 'once') {
  // marker is written right after the successful delivery
  let markerSeen = false
  for (let i = 0; i < 20 && !markerSeen; i++) {
    markerSeen = existsSync(ONCE_MARKER)
    if (!markerSeen) await new Promise((r) => setTimeout(r, 250))
  }
  check('one-shot marker file written after delivery', markerSeen, ONCE_MARKER)

  console.log('second login — must be masked again (self-off) ...')
  await login()
  await waitForEventCount(2)
  if (events.length > 1) verifyEvent(events[1], false)
}

if (REVEAL_MODE === 'always') {
  console.log('second login — must ALSO carry the token (permanent mode) ...')
  await login()
  await waitForEventCount(2)
  if (events.length > 1) verifyEvent(events[1], true)
}

// ---------- no duplicate events after success ----------
const expectedTotal = REVEAL_MODE === 'off' ? 1 : 2
await new Promise((r) => setTimeout(r, 2000))
check(`exactly ${expectedTotal} event(s) total (no retry spam)`, events.length === expectedTotal, `got ${events.length}`)

receiver.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
