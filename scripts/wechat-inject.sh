#!/bin/bash
# Drop a scheduled message into a running bridge by writing a file into
# the bridge's <cwd>/.inject directory. The bridge picks it up via fs.watch
# (with polling fallback) and dispatches it through the same path as a
# real WeChat inbound message — so busy-defer, typing indicator, output
# mirroring etc. all just work.
#
# Usage:
#   wechat-inject.sh <cwd> <text...>
#
# Examples (cron):
#   # 9am pre-market analysis on weekdays
#   55 8 * * 1-5 ~/path/to/repo/scripts/wechat-inject.sh ~/wechat-channels/A "跑 /aniu 盘前分析"
#
#   # Three pill reminders a day
#   0 9,13,21 * * * ~/path/to/repo/scripts/wechat-inject.sh ~/wechat-channels/A "提醒我拍照吃药"
#
# The text is written to a temp file inside <cwd>/.inject and atomically
# renamed into place, so the bridge never sees a partial write. The bridge
# unlinks the file after reading.

set -eu

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <cwd> <text...>" >&2
  exit 1
fi

CWD="$1"
shift
TEXT="$*"

if [[ ! -d "$CWD" ]]; then
  echo "error: cwd $CWD not found" >&2
  exit 1
fi

INJECT_DIR="$CWD/.inject"
mkdir -p "$INJECT_DIR"
chmod 700 "$INJECT_DIR" 2>/dev/null || true

TS="$(date +%Y%m%dT%H%M%S)"
RAND="$$-$RANDOM"
FINAL="$INJECT_DIR/$TS-$RAND"
TMP="$FINAL.tmp"

printf '%s\n' "$TEXT" > "$TMP"
mv "$TMP" "$FINAL"
echo "queued: $FINAL"
