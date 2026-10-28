#!/usr/bin/env bash
# ============================================================
# Badge UI browser check — full flow in ONE call (the sandbox
# reaps background processes seconds after a tool call ends,
# so the stack + browser steps must live in this single script).
# Usage: bash scripts/ui-badge-check.sh
# ============================================================
set -u
cd /home/z/my-project/repo-clone

OUT=/home/z/my-project/download
mkdir -p "$OUT"

# clean state
rm -rf ./data .next/standalone/data /tmp/mock-supabase-store.json
pkill -f 'mock-discord.js' 2>/dev/null
pkill -f 'mock-supabase.js' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
sleep 1

echo "── stack up"
(cd /home/z/my-project/repo-clone && exec node scripts/mock-discord.js  > /tmp/mock-d.log 2>&1) &
(cd /home/z/my-project/repo-clone && exec node scripts/mock-supabase.js > /tmp/mock-s.log 2>&1) &
(cd /home/z/my-project/repo-clone && exec env \
  DISCORD_API_BASE="http://127.0.0.1:9999/api/v10" \
  SUPABASE_URL="http://127.0.0.1:9870" \
  SUPABASE_SERVICE_KEY="test-service-key" \
  MONITOR_ENCRYPTION_KEY="test-key-1234567890" \
  QUEST_HEARTBEAT_INTERVAL_MS="3000" \
  QUEST_VIDEO_TICK_MS="400" \
  DATA_DIR="./data" PORT="3100" \
  node .next/standalone/server.js > /tmp/app-ui.log 2>&1) &
sleep 8

echo "── login"
agent-browser open http://127.0.0.1:3100 >/dev/null 2>&1
sleep 2
TOKEN_BOX=$(agent-browser snapshot -i 2>/dev/null | grep -oE 'textbox "Discord token" \[ref=e[0-9]+\]' | grep -oE 'e[0-9]+' | head -1)
agent-browser fill "@${TOKEN_BOX}" "MTIzNDU2Nzg5MDEyMzQ1Njc4.mocktest.hmac123" >/dev/null 2>&1
agent-browser find role button click --name "Connect" >/dev/null 2>&1
sleep 4

echo "── badge page"
agent-browser open http://127.0.0.1:3100/badge >/dev/null 2>&1
sleep 6
agent-browser screenshot "$OUT/badge-ui-1-cards.png" --full 2>&1 | tail -1

echo "── snapshot (card structure)"
agent-browser snapshot 2>/dev/null | grep -E 'heading|button|progressbar|Quest|Game|Stream|Account|Orbs|Available|Auto|Shop|Completed|Running' | head -40

echo "── click Complete on Game Variety"
agent-browser find role button click --name "Complete" 2>&1 | tail -1
sleep 3
agent-browser screenshot "$OUT/badge-ui-2-running.png" --full 2>&1 | tail -1

echo "── wait for engine quest + tier (~35s)"
sleep 35
agent-browser reload >/dev/null 2>&1
sleep 5
agent-browser screenshot "$OUT/badge-ui-3-after.png" --full 2>&1 | tail -1

echo "── final card states"
agent-browser snapshot 2>/dev/null | grep -E 'Game Variety|Sampler|Engine:|earned|Completed|Running|Waiting' | head -15

echo "── console errors"
agent-browser errors 2>&1 | head -10

echo "── teardown"
pkill -f 'mock-discord.js' 2>/dev/null
pkill -f 'mock-supabase.js' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
echo done
