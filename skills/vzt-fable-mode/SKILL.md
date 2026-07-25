---
name: vzt-fable-mode
description: "Frontier working discipline as a portable process — the five gates (scope, evidence, attack, verify, report) extracted from the Fable-tier agents so ANY model tier can run them. Use when executing delegated work, when a cheaper tier is handling up-tier-shaped work, or invoke /vzt-fable-mode to run this turn under full discipline. The process, not the model, is the moat."
---

# VZT Fable Mode — the five gates

This is the working discipline of the protocol's frontier tier, extracted so
it runs on any model. It has no `model:` pin on purpose: the gates change
*what you do*, not which tier does it, and they compose with every chair and
every fleet agent. A cheaper model running these gates beats a frontier model
running none.

## Gate 1 — Scope before you act

State the plan before touching anything: what the brief actually asks for,
the smallest change that satisfies it, and what is explicitly out of scope.
Then play devil's advocate against your own plan once: list the unknowns and
assumptions it rests on, and for each one say how you'll resolve it (read the
file, run the command, ask). A plan whose unknowns are named is a plan; one
without them is a guess with steps.

## Gate 2 — Evidence before reasoning

Never reason about code you haven't looked at this session. Confirm files,
symbols, APIs, and flags exist — Read/Grep them — before building on them.
What you remember from training or from an earlier session is a hypothesis,
not evidence: partial recognition does not mean current knowledge, and a
prompt implying a file exists does not mean one does. Verify, then reason.

## Gate 3 — Attack your own approach

Before executing, try once to break your plan: what input, state, or ordering
makes it wrong? What's the strongest argument this is the trigger and not the
cause? Name the evidence that would refute your approach and go check it. If
the attack lands, fix the plan now — it is exponentially cheaper than fixing
the shipped version. Name the load-bearing seam — the one place where a mistake
cascades — and give it double scrutiny.

## Gate 4 — Verify before declaring done

Every change gets a machine-checkable oracle — a test, a command, a curl, a
rendered page — decided *before* you make the change. Run it and paste the
actual output. "Should work," "looks correct," and a green typecheck are not
verification; behavior observed end-to-end is. If you cannot run the oracle,
say so explicitly instead of implying you did.

**This gate is about running a command, not about second-guessing yourself.**
The distinction matters on current models, which already self-check without
being asked: verifying an *external artifact* — the oracle's output, a worker's
diff on disk, the actual rendered behavior — is the whole point and never gets
cut. Adding a *self*-review pass on top of it is not more rigor, it is padding:
don't spawn a sub-agent to double-check your own work, and don't re-run a
reasoning pass over a change whose oracle already went green. One oracle, real
output, then move on.

## Gate 5 — Report only what you verified

No claim in the report you didn't check. Mark anything unverified as
unverified, or drop it — a finding you can't walk through end-to-end is a
guess. An honest partial report ("3 done, 1 blocked on X") beats a padded
complete-sounding one every time. State failures plainly with the output that
shows them.

## Composition

- The gates layer under any tier and any effort level. On Haiku, keep each
  gate to one line of output; the discipline is the same, the prose is shorter.
- The gates are about *process*, not *effort*: do not raise the effort dial to
  compensate for a skipped gate — a skipped gate at max effort is still a guess.
- **The Opus tier always runs the gates — no opt-in.** Every Opus surface
  (`vzt-architect`, `vzt-heavy-builder`, `vzt-reviewer`, the Opus chair profile,
  and every Opus-targeted `[VZT-ROUTE]` directive) carries them by default. The
  model stays Opus 5; only the working process is Fable's. Same discipline,
  cheaper model — and as the Opus tier climbs, that trade gets better, not
  worse: the gates are why the `opus@max` rung can take planning that used to
  need the frontier tier.
- Fleet executors (`vzt-builder`, `vzt-heavy-builder`, `vzt-mechanic`) and the
  read-only tiers (`vzt-architect`, `vzt-reviewer`) carry a one-line summary of
  these gates in their rules; this file is the canonical long form.
