#!/usr/bin/env node
/**
 * Mock Supabase (PostgREST subset) for E2E tests — no real Supabase needed.
 *
 * Implements what src/lib/state-store.ts, badge-store.ts and badge-tasks.ts use:
 *   monitor_state:
 *     GET    /rest/v1/monitor_state?id=eq.singleton&select=...  → [row] | []
 *     POST   /rest/v1/monitor_state  (Prefer: merge-duplicates) → upsert, 201
 *     DELETE /rest/v1/monitor_state?id=eq.singleton             → 204
 *   badge_completions (v3.9.0):
 *     GET    /rest/v1/badge_completions?user_id=eq.<id>&select=... → [rows]
 *     POST   /rest/v1/badge_completions  (Prefer: merge-duplicates) → upsert, 201
 *     DELETE /rest/v1/badge_completions?user_id=eq.<id>&badge_id=eq.<b> → 204
 *   badge_tasks (v3.10.0):
 *     GET    /rest/v1/badge_tasks?user_id=eq.<id>&select=... → [rows]
 *            GET /rest/v1/badge_tasks?status=eq.running&select=... → [rows]
 *     POST   /rest/v1/badge_tasks  (Prefer: merge-duplicates) → upsert, 201
 *     DELETE /rest/v1/badge_tasks?user_id=eq.<id>&badge_id=eq.<b> → 204
 *   rpc exec_sql (cutiee pattern):
 *     POST   /rest/v1/rpc/exec_sql  {query: "CREATE TABLE IF NOT EXISTS ..."}
 *            → registers the table (regex on table name) → 200 "OK"
 *
 * Auth mirrors Supabase: `apikey` + `Authorization: Bearer <key>` headers
 * must match API_KEY. Rows are mirrored to STORE_FILE so tests can assert
 * exactly what was persisted (and prove the token is ciphertext-only).
 *
 * Env: PORT (9870) · API_KEY (test-service-key) · STORE_FILE (/tmp/mock-supabase-store.json)
 */
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 9870)
const API_KEY = process.env.API_KEY || 'test-service-key'
const STORE_FILE = process.env.STORE_FILE || '/tmp/mock-supabase-store.json'

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) } catch { return {} }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}
function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

/** Parse PostgREST `col=eq.value` filters. */
function filters(url) {
  const out = {}
  for (const [k, v] of url.searchParams.entries()) {
    if (v.startsWith('eq.')) out[k] = v.slice(3)
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
      catch { resolve(null) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (!url.pathname.startsWith('/rest/v1/')) {
    return json(res, 404, { message: 'not found' })
  }

  // ---- auth gate (mirrors Supabase) ----
  const key = req.headers['apikey'] || ''
  const auth = req.headers['authorization'] || ''
  if (key !== API_KEY || auth !== `Bearer ${API_KEY}`) {
    return json(res, 401, { message: 'Invalid API key' })
  }

  // ---- rpc exec_sql (cutiee pattern, v3.10.0) ----
  // Registers a table so later REST calls on it succeed — good enough to
  // prove the db-init RPC path issues idempotent CREATE TABLE IF NOT EXISTS.
  if (url.pathname === '/rest/v1/rpc/exec_sql' && req.method === 'POST') {
    const body = await readBody(req)
    const query = typeof body?.query === 'string' ? body.query : ''
    const m = query.match(/create\s+table\s+if\s+not\s+exists\s+([a-z_]+)/i)
    if (m) {
      const store = loadStore()
      store.created_tables = store.created_tables ?? []
      if (!store.created_tables.includes(m[1])) store.created_tables.push(m[1])
      saveStore(store)
    }
    return json(res, 200, 'OK')
  }

  const table = url.pathname.slice('/rest/v1/'.length)

  // ================= monitor_state =================
  if (table === 'monitor_state') {
    const idFilter = url.searchParams.get('id') // "eq.singleton"

    if (req.method === 'GET') {
      const store = loadStore()
      const rows = idFilter === 'eq.singleton' ? (store.singleton ? [store.singleton] : []) : Object.values(store)
      return json(res, 200, rows)
    }

    if (req.method === 'POST') {
      const row = await readBody(req)
      if (!row || !row.id) return json(res, 400, { message: 'bad json' })
      const store = loadStore()
      store.singleton = { ...store.singleton, ...row }
      saveStore(store)
      return json(res, 201, [row])
    }

    if (req.method === 'DELETE') {
      const store = loadStore()
      if (idFilter === 'eq.singleton' && store.singleton) {
        delete store.singleton
        saveStore(store)
      }
      res.writeHead(204)
      return res.end()
    }
  }

  // ================= badge_completions (v3.9.0) =================
  if (table === 'badge_completions') {
    const f = filters(url)
    const store = loadStore()
    const badges = store.badge_completions ?? {}

    if (req.method === 'GET') {
      // PostgREST-faithful: every `col=eq.value` filter applies (AND)
      const rows = Object.values(badges).filter((r) =>
        Object.entries(f).every(([k, v]) => r[k] === v)
      )
      return json(res, 200, rows)
    }

    if (req.method === 'POST') {
      const row = await readBody(req)
      if (!row || !row.user_id || !row.badge_id) return json(res, 400, { message: 'bad json' })
      badges[`${row.user_id}:${row.badge_id}`] = { ...row }
      store.badge_completions = badges
      saveStore(store)
      return json(res, 201, [row])
    }

    if (req.method === 'DELETE') {
      for (const [k, r] of Object.entries(badges)) {
        if ((!f.user_id || r.user_id === f.user_id) && (!f.badge_id || r.badge_id === f.badge_id)) {
          delete badges[k]
        }
      }
      store.badge_completions = badges
      saveStore(store)
      res.writeHead(204)
      return res.end()
    }
  }

  // ================= badge_tasks (v3.10.0) =================
  if (table === 'badge_tasks') {
    const f = filters(url)
    const store = loadStore()
    const tasks = store.badge_tasks ?? {}

    if (req.method === 'GET') {
      // PostgREST-faithful: every `col=eq.value` filter applies (AND)
      let rows = Object.values(tasks)
      rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v))
      return json(res, 200, rows)
    }

    if (req.method === 'POST') {
      const row = await readBody(req)
      if (!row || !row.user_id || !row.badge_id) return json(res, 400, { message: 'bad json' })
      tasks[`${row.user_id}:${row.badge_id}`] = { ...tasks[`${row.user_id}:${row.badge_id}`], ...row }
      store.badge_tasks = tasks
      saveStore(store)
      return json(res, 201, [row])
    }

    if (req.method === 'DELETE') {
      for (const [k, r] of Object.entries(tasks)) {
        if ((!f.user_id || r.user_id === f.user_id) && (!f.badge_id || r.badge_id === f.badge_id)) {
          delete tasks[k]
        }
      }
      store.badge_tasks = tasks
      saveStore(store)
      res.writeHead(204)
      return res.end()
    }
  }

  return json(res, 404, { message: 'not found' })
})

saveStore({})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock supabase listening on :${PORT} (store: ${STORE_FILE})`)
})
