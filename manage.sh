#!/bin/bash
# PAI Mobile Integration — management script
set -euo pipefail

PLIST_NAME="com.pai.mobile-gateway"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$PROJECT_DIR/data/logs"

case "${1:-help}" in
  start)
    if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
      echo "Already running. Use 'restart' to restart."
      exit 0
    fi
    launchctl load "$PLIST_PATH"
    echo "Started PAI Mobile Gateway"
    ;;

  stop)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "Stopped PAI Mobile Gateway"
    ;;

  restart)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    sleep 2
    launchctl load "$PLIST_PATH"
    echo "Restarted PAI Mobile Gateway"
    ;;

  status)
    if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
      PID=$(launchctl list | grep "$PLIST_NAME" | awk '{print $1}')
      echo "Running (PID: $PID)"
    else
      echo "Not running"
    fi
    ;;

  logs)
    tail -f "$LOG_DIR/gateway.log"
    ;;

  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

    # Generate plist dynamically from project location
    cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>

  <key>ProgramArguments</key>
  <array>
    <string>$(which npx)</string>
    <string>tsx</string>
    <string>src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$(which node)"):${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/data/logs/launchd-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/data/logs/launchd-stderr.log</string>
</dict>
</plist>
PLIST

    echo "Installed launchd plist to $PLIST_PATH"
    echo "Run './manage.sh start' to begin."
    ;;

  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled launchd plist"
    ;;

  dev)
    cd "$PROJECT_DIR"
    npx tsx --watch src/index.ts
    ;;

  help|*)
    echo "PAI Mobile Integration"
    echo ""
    echo "Usage: ./manage.sh <command>"
    echo ""
    echo "  install   — Install launchd service (auto-start on boot, macOS only)"
    echo "  uninstall — Remove launchd service"
    echo "  start     — Start the service"
    echo "  stop      — Stop the service"
    echo "  restart   — Restart the service"
    echo "  status    — Check if running"
    echo "  logs      — Tail the gateway log"
    echo "  dev       — Run in dev mode (watch + restart)"
    ;;
esac
