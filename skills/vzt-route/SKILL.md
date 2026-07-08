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
4. **Everything else** → Tier 2. When unsure between two tiers, take the lower
   one — the escalation ladder exists precisely so under-routing is cheap.

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
