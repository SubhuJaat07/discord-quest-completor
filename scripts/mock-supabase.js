#!/usr/bin/env node
/**
 * Mock Supabase (PostgREST subset) for E2E tests — no real Supabase needed.
 *
 * Implements what src/lib/state-store.ts uses:
 *   monitor_state:
 *     GET    /rest/v1/monitor_state?id=eq.singleton&select=...  → [row] | []
 *     POST   /rest/v1/monitor_state  (Prefer: merge-duplicates) → upsert, 201
 *     DELETE /rest/v1/monitor_state?id=eq.singleton             → 204
 *   rpc exec_sql (cutiee pattern):
 *     POST   /rest/v1/rpc/exec_sql  {query: "CREATE TABLE IF NOT EXISTS ..."}
 *            → registers the table (regex on table name) → 200 "OK"
 *
 * (v3.11.4 — the badge_completions / badge_tasks handlers are gone with
 * the /badge page; the app keeps no badge tables.)
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

  return json(res, 404, { message: 'not found' })
})

saveStore({})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock supabase listening on :${PORT} (store: ${STORE_FILE})`)
})
