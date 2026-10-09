#!/bin/bash
# 停止並移除 LaunchAgent
set -euo pipefail
LABEL="com.nekokiller.voiceclock"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已移除 $LABEL"
