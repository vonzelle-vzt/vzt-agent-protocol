# SHIP SPEC — <title>

> Written to `.vzt/ship/<slug>/SPEC.md` by `/vzt-ship` BEFORE any code exists.
> This file is the plan. Your memory of it is a hypothesis.
>
> Prose below is for the human. The fenced `json` block at the bottom is the
> machine truth — `vzt-agent ship-check` reads that, and the workflow executes
> it. They live in one file so they cannot drift apart.

## Contract

<What the system must do, in behavioral terms — the done-state a stranger could
check without reading the diff. No implementation language.>

## Out of scope

<Explicit. This is half the value of a spec: it is the list of things a worker
is not allowed to "helpfully" also do.>

## Interfaces / data shapes

<Every type, signature, schema, route, table, and env var that CROSSES a unit
boundary.

These become the BARRIER unit, and the rule is absolute: if two units both need
it, NEITHER may build it. Contracts that land in parallel are contracts that
disagree — N agents will invent N versions of the same interface and the
integration gate becomes a rewrite. One serial barrier buys parallelism
everywhere else.>

## File manifest

<Every file that will exist when this is done: new | modified | deleted.
The union of the units' FILES_IN_SCOPE must cover this list — a manifest file
that no unit owns is a file nobody writes, and the run "succeeds" with the
deliverable missing. ship-check enforces this.>

## Units

<One section per unit, decomposed so the FILES_IN_SCOPE sets are pairwise disjoint.
Disjointness is not a style preference — it is the entire reason the fan-out is
safe. Two workers writing one file clobber each other and neither reports a
problem.

Each unit gets ONE machine-checkable oracle, chosen NOW, before any code exists.
A check invented after the diff exists tests what was built, not what was asked.

**If you cannot name the command that proves a unit is done, the unit is not
specified yet. Decompose again.**>

## Risks / open questions

<Anything unresolved. An open question in the spec is honest. An open question
discovered mid-run is a re-plan, and a re-plan mid-run is how the coherence you
came here for gets lost.>

<!-- vzt-spec — machine-readable truth. `vzt-agent ship-check <this file>` validates it. -->
```json
{
  "specVersion": 1,
  "slug": "example-slug",
  "title": "Human-readable title",
  "root": "/absolute/path/to/repo",
  "contract": "One paragraph: the behavioral done-state.",
  "outOfScope": ["things explicitly not being done"],
  "manifest": [
    { "path": "src/example/types.ts", "op": "new" },
    { "path": "src/example/meter.ts", "op": "new" },
    { "path": "src/example/invoice.ts", "op": "new" }
  ],
  "barrier": {
    "id": "u0-contract",
    "title": "Shared types and empty module skeletons",
    "agentType": "vzt-builder",
    "filesInScope": ["src/example/types.ts"],
    "brief": "Create ONLY the interfaces, types, and function signatures every unit consumes, plus an empty module for each unit's entrypoint. No logic. No implementations.",
    "machineCheck": "npx tsc --noEmit",
    "expect": "exit 0"
  },
  "units": [
    {
      "id": "u1-meter",
      "title": "Usage meter",
      "agentType": "vzt-builder",
      "filesInScope": ["src/example/meter.ts"],
      "brief": "Implement meter() against the interface in src/example/types.ts. Consume that contract — never redefine it.",
      "machineCheck": "npx vitest run test/example/meter.test.ts",
      "expect": "exit 0, 0 failed"
    },
    {
      "id": "u2-invoice",
      "title": "Invoice builder",
      "agentType": "vzt-builder",
      "filesInScope": ["src/example/invoice.ts"],
      "brief": "Implement buildInvoice() against the interface in src/example/types.ts.",
      "machineCheck": "npx vitest run test/example/invoice.test.ts",
      "expect": "exit 0, 0 failed"
    }
  ],
  "integration": {
    "machineCheck": "npx tsc --noEmit && npx vitest run && npm run build",
    "expect": "exit 0"
  }
}
```
