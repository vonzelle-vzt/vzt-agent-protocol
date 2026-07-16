# VZT × Orca — the ship supervision layer

Orca (`stablyai/orca`) is an Agent Development Environment: a fleet of coding agents
in parallel across isolated git worktrees, with per-worktree diffs, cards, and PR
checks. This directory wires Orca as the **supervision layer for `/vzt-ship` runs** —
watch N units work in parallel worktrees, each auto-verified — **without** changing
the terminal-native protocol (routing, hooks, subagents, skills all inherit unchanged
because Orca just runs `claude`).

**Not fan-out.** `vzt-route` rejects Orca as a *racing* mechanism and that still holds.
This is the opposite: pairwise-disjoint units (each owns different files, graded by its
own oracle), which is what `/vzt-ship` already produces. See `skills/vzt-route/SKILL.md`
→ "Accepted — Orca as the ship SUPERVISION layer".

## One command — kick once, walk away

```
vzt-agent ship-check .vzt/ship/<slug>/SPEC.md   # gate first (unchanged)
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md   # then this does everything:
```

`ship-watch` **dispatches** every unit as an Orca `claude` pane → **waits** for each to
finish (`terminal wait --for tui-idle`) → the instant one idles, **auto-verifies** its
oracle, **stamps** its card, and **records** the ledger → runs the **integration gate**.
The barrier (if any) runs first and gates the units. It **stops at the green gate** with
a "ready to review + merge" verdict — it never auto-merges (verify-before-accept stays a
human call). `--timeout-ms <n>` bounds the per-unit wait (default 30m).

## The manual loop (same steps, run them yourself)

Use this to review before spending, or to drive units by hand:

```
vzt-agent ship-start    .vzt/ship/<slug>/SPEC.md          # open the ledger

# Dispatch: dry-run prints the exact `orca worktree create` commands to review first.
vzt-agent ship-dispatch .vzt/ship/<slug>/SPEC.md            # review
vzt-agent ship-dispatch .vzt/ship/<slug>/SPEC.md --execute  # create the panes
#   Each pane runs worktree-bootstrap.sh FIRST (symlinks node_modules/.env from the
#   primary checkout). Barrier runs alone in PHASE 1; units run in PHASE 2 in parallel.

# Supervise: when workers finish, verify every unit's oracle and record it.
vzt-agent ship-supervise .vzt/ship/<slug>/SPEC.md
#   → runs each unit's MACHINE_CHECK in its worktree, appends PASS/FAIL to the SHARED
#     ledger, stamps each Orca card (comment + workspace-status).
```

`vzt-agent ship-status` reconstructs the run from disk after a compaction, and resolves
the ledger to the **primary checkout**, so it works from any worktree pane.

## Files

- **`worktree-bootstrap.sh`** — symlinks `node_modules` and every `.env*` (repo root
  + monorepo `apps/*`,`packages/*`) from the primary checkout into a fresh worktree.
  Idempotent, never fails a create. Closes the "worktree has no deps" objection.
  Installed to `~/.orca/vzt/worktree-bootstrap.sh`; `ship-dispatch` points each unit
  prompt at it.

## Worktree coherence (why the ledger moved)

`.vzt/ship/` is **git-tracked**, so every worktree gets a forked copy on its own
branch. If a worker wrote its result into the worktree's copy, the chair (in the
primary checkout) would never see it, and branches would merge-conflict on
`LEDGER.jsonl`. So `ship-note` / `ship-status` / the router's `[VZT-SHIP]` scan all
resolve the ledger to the **primary checkout** (first entry of `git worktree list`).
In a plain checkout the primary root *is* the repo root, so this is byte-identical to
the old behaviour — it only matters inside a linked worktree.

## Optional: `--setup run` repo hook

`ship-dispatch` passes `--setup run`, so if you also wire `worktree-bootstrap.sh` as
your repo's Orca setup hook (Orca repo settings / `orca.yaml`, per your Orca version),
the bootstrap runs at create time too — belt-and-suspenders with the prompt STEP 0.
The prompt-driven bootstrap is the guaranteed path and needs no Orca config.

## Optional: scheduled automations

```
# Track the Fable-≤15% budget daily inside Orca:
orca automations create --name "VZT routing stats" --trigger daily --time 09:00 \
  --provider claude --repo path:<primary> --prompt "run: vzt-agent stats"
```

## Orca CLI

Bundled at `/Applications/Orca.app/Contents/Resources/bin/orca` (add to PATH or pass
`--orca <path>`). Key verbs used here: `worktree create --agent claude --prompt ... --setup run`,
`worktree list --json`, `worktree set --comment/--workspace-status`, `terminal wait --for tui-idle`,
`worktree ps` (supervisor view), `automations create`. Full guides: `orca skills get orca-cli`.
