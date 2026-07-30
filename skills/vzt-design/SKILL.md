---
name: vzt-design
description: "Plan the given task on Opus 5 at max effort — the `opus@max` rung. Use for architecture, technical specs, roadmaps, migration plans, and breaking down a feature when the planning needs full conversation context. This is the DEFAULT planning turn; use /vzt-plan (Fable) only when the design is genuinely novel. Usage: /vzt-design <task>."
model: opus
effort: max
---

# VZT Design — planning turn on the `opus@max` rung (Opus 5)

This turn runs Opus 5 at `max` effort (the skill's model + effort override). It is
the **default planning turn** of the protocol. Opus 5 is a step change on deep
reasoning at half Fable's cost, so `/vzt-plan` (Fable) is reserved for planning
with no prior art — a novel or greenfield architecture, or a one-way-door
distributed-systems call. Everything else lands here.

This is **technical** design — architecture, schemas, APIs, migration plans.
*Visual* design (look and feel, tokens, palette, brand) is a different lane:
`/vzt-ui`. The word is overloaded; if the ask is about how something looks rather
than how it is built, use that instead.

Produce an **execution-ready plan** for the requested task:

1. Read the actual code/config the plan touches before deciding anything. A plan
   built on a remembered API is a guess with steps in it.
2. Pick one approach; defend it in two sentences. Mention an alternative only if
   the trade-off is genuinely close — give a recommendation, not a survey.
3. Plan at the scope asked. Don't widen the brief into a redesign or quietly
   narrow it; if the ask looks wrong, say so in a sentence and plan it anyway
   with the concern flagged.
4. End with a **step-routing table** so each step runs on the cheapest sufficient
   tier next turn:

   | # | Step | Files | Tier | Verify |
   |---|------|-------|------|--------|

   Tier values: `haiku` (mechanical/recon), `sonnet` (default execution),
   `opus` (dense/tightly-coupled steps). Never tag a step `opus@max` or `fable` —
   those are planning rungs, not execution tiers.
5. Give every step a machine-checkable verification (command + expected result),
   chosen *before* the step is built.
6. Flag the load-bearing seam — the one or two steps that earn an Opus review.

**Escalate once, honestly.** If the design turns out to have no prior art to
reason from, stop and say so: `/vzt-plan` takes it to Fable with full context.
Don't do frontier work at this rung silently, and don't escalate to look
thorough — most planning does not need Fable.

**Do not implement anything this turn.** The session model returns next prompt;
execution belongs to `vzt-builder`/`vzt-mechanic` per the table (or `/vzt-build`
to execute in-context on Sonnet). If the work is big enough that the plan is
really a program of work, point at `/vzt-ship` — it puts the spec on disk where
compaction can't eat it.
