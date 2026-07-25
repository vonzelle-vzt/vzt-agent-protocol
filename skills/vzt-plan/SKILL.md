---
name: vzt-plan
description: "Plan the given task on Fable 5 with full conversation context — the LAST rung. Use ONLY when the design has no prior art to reason from: novel or greenfield architecture, from-scratch system design, one-way-door sharding/replication/consensus/multi-tenancy calls. For routine architecture, specs, roadmaps and migration plans use /vzt-design (Opus 5 @ max) instead — half the cost. Usage: /vzt-plan <task>."
model: fable
effort: max
---

# VZT Plan — frontier planning turn (Fable 5)

This turn runs on Fable 5 (the skill's model override). Use the elevated
capability for reasoning, not execution.

**Check you need this rung first.** `/vzt-design` runs Opus 5 at `max` effort
for half the cost and owns routine planning — architecture, tech specs,
roadmaps, migration plans. This turn is for planning with *no prior art to
pattern-match against*: novel or greenfield architecture, from-scratch system
design, one-way-door calls on sharding, replication, consensus, or
multi-tenancy. If the task turns out to be ordinary planning, say so in your
first line and produce the plan anyway — but flag that it didn't need Fable.

Produce an **execution-ready plan** for the requested task:

1. Read the actual code/config the plan touches before deciding anything.
2. Pick one approach; defend it in two sentences. Mention an alternative only
   if the trade-off is genuinely close.
3. End with a **step-routing table** so each step runs on the cheapest
   sufficient tier next turn:

   | # | Step | Files | Tier | Verify |
   |---|------|-------|------|--------|

   Tier values: `haiku` (mechanical/recon), `sonnet` (default execution),
   `opus` (dense/tightly-coupled steps), `fable` (rare — genuinely frontier-hard).
4. Give every step a machine-checkable verification (command + expected result).
5. Flag the load-bearing seam — the one or two steps that earn an Opus review.

**Do not implement anything this turn.** The session model returns next
prompt; execution belongs to `vzt-builder`/`vzt-mechanic` per the table
(or `/vzt-build` to execute in-context on Sonnet).
