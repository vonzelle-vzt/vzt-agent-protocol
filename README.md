# VZT Agent Protocol

**Automatic model routing for Claude Code — Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5. Right model, right task, zero manual switching.**

Part of the [VZT Tech Consulting Protocol](https://github.com/vonzelle-vzt/VZT-Tech-Consulting-Protocol) ecosystem.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-purple.svg)](#)
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

The session model returns on your next prompt.

## The standard pipeline

```
you: "build feature X"
 └─ classifier → PLAN → vzt-planner (Fable 5, effort max)
     └─ plan with step-routing table + load-bearing seam flagged
         ├─ steps tagged sonnet → vzt-builder        (parallel)
         ├─ steps tagged haiku  → vzt-mechanic/scout (parallel)
         ├─ steps tagged opus   → vzt-heavy-builder
         └─ seam review         → vzt-reviewer (Opus, only the risky seam)
```

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
| Effort routing | ❌ | ✅ `effort:` pinned per tier |
| Escalation | ❌ | ✅ one-tier ladder, both directions |
| Chair awareness | ❌ | ✅ doctrine inverts with session model |
| Decision telemetry | ❌ | ✅ JSONL log + `stats` with budget target |
| Enforcement | prose only | hooks + frontmatter Claude Code enforces |

## Requirements

- Claude Code ≥ 2.1.170 (skill/agent `model:` frontmatter incl. `fable` alias)
- Node.js ≥ 18
- A plan with access to Fable 5 (falls back gracefully: `availableModels`
  restrictions make blocked tiers inherit the session model)

## Docs

- [Routing matrix + decision procedure](docs/ROUTING-MATRIX.md)
- [CLAUDE.md snippet for manual installs](templates/CLAUDE-snippet.md)

## License

MIT © VZT Tech Consulting
