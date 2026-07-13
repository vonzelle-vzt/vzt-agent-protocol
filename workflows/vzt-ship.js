export const meta = {
  name: 'vzt-ship',
  description: 'Spec-first long-horizon build: barrier → parallel units → independent oracle → bounded repair → integration gate',
  whenToUse:
    'Invoked by the /vzt-ship skill AFTER `vzt-agent ship-check` exits 0. Requires args {spec} — the parsed <!-- vzt-spec --> block from SPEC.md. Workflow scripts have no filesystem access, so the calling session reads the spec and passes it in. Returns per-unit verdicts plus ledgerLines; the session appends them to LEDGER.jsonl.',
  phases: [
    { title: 'Barrier', detail: 'shared interfaces — serial, must land before anything fans out' },
    { title: 'Units', detail: 'one agent per unit, disjoint FILES_IN_SCOPE, fully parallel' },
    { title: 'Verify', detail: 'a SEPARATE read-only agent re-runs each oracle — builders never grade themselves' },
    { title: 'Repair', detail: 'bounded correction: ≤2 rounds per failed unit, then BLOCKED' },
    { title: 'Integration', detail: 'whole-repo gate — the only thing that sees cross-unit breakage' },
  ],
}

// This script CANNOT touch the filesystem — no fs, no child_process, no require.
// (Anthropic: "workflow scripts have no filesystem access.") Every disk read and
// every shell command happens inside an agent(). The spec arrives via args; the
// ledger lines are RETURNED, not written — the chair is the single writer.
// `args` can arrive as a STRING rather than an object — the harness serializes it
// on the way in. A script that assumes an object dies on line 1, before a single
// agent is spawned, and the failure looks like a bad spec when it is a bad decode.
const input = typeof args === 'string' ? JSON.parse(args) : args
const spec = input && input.spec
if (!spec || !Array.isArray(spec.units) || spec.units.length === 0) {
  throw new Error('vzt-ship requires args:{spec} — the parsed <!-- vzt-spec --> block from SPEC.md')
}

// Re-assert the collision boundary IN CODE. `vzt-agent ship-check` is the
// authoritative gate, but a hand-edited spec must not be able to launch an
// overlapping wave: two workers writing one file clobber each other and NEITHER
// reports a problem. Silent failure is the one we refuse to risk.
const owner = new Map()
for (const u of [spec.barrier, ...spec.units].filter(Boolean)) {
  for (const f of u.filesInScope || []) {
    if (owner.has(f)) throw new Error(`FILES_IN_SCOPE collision: "${f}" claimed by both ${owner.get(f)} and ${u.id}`)
    owner.set(f, u.id)
  }
}

const ROOT = spec.root
const SPEC_PATH = `${spec.root}/.vzt/ship/${spec.slug}/SPEC.md`
const MAX_ROUNDS = 2

// Paths that were ALREADY dirty before this run started — the chair snapshots
// `git status --porcelain` and passes them in. Without this, the verifier reads
// every dirty path as something the worker wrote, and a repo with any
// pre-existing untracked file produces a FALSE SCOPE_BREACH: it burns both
// correction rounds punishing a worker that did nothing wrong, then BLOCKS a run
// that was fine. A verifier that manufactures failures is worse than no verifier.
const PREEXISTING = Array.isArray(spec.preexisting) ? spec.preexisting : []
const ignoreLine = PREEXISTING.length
  ? `\nPRE-EXISTING DIRT — these paths were already modified/untracked BEFORE this run began.
You did NOT write them. They are NOT a scope breach. IGNORE them entirely:
${PREEXISTING.map((p) => `  - ${p}`).join('\n')}`
  : ''

const GATES = `Run the five gates: scope before acting; EVIDENCE before reasoning (read the files —
never reason about code you have not opened this session); attack your own approach once;
machine-checkable proof before declaring done; report only what you verified.

COLLISION BOUNDARY IS LAW. Write ONLY the files listed in FILES_IN_SCOPE. If completing the
task appears to require writing a file outside it, STOP and report the conflict — never expand
scope on your own.

The SPEC at ${SPEC_PATH} is the contract. Read it. Interfaces that cross unit boundaries already
exist — consume them, never redefine them.`

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'verdict', 'oracleOutput', 'filesWritten'],
  properties: {
    unit: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'ORACLE_FAIL', 'SCOPE_BREACH', 'CANNOT_RUN'] },
    oracleOutput: { type: 'string', description: 'the MACHINE_CHECK output PASTED VERBATIM — never summarized' },
    filesWritten: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths from `git status --porcelain`' },
    note: { type: 'string' },
  },
}

const buildPrompt = (u, correction) => `${GATES}

UNIT: ${u.id} — ${u.title || ''}

FILES_IN_SCOPE (the ONLY files you may write):
${(u.filesInScope || []).map((f) => `  - ${f}`).join('\n')}

OPERATION:
${u.brief}

MACHINE_CHECK (chosen before you existed — run it, paste the output):
  cd ${ROOT} && ${u.machineCheck}
EXPECT: ${u.expect}
${
  correction
    ? `
=== CORRECTION ROUND ${correction.round} — this is the SAME unit, not a new task ===
Your previous attempt FAILED.
VERDICT: ${correction.verdict}
ORACLE OUTPUT (verbatim):
${correction.oracleOutput}
${
  correction.filesWritten && correction.filesWritten.length
    ? `FILES YOU ACTUALLY WROTE: ${correction.filesWritten.join(', ')}\n`
    : ''
}${
        correction.verdict === 'SCOPE_BREACH'
          ? `You wrote OUTSIDE FILES_IN_SCOPE. Revert those files (git checkout -- <path>) and achieve the
goal inside your boundary. If that is genuinely impossible, the SPEC is wrong — say so and STOP.\n`
          : ''
      }
Fix the CAUSE, not the symptom. Do not weaken or delete the check to make it pass. Re-run the
MACHINE_CHECK and paste its real output. If the SPEC itself is wrong, say so and STOP — do not
improvise a different contract.`
    : ''
}`

// A SEPARATE, read-only agent grades the work. A builder that grades itself is
// producing a report, not evidence — "Reporting ≠ persistence" made structural.
const verifyPrompt = (u) => `You are a VERIFIER. Write NOTHING. Do not fix anything. Do not create files.

UNIT: ${u.id}

1. cd ${ROOT} && git status --porcelain     → every path currently dirty
2. cd ${ROOT} && ${u.machineCheck}          → paste the output VERBATIM
EXPECT: ${u.expect}
${ignoreLine}

Set verdict:
  PASS          — the oracle met EXPECT *and* every path this unit wrote is inside FILES_IN_SCOPE:
                  ${(u.filesInScope || []).join(', ')}
  SCOPE_BREACH  — a path THIS UNIT WROTE lies outside FILES_IN_SCOPE (list them in filesWritten).
                  Do NOT report a breach for pre-existing dirt listed above, and do not report one
                  for a path the oracle itself passed. If the oracle PASSED and the only extra dirty
                  paths are pre-existing, the verdict is PASS.
  ORACLE_FAIL   — the check ran and did not meet EXPECT
  CANNOT_RUN    — the command could not execute (missing dep, no such script). Say so.

Never guess PASS. An unrunnable check is CANNOT_RUN, not a pass — a fabricated pass is worse
than no check at all, because it removes the failure from the search.`

async function runUnit(u, phaseName) {
  let correction = null
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    await agent(buildPrompt(u, correction), {
      agentType: u.agentType || 'vzt-builder',
      label: round === 0 ? u.id : `${u.id}:repair${round}`,
      phase: round === 0 ? phaseName : 'Repair',
    })

    const v = await agent(verifyPrompt(u), {
      agentType: 'vzt-scout',
      label: `verify:${u.id}${round ? `:r${round}` : ''}`,
      phase: 'Verify',
      schema: VERDICT,
    })

    // agent() returns null if it was skipped or died. Never read that as PASS.
    if (!v) {
      return { unit: u.id, verdict: 'CANNOT_RUN', rounds: round, oracleOutput: 'verifier returned no result', filesWritten: [] }
    }
    if (v.verdict === 'PASS') return { ...v, unit: u.id, rounds: round }

    correction = { ...v, round: round + 1 }
    log(`${u.id}: ${v.verdict} (round ${round}) — ${round < MAX_ROUNDS ? 'correcting' : 'BLOCKED'}`)
  }

  // Two rounds is the ceiling. A worker that fails the same oracle twice is not
  // converging, and round 3 is where models start deleting the test to go green.
  return {
    unit: u.id,
    verdict: 'BLOCKED',
    rounds: MAX_ROUNDS,
    oracleOutput: (correction && correction.oracleOutput) || '',
    filesWritten: (correction && correction.filesWritten) || [],
    escalate: 'vzt-heavy-builder',
  }
}

// ── Barrier ──────────────────────────────────────────────────────────────────
// The one place a barrier genuinely belongs. Every unit consumes the shared
// interfaces; if those land in parallel, N agents invent N contracts. Serial
// here is what buys parallelism everywhere else.
let barrier = null
if (spec.barrier) {
  phase('Barrier')
  barrier = await runUnit(spec.barrier, 'Barrier')
  if (barrier.verdict !== 'PASS') {
    log('BARRIER FAILED — refusing to fan out onto an unstable contract.')
    return {
      slug: spec.slug,
      barrier,
      units: [],
      blocked: [],
      integration: null,
      aborted: 'barrier_failed',
      ledgerLines: [
        { kind: 'unit_result', unit: barrier.unit, status: barrier.verdict, round: barrier.rounds, oracle: spec.barrier.machineCheck, output: String(barrier.oracleOutput || '').slice(0, 500) },
        { kind: 'aborted', reason: 'barrier_failed' },
      ],
    }
  }
}

// ── Units ────────────────────────────────────────────────────────────────────
// Disjoint scopes ⇒ genuinely parallel. No barrier between them: serializing
// here would burn the exact resource this whole release exists to protect.
phase('Units')
log(`Fanning out ${spec.units.length} units (FILES_IN_SCOPE verified pairwise disjoint in code)`)
const results = await parallel(spec.units.map((u) => () => runUnit(u, 'Units')))

const done = results.filter(Boolean)
const passed = done.filter((r) => r.verdict === 'PASS')
const failed = done.filter((r) => r.verdict !== 'PASS')
log(`${passed.length}/${spec.units.length} units passed their oracle; ${failed.length} did not`)

// ── Integration ──────────────────────────────────────────────────────────────
// Per-unit oracles are LOCAL and structurally cannot see cross-unit breakage.
// Run this even when units are blocked — partial failure must still tell the
// chair whether what DID land is coherent.
phase('Integration')
const integration = await agent(
  `You are a VERIFIER. Write NOTHING; do not fix anything.

cd ${ROOT} && ${spec.integration.machineCheck}
EXPECT: ${spec.integration.expect}

Paste the output VERBATIM. If it fails, attribute each error to a unit where you can:
${[spec.barrier, ...spec.units]
  .filter(Boolean)
  .map((u) => `  ${u.id}: ${(u.filesInScope || []).join(', ')}`)
  .join('\n')}

Blocked units (their files may be absent or incomplete — this is expected, not a new bug):
${failed.map((f) => f.unit).join(', ') || 'none'}`,
  {
    agentType: 'vzt-reviewer',
    label: 'integration',
    phase: 'Integration',
    schema: {
      type: 'object',
      required: ['status', 'output'],
      properties: {
        status: { type: 'string', enum: ['PASS', 'FAIL', 'CANNOT_RUN'] },
        output: { type: 'string' },
        attribution: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

// The script cannot write to disk — it RETURNS the ledger lines and the chair
// appends them. One writer, no interleaving.
const ledgerLines = []
if (barrier) {
  ledgerLines.push({ kind: 'unit_result', unit: barrier.unit, status: barrier.verdict, round: barrier.rounds, oracle: spec.barrier.machineCheck, output: String(barrier.oracleOutput || '').slice(0, 500) })
}
for (const r of done) {
  const u = spec.units.find((x) => x.id === r.unit)
  ledgerLines.push({ kind: 'unit_result', unit: r.unit, status: r.verdict, round: r.rounds, oracle: u ? u.machineCheck : null, output: String(r.oracleOutput || '').slice(0, 500) })
}
ledgerLines.push({ kind: 'integration', status: integration ? integration.status : 'CANNOT_RUN', output: String((integration && integration.output) || '').slice(0, 500) })
ledgerLines.push({ kind: 'run_complete', passed: passed.length, blocked: failed.length })

return {
  slug: spec.slug,
  barrier,
  units: done,
  // Blocked units come back with the verbatim oracle output and a ONE-tier
  // escalation suggestion. The chair decides whether to spend it — tier
  // escalation stays out of the automated path, which is how Fable stays ≤15%.
  blocked: failed.map((f) => ({ unit: f.unit, rounds: f.rounds, oracleOutput: f.oracleOutput, escalate: f.escalate || 'vzt-heavy-builder' })),
  integration,
  ledgerLines,
}
