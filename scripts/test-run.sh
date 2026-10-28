#!/usr/bin/env bash
# ============================================================
# Full E2E test run: build → mock Discord → app → tests
# Usage: bash scripts/test-run.sh
# ============================================================
set -e
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
MOCK_PORT="${MOCK_PORT:-9999}"
DATA_DIR="${DATA_DIR:-./data}"

echo "── [1/5] Installing deps (if needed)…"
if [ ! -d node_modules ]; then
  (command -v bun >/dev/null 2>&1 && bun install) || npm ci --ignore-scripts || npm install --ignore-scripts
  npx prisma generate || true
fi

echo "── [2/5] Building Next.js standalone…"
npm run build

echo "── [3/5] Starting mock Discord on :${MOCK_PORT}…"
node scripts/mock-discord.js &
MOCK_PID=$!
trap 'kill $MOCK_PID $APP_PID 2>/dev/null || true' EXIT
sleep 1

echo "── [4/5] Starting app on :${PORT} (DISCORD_API_BASE → mock)…"
rm -rf "$DATA_DIR"
DISCORD_API_BASE="http://127.0.0.1:${MOCK_PORT}/api/v10" \
QUEST_HEARTBEAT_INTERVAL_MS=3000 \
QUEST_VIDEO_TICK_MS=400 \
DATA_DIR="$DATA_DIR" \
PORT=$PORT \
HOSTNAME=127.0.0.1 \
node .next/standalone/server.js &
APP_PID=$!

# wait for health
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "   app is healthy ✅"

echo "── [5/5] Running E2E tests…"
node scripts/test-e2e.mjs
STATUS=$?

echo ""
echo "Done. (mock pid $MOCK_PID, app pid $APP_PID were stopped)"
exit $STATUS
