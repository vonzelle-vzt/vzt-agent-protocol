#!/bin/sh
# vzt-vscode-agent-state.sh — idle sentinel for the native VS Code mux (--mux vscode).
#
# Wired as a GLOBAL `Stop` hook by `vzt-agent install`. It fires on every turn-stop
# in every Claude Code session, but NO-OPS everywhere except inside a ship-unit
# terminal that the vscode backend launched — those set VZT_VSCODE_MUX=1 and
# VZT_VSCODE_UNIT=<slug>-<id> in the terminal env (see cli/vzt-agent.js
# vscodeBackend + the companion extension). So it never touches your normal work.
#
# On a real unit stop it writes an empty sentinel file that `vzt-agent ship-watch`
# polls in waitIdle(): ~/.vzt/vscode-mux/state/<unitKey>.idle
set -eu

# Claude Code delivers the hook payload on stdin; drain it (we only need env vars).
cat >/dev/null 2>&1 || true

[ "${VZT_VSCODE_MUX:-}" = "1" ] || exit 0
[ -n "${VZT_VSCODE_UNIT:-}" ] || exit 0

dir="${VZT_VSCODE_DIR:-$HOME/.vzt/vscode-mux}/state"
mkdir -p "$dir" 2>/dev/null || exit 0
: > "$dir/${VZT_VSCODE_UNIT}.idle" 2>/dev/null || exit 0
exit 0
