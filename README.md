# VZT Agent Protocol

**Automatic model routing for Claude Code — Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5. Right model, right task, zero manual switching.**

Part of the [VZT Tech Consulting Protocol](https://github.com/vonzelle-vzt/VZT-Tech-Consulting-Protocol) ecosystem.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.2.0-purple.svg)](#)
[![Tiers](https://img.shields.io/badge/Tiers-Fable%205%20%7C%20Opus%204.8%20%7C%20Sonnet%205%20%7C%20Haiku%204.5-green.svg)](docs/ROUTING-MATRIX.md)

---

## The problem

Running every prompt on your best model burns through weekly usage limits in
days. Running everything on a cheap model caps quality. Manually flipping
`/model` per task is friction nobody sustains.

## The solution

The VZT Agent Protocol classifies every prompt and routes the work to the
**cheapest model tier that can do it well** — automatically, on every prompt,
with zero API cost for the routing itself:

| Tier | Model | Owns |
|------|-------|------|
| 4 | **Fable 5** | Architecture, planning, impossible bugs, root-cause, security analysis |
| 3 | **Opus 4.8** | Large refactors, dense algorithms, performance surgery, load-bearing review |
| 2 | **Sonnet 5** | Standard implementation — the default (burns its own separate weekly bucket) |
| 1 | **Haiku 4.5** | Search, summaries, renames, formatting, commit messages — nearly free |

**Why this preserves your limits:** Max plans meter a Sonnet-only weekly bucket
*separately* from the all-models bucket that Fable/Opus consume. Routing
execution to Sonnet and mechanical work to Haiku means your premium quota is
spent only where premium reasoning actually changes the outcome.

**Recommended setup — Opus first line:** sit on Opus 4.8 (`/model opus`) so
strong reasoning is always on tap, and let the protocol delegate routine builds
*down* to Sonnet and mechanical work *down* to Haiku, reaching *up* to Fable only
on the ~15% of turns that are genuinely frontier-hard. See
[Chair Profiles](docs/CHAIR-PROFILES.md) for every chair's behavior.

## Quick start

```bash
git clone https://github.com/vonzelle-vzt/vzt-agent-protocol.git
cd vzt-agent-protocol

# install into the current project's .claude/
node cli/vzt-agent.js install --target /path/to/your/project

# or install globally for every project
node cli/vzt-agent.js install --global

# verify
node cli/vzt-agent.js doctor --global
```

Restart Claude Code. Pick the chair that matches how you work — the protocol
adapts the routing doctrine to it either way:

- **Opus 4.8 chair** (`/model opus`) — build inline, delegate routine execution
  *down* to Sonnet and mechanical work to Haiku, escalate *up* to Fable only for
  hard architecture/debugging. Best when you want strong first-line reasoning on
  tap and Sonnet as your workhorse below it.
- **Sonnet 5 chair** (`/model sonnet`) — most work stays inline on the
  Sonnet-only bucket; escalate *up* to Opus/Fable only when a task earns it.
  Best for maximum quota efficiency.

## How it works — four real routing layers

Unlike prompt-only "routers" (see [comparison](#vs-fable-prep)), every layer
here uses a mechanism Claude Code actually enforces:

### 1. Per-prompt classifier hook (`UserPromptSubmit`)
A deterministic, <50ms, zero-API-cost classifier scores every prompt against
the routing matrix (25+ signal patterns + length heuristics) and injects a
`[VZT-ROUTE]` directive: which tier, which agent, whether to handle inline.
Every decision is logged to `~/.claude/vzt-router/decisions.jsonl`.

### 2. Chair-aware session profiles (`SessionStart`)
The protocol reads which model your session launched with and **inverts the
doctrine to match**:
- **Fable chair** → tokens are scarce: plan inline, delegate ALL execution down
- **Opus chair** → clock is scarce: build inline, push mechanical work down
- **Sonnet chair** → capability is scarce: escalate up only when a task earns it
- **Haiku chair** → dispatcher mode: delegate almost everything

### 3. Model-pinned agent fleet (`.claude/agents/`)
Seven agents with `model:` + `effort:` frontmatter — Claude Code runs each on
its pinned model regardless of your session model:

| Agent | Model | Effort | Role |
|-------|-------|--------|------|
| `vzt-planner` | fable | max | Plans with a **step-routing table** (each step tagged with its cheapest sufficient tier) |
| `vzt-oracle` | fable | max | Root-causes impossible bugs; returns a fix packet, not a guess |
| `vzt-heavy-builder` | opus | high | Tightly-coupled multi-file surgery, algorithms, migrations |
| `vzt-reviewer` | opus | high | Reviews **only the load-bearing seam** the plan flags |
| `vzt-builder` | sonnet | medium | The workhorse — all routine implementation |
| `vzt-scout` | haiku | low | Recon: find/count/summarize, read-only |
| `vzt-mechanic` | haiku | low | Mechanical edits: renames, formatting, bumps |

### 4. Turn-level skills (skill `model:` override)
When up- or down-tier work needs the **full conversation context** (subagents
start fresh), these switch the *current turn's* model in place:

- `/vzt-plan <task>` — plan this turn on **Fable 5**
- `/vzt-fix <bug>` — root-cause this turn on **Fable 5**
- `/vzt-build <step>` — execute this turn on **Sonnet 5**
- `/vzt-quick <task>` — mechanical turn on **Haiku 4.5**
- `/vzt-fable-mode` — run this turn under the five frontier working gates
  (scope, evidence, attack, verify, report) (no model pin — runs on the
  active model)

The session model returns on your next prompt.

## The standard pipeline

```
you: "build feature X"  (a non-trivial, multi-part feature)
 └─ PLAN → vzt-planner (Fable 5, effort max)   ·   or /vzt-plan for an in-context turn
     └─ plan with step-routing table + load-bearing seam flagged
         ├─ steps tagged sonnet → vzt-builder        (parallel)
         ├─ steps tagged haiku  → vzt-mechanic/scout (parallel)
         ├─ steps tagged opus   → vzt-heavy-builder
         └─ seam review         → vzt-reviewer (Opus, only the risky seam)
```

On an **Opus chair**, a routine one-shot request skips planning entirely — the
classifier delegates the build straight down to `vzt-builder` (Sonnet) and any
mechanical part to `vzt-mechanic` (Haiku), while you stay on Opus as coordinator.
Full walkthroughs per chair: [Chair Profiles](docs/CHAIR-PROFILES.md).

## Guardrails

- **Escalation ladder** — two failures at a tier escalates exactly one tier
  (haiku→sonnet→opus→fable), stated aloud. Under-routing is self-healing.
- **Fable budget** — ≤15% of turns; `vzt-agent stats` shows your distribution
  against the target.
- **No frontier execution** — plans always hand execution to cheaper tiers.
- **Advisory, not authoritarian** — directives are context injections; Claude
  overrides them only with a stated reason.

## Manual overrides

| Input | Effect |
|-------|--------|
| `@fable` / `@opus` / `@sonnet` / `@haiku` prefix | Force a tier for that prompt |
| `~` prefix | Bypass routing for that prompt |
| `/vzt-route <task>` | Ask for an explicit routing decision |
| `/vzt-route stats` | Tier distribution vs. targets |

## CLI

```bash
vzt-agent install [--global] [--target <dir>]   # install + wire settings.json
vzt-agent uninstall [--global] [--target <dir>] # clean removal
vzt-agent doctor [--global]                     # health check
vzt-agent stats                                 # routing decision distribution
vzt-agent matrix                                # print the routing matrix
```

## vs. fable-prep

Inspired by the premise of [Dallionking/fable-prep](https://github.com/Dallionking/fable-prep)
(prep work on cheap models, frontier executes), but that repo contains **no
actual model routing** — its model config is unused strings and mode selection
is a manually flipped sentinel file. Comparison:

| | fable-prep | vzt-agent-protocol |
|---|---|---|
| Model switching | ❌ manual sentinel file; user launches the right model | ✅ 4 enforced layers: agent `model:` frontmatter, skill turn overrides, per-prompt classifier, chair profiles |
| Haiku tier | ❌ absent | ✅ two agents + turn skill |
| Per-step routing | ❌ whole-queue only | ✅ step-routing table in every plan |
| Effort routing | ❌ | ✅ `effort:` pinned per tier, plus a per-prompt suggested effort in every [VZT-ROUTE] directive |
| Escalation | ❌ | ✅ one-tier ladder, both directions |
| Chair awareness | ❌ | ✅ doctrine inverts with session model |
| Decision telemetry | ❌ | ✅ JSONL log + `stats` with budget target |
| Enforcement | prose only | hooks + frontmatter Claude Code enforces |
| Worker brief contract | ❌ (sol-prep sibling repo: prose-only lane briefs) | ✅ canonical template + agent-enforced collision-boundary halt + reporting≠persistence verification |

## The process is the moat

Model choice alone isn't the whole story — the working discipline riding on
top of it is. `/vzt-fable-mode` extracts the frontier tier's five gates (scope
before acting, evidence before reasoning, attack your own approach, verify
before declaring done, report only what you verified) into a portable process
any tier can run — a cheaper model running these gates beats a frontier model
running none. The orchestrator doctrine (frontier designs and verifies,
Sonnet/Haiku execute and report back) is what actually delivers the ~8–25×
lower cost on routine steps at equal quality. The Cost/Intelligence/Taste
columns in the [routing matrix](docs/ROUTING-MATRIX.md) quantify that
trade-off tier by tier, so the routing decision is a number, not a vibe.

### How fable-mode activates

- **Automatic in fleet executors** — `vzt-builder`, `vzt-heavy-builder`, and
  `vzt-mechanic` carry the gate summary as Rule 1, so anything the router
  delegates to them runs the gates with no user action. `vzt-planner`,
  `vzt-oracle`, and `vzt-reviewer` don't reference it — they're the source of
  the doctrine, not a consumer of it.
- **Manual on the chair** — `/vzt-fable-mode <task>` loads the full skill into
  the current turn, the "elevate Opus/Sonnet" move for hard inline work. The
  model may also auto-invoke it when a task obviously calls for the discipline,
  but the slash command is the guaranteed path. Skip it for routine one-liners
  — the gates would just add overhead.
- **No model pin, by design** — unlike `/vzt-plan`/`/vzt-fix` (force Fable),
  `/vzt-build` (Sonnet), and `/vzt-quick` (Haiku), fable-mode runs on whatever
  model is already active. It changes *how* the current model works, not
  *which* model works: the router picks the tier and effort, fable-mode
  upgrades the discipline of whichever tier got picked. The two dials are
  independent.

## Requirements

- Claude Code ≥ 2.1.170 (skill/agent `model:` frontmatter incl. `fable` alias)
- Node.js ≥ 18
- A plan with access to Fable 5 (falls back gracefully: `availableModels`
  restrictions make blocked tiers inherit the session model)

## Docs

- [Chair profiles — Opus-first, Sonnet-first, Fable, Haiku](docs/CHAIR-PROFILES.md)
- [Routing matrix + decision procedure](docs/ROUTING-MATRIX.md)
- [CLAUDE.md snippet for manual installs](templates/CLAUDE-snippet.md)

## Release notes

### 1.2.0 — 2026-07-08

- Added worker-brief delegation doctrine: `templates/worker-brief.md` is the
  canonical template (TASK/CONTEXT/FILES_IN_SCOPE/OPERATION/ACCEPTANCE/
  MACHINE_CHECK/EXPECT/CONSTRAINTS/REPORT) — brief format adapted from
  [Dallionking/sol-prep](https://github.com/Dallionking/sol-prep)'s lane-brief
  concept.
- **Collision boundary**: FILES_IN_SCOPE in a brief is a hard write boundary —
  `vzt-builder`, `vzt-mechanic`, and `vzt-heavy-builder` now all STOP and
  report rather than expanding scope if the task needs a file outside it.
- **Machine-checkable acceptance**: `vzt-planner`'s step-routing table now
  carries a `machine_check` command per step, chosen at plan time, not
  invented by the worker after the fact.
- **Reporting ≠ persistence**: the `SessionStart` hook's Fable/Opus chair
  profiles and `skills/vzt-route/SKILL.md` now tell the orchestrator to verify
  worker artifacts on disk (git diff, re-run the check) before accepting a
  completion report.
- Added a sync test asserting the template, the three worker agents, and the
  routing skill all carry the new contract.

### 1.1.0 — 2026-07-07

- Added the `vzt-fable-mode` skill: the frontier tier's five working gates
  (scope, evidence, attack, verify, report) extracted into a portable process
  any tier can run — cited as a new rule 1 in `vzt-builder`, `vzt-heavy-builder`,
  and `vzt-mechanic`.
- Effort is now a routing dimension: the classifier computes a suggested
  effort (`suggestEffort()`) per prompt and surfaces it in every `[VZT-ROUTE]`
  directive (`@ effort low|medium|high`), alongside an effort note explaining
  when not to reach for `xhigh`/`max`.
- Added Cost/Intelligence/Taste columns to `TIERS` in the classifier hook, with
  matching columns in `docs/ROUTING-MATRIX.md` and `skills/vzt-route/SKILL.md`
  — a sync test now enforces the cost values match across all three.
- Added orchestrator doctrine (frontier designs and verifies; Sonnet/Haiku
  execute and report back) to `vzt-planner`, `skills/vzt-route/SKILL.md`, the
  `SessionStart` hook's Fable/Opus profiles, and the CLAUDE.md snippet.

## License

MIT © VZT Tech Consulting
