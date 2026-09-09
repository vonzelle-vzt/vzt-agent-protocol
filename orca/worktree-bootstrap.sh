#!/bin/sh
# vzt-agent-protocol — Orca worktree bootstrap
#
# WHY: A fresh git worktree has no node_modules and no .env* (both gitignored in
# every real project), so a VZT ship unit spawned in an Orca worktree cannot build
# or run its MACHINE_CHECK oracle. This symlinks the build-critical, gitignored
# artifacts from the PRIMARY checkout into the new worktree so the unit is runnable
# the instant it opens. This closes objection #1 in vzt-route's Orca rejection.
#
# WIRING: called by an Orca repo setup hook (orca.yaml `setup:`), which runs on
# `orca worktree create --setup run`. Also safe to run by hand as the first line
# of a worker brief. Idempotent; never fails the create (always exits 0).
#
# It SYMLINKS (never copies): node_modules is huge and .env secrets must match the
# primary exactly. Symlinks also mean the worktree can never drift from primary deps.
#
# Usage: worktree-bootstrap.sh [worktree_dir]   (defaults to $PWD)

set -u
WT="${1:-$PWD}"
cd "$WT" 2>/dev/null || { echo "vzt-bootstrap: cannot cd into $WT" >&2; exit 0; }

# Resolve the PRIMARY worktree root — the first entry of `git worktree list` is
# always the main checkout (verified). Fall back gracefully; never hard-fail.
PRIMARY=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
if [ -z "${PRIMARY:-}" ]; then
  echo "vzt-bootstrap: not a git worktree (or git unavailable) — skipping" >&2
  exit 0
fi
WT_TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "$WT")

# --- Cross-model adversarial review activation -------------------------------
# WHY: the pipeline gate stores its state in <repo>/.pipeline/, which is gitignored
# in every project that uses it. A fresh git worktree therefore starts with NO
# state, and `pipeline.js check` treats missing state as "nothing to enforce" and
# exits 0. The gate was silently inert in every worktree it was supposed to guard.
# Initializing here is what makes the review gate hold "all the time" rather than
# only in the one checkout where someone happened to run init by hand.
#
# STRICTLY OPT-IN: this does nothing unless the repo has committed a
# `.pipeline-required` marker at its root. The marker is tracked on purpose — an
# untracked or gitignored marker cannot survive `git worktree add`, which is the
# exact failure this block exists to prevent. Repos without the marker behave
# byte-for-byte as they did before, so this is safe in every repo the managed
# orca.yaml hook was fanned into.
#
# Never fails the worktree create: every path here ends in success.
activate_cross_model_pipeline() {
  [ -f "$WT_TOP/.pipeline-required" ] || return 0

  if ! command -v node >/dev/null 2>&1; then
    echo "vzt-bootstrap: .pipeline-required present but node is not on PATH — gate NOT armed" >&2
    return 0
  fi

  # Prefer the repo's own checkout so a worktree tests the code it contains;
  # fall back to the globally installed shim.
  pipeline=""
  for cand in "$WT_TOP/scripts/pipeline.js" "$HOME/.local/bin/pipeline.js"; do
    [ -f "$cand" ] && { pipeline="$cand"; break; }
  done
  if [ -z "$pipeline" ]; then
    echo "vzt-bootstrap: .pipeline-required present but pipeline.js not found — gate NOT armed" >&2
    return 0
  fi

  # `init` is idempotent and lock-protected; it never clobbers existing state.
  if (cd "$WT_TOP" && node "$pipeline" init >/dev/null 2>&1); then
    echo "vzt-bootstrap: cross-model review gate armed (pipeline state initialized)"
  else
    echo "vzt-bootstrap: pipeline.js init failed — gate NOT armed, commits will be blocked until you run: node $pipeline init" >&2
  fi
  return 0
}

activate_cross_model_pipeline

if [ "$PRIMARY" = "$WT_TOP" ]; then
  echo "vzt-bootstrap: this IS the primary checkout — nothing to link" >&2
  exit 0
fi

linked=0
link_one() {
  # link_one <relative-path>   — symlink primary/<rel> into worktree/<rel> if the
  # source exists and the target does not already exist (idempotent).
  rel="$1"
  src="$PRIMARY/$rel"
  dst="$WT_TOP/$rel"
  [ -e "$src" ] || return 0
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    return 0   # respect anything the worktree already has (tracked or linked)
  fi
  mkdir -p "$(dirname "$dst")"
  if ln -s "$src" "$dst" 2>/dev/null; then
    echo "  linked $rel"
    linked=$((linked + 1))
  fi
}

echo "vzt-bootstrap: primary=$PRIMARY  worktree=$WT_TOP"

# 1) node_modules — repo root AND monorepo package dirs (apps/*, packages/*).
link_one "node_modules"
for base in apps packages services; do
  if [ -d "$PRIMARY/$base" ]; then
    for pkg in "$PRIMARY/$base"/*/; do
      [ -d "${pkg}node_modules" ] || continue
      rel="$base/$(basename "$pkg")/node_modules"
      link_one "$rel"
    done
  fi
done

# 2) Every gitignored .env* the build actually reads — root + one level of nesting.
#    (find is bounded to depth 2 so we never walk node_modules or the whole tree.)
for env in $(cd "$PRIMARY" 2>/dev/null && find . -maxdepth 2 -name '.env*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\./||'); do
  link_one "$env"
done

echo "vzt-bootstrap: done — $linked link(s) created."
exit 0
