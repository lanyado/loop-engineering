#!/usr/bin/env bash
# Saves Claude Code's usage limits for the dashboard's top bar (apps/server modules/claude-usage.ts).
# Claude Code gives its status line command a JSON object on stdin that includes rate_limits (the
# 5-hour and weekly windows). Pipe that same JSON here from your status line script:
#   printf '%s' "$input" | ~/loop-engineering/scripts/capture-claude-usage.sh
# Writes nothing when rate_limits is missing (API-key logins, older Claude Code), and never fails the
# status line. Output: $CLAUDE_USAGE_FILE, default ~/.local/state/loop-engineering/claude-usage.json.
out="${CLAUDE_USAGE_FILE:-$HOME/.local/state/loop-engineering/claude-usage.json}"
json=$(jq -c 'select(.rate_limits != null) | {capturedAt: (now | floor), rateLimits: .rate_limits}' 2>/dev/null) || exit 0
[ -n "$json" ] || exit 0
mkdir -p "$(dirname "$out")" || exit 0
# Write then rename, so the server never reads a half-written file.
tmp="$out.$$"
printf '%s\n' "$json" >"$tmp" && mv -f "$tmp" "$out"
exit 0
