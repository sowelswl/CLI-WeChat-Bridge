#!/bin/bash
# Stop one or more WeChat bridge tmux sessions and any orphan bridges
# that survived earlier sessions.
#
# The companion_bound bridge is spawned detached by wechat-claude-start,
# so killing the tmux session alone leaves the bridge child running with
# PPID=1. Repeat down/up cycles accumulate ghost bridges that all poll
# the same iLink account — inbound messages then route to the wrong
# instance ("companion not connected" errors). This script also reaps
# any wechat-bridge.ts process whose --cwd matches the channel workspace.
#
# Usage:
#   ./wechat-bridges-down.sh           # stop A and B (the defaults)
#   ./wechat-bridges-down.sh A         # stop only A
#   ./wechat-bridges-down.sh A B C     # stop multiple

set -u

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"
CHANNEL_DATA_BASE="${WECHAT_CHANNEL_DATA_BASE:-$HOME/.claude/channels}"
DEFAULT_WORKSPACE_BASE="${WECHAT_DEFAULT_WORKSPACE_BASE:-$HOME/wechat-channels}"

if [[ -z "$TMUX_BIN" ]]; then
  echo "error: tmux not found on PATH" >&2
  exit 1
fi

resolve_workspace() {
  local letter="$1"
  local upper
  upper=$(printf '%s' "$letter" | tr '[:lower:]' '[:upper:]')
  local override_var="WECHAT_CHANNEL_${upper}_WORKSPACE"
  if [[ -n "${!override_var:-}" ]]; then
    printf '%s' "${!override_var}"
  else
    printf '%s/%s' "$DEFAULT_WORKSPACE_BASE" "$letter"
  fi
}

stop_one() {
  local letter="$1"
  local session="wechat-${letter}"
  local workspace
  workspace="$(resolve_workspace "$letter")"
  local channel_dir="${CHANNEL_DATA_BASE}/wechat-${letter}"

  # 1. Kill the tmux session (kills wechat-claude-start loop + companion).
  if "$TMUX_BIN" has-session -t "$session" 2>/dev/null; then
    "$TMUX_BIN" kill-session -t "$session"
    echo "stopped session: ${session}"
  else
    echo "session not running: ${session}"
  fi

  # 2. Reap orphan bridge processes bound to this workspace.
  local pids
  pids=$(pgrep -f "wechat-bridge.ts.*--cwd ${workspace}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null
    echo "killed orphan bridge(s) for ${workspace}: $(echo $pids | tr '\n' ' ')"
  fi

  # 3. Clean up the lock file so the next start doesn't think it's inheriting
  #    a still-alive bridge.
  rm -f "${channel_dir}/bridge.lock.json"
}

if [[ $# -eq 0 ]]; then
  set -- A B
fi

for letter in "$@"; do
  stop_one "$letter"
done
