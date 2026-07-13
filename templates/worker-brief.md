# Worker Brief Template

Use this structure when delegating self-contained work to a worker agent
(vzt-builder / vzt-mechanic / vzt-heavy-builder). A brief that fits this shape
lets the worker finish in one shot and lets the orchestrator verify the result
mechanically instead of trusting the report.

## Template

```
TASK: <one-line name>
CONTEXT: <everything the worker needs that isn't in the files: decisions already
  made, constraints, why this approach. Workers have no conversation memory —
  if it isn't in the brief or the repo, it doesn't exist.>
FILES_IN_SCOPE: <explicit list of files/globs the worker may MODIFY — this is
  the collision boundary. Reads are unrestricted; writes outside this list are
  forbidden.>
OPERATION: <precise spec of the change — executable in one shot, no open
  questions left to the worker's judgment unless explicitly delegated>
ACCEPTANCE: <the done-state in one sentence>
MACHINE_CHECK: <shell command(s) that prove completion — test, build, curl, grep>
EXPECT: <what MACHINE_CHECK must output for the work to count as done>
CONSTRAINTS: <hard rules verbatim — style, no-new-deps, do-not-touch list>
REPORT: <what to include in the report back: diff summary, MACHINE_CHECK output
  pasted verbatim, anything discovered outside scope>
```

## Rules

- **Collision boundary is law.** If completing the task requires writing a file
  outside FILES_IN_SCOPE, the worker STOPS and reports the conflict instead of
  expanding scope. This is what makes parallel dispatch safe — two workers with
  disjoint FILES_IN_SCOPE cannot collide.
- **MACHINE_CHECK is decided by the orchestrator, before dispatch.** A check the
  worker invents after the fact tests what was built, not what was asked.
- **Reporting ≠ persistence.** The orchestrator verifies the artifacts exist on
  disk (git diff/status, re-run MACHINE_CHECK) before accepting the report.
  A worker saying "written" is a claim, not evidence.
- Small tasks may collapse fields (CONTEXT+OPERATION), but FILES_IN_SCOPE,
  MACHINE_CHECK and EXPECT never drop for anything that edits files.
- For parallel waves: every lane gets its own brief, FILES_IN_SCOPE sets must be
  pairwise disjoint, and the orchestrator reviews each lane's diff against
  ACCEPTANCE before merging any of them.

## Supervision — dispatch is not delegation

Spawn-and-block wastes the wall-clock this protocol exists to protect.
Spawn-and-trust wastes correctness. Do neither: dispatch workers to the
**background** and supervise them.

**Name every worker.** The name is the handle you correct it with — `SendMessage`
addresses agents by NAME (the raw agentId is only a fallback), and *a name keeps
working after the agent completes: a send resumes it from its transcript.* An
unnamed worker cannot be corrected, only re-briefed from scratch.

## Verification — the artifact, never the report

Before accepting ANY report:

1. `git status --porcelain` — did it write outside FILES_IN_SCOPE?
2. `git diff --stat -- <FILES_IN_SCOPE>` — did the files actually change?
3. **Re-run the MACHINE_CHECK yourself.** The worker's pasted output is evidence
   *offered*. On a load-bearing unit it is not evidence *accepted*.

A worker that reports PASS over a red oracle is not lying — it is optimistic.
Design for that.

## The correction protocol

A worker that failed its oracle already holds the whole task in context.
Re-briefing from scratch throws that away and pays for it twice. **Correct it.**

**Rounds 1–2 — CORRECT.** `SendMessage` the worker by name:

```
CORRECTION — round <n>. Same unit, not a new task.
VERDICT: ORACLE_FAIL | SCOPE_BREACH
ORACLE:  <the command>
OUTPUT (verbatim): <paste it — never summarize; a summarized failure is a new guess>
[SCOPE_BREACH only] You wrote outside FILES_IN_SCOPE: <paths>.
  Run `git checkout -- <paths>` and achieve the goal inside your boundary.
Fix the CAUSE, not the symptom. Do not weaken or delete the check to make it pass.
Re-run the MACHINE_CHECK and paste its real output.
If the SPEC itself is wrong, say so and STOP — do not improvise a different contract.
```

**Two rounds is the ceiling.** A worker that fails the same oracle twice is not
converging, and round 3 is where models start deleting the test to go green.

**Round 3 — stop correcting. Choose one:**

- **Re-dispatch fresh**, same tier — if the failure was *contextual* (it misread
  the brief, wandered, ran out of room). When a SPEC is on disk, a fresh worker
  reconstructs full context for the price of one agent. **This is what the spec
  file buys: worker context becomes disposable, because the plan is not.**
- **Escalate exactly ONE tier** (vzt-builder → vzt-heavy-builder) — if the
  failure was *capability*: it understood the task and could not do it. Carry
  both rounds' verbatim output with you.
- **Re-spec** — if two independent workers both stopped and said the spec is
  wrong, they are probably right. That is a signal about the spec, not about the
  workers.

Still failing after the one-tier escalation → `/vzt-fix` (Fable) with the spec,
the diffs, and every oracle output attached. That is the ladder, and it is the
only path by which routine implementation reaches the frontier tier.

## Scope breach is a first-class failure

Not a nit. Two workers writing one file clobber each other and **neither reports
a problem** — the failure is *silent*, which is what makes it the worst kind.
Detect it (`git status --porcelain` against FILES_IN_SCOPE), correct it, and
never let it slide because the result happened to work.
