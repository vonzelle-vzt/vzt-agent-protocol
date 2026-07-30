# VZT Agent Protocol — CLAUDE.md snippet

Paste this into a project's `CLAUDE.md` if you want the routing doctrine
active without the hooks (or as reinforcement alongside them).

---

## Model routing (VZT Agent Protocol)

Route every piece of work to the cheapest tier that can do it well:

- **Recon/mechanical** (search, summaries, renames, formatting, bumps) →
  delegate to `vzt-scout`/`vzt-mechanic` (Haiku). Never do this inline on a
  premium model.
- **Standard implementation** (features, fixes, tests, endpoints) →
  `vzt-builder` (Sonnet) or inline if the chair is Sonnet.
- **Heavy implementation** (tight coupling, algorithms, migrations, perf) →
  `vzt-heavy-builder` (Opus). Load-bearing review → `vzt-reviewer` (Opus).
- **Planning** (architecture, tech specs, roadmaps, migration plans, PRD
  breakdown) → `vzt-architect` (Opus 5 @ `max` — the `opus@max` rung), or
  `/vzt-design` when full conversation context matters. This is where planning
  goes by default.
- **No-prior-art planning** (novel or greenfield architecture, from-scratch
  design, one-way-door sharding/replication/consensus/multi-tenancy calls) **and
  impossible bugs** → `vzt-planner`/`vzt-oracle` (Fable), or `/vzt-plan` /
  `/vzt-fix` when full conversation context matters. This is the last rung —
  routine architecture does not belong here.
- **Visual work** (restyle, retheme, spacing, typography, palette, brand, dark
  mode, "make it look right") → read `DESIGN.md` at the repo root FIRST, then
  delegate to `vzt-stylist` (Sonnet) and make every value trace to a token. If
  there is no `DESIGN.md`, the first move is to WRITE one — `/vzt-ui` /
  `vzt-art-director` (Opus), once — not to hand-style a single screen. Taste on
  disk is what lets visual work run on a cheap tier. This is *visual* design;
  technical design is the `vzt-architect` bullet above.
- **Long-horizon work** (scope language — entire codebase, from scratch,
  greenfield, end-to-end, multi-tenant — combined with a build verb) →
  `/vzt-ship` (Opus, spec-first). It writes a SPEC to
  `.vzt/ship/<slug>/SPEC.md` before any code, gates it with
  `vzt-agent ship-check`, then runs it as supervised background workers.
  Escalate the PROCESS, not the model — scope language alone with no build
  verb is still a planning question: it goes to `opus@max`, or Fable if the
  design is genuinely novel.

Rules: two failures at a rung → escalate exactly one rung
(haiku → sonnet → opus → opus@max → fable) and say so. Fable turns ≤10% of the
session. Never execute a routine plan on Fable/Opus — plans end with a
step-routing table and hand off to `vzt-builder`.

Orchestrator doctrine: when Fable/Opus orchestrates multi-step or dynamic
work, default worker steps to Sonnet (Haiku if mechanical) — equal results at
~8–25× lower cost; the orchestrator designs and verifies, workers execute and
report back, and only a stated reason promotes a step to the orchestrator's
own tier.

Delegation cap: don't delegate work you could finish in a handful of tool calls
— a sub-agent re-establishes context, re-explores, and reports back, and you
still have to read the report. Prefer one sub-agent over several, keep spawn
counts low, and once you delegate, commit: never re-derive a worker's findings.
Verify **external** artifacts relentlessly (run the oracle, `git diff` the
worker's output); never spawn a sub-agent to double-check your own inline work.

Scope: deliver what was asked at the scope intended — no unrequested refactors,
abstractions, or error handling for cases that cannot happen. Lead with the
outcome.
