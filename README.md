# Discord Quest Completor v3.5.1 — Verified Direct REST API Method

Auto-completes Discord quests via Discord's own REST endpoints. **No browser, no Puppeteer, no Chromium** — pure HTTP, Docker-friendly, ~180MB image instead of ~2GB.

**v3.5.1:** 🔐 security hardening — no token/cookie values in server logs · monitor token sealed at rest with AES-256-GCM (`monitor.json` never contains plaintext) · `/api/debug` off by default & requires login (+ optional `DEBUG_KEY`). Zero UI changes.

**v3.5.0:** 🌗 dark/light theme toggle · 🔓 open source (this repo) — your token never leaves your server · ✨ brand badge logo + animated RGB panel borders · 📄 Terms of Service & Privacy Policy pages.

**v3.4.0:** 🎖️ brand badge logo everywhere (incl. favicon) · 🌈 animated full-spectrum RGB panel borders · 🛡️ privacy policy states "We do not collect any data related to you".

**v3.3.0:** 🧹 minimal clean UI overhaul (toggle → Start All → quest list with queue numbering) · TOS + Privacy pages · repo cleanup.

**v3.2.0:** 🎬 video-quest fix (auto-fallback to heartbeat) · 📡 24h Auto-Monitor · 🐳 Coolify support (persistent volume + dynamic `$PORT`) · 🧪 E2E test suite with a mock Discord.

**v3.1.0:** ⏱️ live real-time timers · 🚀 `Start All` sequential queue · 📝 auto-accept · 🛡️ 100% tab-close-proof (server-side) · 🔄 session/queue restore on page reopen.

> ⚠️ Educational purpose only. Automating quests violates Discord ToS and Discord has been suspending quest access of accounts caught automating (Aug 2026). Use at your own risk.

## Token safety — why you can trust this code

The app is **fully open source and self-hosted**. Your Discord token is sent only to the server **you** deploy (Railway, Coolify, your own VPS — your choice). There is no central server, no analytics, no telemetry, and no account sign-up. Read every line yourself: this repository is the complete source. Deploy it privately and your token stays yours.

### Where the token lives (and doesn't)

| Place | How it's handled |
|---|---|
| Database | **Never stored** — the Prisma schema has no token field at all. |
| Server logs | **Never logged** — no token fragments, no cookie values, no session IDs (v3.5.1). |
| Browser | `httpOnly` + `sameSite=lax` + `secure` (production) cookie — unreadable to JavaScript. |
| Server memory | In-memory session map only, needed to run the engine. Wiped on restart. |
| Disk (`data/monitor.json`, only if you enable the 24h monitor) | **Sealed with AES-256-GCM** — the plaintext token is never written. Key comes from `MONITOR_ENCRYPTION_KEY` (env) or an auto-generated `data/.monitor-key` (mode 0600, git-ignored). |
| Discord API | The only network destination — the engine talks directly to `https://discord.com/api/v10` (override via `DISCORD_API_BASE` for tests). No webhooks, no third-party URLs, no telemetry — grep the code, there are none. |

Additional hardening in v3.5.1: `/api/debug` is disabled by default (404) and, when enabled via `DEBUG_ENABLED=true`, still requires login cookies and an optional `x-debug-key` header — and its responses never include tokens. Turning the monitor off wipes the stored (already-encrypted) token from disk.

## The Method (live-verified 2026-10-12)

Reverse-engineered from Discord's own web client (`/assets/web.*.js`) and verified end-to-end against production:

| Endpoint | Purpose |
|---|---|
| `GET  /api/v10/quests/@me` | List quests + real progress (`user_status.progress.<TASK>.value`) |
| `POST /api/v10/quests/{id}/enroll` | Enroll a quest — body `{ "location": 11 }` (11 = QUEST_HOME_DESKTOP) |
| `POST /api/v10/quests/{id}/heartbeat` | **The core**: body `{ "stream_key": "call:<channelId>:1", "terminal": false }` |
| `POST /api/v10/quests/{id}/video-progress` | Video quests: body `{ "timestamp": <sec> }` |
| `POST /api/v10/quests/{id}/claim-reward` | Body `{ "platform": 0, "location": 11 }` — usually requires hCaptcha |

### How the heartbeat trick works (empirically mapped)

```
beat #1 ──────── beat #2 ──────── beat #3
  t=0               t=25s             t=50s      → progress = full elapsed time
```

- The server credits **full wall-clock time between consecutive beats** — you don't need to actually play/stream anything.
- The gap must stay inside the **credit window (~2 min)**: 100s gaps ✅ credited, 150s gaps ❌ zeroed.
- Engine beats every **90s** (safe margin), reads authoritative progress from each response, and sends a **terminal beat** when the target is reached. Discord then sets `completed_at` itself.
- Verified live: Apex VS SF6 quest completed 0 → 900/900 on 2026-10-12.
- `stream_key` uses any DM channel id (`call:<dmChannelId>:1`); guild voice channel ids also work; final fallback = quest id.
- Video quests accept client-reported timestamps directly (jump to target).
- Reward claiming is gated by **hCaptcha** → claim inside the Discord app/web client.

## Why the old Puppeteer method failed

The v2 code launched headless Chromium, logged in with the token, hooked the gateway WebSocket and sent `op:3 PRESENCE_UPDATE` with a fake game activity. **Discord's quest system does not track presence updates at all** — quest progress only accumulates from `/heartbeat` calls. Presence spoofing changes your status text; it never moves quest progress. That's why every session showed 0% forever.

Other bugs fixed in v3:
- Wrong quest list endpoint (`/users/@me/quests` → 404). Correct: **`/quests/@me`**.
- `completed_at` compared as `typeof number` but Discord returns ISO strings → completed quests never detected.
- Progress read from `stream_progress_seconds` (always 0 for desktop quests) instead of `user_status.progress.<TASK>.value`.
- `user_status.is_claimed` doesn't exist → real field is `claimed_at`.

## Quick start (Docker)

```bash
docker compose up -d --build
# open http://localhost:3000
```

Login with your Discord token, pick a quest, hit Start — or hit **Start All**. The engine enrolls (if needed), heartbeats every 90s, and auto-completes. A 15-min quest takes 15 min of server time (progress = real elapsed time — that's Discord's server-side rule).

### What v3.1.0 adds

- **⏱️ Live timers** — the UI ticks elapsed/remaining every second between 3s server polls, so the countdown actually moves. (Previously the API never returned the formatted fields the UI read, so the timer stayed frozen at 15:00.)
- **🚀 Start All** — one click queues every completable quest and runs them **one after another** on the server, with a live queue panel (current quest + pending + completed + failed).
- **📝 Auto-accept** — any unaccepted quest is enrolled automatically when its turn comes (single quests and queue both).
- **🛡️ Tab-close-proof** — quests run as server-side intervals in the Node process. Close the tab, log out, shut your PC: nothing stops until *you* press Stop/Cancel (or the quest completes).
- **🔄 Restore** — the session/queue id is kept in `localStorage`; reopening the page reattaches the UI to the still-running server-side quest/queue with correct live timers.

### What v3.2.0 adds

- **🎬 Video quest fix** — if Discord rejects `/video-progress` (the "accepted but never completes" bug), the engine now logs the full error body, fails fast, and **automatically falls back to the verified heartbeat method** (`stream_key`) so the quest still completes. Integer timestamps + server-reported progress preferred.
- **📡 24h Auto-Monitor** — after login, toggle **Monitor ON** in the UI. The server then checks for new quests **every 24 hours**, auto-accepts and completes whatever it finds (sequential queue), and records a run history with a live next-run countdown. Survives redeploys/restarts via `$DATA_DIR/monitor.json` (mount `/app/data` as a volume). `runNow` button for instant cycles.
- **🐳 Coolify support** — health check honors dynamic `$PORT`, `/app/data` is a persistent volume mount point, `docker-compose.yml` ships with a named volume. Works on Railway unchanged.
- **🧪 E2E test suite** — `scripts/mock-discord.js` emulates Discord's quest endpoints (including rejections); `scripts/test-e2e.mjs` runs 34 assertions across login, video happy-path, video-rejected→heartbeat-fallback, monitor cycles, persistence across restart, and Start All.

## Quick start (no Docker)

```bash
npm install        # postinstall auto-runs `prisma generate`
npm run build
npm start        # listens on :3000
```

## API

Web UI drives these; they're also callable directly:

```
POST /api/token            { token }              # login (validates via /users/@me)
GET  /api/quests                                  # quest list w/ correct statuses
POST /api/quest/start      { questId }             # enroll + start heartbeat session
POST /api/quest/start-all  { }                     # 🚀 queue ALL quests — one-by-one, auto-accept
GET  /api/quest/start-all?queueId=...             # queue status (current/pending/completed/failed)
DELETE /api/quest/start-all?queueId=...           # cancel queue + current quest
GET  /api/quest/status?sessionId=...              # progress (server-verified) + MM:SS timers
GET  /api/quest/status                            # 🔄 restore: my active sessions + queues
DELETE /api/quest/cancel?sessionId=...            # stop session (progress preserved)
GET  /api/quest/monitor                           # 📡 monitor status + history + next-run countdown
POST /api/quest/monitor     { enabled: true, intervalHours?: 24 }  # enable the 24h monitor
POST /api/quest/monitor     { enabled: false }                     # disable
POST /api/quest/monitor     { runNow: true }                       # trigger a cycle immediately
DELETE /api/quest/monitor                          # wipe monitor (disable + clear history)
GET  /api/quest/discord-verify?questId=...        # raw Discord verification
GET  /api/health                                   # healthcheck
```

v1 API-key variants live under `/api/v1/quests/:id/{start,status,cancel}` (header `x-api-key`).

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `QUEST_HEARTBEAT_INTERVAL_MS` | `90000` | Beat cadence — keep < 120000 |
| `QUEST_VIDEO_TICK_MS` | `1100` | Video quest timestamp cadence |
| `DISCORD_API_BASE` | `https://discord.com/api/v10` | API base |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Monitor state storage — **mount as a volume** |

## Deploying on Coolify (your own server)

The repo is Coolify-ready out of the box — data stays on your machine:

1. **New Resource → Dockerfile** build pack (the repo's `Dockerfile` is detected automatically).
2. **Port**: leave auto — the container health check honors `$PORT`, so Coolify's dynamic port mapping works.
3. **Persistent volume (important!)**: add a volume mounted at **`/app/data`** — this is where the 24h monitor stores its state (`monitor.json`). Without it, every redeploy turns the monitor off.
4. **Health check path**: `/api/health` (auto-detected from the Dockerfile).
5. Deploy → open the URL → login with your Discord token → enable **Monitor**.

Docker-compose alternative (for a plain VPS):

```bash
docker compose up -d --build      # data persists in the `quest-data` volume
```

Railway: unchanged — add a volume mounted at `/app/data` to keep the monitor across deploys.

## Testing (mock Discord — no real account needed)

```bash
bash scripts/test-run.sh           # build + mock Discord + app + 34 E2E assertions
```

Covers: login · quest list · video quest happy path · **video-rejected → heartbeat fallback** · 24h monitor cycle + history · monitor persistence across restart · Start All sequential queue.

## Deployment notes

- Sessions/queues are in-memory → run as a **long-lived process** (Docker/VPS/Railway), not serverless. On serverless (Vercel), the process freezes between requests — the server-side engine needs a long-lived container.
- One session per quest at a time; one running queue per user; per-quest safety timeout = target + 10 min so a stuck session can't hang the queue.
- Progress persists on **Discord's** side even if you restart the container — start the quest again and it resumes from Discord's saved progress (`user_status.progress.<TASK>.value`).
- Rate-limit aware: handles HTTP 429 with retry-after backoff.
