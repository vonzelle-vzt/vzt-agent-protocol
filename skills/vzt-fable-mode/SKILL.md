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
the shipped version.

## Gate 4 — Verify before declaring done

Every change gets a machine-checkable oracle — a test, a command, a curl, a
rendered page — decided *before* you make the change. Run it and paste the
actual output. "Should work," "looks correct," and a green typecheck are not
verification; behavior observed end-to-end is. If you cannot run the oracle,
say so explicitly instead of implying you did.

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
  (`vzt-heavy-builder`, `vzt-reviewer`, the Opus chair profile, and every
  Opus-targeted `[VZT-ROUTE]` directive) carries them by default. The model
  stays Opus 4.8; only the working process is Fable's. Same discipline,
  cheaper model.
- Fleet executors (`vzt-builder`, `vzt-heavy-builder`, `vzt-mechanic`) and
  `vzt-reviewer` carry a one-line summary of these gates in their rules; this
  file is the canonical long form.
