---
name: vzt-plan
description: "Plan the given task on Fable 5 with full conversation context. Use for architecture, system design, migration strategy, or breaking down a large feature — when the planning needs everything already discussed in this session. Usage: /vzt-plan <task>."
model: fable
effort: max
---

# VZT Plan — frontier planning turn (Fable 5)

This turn runs on Fable 5 (the skill's model override). Use the elevated
capability for reasoning, not execution.

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
