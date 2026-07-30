# VZT Agent Protocol — Routing Matrix

The protocol routes every piece of work to the **cheapest tier that can do it
well**. Under-routing is cheap (the escalation ladder catches it); over-routing
burns the quota this protocol exists to protect.

## Tiers

<!-- sync: TIERS in hooks/vzt-route-classifier.mjs — test/classifier.test.mjs asserts the Cost column matches -->
| Tier | Model | Alias | Owns | Fleet agents | Turn skill | Cost | Intelligence | Taste |
|------|-------|-------|------|--------------|------------|------|--------------|-------|
| 4 | Claude Fable 5 | `fable` | Planning with **no prior art**: novel/greenfield architecture, from-scratch system design, one-way-door sharding/replication/consensus/multi-tenancy calls. Impossible bugs, root-cause analysis, security analysis | `vzt-planner`, `vzt-oracle` | `/vzt-plan`, `/vzt-fix` | 10× | 10 | 10 |
| 3+ | Claude Opus 5 @ `max` | `opus@max` | **Routine planning** — architecture, tech specs, roadmaps, migration plans, PRD breakdown, approach selection | `vzt-architect` | `/vzt-design` | 5× | 9 | 9 |
| 3 | Claude Opus 5 | `opus` | Large refactors, migrations, dense algorithms, performance/concurrency surgery, load-bearing review. **Authoring visual taste** when no `DESIGN.md` exists | `vzt-heavy-builder`, `vzt-reviewer`, `vzt-art-director` | `/vzt-ui` | 5× | 9 | 9 |
| 2 | Claude Sonnet 5 | `sonnet` | Standard implementation: features, bug fixes, tests, endpoints, components, integration — **the default tier**. **Applying visual taste** from an existing `DESIGN.md` | `vzt-builder`, `vzt-stylist` | `/vzt-build` | 3× | 8 | 8 |
| 1 | Claude Haiku 4.5 | `haiku` | Search/recon, summaries, renames, typo fixes, formatting, lint, version bumps, commit messages, file moves | `vzt-scout`, `vzt-mechanic` | `/vzt-quick` | 1× | 5 | 4 |

## Decision procedure

1. Mechanical or pure discovery? → **Tier 1**, no exceptions.
2. Requires choosing an approach (architecture/schema/strategy/trade-offs)? →
   **Tier 3+ (`opus@max`)** — `vzt-architect` / `/vzt-design`. This is where
   planning goes by default.
   - **Tier 4** only if the design has **no prior art to reason from**: novel,
     greenfield, from-scratch, or a one-way-door distributed-systems call
     (sharding, replication, consensus, multi-tenancy). Or if it has beaten a
     lower rung twice.
3. Implementation with tight coupling, algorithms, or blast radius? → **Tier 3**.
3b. **Visual work** — restyle, retheme, spacing, typography, palette, brand,
   "make it look right"? → **the `ui` lane**, and the tier is decided by a FILE,
   not by the prompt: a real `DESIGN.md` at the repo root → **Tier 2**
   (`vzt-stylist`, apply it); no `DESIGN.md` and the ask carries taste language →
   **Tier 3** (`vzt-art-director`, write it once). Surface-only tweaks with no
   cache stay Tier 2. See **VISUAL** below.
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
- **Action**: route to **Opus 5**, task kind `HORIZON`, and point at
  `/vzt-ship` — spec-first: write `.vzt/ship/<slug>/SPEC.md` (contract,
  out-of-scope, cross-unit interfaces as a barrier unit, file manifest, units
  with pairwise-disjoint `FILES_IN_SCOPE` and one oracle each) before any
  code, gate it with `vzt-agent ship-check`, then run it as supervised
  background workers.
- **Explicitly not HORIZON**: scope language with no build verb. That stays a
  planning question — the work being *asked for* is a plan, not a shipped
  artifact. It routes to `opus@max`, or to Fable if it is genuinely novel.

## VISUAL — the taste cache

Visual work is the one kind the classifier used to be blind to: *"restyle the
dashboard"*, *"the spacing is off"*, *"the palette is wrong"* matched nothing and
fell into the zero-signal default, done from whatever the model imagined the
product looked like.

A **`DESIGN.md` at the repo root** fixes it by moving taste **off the model tier
and onto disk** — the same move `/vzt-ship` makes for long-horizon plans. Once
the taste is written down, applying it is execution, not judgement, so it routes
down a tier.

- **Two-factor gate**, structurally identical to HORIZON — except the second
  factor is a **file**, not a second regex. The classifier does a cheap
  `statSync` *only* after the `ui` lane has already won, so routine turns pay
  nothing.
- **The lane splits by who has to decide.** TASTE language (*"look and feel"*,
  *"make it feel premium"*, *"design system"*, *"off-brand"*) scores on Opus —
  somebody has to invent an answer. SURFACE language (*"spacing"*, *"dark mode"*,
  *"the hero"*, *"contrast ratio"*) scores on Sonnet — it says what to change,
  not what it should become. Surface-on-Sonnet is the safety property: a visual
  false positive can never buy a more expensive tier.
- **Cache hit → Tier 2.** `vzt-stylist` applies the file. Every value must trace
  to a token; a missing token is a **gap it reports**, never a value it invents.
- **Cache miss + taste → Tier 3.** `vzt-art-director` writes `DESIGN.md` **once**,
  derived from the repo's real token layer, then applies it to the one screen
  asked for. Everything after that routes down automatically.
- **A stub is not a cache.** Under 400 bytes counts as absent — a placeholder
  would down-route every visual request forever while containing no taste to
  apply.
- **Explicitly not VISUAL**: technical design. `design the <system|schema|api|
  architecture>` stays `plan` and routes to `opus@max` or Fable. The word
  "design" is overloaded; this lane is entered by taste nouns and restyle verbs,
  never by "design" standing alone.
- **No rung above it.** Visual work never escalates to Fable — taste is not
  frontier reasoning, and every product ever shipped is prior art.

## Hard rules

- **Escalation ladder**: two failures at a rung → up exactly one rung
  (haiku → sonnet → opus → opus@max → fable), stated aloud.
- **Fable budget**: Fable turns ≤10% of a session (`vzt-agent stats` tracks it).
  The `opus@max` rung absorbs the planning that used to land there.
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
- **Opus `PLAN` returns `max`** — that *is* the `opus@max` rung, and it is the
  only place the classifier suggests `max`. (The older "never suggests max"
  invariant was retired when the rung was added.)
- Start `xhigh` for coding/agentic work and `high` elsewhere, then sweep
  **down**: Opus 5 is unusually strong at `low`/`medium`, so effort defaults
  carried over from earlier models over-spend. `xhigh` remains the right call
  for the heavy-builder's dense work.

**`/vzt-fable-mode` is a separate dial from tier/effort routing above**: it
carries no `model:` pin and runs on whichever model the router already picked,
upgrading that tier's *working discipline* (the five gates) rather than
switching model or effort. Fleet executors carry it automatically as Rule 1;
on the chair it's invoked manually via `/vzt-fable-mode <task>`.
