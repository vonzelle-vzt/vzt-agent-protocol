---
name: vzt-ship
description: "Spec-first long-horizon execution. Use for work the chair would otherwise avoid as 'too big for one shot' — a whole subsystem, a greenfield feature, an end-to-end migration, a sweep across dozens of files. Forces a complete written SPEC to disk BEFORE any code (contract, file manifest, cross-unit interfaces, units with pairwise-disjoint FILES_IN_SCOPE, one machine-checkable oracle per unit), gates it with a command, then drives the units as supervised background workers and verifies every oracle independently. Usage: /vzt-ship <the system to build>."
---

# VZT Ship — spec-first long-horizon execution

Long-horizon work does not fail because the model is not smart enough. It fails
because **the plan dies in context compaction halfway through the run**, and the
second half gets built against a plan the chair no longer remembers.

A frontier model closes that gap by holding the spec coherently *in its head*
for many minutes. That costs wall-clock — the one budget this protocol refuses
to spend.

So close it the other way: **externalize the coherence.** The spec goes on disk.
The unit statuses go on disk. Compaction can eat the conversation; it cannot eat
a file. Same coherence, no wall-clock tax.

**Escalate the PROCESS, not the MODEL.**

> **This skill authorizes you to call the Workflow tool.** Workflow requires
> explicit opt-in, and "the user invoked a skill whose instructions tell you to
> call Workflow" is a sanctioned opt-in path. This is that.

## Phase 1 — SPEC (no code. none.)

**You are forbidden from editing a source file in this phase.** Read the codebase
first — Gate 2, evidence before reasoning — then write `.vzt/ship/<slug>/SPEC.md`
from `.claude/templates/spec.md`:

> **Where the templates live.** They ship with the protocol, not with your project:
> `.claude/templates/<name>` for a project install, `~/.claude/templates/<name>` for a global
> one. There is **no `templates/` directory at a repo root** — looking for one there is what
> makes an otherwise-installed template report as missing.

1. **Contract** — the behavioral done-state a stranger could check.
   **Out of scope** — explicit; it is the list of things a worker may not
   "helpfully" also do.
2. **Interfaces / data shapes** — everything that CROSSES a unit boundary. These
   become the **barrier unit**, and the rule is absolute: *if two units both need
   it, neither may build it.* Contracts that land in parallel are contracts that
   disagree.
3. **File manifest** — every file that will exist when this is done.
4. **Units** — decompose so `FILES_IN_SCOPE` sets are **pairwise disjoint**.
   Disjointness is not a style preference; it is the only reason the fan-out is
   safe.
5. **`dependsOn` — the order, when order exists.** Disjoint scopes stop two units
   *writing* one file. They say nothing about a unit *reading* a file another
   unit is still writing. If unit B consumes what unit A produces, say so:
   `"dependsOn": ["u1-meter"]`. B then starts in a worktree seeded with A's
   finished work, in the next wave. Omit it when units are genuinely independent
   — a spec with no edges is one wave, which is the old flat fan-out.
   The barrier is an implicit dependency of every unit; never name it.
   Cycles and unknown ids are refused by `ship-check`.
6. **One oracle per unit, chosen NOW** — the command, and its expected output.
   A check invented after the diff exists tests what was built, not what was
   asked. **If you cannot name the command that proves a unit is done, the unit
   is not specified — decompose again.**

   🔴 **For a MOVE or WIRE unit, `exit 0` proves nothing.** A unit once wrote a
   462-line component, never imported it, left the original in place, and passed
   typecheck + lint + the entire test suite — because dead code typechecks
   perfectly. The build cannot tell *moved* from *copied*. So when the job is
   extraction, rewiring, deletion or "retire X", the oracle must also assert on
   **what must NO LONGER exist**:

   ```bash
   grep -c 'NewThing' path/to/consumer   # >= 2  (import + usage)
   grep -c '<OldThing' path/to/consumer  # == 0  (the original is GONE)
   wc -l < path/to/consumer              # materially smaller
   ```

   Name the absence, not just the compile. This is the same unwired-seam failure
   the spec exists to prevent, arriving through the oracle instead of the code.
7. Fill the `<!-- vzt-spec -->` JSON block. It is the machine truth.

## Phase 2 — GATE (a command, not an opinion)

```bash
vzt-agent ship-check .vzt/ship/<slug>/SPEC.md
```

Exits non-zero on: overlapping FILES_IN_SCOPE, a manifest file no unit owns, a
unit with no oracle, an unknown agentType, a `dependsOn` cycle or unknown id, or a
`connectionsInScope` id absent from `.vzt/connections.json`. **Do not proceed on a red gate.**
This is Gate 4 pointed at the plan itself.

**Bring the spec to the user for approval before spending anything.** The spec is
where their judgment is worth the most; every later gate is mechanical.

Then open the ledger:

```bash
vzt-agent ship-start .vzt/ship/<slug>/SPEC.md
```

## Phase 3 — RUN

**Default substrate — Orca, a live agent multiplexer.** If `vzt-agent` is on
`PATH` and Orca is reachable (`orca terminal list --json` succeeds), drive the
run there by default — you do NOT need to be asked. Run `vzt-orca-flow doctor`
before dispatch as the full gate: it verifies the effective mux, Orca agent
status hooks, and the live pane census. Each pairwise-disjoint unit becomes a
**real `claude` agent in its own worktree pane** you can watch and attach:

```bash
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md      # dispatch → idle-wait → independent oracle → integration gate
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md --max-concurrent 2  # cap units in flight (default 4, 0 = unlimited)
```

The built-in default is **orca** — `--mux` beats `VZT_MUX`, which beats orca. Export
`VZT_MUX=herdr` (or `vscode`) to change it, or pass `--mux herdr|vscode|orca` per run.
Non-default alternatives have their own liveness probes: Herdr uses
`herdr worktree list --cwd . --json`; VS Code uses the native integrated-terminal
backend. `--mux vscode` opens each unit as a native VS Code integrated terminal and
adds a Ship Run tree — per-unit status, the unit's worktree diff readable mid-run,
and one-click oracle re-runs. Units run in dependency **waves**: a unit still waiting
on an unmet `dependsOn` shows `waiting` (grey) in that tree — do not mistake it for
`blocked` (amber), which means the unit is live and parked on a permission prompt;
`waiting` means it hasn't been dispatched at all.

**When a unit FAILs, read what it prints** — the oracle command, the oracle's own
output, the worktree, and the agent's Claude Code transcript path. "agent transcript:
none" is not missing information; it IS the diagnosis, and it means the agent never
started in that worktree. Do not re-dispatch before reading it.
This STOPS at the green integration gate — **never auto-merge**; Phase 4 LAND stays
human. Small/inline work never comes here: a single-file edit, a quick fix, or a one-off
script is normal in-session work, not a ship run. See `~/.orca/vzt/README.md` for the mux
backends and `.claude/docs/VSCODE.md` for the native VS Code backend.

**Fallback substrate — the headless Workflow tool** (no mux live, or `vzt-agent`
off `PATH`). Resumable + content-cached, but not watchable; use it only as a
last resort and announce the fallback. **Say which driver you used.** Read the
`<!-- vzt-spec -->` block and pass it in — Workflow scripts have **no filesystem access**,
so the script cannot read the spec itself:

```
Workflow({ scriptPath: "<~/.claude|$CLAUDE_PROJECT_DIR/.claude>/workflows/vzt-ship.js",
           args: { spec: <the parsed vzt-spec object> } })
```

Either substrate runs the same shape: barrier → parallel units → **independent
read-only verification of every oracle** (builders never grade themselves) →
bounded repair (≤2 rounds) → integration gate.

Record the runId immediately (Workflow path):

```bash
vzt-agent ship-note .vzt/ship/<slug>/SPEC.md '{"kind":"workflow_launched","wfRunId":"wf_..."}'
```

If the session dies or you edit the script, resume with
`Workflow({scriptPath, resumeFromRunId})` — completed agents return from cache
(content-hashed per call, so editing one unit does not re-run the others).

**Fallback when Workflow is unavailable** — dispatch the units yourself as
**named** background agents, one brief each from `.claude/templates/worker-brief.md`, and
supervise them via the correction protocol there (SendMessage by name; ≤2 rounds).
Same spec, same oracles, same ledger. You lose resumability, not rigor.

## Phase 4 — LAND

For every unit: **verify the artifact, not the report.**
`git diff --stat -- <FILES_IN_SCOPE>`, and re-run the oracle yourself on the
load-bearing units. A worker saying "written" is a claim.

Append the workflow's returned `ledgerLines` (it cannot write to disk — you are
the single writer), then log the run:

```bash
vzt-agent ship-note <SPEC.md> '{"kind":"run_complete","passed":N,"blocked":M}'
```

**Blocked units:** escalate **exactly one tier** (`vzt-heavy-builder`), carrying
the verbatim oracle output. Still blocked → `/vzt-fix` (Fable) with the spec and
both failures attached. A Fable turn that begins with a written spec and two
recorded failures is worth several that begin cold.

**Stop before commit and deploy.** The run proves the oracles; the user approves
the diff.

## After a compaction

You will lose the plan. You will not lose the spec.

```bash
vzt-agent ship-status
```

Then **re-read SPEC.md**. Do not re-plan from memory — the file is the plan; your
memory of it is a hypothesis. (The `[VZT-SHIP]` block the classifier hook injects
on every prompt exists precisely so you cannot forget this.)

## When NOT to use this

- **One unit.** A spec with one unit is a worker brief. Use `.claude/templates/worker-brief.md`.
- **The oracle doesn't exist yet** — a design spike, "does this even work". Spike
  on `/vzt-build` first, then ship the real thing.
- **It's a question of approach, not of scale.** That's `/vzt-plan`. `/vzt-ship`
  assumes the *what* is settled and the *size* is the problem.

## Telemetry — and the kill-switch

This skill ships with the test that can delete it. That is Gate 3 pointed at the
protocol itself.

```bash
printf '%s\n' '{"ts":"<ISO8601>","kind":"ship","units":<N>,"passed":<P>,"blocked":<B>,"corrections":<C>}' \
  >> ~/.claude/vzt-router/decisions.jsonl
```

**Falsification rule:** after **5+ runs**, if runs are still blocking *and*
corrections have reached **≥1 per unit**, the spec is not buying coherence — it
is buying a document, and a document is a tax. Check with `vzt-agent stats`, and
if it prints `falsified`, **delete this skill and ship the way you used to.**
