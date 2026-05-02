#!/bin/bash
# Bring up one or more WeChat bridge channels in detached tmux sessions.
# Each channel runs `wechat-claude-start` in an auto-restart loop, so a
# dropped companion or a crashed bridge restarts within ~5s without losing
# the session.
#
# Quick start (defaults: channels A and B, workspaces at ~/wechat-channels/<letter>):
#   ./wechat-bridges-up.sh           # start both A and B
#   ./wechat-bridges-up.sh A         # start only A
#   ./wechat-bridges-up.sh down      # stop all (alias for wechat-bridges-down.sh)
#
# Custom workspaces (any letter or word — the script picks them up dynamically):
#   export WECHAT_CHANNEL_A_WORKSPACE=/Users/alice/projects/work
#   export WECHAT_CHANNEL_B_WORKSPACE=/Users/alice/projects/personal
#   ./wechat-bridges-up.sh A B
#
# Other env knobs (rarely needed):
#   TMUX_BIN, START_BIN          override binary locations (auto-discovered via PATH by default)
#   WECHAT_CHANNEL_DATA_BASE     override the channel-data directory (default: ~/.claude/channels)
#
# Attach for live debugging:    tmux attach -t wechat-A    (Ctrl+B then D to detach)
# Stop:                         ./wechat-bridges-down.sh   [letters...]
#
# Platform note: tested on macOS. Should work on Linux as long as tmux and
# wechat-claude-start are both on PATH.

set -u

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"
START_BIN="${START_BIN:-$(command -v wechat-claude-start || true)}"
CAFFEINATE_BIN="${CAFFEINATE_BIN:-$(command -v caffeinate || true)}"
CHANNEL_DATA_BASE="${WECHAT_CHANNEL_DATA_BASE:-$HOME/.claude/channels}"
DEFAULT_WORKSPACE_BASE="${WECHAT_DEFAULT_WORKSPACE_BASE:-$HOME/wechat-channels}"
CAFFEINATE_PID_FILE="${CHANNEL_DATA_BASE}/.wechat-bridges-caffeinate.pid"

if [[ -z "$TMUX_BIN" ]]; then
  echo "error: tmux not found on PATH (install with 'brew install tmux' on macOS)" >&2
  exit 1
fi
if [[ -z "$START_BIN" ]]; then
  echo "error: wechat-claude-start not found on PATH (run 'npm install -g .' from the repo root)" >&2
  exit 1
fi

ensure_caffeinate() {
  # macOS only — keep the system awake while bridges are up. pmset sleep=0
  # already covers AC power, but caffeinate -i also handles battery and
  # survives third-party tools that override pmset. No-op on Linux.
  if [[ -z "$CAFFEINATE_BIN" ]]; then
    return
  fi
  mkdir -p "$(dirname "$CAFFEINATE_PID_FILE")"
  if [[ -f "$CAFFEINATE_PID_FILE" ]]; then
    local existing
    existing=$(cat "$CAFFEINATE_PID_FILE" 2>/dev/null)
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      return
    fi
    rm -f "$CAFFEINATE_PID_FILE"
  fi
  "$CAFFEINATE_BIN" -i &
  echo "$!" > "$CAFFEINATE_PID_FILE"
  echo "caffeinate -i started (pid $(cat "$CAFFEINATE_PID_FILE"))"
}

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

start_one() {
  local letter="$1"
  local session="wechat-${letter}"
  local channel_dir="${CHANNEL_DATA_BASE}/wechat-${letter}"
  local workspace
  workspace="$(resolve_workspace "$letter")"

  if [[ ! -d "$workspace" ]]; then
    echo "skip ${session}: workspace ${workspace} not found"
    echo "       (set WECHAT_CHANNEL_$(printf '%s' "$letter" | tr '[:lower:]' '[:upper:]')_WORKSPACE or create the directory)"
    return
  fi
  if [[ ! -f "$channel_dir/account.json" ]]; then
    echo "skip ${session}: no account.json in ${channel_dir}"
    echo "       run: CLAUDE_WECHAT_CHANNEL_DATA_DIR='${channel_dir}' bun run setup"
    return
  fi

  if "$TMUX_BIN" has-session -t "$session" 2>/dev/null; then
    echo "already running: ${session}"
    return
  fi

  # Inner `while true` makes the bridge auto-resurrect; the outer tmux
  # session is the long-lived holder so attach still works mid-restart.
  "$TMUX_BIN" new-session -d -s "$session" -c "$workspace" \
    "while true; do \
       echo \"[\$(date '+%H:%M:%S')] starting ${session}...\"; \
       CLAUDE_WECHAT_CHANNEL_DATA_DIR='${channel_dir}' \
         '${START_BIN}'; \
       echo \"[\$(date '+%H:%M:%S')] ${session} exited, restarting in 5s (Ctrl+C inside the session to abort the loop)...\"; \
       sleep 5; \
     done"
  echo "started: ${session}  (attach with: tmux attach -t ${session})"
}

if [[ "${1:-}" == "down" ]]; then
  exec "$(dirname "$0")/wechat-bridges-down.sh" "${@:2}"
fi

if [[ $# -eq 0 ]]; then
  set -- A B
fi

ensure_caffeinate

for letter in "$@"; do
  start_one "$letter"
done
