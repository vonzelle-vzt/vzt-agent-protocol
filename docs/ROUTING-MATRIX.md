# VZT Agent Protocol — Routing Matrix

The protocol routes every piece of work to the **cheapest tier that can do it
well**. Under-routing is cheap (the escalation ladder catches it); over-routing
burns the quota this protocol exists to protect.

## Tiers

<!-- sync: TIERS in hooks/vzt-route-classifier.mjs — test/classifier.test.mjs asserts the Cost column matches -->
| Tier | Model | Alias | Owns | Fleet agents | Turn skill | Cost | Intelligence | Taste |
|------|-------|-------|------|--------------|------------|------|--------------|-------|
| 4 | Claude Fable 5 | `fable` | Architecture, system design, planning, migration strategy, impossible bugs, root-cause analysis, security analysis, multi-repo strategy | `vzt-planner`, `vzt-oracle` | `/vzt-plan`, `/vzt-fix` | 25× | 10 | 10 |
| 3 | Claude Opus 4.8 | `opus` | Large refactors, migrations, dense algorithms, performance/concurrency surgery, load-bearing review | `vzt-heavy-builder`, `vzt-reviewer` | — | 15× | 9 | 9 |
| 2 | Claude Sonnet 5 | `sonnet` | Standard implementation: features, bug fixes, tests, endpoints, components, integration — **the default tier** | `vzt-builder` | `/vzt-build` | 3× | 8 | 8 |
| 1 | Claude Haiku 4.5 | `haiku` | Search/recon, summaries, renames, typo fixes, formatting, lint, version bumps, commit messages, file moves | `vzt-scout`, `vzt-mechanic` | `/vzt-quick` | 1× | 5 | 4 |

## Decision procedure

1. Mechanical or pure discovery? → **Tier 1**, no exceptions.
2. Requires choosing an approach (architecture/schema/strategy/trade-offs), or
   has beaten a lower tier twice? → **Tier 4**.
3. Implementation with tight coupling, algorithms, or blast radius? → **Tier 3**.
4. Scope language (entire codebase / from scratch / greenfield / end-to-end /
   multi-tenant / ...) **plus a build verb** (build/implement/ship/create/
   scaffold/rewrite/...)? → **Tier 3, kind `HORIZON`** — spec-first via
   `/vzt-ship`, not routine inline execution. **Scope language alone, with no
   build verb, is still a planning question and stays on Tier 4** ("design the
   architecture for the whole system").
5. Everything else → **Tier 2**. Unsure between two tiers? Take the lower.

## HORIZON — long-horizon work

Long-horizon work doesn't fail because the model isn't smart enough; it fails
because context compaction eats the plan halfway through the run, and the
back half gets built against a plan the chair no longer remembers. A slower
model doesn't fix that — a plan on disk does. **Escalate the PROCESS, not the
MODEL.**

- **Trigger**: the two-factor gate above — scope language **and** a build
  verb, both present in the same prompt.
- **Action**: route to **Opus 4.8**, task kind `HORIZON`, and point at
  `/vzt-ship` — spec-first: write `.vzt/ship/<slug>/SPEC.md` (contract,
  out-of-scope, cross-unit interfaces as a barrier unit, file manifest, units
  with pairwise-disjoint `FILES_IN_SCOPE` and one oracle each) before any
  code, gate it with `vzt-agent ship-check`, then run it as supervised
  background workers.
- **Explicitly not HORIZON**: scope language with no build verb. That stays a
  planning question on Fable — the work being *asked for* is a plan, not a
  shipped artifact.

## Hard rules

- **Escalation ladder**: two failures at a tier → up exactly one tier
  (haiku → sonnet → opus → fable), stated aloud.
- **Fable budget**: Fable turns ≤15% of a session (`vzt-agent stats` tracks it).
- **Never execute a routine plan on Fable/Opus** — plans hand off to
  `vzt-builder` via the step-routing table.
- **Chair-aware inversion**: on a Fable/Opus chair the doctrine flips to
  delegating DOWN; on a Sonnet/Haiku chair it escalates UP only when earned.

## Why this saves your limits

- Max-plan weekly limits have **two buckets**: one for all models, one for
  **Sonnet only**. Work routed to `vzt-builder`/`/vzt-build` draws on the
  Sonnet bucket and preserves the all-models bucket that Fable and Opus burn.
- Per-turn cost is tiered (Opus is several × Sonnet, Sonnet several × Haiku),
  so pushing recon and mechanical work to Haiku is nearly free.

## Effort routing

- Default effort per tier: Fable `high`, Opus `high`, Sonnet `medium`, Haiku
  `low`.
- Opus downgrades to `medium` on low-confidence classifications — don't spend
  high effort confirming a guess.
- The classifier never suggests `max` — that's reserved for pinned Fable
  agents or an explicit escalation, not routine routing.
- Fable-low ≈ Opus-high in quality-per-cost.
- `xhigh`/`max` on routine work causes overthinking, not quality.

**`/vzt-fable-mode` is a separate dial from tier/effort routing above**: it
carries no `model:` pin and runs on whichever model the router already picked,
upgrading that tier's *working discipline* (the five gates) rather than
switching model or effort. Fleet executors carry it automatically as Rule 1;
on the chair it's invoked manually via `/vzt-fable-mode <task>`.
