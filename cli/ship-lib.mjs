/**
 * ship-lib — the machine truth behind /vzt-ship.
 *
 * Long-horizon work does not fail because the model is not smart enough. It
 * fails because the plan dies in context compaction halfway through the run,
 * and the second half gets built against a plan nobody remembers. The fix is
 * to externalize the plan: a SPEC on disk, a LEDGER on disk. Compaction can eat
 * the conversation; it cannot eat a file.
 *
 * This module is the part of that which must not be left to a model's judgment:
 *   parseSpec     — pull the machine-readable block out of SPEC.md
 *   validateSpec  — turn the collision boundary into a non-zero exit code
 *   reduceLedger  — reconstruct run state from an append-only log
 *
 * Pure, zero-dep, no I/O. The CLI does the reading; this does the thinking.
 */

/** The agents install() ships. A spec may not name an agentType that does not exist. */
export const AGENT_TYPES = [
  'vzt-planner',
  'vzt-oracle',
  'vzt-heavy-builder',
  'vzt-reviewer',
  'vzt-builder',
  'vzt-mechanic',
  'vzt-scout',
];

const SPEC_MARKER = '<!-- vzt-spec';

/**
 * Extract the spec object from SPEC.md.
 *
 * The file is prose for the human plus ONE fenced json block after the
 * `<!-- vzt-spec -->` marker, which is the machine truth. One file, so the
 * narrative and the executable plan cannot drift apart.
 *
 * @returns {{spec: object|null, error: string|null}}
 */
export function parseSpec(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { spec: null, error: 'SPEC is empty' };
  const markerAt = markdown.indexOf(SPEC_MARKER);
  if (markerAt === -1)
    return { spec: null, error: `SPEC has no "${SPEC_MARKER} -->" marker — the machine-readable block is missing` };

  const after = markdown.slice(markerAt);
  const fence = after.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return { spec: null, error: 'SPEC marker found but no ```json block follows it' };

  try {
    return { spec: JSON.parse(fence[1]), error: null };
  } catch (e) {
    return { spec: null, error: `SPEC json block is not valid JSON: ${e.message}` };
  }
}

/** Every unit that owns files: the barrier (if present) plus the units. */
function allUnits(spec) {
  return [spec.barrier, ...(Array.isArray(spec.units) ? spec.units : [])].filter(Boolean);
}

/**
 * Validate a spec. Returns an array of violations — empty means valid.
 *
 * This is the release's central trick. "FILES_IN_SCOPE sets must be pairwise
 * disjoint" was doctrine an LLM might honor; here it is a command that exits
 * non-zero. Two workers writing one file clobber each other and NEITHER reports
 * a problem — silent failure is the worst kind, so it gets caught before any
 * agent is spawned, not after.
 */
export function validateSpec(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];

  for (const f of ['slug', 'title', 'root', 'contract']) {
    if (!spec[f] || typeof spec[f] !== 'string' || !spec[f].trim()) errs.push(`missing required field: ${f}`);
  }
  if (typeof spec.root === 'string') {
    if (!spec.root.startsWith('/')) errs.push(`root must be an absolute path (got "${spec.root}")`);
    if (spec.root.includes('..')) errs.push('root must not contain ".."');
  }
  if (!Array.isArray(spec.units) || spec.units.length === 0) {
    errs.push('spec has no units — nothing to ship');
    return errs; // everything below assumes units exist
  }
  if (spec.units.length === 1 && !spec.barrier) {
    errs.push('a one-unit spec is a worker brief, not a ship run — use templates/worker-brief.md');
  }
  if (!spec.integration || !spec.integration.machineCheck) {
    errs.push('missing integration.machineCheck — per-unit oracles are local and cannot see cross-unit breakage');
  }

  const seenIds = new Set();
  // file -> unit id that claims it. This map IS the collision boundary.
  const owner = new Map();

  for (const u of allUnits(spec)) {
    const id = u.id || '<unnamed>';
    if (!u.id) errs.push('a unit has no id');
    else if (seenIds.has(u.id)) errs.push(`duplicate unit id: ${u.id}`);
    seenIds.add(u.id);

    if (!u.brief || !String(u.brief).trim()) errs.push(`unit ${id}: missing brief`);

    // Gate 4, applied to the plan itself: if you cannot name the command that
    // proves this unit is done, the unit is not specified yet.
    if (!u.machineCheck || !String(u.machineCheck).trim())
      errs.push(`unit ${id}: no machineCheck — if you cannot name the command that proves it done, it is not specified`);
    if (!u.expect || !String(u.expect).trim()) errs.push(`unit ${id}: no expect — a check with no expected output proves nothing`);

    if (u.agentType && !AGENT_TYPES.includes(u.agentType))
      errs.push(`unit ${id}: unknown agentType "${u.agentType}" (installed: ${AGENT_TYPES.join(', ')})`);

    const scope = Array.isArray(u.filesInScope) ? u.filesInScope : [];
    if (scope.length === 0) errs.push(`unit ${id}: empty filesInScope — a unit that owns no files cannot be verified`);
    for (const f of scope) {
      if (owner.has(f)) errs.push(`FILES_IN_SCOPE collision: "${f}" is claimed by both ${owner.get(f)} and ${id}`);
      else owner.set(f, id);
    }
  }

  // Every planned file must be owned by exactly one unit. A file in the manifest
  // that no unit owns is a file nobody will write — the run would "succeed" with
  // the deliverable missing.
  if (Array.isArray(spec.manifest)) {
    for (const entry of spec.manifest) {
      const p = typeof entry === 'string' ? entry : entry && entry.path;
      if (!p) {
        errs.push('manifest entry has no path');
        continue;
      }
      if (!owner.has(p)) errs.push(`manifest file "${p}" is owned by no unit — nobody will write it`);
    }
  }

  return errs;
}

const TERMINAL = new Set(['run_complete', 'aborted']);

/**
 * Reduce an append-only LEDGER.jsonl into current run state.
 *
 * MUST tolerate a truncated final line: a half-written line is the EXPECTED
 * state after a crash, and a reducer that throws on it is a reducer that fails
 * exactly when it is needed. Bad lines are skipped, never fatal.
 *
 * @param {string} text raw file contents
 */
export function reduceLedger(text) {
  const state = {
    runId: null,
    slug: null,
    specPath: null,
    wfRunId: null,
    units: {}, // id -> { status, round, oracle, output }
    integration: null,
    active: false,
    passed: 0,
    blocked: 0,
    corrections: 0,
  };
  if (typeof text !== 'string' || !text.trim()) return state;

  let sawTerminal = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue; // truncated/corrupt line — expected after a crash, never fatal
    }
    if (!e || typeof e !== 'object') continue;

    switch (e.kind) {
      case 'run_started':
        state.runId = e.runId || state.runId;
        state.slug = e.slug || state.slug;
        state.specPath = e.specPath || state.specPath;
        sawTerminal = false;
        break;
      case 'workflow_launched':
        state.wfRunId = e.wfRunId || state.wfRunId;
        break;
      case 'unit_result':
        if (e.unit) {
          // Last write wins: a later round supersedes an earlier one.
          state.units[e.unit] = {
            status: e.status || 'DISPATCHED',
            round: typeof e.round === 'number' ? e.round : 0,
            oracle: e.oracle || null,
            output: e.output || null,
          };
        }
        break;
      case 'integration':
        state.integration = { status: e.status || 'UNKNOWN', output: e.output || null };
        break;
      case 'run_complete':
      case 'aborted':
        sawTerminal = true;
        break;
      default:
        break;
    }
  }

  for (const u of Object.values(state.units)) {
    if (u.status === 'PASS') state.passed++;
    else if (u.status === 'BLOCKED') state.blocked++;
    state.corrections += u.round || 0;
  }
  state.active = Boolean(state.runId) && !sawTerminal;
  return state;
}

/** The single next action, derived from ledger state. Keep it one line — it goes into a hook. */
export function nextAction(state) {
  if (!state.runId) return 'no run started';
  if (!state.active) return 'run is complete — nothing pending';
  const entries = Object.entries(state.units);
  if (entries.length === 0) return 'spec gated, no units reported yet — launch the workflow';
  const blocked = entries.filter(([, u]) => u.status === 'BLOCKED').map(([id]) => id);
  const failed = entries.filter(([, u]) => u.status === 'ORACLE_FAIL' || u.status === 'SCOPE_BREACH').map(([id]) => id);
  if (blocked.length)
    return `${blocked.join(', ')} BLOCKED after correction rounds → escalate exactly ONE tier (vzt-heavy-builder) carrying the verbatim oracle output`;
  if (failed.length) return `${failed.join(', ')} failed their oracle → correct (≤2 rounds), do not re-brief from scratch`;
  if (!state.integration) return 'all reported units passed → run the integration gate';
  if (state.integration.status !== 'PASS') return 'integration gate FAILED → attribute the failure to a unit before touching anything';
  return 'integration PASS → verify artifacts on disk, then land';
}

/** One-line per-unit status summary, e.g. "u1 PASS | u2 BLOCKED(2)". */
export function unitLine(state) {
  const ids = Object.keys(state.units);
  if (!ids.length) return '(none reported)';
  return ids
    .map((id) => {
      const u = state.units[id];
      return `${id} ${u.status}${u.round ? `(${u.round})` : ''}`;
    })
    .join(' | ');
}
