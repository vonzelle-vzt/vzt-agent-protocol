# VZT × agent multiplexers — the ship supervision layer

Wires an **agent multiplexer** as the **supervision layer for `/vzt-ship` runs** — watch
N units work in parallel git worktrees, each auto-verified — **without** changing the
terminal-native protocol (routing, hooks, subagents, skills all inherit unchanged because
the mux just runs `claude`). Two backends, one interface, pick with `--mux`:

| `--mux` | tool | what it is |
|---|---|---|
| `orca` (default) | [`stablyai/orca`](https://github.com/stablyai/orca) | desktop ADE — per-worktree diffs, cards, PR checks |
| `herdr` | [`herdr`](https://herdr.dev) | terminal-native agent multiplexer — persistent, SSH/mobile, a binary not an app |

Both manage git worktrees + panes and report agent state; the VZT commands drive either
through one 5-method backend (dispatch / waitIdle / resolve / stamp / plan in `cli/vzt-agent.js`).

**Not fan-out.** `vzt-route` rejects these tools as a *racing* mechanism and that still
holds. This is the opposite: pairwise-disjoint units (each owns different files, graded by
its own oracle), which is what `/vzt-ship` already produces. See `skills/vzt-route/SKILL.md`
→ "Accepted — the ship SUPERVISION layer".

## Herdr prerequisites (one-time)

```
brew install herdr                    # or: curl -fsSL https://herdr.dev/install.sh | sh
brew services start herdr             # the socket API needs the server running
herdr integration install claude      # so claude reports idle/working/blocked → `agent wait`
```
Orca needs its desktop app running (its daemon exposes the same socket API). Everything
below works with `--mux herdr` or `--mux orca` (default).

## One command — kick once, walk away

```
vzt-agent ship-check .vzt/ship/<slug>/SPEC.md              # gate first (unchanged)
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md              # everything, on orca (default)
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md --mux herdr  # …or on herdr
```

`ship-watch` **dispatches** every unit as a `claude` worktree pane → **waits** for each to
finish (agent idle) → the instant one idles, **auto-verifies** its
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
