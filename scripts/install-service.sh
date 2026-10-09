#!/bin/bash
# 安裝並啟動 LaunchAgent（開機登入後自動執行、當掉自動重啟）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.nekokiller.voiceclock"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/voiceclock"
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "找不到 node，請先安裝。"; exit 1; }
[ -f "$ROOT/.env" ] || { echo "找不到 $ROOT/.env，請先複製 .env.example 並填入 PANEL_PASSWORD。"; exit 1; }
grep -Eq '^PANEL_PASSWORD=.+' "$ROOT/.env" || { echo "$ROOT/.env 的 PANEL_PASSWORD 還是空的，請先填入密碼。"; exit 1; }

chmod 600 "$ROOT/.env"
mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__ROOT__#$ROOT#g" -e "s#__LOGDIR__#$LOGDIR#g" \
  "$ROOT/launchd/$LABEL.plist.template" > "$PLIST"
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "已安裝並啟動：$LABEL"
echo "日誌：$LOGDIR/out.log、err.log"
echo "面板：http://$(ipconfig getifaddr en0 2>/dev/null || echo '<本機IP>'):${PORT:-8780}"
