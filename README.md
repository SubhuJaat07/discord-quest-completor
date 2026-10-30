# Discord Quest Completor

Auto-complete Discord quests via Discord's own REST API. **No browser, no Puppeteer, no Chromium** — pure HTTP, a ~180 MB Docker image, and quests that keep running server-side after you close the tab.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/github-repo?repo=https%3A%2F%2Fgithub.com%2FSubhuJaat07%2Fdiscord-quest-completor)
[![Use the hosted version](https://img.shields.io/badge/No_server_of_your_own%3F-Use_the_hosted_version-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord-quest.ophelia.website)

![Next.js](https://img.shields.io/badge/Next.js_16-000000?style=flat&logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)

> ⚠️ **Educational purposes only.** Automating quests violates Discord's Terms of Service, and Discord has been suspending quest access of accounts caught automating (Aug 2026). Use at your own risk.

## Features

- **⚡ Direct REST engine** — talks straight to Discord's quest endpoints. Nothing to install, nothing heavy to run.
- **🛡️ 100 % server-side** — start a quest, close the tab, log out, switch off your PC. The engine keeps beating on the server until the quest completes.
- **🚀 Start All** — one click queues every completable quest and runs them one after another, with a live queue panel.
- **📝 Auto-accept** — unaccepted quests are enrolled automatically when their turn comes.
- **🏅 Quests badge** — complete a quest and Discord auto-grants the Quests badge to your profile through its own telemetry. No badge page needed (and none exists): badges are passive awards, not something a site can claim.
- **📡 24 h Auto-Monitor** — optionally let the server check for new quests every 24 hours and complete them while you sleep. State survives redeploys (encrypted on disk + optional Supabase restore).
- **🌗 Dark / light theme**, live timers, session restore on page reopen, rate-limit-aware fetch with backoff.

## How it works

Reverse-engineered from Discord's own web client and verified end-to-end against production (2026-10-12):

| Endpoint | Purpose |
|---|---|
| `GET  /api/v10/quests/@me` | List quests + real progress (`user_status.progress.<TASK>.value`) |
| `POST /api/v10/quests/{id}/enroll` | Enroll a quest — body `{ "location": 11 }` (11 = QUEST_HOME_DESKTOP) |
| `POST /api/v10/quests/{id}/heartbeat` | **The core**: body `{ "stream_key": "call:<channelId>:1", "terminal": false }` |
| `POST /api/v10/quests/{id}/video-progress` | Video quests: body `{ "timestamp": <sec> }` |
| `POST /api/v10/quests/{id}/claim-reward` | Body `{ "platform": 0, "location": 11 }` — usually requires hCaptcha |

The heartbeat endpoint credits **full wall-clock time between consecutive beats**:

```
beat #1 ──────── beat #2 ──────── beat #3
  t=0               t=25s             t=50s      → progress = full elapsed time
```

- Gaps must stay inside the credit window (~2 min): 100 s gaps are credited, 150 s gaps are zeroed. The engine beats every **90 s** (safe margin).
- Progress is read authoritatively from each beat's response; when the target is reached a terminal beat closes the quest and Discord itself sets `completed_at`.
- `stream_key` works with any DM channel id (`call:<dmChannelId>:1`); guild voice channel ids also work.
- Video quests accept client-reported timestamps; if Discord rejects them, the engine automatically falls back to the heartbeat method.
- Reward claiming is gated by hCaptcha — claim inside the Discord app/web client.
- Progress lives on **Discord's** side: restart the container mid-quest and the engine resumes from Discord's saved progress.

## Token safety

The app is **fully open source and self-hosted**. Your Discord token is sent only to the server **you** deploy. There is no central server, no database, no analytics, no telemetry, and no account sign-up. Read every line yourself — this repository is the complete source.

| Place | How it's handled |
|---|---|
| Database | **There is none.** The app ships with zero database and zero config — deploy and go. |
| Server logs | **Never logged** — no token fragments, no cookie values, no session IDs. |
| Browser | `httpOnly` + `sameSite=lax` + `secure` (production) cookie — unreadable to JavaScript. |
| Server memory | In-memory session map, only while the engine runs. Wiped on restart. |
| Disk (only if you enable the 24 h monitor) | **Sealed with AES-256-GCM** — the plaintext token is never written. Key from `MONITOR_ENCRYPTION_KEY` (env) or an auto-generated `data/.monitor-key` (mode 0600, git-ignored). |
| Network | Discord's API is the **only** destination — `https://discord.com/api/v10` (overridable via `DISCORD_API_BASE` for tests). No webhooks, no third-party URLs, no telemetry. |

Additional hardening: `/api/debug` is disabled by default (404) and, when enabled via `DEBUG_ENABLED=true`, still requires login cookies and an optional `x-debug-key` header. Turning the monitor off wipes the stored (already-encrypted) token from disk.

## Quick start

**Railway (one click):** press the deploy button at the top, then add a volume mounted at `/app/data` to keep the 24 h monitor across deploys.

**Docker:**

```bash
docker compose up -d --build
# open http://localhost:3000
```

**Any VPS / Coolify:** Dockerfile build pack, dynamic `$PORT` supported, mount a volume at `/app/data`, health check on `/api/health`.

**Local:**

```bash
npm install
npm run build
npm start        # listens on :3000
```

Login with your Discord token, pick a quest, hit **Start** — or hit **Start All**. A 15-minute quest takes 15 minutes of server time; that's Discord's own server-side rule, not a limitation of this tool.

## API

The web UI drives these endpoints; they're also callable directly:

```
POST   /api/token                       { token }            # login (validates via /users/@me)
DELETE /api/token                                            # logout (clears cookies)
GET    /api/token                                            # login status
GET    /api/quests                                            # quest list with correct statuses
POST   /api/quest/start                 { questId }           # enroll + start a session
GET    /api/quest/start?sessionId=...                         # poll session status
DELETE /api/quest/start?sessionId=...                         # cancel session
POST   /api/quest/start-all             { }                   # queue ALL quests — one-by-one
GET    /api/quest/start-all?queueId=...                       # queue status
DELETE /api/quest/start-all?queueId=...                       # cancel queue + current quest
GET    /api/quest/status?sessionId=...                        # progress (server-verified)
GET    /api/quest/status                                       # restore: my sessions + queues
DELETE /api/quest/cancel?sessionId=...                        # stop session (progress preserved)
GET    /api/quest/discord-verify?questId=...                  # raw Discord verification
GET    /api/quest/monitor                                      # monitor status + history
POST   /api/quest/monitor               { enabled: true, intervalHours?: 24 }
POST   /api/quest/monitor               { runNow: true }      # trigger a cycle immediately
DELETE /api/quest/monitor                                     # wipe monitor
GET    /api/health                                            # healthcheck
```

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `QUEST_HEARTBEAT_INTERVAL_MS` | `90000` | Beat cadence — keep < 120000 |
| `QUEST_VIDEO_TICK_MS` | `1100` | Video quest timestamp cadence |
| `DISCORD_API_BASE` | `https://discord.com/api/v10` | API base (override only for tests) |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Monitor state storage — **mount as a volume** |
| `MONITOR_ENCRYPTION_KEY` | auto-generated key file | AES-256-GCM key for the sealed monitor token |
| `DEBUG_ENABLED` / `DEBUG_KEY` | `false` / unset | Enables + locks `/api/debug` (login + header) |

## Testing

No real Discord account needed — the suite runs against a mock Discord:

```bash
npm test          # build + mock Discord + app + 34 E2E assertions
```

Covers: login · quest list · video quest happy path · video-rejected → heartbeat fallback · 24 h monitor cycle + history · monitor persistence (encrypted) across restart · Start All sequential queue.

## Deployment notes

- Sessions and queues are **in-memory** → run as a long-lived process (Docker / VPS / Railway), not serverless. The engine needs a live container.
- One session per quest at a time; one running queue per user; per-quest safety timeout = target + 10 min so a stuck session can't hang the queue.
- The engine is rate-limit aware — HTTP 429 responses are retried with `retry-after` backoff.
