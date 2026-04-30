#!/bin/bash
# Stop one or more WeChat bridge tmux sessions started by wechat-bridges-up.sh.
#
# Usage:
#   ./wechat-bridges-down.sh           # stop A and B (the defaults)
#   ./wechat-bridges-down.sh A         # stop only A
#   ./wechat-bridges-down.sh A B C     # stop multiple

set -u

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"
if [[ -z "$TMUX_BIN" ]]; then
  echo "error: tmux not found on PATH" >&2
  exit 1
fi

stop_one() {
  local session="wechat-$1"
  if "$TMUX_BIN" has-session -t "$session" 2>/dev/null; then
    "$TMUX_BIN" kill-session -t "$session"
    echo "stopped: ${session}"
  else
    echo "not running: ${session}"
  fi
}

if [[ $# -eq 0 ]]; then
  set -- A B
fi

for letter in "$@"; do
  stop_one "$letter"
done
