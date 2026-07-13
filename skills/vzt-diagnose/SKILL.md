---
name: vzt-diagnose
description: "Parallel hypothesis fan-out for a hard bug — enumerate N candidate root causes, dispatch N read-only agents to confirm-or-refute each one with a real command, and collect evidence before spending a frontier tier. Use when a bug has 2+ plausible causes, BEFORE escalating to /vzt-fix (Fable). Usage: /vzt-diagnose <symptom>."
---

# VZT Diagnose — parallel hypothesis fan-out

Debugging is normally a **serial** loop at the most expensive chair in the
building: grep, form a hypothesis, test it, wrong, grep again. Every round trip
spends premium tokens on what is fundamentally recon — and after two failures
the ladder escalates to Fable, spending the scarcest budget on a problem that
was never *hard*, only *unexplored*.

This skill inverts it. Enumerate the candidate causes **once**, then test them
**all at once**, cheaply, with real commands.

## The move

1. **Enumerate.** Name **N ≤ 4** plausible root causes. Distinct *mechanisms*,
   not rephrasings of one guess — if two hypotheses would be confirmed by the
   same command, they are one hypothesis.
2. **Pick each one's oracle before dispatch.** For each hypothesis, name the
   **single command** whose output would confirm or refute it. If you cannot
   name one, that hypothesis is not testable yet — sharpen it or drop it.
   *(This is Gate 4, applied per-branch.)*
3. **Dispatch all N in one message** — multiple Agent calls in a single block,
   so they run concurrently. `vzt-scout` (Haiku) for log/grep/config questions;
   `vzt-builder` (Sonnet) when the probe needs to run the app or read across
   subsystems.
4. **Read N evidence reports**, not N diffs. Each returns one verdict plus the
   pasted command output.
5. **Then** act: fix the confirmed cause, or — if everything comes back REFUTED
   — escalate to `/vzt-fix` (Fable) **carrying the refutations with you**. A
   Fable turn that starts with four things already ruled out is worth several
   that start cold.

## Why this needs no worktree

The agents are **read-only**. `FILES_IN_SCOPE` is empty, so the
pairwise-disjointness rule is satisfied trivially and there is nothing to
collide.

That is the entire trick, and it is what makes this the *only* fan-out pattern
we adopted: because nobody writes, every agent runs **in the real repo** — with
the real `node_modules`, the real `.env.local`, the real dev server. So every
agent can **actually run its oracle**.

A worktree would have taken exactly that away (`node_modules` is gitignored and
1.6 GB; `.env*` is gitignored — a fresh worktree has neither). Candidates in
worktrees can't run anything, so they can only *claim*. See the rejection in
`skills/vzt-route/SKILL.md`.

**Probes must not mutate.** No writes, no migrations, no `prisma migrate`, no
deploys, no seeding. Worktrees isolate files, not databases — and these agents
don't even have that. A probe that mutates shared state corrupts the evidence
of every sibling running beside it.

## Agent contract

Give each agent exactly **one** hypothesis and **one** command:

```
HYPOTHESIS
<one candidate root cause, stated as a falsifiable mechanism>

PROBE (read-only — run this, do not fix anything)
<the single command whose output settles it>

RETURN
VERDICT: CONFIRMED | REFUTED | INCONCLUSIVE
EVIDENCE: <the command output, PASTED VERBATIM — not summarized>
NOTE: <one line, only if the output suggests a cause nobody listed>
```

Read the verdicts skeptically. **INCONCLUSIVE is a real answer** and must stay
available — an agent forced to choose CONFIRMED or REFUTED will invent
confidence, and a fabricated refutation is worse than no probe at all: it
removes the true cause from the search.

Treat CONFIRMED as a lead, not a conclusion, until you have seen the pasted
output yourself. Reporting ≠ persistence.

## When NOT to use this

- **The cause is already obvious.** One hypothesis is not a fan-out. Just fix it.
- **The probes would mutate shared state.** Never fan out anything that touches
  Supabase / Vercel / migrations.
- **No hypothesis has a runnable oracle.** Then you are not diagnosing, you are
  polling four agents for opinions. Go read the code instead.
- **It's a design question, not a bug.** That's `/vzt-plan`.

## Telemetry — and the kill-switch

This feature ships with the test that can delete it. That is Gate 3 (attack your
own approach) pointed at the protocol itself.

After the wave resolves, append one line to the existing decisions log:

```bash
printf '%s\n' "$(cat <<'EOF'
{"ts":"<ISO8601>","kind":"fanout","mode":"diagnose","n":<N>,"confirmed_idx":<0-based index of the CONFIRMED hypothesis, or -1 if none>,"tier":"<haiku|sonnet>"}
EOF
)" >> ~/.claude/vzt-router/decisions.jsonl
```

`confirmed_idx` is the load-bearing field: it records whether the chair's
**first** hypothesis — the one it would have tested anyway, serially, for free —
turned out to be the right one.

**The falsification rule:** once there are **10+ runs**, if `confirmed_idx === 0`
in **≥60%** of them, the chair's first guess was usually right and the fan-out
bought nothing but tokens. **Delete this skill.**

Check it with:

```bash
grep '"mode":"diagnose"' ~/.claude/vzt-router/decisions.jsonl \
  | grep -o '"confirmed_idx":-\?[0-9]*' | sort | uniq -c | sort -rn
```

If instead the confirmations spread across indices 1–3, the fan-out is finding
causes the serial loop would have reached late or not at all — it is earning its
cost. Keep it.
