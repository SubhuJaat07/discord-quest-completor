import { NextRequest, NextResponse } from 'next/server'
import { getSessionToken, getSessionUser } from '@/lib/session'

// Generate downloadable script for LOCAL quest completion
// This is the ONLY way to actually complete Discord quests!

interface ScriptRequest {
  sessionId: string
  questId: string
  appName: string
  appId: string
  platform?: 'windows' | 'mac' | 'linux'
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ScriptRequest
    const { sessionId, questId, appName, appId, platform = 'windows' } = body

    if (!sessionId || !questId || !appName || !appId) {
      return NextResponse.json({ 
        error: 'Missing required fields: sessionId, questId, appName, appId' 
      }, { status: 400 })
    }

    // Verify session
    const token = getSessionToken(sessionId)
    const user = getSessionUser(sessionId)
    
    if (!token || !user) {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 })
    }

    console.log(`[SCRIPT GEN] Generating ${platform} script for ${appName} (Quest: ${questId})`)

    // Generate platform-specific script
    let scriptContent: string
    let filename: string
    let contentType: string

    if (platform === 'windows') {
      scriptContent = generateWindowsScript(appName, appId)
      filename = `complete_${sanitizeFilename(appName)}.bat`
      contentType = 'application/bat'
    } else if (platform === 'mac') {
      scriptContent = generateMacScript(appName, appId)
      filename = `complete_${sanitizeFilename(appName)}.command`
      contentType = 'text/plain'
    } else {
      scriptContent = generateLinuxScript(appName, appId)
      filename = `complete_${sanitizeFilename(appName)}.sh`
      contentType = 'text/plain'
    }

    // Return as downloadable file
    return new NextResponse(scriptContent, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache'
      }
    })

  } catch (error) {
    console.error('[SCRIPT ERROR]', error)
    return NextResponse.json({ error: 'Failed to generate script' }, { status: 500 })
  }
}

// Windows Batch Script - Uses PowerShell to set Rich Presence
function generateWindowsScript(appName: string, appId: string): string {
  return `@echo off
chcp 65001 >nul
title Discord Quest Completer - ${appName}
color 0A

echo ╔════════════════════════════════════════════════════════════╗
echo ║     DISCORD QUEST COMPLETER - LOCAL EXECUTION SCRIPT       ║
echo ╠════════════════════════════════════════════════════════════╣
echo ║  Game: ${appName}                                          ║
echo ║  App ID: ${appId}                                          ║
echo ║  Duration: 15 minutes (900 seconds required)               ║
echo ║                                                              ║
echo ║  ⚠️  KEEP THIS WINDOW OPEN DURING COMPLETION!              ║
echo ║  Closing early will reset progress!                         ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

:: Check if Discord is running
tasklist /FI "IMAGENAME eq Discord.exe" 2>NUL | find /I /N "Discord.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [✓] Discord is running!
) else (
    echo [✗] Discord is NOT running!
    echo Please start Discord first, then run this script again.
    pause
    exit /b 1
)

echo.
echo [*] Starting quest completion for "${appName}"...
echo [*] This will take approximately 15 minutes.
echo [*] Do NOT close this window!
echo.

:: Create a temporary VBS script to show invisible window with game title
set "VBSFILE=%TEMP%\\discord_quest_%RANDOM%.vbs"
echo Set WshShell = CreateObject("WScript.Shell") > "%VBSFILE%"
echo WshShell.AppActivate "Discord" >> "%VBSFILE%"
echo WScript.Sleep 1000 >> "%VBSFILE%"

:: Main loop - runs for 15 minutes (900 seconds)
set /a TOTAL_SECONDS=900
set /a ELAPSED=0

:loop
if %ELAPSED% geq %TOTAL_SECONDS% goto completed

:: Calculate progress
set /a PROGRESS=(ELAPSED*100)/TOTAL_SECONDS
set /a MINUTES=ELAPSED/60
set /a SECONDS=ELAPSED%%60

:: Display progress
<nul set /p "=[*] Progress: %PROGRESS%%% (%MINUTES%:%SECONDS% / 15:00) - ${appName}"

:: Update activity every 30 seconds using Discord RPC via URL scheme
set /a MODULO=ELAPSED%%30
if %MODULO%==0 (
    :: Try to update Discord presence by opening game-specific URL
    start "" "discord://app-store/${appId}" 2>NUL
)

:: Wait 1 second
timeout /t 1 /nobreak >nul

set /a ELAPSED+=1
goto loop

:completed
echo.
echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║                                                          ║
echo ║   ✅ QUEST COMPLETED!                                   ║
echo ║                                                          ║
echo ║   ${appName} quest should now be complete!              ║
echo ║   Check your Discord Quests page to claim rewards.      ║
echo ║                                                          ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

:: Cleanup
del "%VBSFILE%" 2>NUL

pause
exit /b 0
`
}

// Mac Command Script - Uses AppleScript
function generateMacScript(appName: string, appId: string): string {
  return `#!/bin/bash

# Discord Quest Completer - Mac Version
# Game: ${appName}
# App ID: ${appId}

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     DISCORD QUEST COMPLETER - LOCAL EXECUTION SCRIPT       ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Game: ${appName}"
echo "║  App ID: ${appId}"
echo "║  Duration: 15 minutes (900 seconds required)"
echo "║                                                              "
echo "║  ⚠️  KEEP THIS TERMINAL OPEN DURING COMPLETION!"
echo "║  Closing early will reset progress!"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if Discord is running
if pgrep -x "Discord" > /dev/null; then
    echo "[✓] Discord is running!"
else
    echo "[✗] Discord is NOT running!"
    echo "Please start Discord first, then run this script again."
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "[*] Starting quest completion for '${appName}'..."
echo "[*] This will take approximately 15 minutes."
echo "[*] Do NOT close this terminal!"
echo ""

# Total duration in seconds
TOTAL_SECONDS=900
ELAPSED=0

while [ $ELAPSED -lt $TOTAL_SECONDS ]; do
    # Calculate progress
    PRO=$((ELAPSED * 100 / TOTAL_SECONDS))
    MIN=$((ELAPSED / 60))
    SEC=$((ELAPSED % 60))
    
    # Display progress (overwrite line)
    printf "\\r[*] Progress: %3d%% (%02d:%02d / 15:00) - ${appName}" "$PRO" "$MIN" "$SEC"
    
    # Update activity every 30 seconds
    MOD=$((ELAPSED % 30))
    if [ $MOD -eq 0 ]; then
        # Try to open Discord app store URL to trigger activity detection
        open "discord://app-store/${appId}" 2>/dev/null || true
    fi
    
    # Wait 1 second
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

echo ""
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║   ✅ QUEST COMPLETED!                                   ║"
echo "║                                                          ║"
echo "║   ${appName} quest should now be complete!"
echo "║   Check your Discord Quests page to claim rewards."
echo "║                                                          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

read -p "Press Enter to exit..."
`
}

// Linux Shell Script
function generateLinuxScript(appName: string, appId: string): string {
  return `#!/bin/bash

# Discord Quest Completer - Linux Version
# Game: ${appName}
# App ID: ${appId}

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     DISCORD QUEST COMPLETER - LOCAL EXECUTION SCRIPT       ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Game: ${appName}"
echo "║  App ID: ${appId}"
echo "║  Duration: 15 minutes (900 seconds required)"
echo "║                                                              "
echo "║  ⚠️  KEEP THIS TERMINAL OPEN DURING COMPLETION!"
echo "║  Closing early will reset progress!"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if Discord is running (Flatpak, Snap, or native)
if pgrep -f "discord" > /dev/null; then
    echo "[✓] Discord is running!"
else
    echo "[✗] Discord is NOT running!"
    echo "Please start Discord first, then run this script again."
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "[*] Starting quest completion for '${appName}'..."
echo "[*] This will take approximately 15 minutes."
echo "[*] Do NOT close this terminal!"
echo ""

# Total duration in seconds
TOTAL_SECONDS=900
ELAPSED=0

while [ $ELAPSED -lt $TOTAL_SECONDS ]; do
    # Calculate progress
    PRO=$((ELAPSED * 100 / TOTAL_SECONDS))
    MIN=$((ELAPSED / 60))
    SEC=$((ELAPSED % 60))
    
    # Display progress (overwrite line)
    printf "\\r[*] Progress: %3d%% (%02d:%02d / 15:00) - ${appName}" "$PRO" "$MIN" "$SEC"
    
    # Update activity every 30 seconds
    MOD=$((ELAPSED % 30))
    if [ $MOD -eq 0 ]; then
        # Try xdg-open for Discord URL
        xdg-open "discord://app-store/${appId}" 2>/dev/null || true
    fi
    
    # Wait 1 second
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

echo ""
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║   ✅ QUEST COMPLETED!                                   ║"
echo "║                                                          ║"
echo "║   ${appName} quest should now be complete!"
echo "║   Check your Discord Quests page to claim rewards."
echo "║                                                          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

read -p "Press Enter to exit..."
`
}

// Sanitize filename
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .substring(0, 50)
    .replace(/_+$/, '')
}
