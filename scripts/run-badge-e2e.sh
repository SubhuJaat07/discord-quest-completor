#!/usr/bin/env bash
# ============================================================
# Badge engine E2E runner — starts the full mock stack + app,
# runs scripts/test-badge-engine.mjs, tears everything down.
# Uses PORT 3100 so a stray zombie server on :3000 can never
# poison the results (the standalone server retitles its process
# to "next-server", which makes pkill unreliable).
# Usage: bash scripts/run-badge-e2e.sh
# ============================================================
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-3100}"
LOG_DIR="/tmp/badge-e2e"
mkdir -p "$LOG_DIR"

# clean state — NOTE: the standalone server chdirs to .next/standalone, so
# the REAL default data dir is .next/standalone/data, NOT ./data
rm -rf ./data .next/standalone/data /tmp/mock-supabase-store.json
pkill -f 'mock-discord.js' 2>/dev/null
pkill -f 'mock-supabase.js' 2>/dev/null
pkill -f 'standalone/server.js' 2>/dev/null
pkill -f 'next-server' 2>/dev/null   # standalone retitles itself — this is the one that matters
sleep 1

echo "── starting mock discord (:9999) + mock supabase (:9870)"
node scripts/mock-discord.js   > "$LOG_DIR/mock-discord.log"   2>&1 &
MOCK_D=$!
node scripts/mock-supabase.js  > "$LOG_DIR/mock-supabase.log"  2>&1 &
MOCK_S=$!
sleep 2

echo "── starting app (:$PORT)"
DISCORD_API_BASE="http://127.0.0.1:9999/api/v10" \
SUPABASE_URL="http://127.0.0.1:9870" \
SUPABASE_SERVICE_KEY="test-service-key" \
MONITOR_ENCRYPTION_KEY="test-key-1234567890" \
QUEST_HEARTBEAT_INTERVAL_MS="3000" \
QUEST_VIDEO_TICK_MS="400" \
DATA_DIR="./data" \
PORT="$PORT" \
node .next/standalone/server.js > "$LOG_DIR/app.log" 2>&1 &
APP=$!
sleep 10

echo "── app boot log:"
head -12 "$LOG_DIR/app.log"

echo "── running badge E2E"
APP_URL="http://127.0.0.1:$PORT" node scripts/test-badge-engine.mjs
EXIT=$?

echo "── app log tail:"
tail -30 "$LOG_DIR/app.log"

kill $MOCK_D $MOCK_S $APP 2>/dev/null
pkill -f 'next-server' 2>/dev/null
wait 2>/dev/null
exit $EXIT
