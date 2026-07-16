---
name: vzt-route
description: "VZT Agent Protocol routing doctrine and manual router. Use when the user asks how work is being routed, wants to route a specific task ('/vzt-route <task>'), wants routing stats, or when deciding which model tier should handle a piece of work."
---

# VZT Route — the routing doctrine

The VZT Agent Protocol routes every piece of work to the cheapest tier that
can do it well. This skill is the canonical decision procedure; the
[VZT-ROUTE] hook directives are compressed versions of it.

## The routing matrix

<!-- sync: TIERS in hooks/vzt-route-classifier.mjs — test/classifier.test.mjs asserts the Cost column matches -->
| Tier | Model | Owns | Fleet agents | Cost | Intelligence | Taste |
|------|-------|------|--------------|------|--------------|-------|
| 4 | **Fable 5** | Architecture, system design, planning, impossible bugs, root-cause, security analysis, multi-repo strategy | `vzt-planner`, `vzt-oracle` | 25× | 10 | 10 |
| 3 | **Opus 4.8** | Large refactors, migrations, dense algorithms, performance/concurrency surgery, load-bearing review | `vzt-heavy-builder`, `vzt-reviewer` | 15× | 9 | 9 |
| 2 | **Sonnet 5** | Standard implementation, features, bug fixes, tests, endpoints, components — the default | `vzt-builder` | 3× | 8 | 8 |
| 1 | **Haiku 4.5** | Search/recon, summaries, renames, typos, formatting, version bumps, commit messages, file moves | `vzt-scout`, `vzt-mechanic` | 1× | 5 | 4 |

## Decision procedure

1. **Is it mechanical or pure discovery?** → Tier 1. Never higher, no exceptions.
2. **Does it require choosing an approach** (architecture, schema, strategy,
   trade-offs) or **has it beaten a lower tier twice**? → Tier 4.
3. **Is it implementation with tight coupling, algorithms, or blast radius?**
   → Tier 3.
4. **Does it name scope language** (entire codebase / from scratch /
   greenfield / end-to-end / multi-tenant / ...) **AND a build verb**
   (build/implement/ship/create/scaffold/rewrite/...)? → Tier 3, kind
   `HORIZON` — spec-first via `/vzt-ship`, never routine inline execution.
   Scope language *without* a build verb is still a planning question and
   stays on Tier 4.
5. **Everything else** → Tier 2. When unsure between two tiers, take the lower
   one — the escalation ladder exists precisely so under-routing is cheap.

## Escalate the process, not the model

Scope language used to route straight to Fable, on the assumption that
long-horizon work needs the smartest model. It doesn't — it fails because
**context compaction eats the plan halfway through the run**, and the back
half gets built against a plan the chair no longer remembers. A slower model
does not fix a coherence problem; a plan on disk does.

So a `HORIZON` classification (the two-factor gate above) routes to **Opus**,
not Fable, and points at `/vzt-ship`: write a SPEC to
`.vzt/ship/<slug>/SPEC.md` before any code (contract, out-of-scope, the
interfaces that cross unit boundaries as a serial barrier unit, a file
manifest, units with pairwise-disjoint `FILES_IN_SCOPE` and one
machine-checkable oracle each, chosen before the unit is built), gate it with
`vzt-agent ship-check` (a command, not an opinion), then drive it as
supervised background workers — barrier → parallel units → independent oracle
verification → bounded repair (≤2 rounds) → integration gate. The SPEC and
the run ledger live on disk specifically so a compaction mid-run loses
nothing: `vzt-agent ship-status` reconstructs state, and the classifier hook
re-injects a `[VZT-SHIP]` block on every prompt because compaction does not
re-fire `SessionStart`.

## Effort routing

- Default effort per tier: Fable `high`, Opus `high`, Sonnet `medium`, Haiku
  `low`.
- Opus downgrades to `medium` on low-confidence classifications — don't spend
  high effort confirming a guess.
- The classifier never suggests `max` — that's reserved for pinned Fable
  agents or an explicit escalation, not routine routing.
- Fable-low ≈ Opus-high in quality-per-cost.
- `xhigh`/`max` on routine work causes overthinking, not quality.

## Delegation vs. turn-switch

- **Subagent (Agent tool)**: work that is self-contained once briefed. Pass
  complete context; the agent's model comes from its frontmatter. Structure the
  delegation as a worker brief (templates/worker-brief.md): FILES_IN_SCOPE as a
  collision boundary, a one-shot operation spec, and MACHINE_CHECK + EXPECT
  chosen before dispatch. On report-back, verify artifacts on disk — reporting
  ≠ persistence — and re-run the MACHINE_CHECK yourself on load-bearing steps.
  For parallel waves, FILES_IN_SCOPE sets must be pairwise disjoint.
- **Turn skill** (`/vzt-plan`, `/vzt-fix`, `/vzt-build`, `/vzt-quick`): work
  that needs the full conversation context. The skill's `model:` frontmatter
  switches THIS turn to the target tier; the session model returns next turn.
- **Exception — `/vzt-fable-mode`**: no `model:` frontmatter. It switches
  *discipline*, not model — runs the five gates on whichever tier is already
  active instead of forcing a tier switch.

## Fan-out doctrine — the horizontal axis

Everything above routes work *vertically* (which tier). This routes it
*horizontally* (how many agents at once).

**Fan-out is for DIVERGENCE and EVIDENCE — never for CORRECTNESS.** If the task
has one right answer, build it once on Sonnet and review the seam on Opus. That
is a sequential search with a *better* selection signal, because the reviewer
reads the code in the real repo and can run it.

Rules:

- **N ≤ 4. Fan out on Sonnet/Haiku only — never Opus or Fable.** Fanning the
  premium tiers multiplies the one budget that actually binds.
- **Every fanned agent must carry a MACHINE_CHECK it can actually run in its own
  environment.** If it can't run the check, don't fan out — you are
  manufacturing unverifiable work at N× the cost.
- **FILES_IN_SCOPE sets stay pairwise disjoint** (see above). No exceptions.
- **Never fan out anything that mutates shared remote state** — databases,
  deploys, migrations. Isolation of *files* is not isolation of *state*.
- **No model judge over unrun diffs.** If an objective oracle exists, the judge
  is a **command**, not a model. If none exists, don't fan out.

The sanctioned pattern is **`/vzt-diagnose`**: read-only hypothesis fan-out for
a hard bug. Read-only ⇒ empty FILES_IN_SCOPE ⇒ nothing collides ⇒ every agent
runs in the real working tree and can actually execute its probe. Use it
*before* escalating a bug to `/vzt-fix` (Fable).

### Rejected — do not re-propose

Evaluated **Orca** (`stablyai/orca`), whose headline is *"fan one prompt across
five agents, each in its own isolated git worktree — compare the results and
merge the winner."* We took the idea (run in parallel, gather evidence) and
rejected the implementation:

- **Git-worktree isolation for implementation fan-out.** A fresh worktree has no
  `node_modules` and no `.env*` — both are gitignored in every real project. A
  candidate in one **cannot typecheck, build, or run the app**; it can only
  *claim* success. That kills the verification gate for every candidate.
  Worktrees isolate files, **not** the shared database/deploy state where the
  actual risk lives.
- **Overlapping-scope fan-out** (N agents editing the same file). Requires
  worktrees. Same blocker.
- **Judge panels over candidate diffs.** Multiplies the binding constraint (the
  premium-tier bucket) to buy taste-based selection on code nobody executed, in
  order to save Sonnet — the bucket that is already separate and effectively
  free on Max plans.
- **Why it works for Orca and not for us:** Orca fans across *different vendors'*
  agents (Codex / Claude / Cursor) — genuinely **uncorrelated** failure modes,
  which is what makes "pick the winner" pay. Fanning N `vzt-builder`s is N draws
  from **one model with one prior**: diversity of phrasing, not of understanding.

### Accepted — Orca as the ship SUPERVISION layer (not fan-out)

The rejection above is narrow: it kills Orca as a *fan-out/racing* mechanism. It
does **not** reject Orca as a place to *watch* a `/vzt-ship` run whose units are
already pairwise-disjoint (not a race — each unit owns different files and is graded
by its own oracle). That use is accepted and wired via `orca/` in this package:

- **Terminal stays the substrate; routing is untouched.** Orca runs `claude`, so the
  `[VZT-ROUTE]` hooks, subagents, and skills inherit unchanged. Reserve Orca for
  *parallel* ship runs; single-thread work stays in the plain terminal.
- **Two execution paths, never both on one SPEC:** the headless `vzt-ship.js`
  Workflow (background subagents), OR `vzt-agent ship-dispatch <SPEC>` → one
  `orca worktree create --agent claude` per unit (Orca panes you supervise).
- **The worktree objection is closed here** (it still stands for fan-out): each unit
  pane runs `orca/worktree-bootstrap.sh` first, symlinking `node_modules`/`.env*`
  from the primary checkout — so a supervised unit *can* build and run its oracle.
- **`vzt-agent ship-supervise <SPEC>`** runs each unit's MACHINE_CHECK in its worktree
  and records PASS/FAIL to the shared LEDGER (which resolves to the **primary
  checkout**, so worktree writes are never lost or conflicted).
- **Chair pane in the primary checkout; worker panes in worktrees.** Pick the model
  each worker pane launches with — every pane is its own routed session.

See `orca/README.md` for the full loop and the `orca` CLI verbs.

## Parallel waves — the mechanism

The pipeline below says "parallelize independent steps." Concretely: dispatch
them as **multiple Agent calls in a single message** — they run concurrently.
Serial dispatch is the default failure mode; it costs wall-clock, which is
exactly what the Opus chair is protecting.

A wave is legal when the steps' FILES_IN_SCOPE sets are pairwise disjoint.
Verify they don't intersect before dispatching — two agents writing one file
silently clobber each other and **neither reports a problem**.

## Standard pipeline for non-trivial features

1. `vzt-planner` (Fable) → plan with step-routing table
2. Steps execute on their tagged tiers (`vzt-builder` default, `vzt-mechanic`
   for mechanical steps, `vzt-heavy-builder` for `opus` steps) — parallelize
   independent steps
3. `vzt-reviewer` (Opus) reviews ONLY the load-bearing seam the plan flagged
4. `vzt-scout`/`vzt-mechanic` (Haiku) run verification oracles and cleanup

## Orchestrator doctrine

The frontier tier designs and verifies; cheap tiers execute. When Fable or
Opus orchestrates a multi-step or dynamic workflow, worker steps default to
Sonnet (Haiku if mechanical) — measured results on routine steps are equal at
~8–25× lower cost (see the Cost column above). Workers report back after each
step; the orchestrator uses the reports to design the next step. Never promote
a worker step to the orchestrator's own tier without a stated reason.

## Hard rules

- Escalation ladder: two failures at a tier → up exactly one tier, stated aloud.
  On a *bug*, run `/vzt-diagnose` before the rung that lands on Fable — cheap
  parallel evidence first, frontier reasoning only once it is earned.
- Fan out for divergence and evidence, never for correctness. Sonnet/Haiku only.
- Fable turns ≤15% of the session. Never execute a routine plan on Fable/Opus.
- Sonnet draws on its own separate weekly usage bucket on Max plans — routing
  execution there directly preserves the all-models bucket Fable/Opus burn.
- Routing directives are advisory: override with a stated reason, never silently.

## Manual usage

- `/vzt-route <task description>` → classify the task against the matrix and
  state tier + agent + why, then proceed with that routing.
- `/vzt-route stats` → run `vzt-agent stats` (or read
  `~/.claude/vzt-router/decisions.jsonl`) and summarize tier distribution vs.
  the ≤15%-Fable target.
