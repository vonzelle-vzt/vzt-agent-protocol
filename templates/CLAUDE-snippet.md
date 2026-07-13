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
- **Planning/architecture/impossible bugs** → `vzt-planner`/`vzt-oracle`
  (Fable), or `/vzt-plan` / `/vzt-fix` when full conversation context matters.
- **Long-horizon work** (scope language — entire codebase, from scratch,
  greenfield, end-to-end, multi-tenant — combined with a build verb) →
  `/vzt-ship` (Opus, spec-first). It writes a SPEC to
  `.vzt/ship/<slug>/SPEC.md` before any code, gates it with
  `vzt-agent ship-check`, then runs it as supervised background workers.
  Escalate the PROCESS, not the model — scope language alone with no build
  verb is still a planning question and stays on Fable.

Rules: two failures at a tier → escalate exactly one tier and say so. Fable
turns ≤15% of the session. Never execute a routine plan on Fable/Opus — plans
end with a step-routing table and hand off to `vzt-builder`.

Orchestrator doctrine: when Fable/Opus orchestrates multi-step or dynamic
work, default worker steps to Sonnet (Haiku if mechanical) — equal results at
~8–25× lower cost; the orchestrator designs and verifies, workers execute and
report back, and only a stated reason promotes a step to the orchestrator's
own tier.
