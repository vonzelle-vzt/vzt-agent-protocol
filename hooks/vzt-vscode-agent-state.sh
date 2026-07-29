#!/bin/sh
# vzt-vscode-agent-state.sh — agent lifecycle sentinels for the native VS Code mux.
#
# Wired GLOBALLY by `vzt-agent install` on three events, each passing an action:
#     SessionStart      -> started    (the agent's claude process actually booted)
#     PermissionRequest -> blocked    (sitting on a prompt, waiting for a human)
#     Stop              -> idle       (turn finished)
#
# Every one fires in EVERY Claude Code session but NO-OPS immediately unless
# VZT_VSCODE_MUX=1 and VZT_VSCODE_UNIT are set — i.e. only inside a ship-unit
# terminal the vscode backend launched. Your normal work is untouched, and the
# guard is two `[` tests before any filesystem access, so the global cost is
# negligible.
#
# WHY `started` EXISTS (this is the load-bearing part):
#   herdr's waitIdle waits for `working` OR `blocked` BEFORE waiting for `idle`,
#   because a freshly-spawned pane reports idle before the agent has produced
#   anything — so waiting on idle alone grades an empty worktree.
#   The vscode backend had NO equivalent: it polled one binary `.idle` sentinel.
#   Observed live on 2026-07-28: two identical units dispatched together; u2's
#   terminal ran and passed in 17s, while u1's `sendText` was swallowed by a
#   still-initialising shell, so u1 never ran claude at all — no `.idle` ever
#   appeared and ship-watch burned the FULL timeout before grading it FAIL
#   against an empty worktree. `started` makes those two cases distinguishable.
#
# The start signal comes from SessionStart rather than PreToolUse deliberately:
# it fires ONCE per session instead of once per tool call, and it is already
# sufficient — the failure mode is "claude never launched", which SessionStart
# detects exactly.
#
# `PermissionRequest` is a REAL Claude Code hook event (verified 2026-07-28
# against code.claude.com/docs/en/hooks.md), and it fires precisely when a
# permission dialog appears — i.e. when the agent is blocked awaiting a human.
# That is the signal we want; do NOT "fix" this to `Notification`, which is the
# general informational event and does not mean blocked.
set -eu

# Claude Code delivers the hook payload on stdin; drain it (we only need env vars).
cat >/dev/null 2>&1 || true

action="${1:-idle}"

[ "${VZT_VSCODE_MUX:-}" = "1" ] || exit 0
[ -n "${VZT_VSCODE_UNIT:-}" ] || exit 0

dir="${VZT_VSCODE_DIR:-$HOME/.vzt/vscode-mux}/state"
mkdir -p "$dir" 2>/dev/null || exit 0
unit="$dir/${VZT_VSCODE_UNIT}"

case "$action" in
  started)
    : > "$unit.started" 2>/dev/null || true
    ;;
  blocked)
    # Blocked counts as STARTED too — an agent sitting on a permission prompt has
    # clearly begun, and we want the idle wait (not a fast false FAIL) to govern it.
    : > "$unit.started" 2>/dev/null || true
    : > "$unit.blocked" 2>/dev/null || true
    ;;
  idle)
    # Reaching a turn-stop means we are no longer waiting on a human.
    rm -f "$unit.blocked" 2>/dev/null || true
    : > "$unit.idle" 2>/dev/null || true
    ;;
  *)
    ;;
esac
exit 0
