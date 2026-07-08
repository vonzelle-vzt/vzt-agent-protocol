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
