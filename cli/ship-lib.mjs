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
 *   parseSpec        — pull the machine-readable block out of SPEC.md
 *   parseConnections — read the external side-effect registry
 *   validateSpec     — turn the collision boundary into a non-zero exit code
 *   planWaves        — turn `dependsOn` into the order units may actually run in
 *   reduceLedger     — reconstruct run state from an append-only log
 *
 * Pure, zero-dep, no I/O. The CLI does the reading; this does the thinking.
 */

/** The agents install() ships. A spec may not name an agentType that does not exist. */
export const AGENT_TYPES = [
  'vzt-planner',
  // The opus@max planning rung. install() ships agents/vzt-architect.md and the
  // router demotes routine `fable/plan` decisions onto it, so omitting it here
  // meant ship-check REJECTED any spec naming the very agent the doctrine tells
  // you to plan with.
  'vzt-architect',
  'vzt-oracle',
  'vzt-heavy-builder',
  'vzt-reviewer',
  'vzt-builder',
  'vzt-mechanic',
  'vzt-scout',
  // The visual lane. Same failure shape as vzt-architect above: install() ships
  // both, and the router hands visual units to them, so omitting them here meant
  // ship-check REJECTED any spec whose unit does UI work.
  'vzt-art-director',
  'vzt-stylist',
];

/**
 * Unit statuses that mean "this unit did not succeed".
 *
 * There are TWO producers writing unit_result lines and they speak different
 * dialects: the supervised path (`ship-watch` → verifyAndRecord) writes
 * `PASS`/`FAIL`, while the headless workflow path writes
 * `PASS`/`BLOCKED`/`ORACLE_FAIL`/`SCOPE_BREACH`. Until this set existed the
 * reducer knew only the workflow's dialect, so a `FAIL` matched nothing and a
 * run with a failing unit reported "all reported units passed" — a false green
 * delivered at exactly the moment (post-compaction rehydration) when the chair
 * has no other source of truth. Every consumer must go through this set.
 */
export const FAILED_STATUSES = new Set(['FAIL', 'ORACLE_FAIL', 'SCOPE_BREACH']);

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

/**
 * Is `p` covered by a FILES_IN_SCOPE entry?
 *
 * ONE definition, deliberately, because there are two consumers and they must
 * not drift: validateSpec uses it to decide whether a manifest file has an
 * owner, and the runtime scope audit uses it to decide whether a unit wrote
 * somewhere it shouldn't. If they disagreed, a directory scope would be legal
 * to the validator and a breach to the auditor (or the reverse), and every unit
 * declaring one would fail for a reason found nowhere in the spec.
 *
 * An entry ending in `/` claims a subtree; anything else claims that exact file
 * (and, for convenience, the subtree under a bare directory name).
 */
export function pathInScope(p, scope) {
  const f = String(p).replace(/^\.\//, '');
  return (scope || []).some((raw) => {
    const s = String(raw).replace(/^\.\//, '');
    return s.endsWith('/') ? f.startsWith(s) : f === s || f.startsWith(`${s}/`);
  });
}

/**
 * Fields that must never appear in `.vzt/connections.json`.
 *
 * The registry is a git-tracked file describing which external services a unit
 * may touch. The obvious failure is someone pasting the actual token into it,
 * at which point a file whose entire purpose is to bound blast radius becomes
 * the largest blast radius in the repo. The registry names the ENV VAR that
 * holds the credential (`credentialEnv`); it never holds the credential.
 */
const FORBIDDEN_CREDENTIAL_FIELDS = ['credential', 'secret', 'token', 'apiKey', 'api_key', 'password', 'key'];

/**
 * Parse and validate `.vzt/connections.json` — the external side-effect registry.
 *
 * FILES_IN_SCOPE bounds what a unit may write INSIDE the repo. Nothing bounded
 * what it could reach OUTSIDE the repo, and the ship path makes that gap sharp:
 * `worktree-bootstrap.sh` symlinks `.env*` from the primary checkout into every
 * unit's worktree, so a parallel fan-out of agents starts life holding whatever
 * production credentials the repo holds. The only thing standing between a
 * builder and a live customer API was that nobody had told it to call one.
 *
 * So external access gets the same treatment as filesystem access: DECLARED in
 * the spec, CHECKED by a command, default-deny. A unit that names no connection
 * is repo-local work, which is nearly all work.
 *
 * @returns {{connections: object[]|null, errors: string[]}}
 */
export function parseConnections(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { connections: null, errors: [`not valid JSON: ${e.message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { connections: null, errors: ['top level must be an object'] };
  if (!Array.isArray(doc.connections)) return { connections: null, errors: ['missing "connections" array'] };

  const errors = [];
  const seen = new Set();
  for (const c of doc.connections) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push('a connection entry is not an object');
      continue;
    }
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    if (!id) errors.push('a connection entry has no id');
    else if (seen.has(id)) errors.push(`duplicate connection id: ${id}`);
    seen.add(id);

    const label = id || '<unnamed>';
    for (const f of ['service', 'mode', 'credentialEnv']) {
      if (!c[f] || typeof c[f] !== 'string' || !c[f].trim()) errors.push(`connection ${label}: missing required field: ${f}`);
    }
    // `allow` is the operation boundary — the connection-level analogue of
    // FILES_IN_SCOPE. An entry with no allow list grants nothing, which is a
    // spec bug rather than a safe default: the unit will be blocked at runtime
    // for a reason found nowhere in the spec.
    if (!Array.isArray(c.allow) || c.allow.length === 0) errors.push(`connection ${label}: empty allow — a connection that permits no operation cannot be used`);
    else if (c.allow.some((a) => typeof a !== 'string' || !a.trim())) errors.push(`connection ${label}: allow entries must be non-empty strings`);

    for (const f of FORBIDDEN_CREDENTIAL_FIELDS) {
      if (f in c) errors.push(`connection ${label}: field "${f}" is forbidden — this file is git-tracked; name the env var in credentialEnv instead of storing the value`);
    }
  }
  return { connections: errors.length ? null : doc.connections, errors };
}

/** Read a unit's declared external connections as a clean array of ids. */
export function connectionsOf(u) {
  return Array.isArray(u && u.connectionsInScope) ? u.connectionsInScope.filter((c) => typeof c === 'string' && c.trim()) : [];
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
export function validateSpec(spec, opts = {}) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];

  // Known connection ids from `.vzt/connections.json`, or null when the repo has
  // no registry. null is NOT "anything goes" — it is "nothing is declared", so a
  // unit naming a connection fails. Default-deny is the whole point.
  const known = Array.isArray(opts.connections) ? opts.connections : null;

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
    errs.push('a one-unit spec is a worker brief, not a ship run — use .claude/templates/worker-brief.md');
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

    // CONNECTIONS_IN_SCOPE — the same rule one axis out. Omitted means repo-local
    // work, which is the overwhelming majority of units and stays frictionless.
    if ('connectionsInScope' in u && !Array.isArray(u.connectionsInScope)) {
      errs.push(`unit ${id}: connectionsInScope must be an array of connection ids`);
    } else {
      for (const c of connectionsOf(u)) {
        if (!known) errs.push(`unit ${id}: declares connection "${c}" but the repo has no .vzt/connections.json — an external side effect must be registered before a unit may claim it`);
        else if (!known.includes(c)) errs.push(`unit ${id}: connection "${c}" is not in .vzt/connections.json (registered: ${known.join(', ') || 'none'})`);
      }
    }
  }

  // The DAG. `dependsOn` is what lets a unit CONSUME another unit's output
  // instead of racing it, so a bad edge is not a style problem: an edge naming a
  // unit that does not exist silently drops the ordering, and a cycle makes the
  // scheduler dispatch nothing at all. Both must be exit codes, not surprises.
  errs.push(...validateDeps(spec));

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
      // Exact claim first (it names the owning unit in the error), then the
      // subtree form, so `filesInScope: ["src/api/"]` legitimately owns
      // `src/api/x.ts` — the same rule the runtime scope audit applies.
      if (!owner.has(p) && !pathInScope(p, [...owner.keys()]))
        errs.push(`manifest file "${p}" is owned by no unit — nobody will write it`);
    }
  }

  return errs;
}

/**
 * Read a unit's declared dependencies as a clean array of ids.
 *
 * The barrier is an IMPLICIT dependency of every unit — it runs first and alone
 * by construction — so it never appears here and naming it is rejected by
 * validateDeps rather than silently honoured. One rule, one place.
 */
export function depsOf(u) {
  return Array.isArray(u && u.dependsOn) ? u.dependsOn.filter((d) => typeof d === 'string' && d.trim()) : [];
}

/**
 * Validate the dependency edges. Returns violations — empty means valid.
 *
 * Split out of validateSpec so the cycle check is testable on its own; called
 * from validateSpec so there is still exactly ONE gate a spec has to pass.
 */
function validateDeps(spec) {
  const errs = [];
  const units = Array.isArray(spec.units) ? spec.units : [];
  const ids = new Set(units.map((u) => u.id).filter(Boolean));
  const barrierId = spec.barrier && spec.barrier.id;

  for (const u of units) {
    const id = u.id || '<unnamed>';
    if (u.dependsOn !== undefined && !Array.isArray(u.dependsOn)) {
      errs.push(`unit ${id}: dependsOn must be an array of unit ids`);
      continue;
    }
    for (const d of depsOf(u)) {
      if (d === u.id) errs.push(`unit ${id}: dependsOn lists itself`);
      else if (barrierId && d === barrierId)
        errs.push(`unit ${id}: dependsOn names the barrier "${d}" — the barrier is an implicit dependency of every unit; remove it`);
      else if (!ids.has(d)) errs.push(`unit ${id}: dependsOn names unknown unit "${d}"`);
    }
  }

  // Kahn: whatever cannot be peeled off is, by definition, inside a cycle.
  // Reported by name — "there is a cycle" is not an actionable error message.
  const indeg = new Map();
  const dependents = new Map();
  for (const u of units) {
    if (!u.id) continue;
    const deps = depsOf(u).filter((d) => ids.has(d) && d !== u.id);
    indeg.set(u.id, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(u.id);
    }
  }
  const queue = [...indeg.keys()].filter((id) => indeg.get(id) === 0);
  let settled = 0;
  while (queue.length) {
    const id = queue.shift();
    settled++;
    for (const next of dependents.get(id) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (settled < indeg.size) {
    const stuck = [...indeg.keys()].filter((id) => indeg.get(id) > 0);
    errs.push(`dependsOn cycle: ${stuck.join(' → ')} can never run — every one waits on another`);
  }

  return errs;
}

/**
 * Group the units into dependency WAVES: everything in wave N may run in
 * parallel, and wave N+1 may not start until wave N has landed.
 *
 * Two agents "bump heads" in two different ways. The one this repo already
 * solved is spatial — two units writing one file — killed at plan time by the
 * pairwise-disjoint FILES_IN_SCOPE gate. This is the OTHER one, the temporal
 * kind: a unit that reads what another unit is still writing. Disjoint scopes
 * say nothing about that, because reading is not writing.
 *
 * Order inside a wave is spec order, so the result is deterministic and a run
 * is reproducible. A spec with no `dependsOn` anywhere yields exactly one wave —
 * which is the flat fan-out this replaced, so old specs behave identically.
 *
 * Assumes the spec passed validateSpec: a cycle is dropped rather than hung on
 * (never silently — validateSpec has already refused the run by then).
 *
 * @returns {Array<Array<object>>} waves of unit objects (never the barrier)
 */
export function planWaves(spec) {
  const units = Array.isArray(spec && spec.units) ? spec.units.filter((u) => u && u.id) : [];
  const ids = new Set(units.map((u) => u.id));
  const remaining = new Map(units.map((u) => [u.id, u]));
  const landed = new Set();
  const waves = [];

  while (remaining.size) {
    const wave = units.filter(
      (u) => remaining.has(u.id) && depsOf(u).every((d) => !ids.has(d) || d === u.id || landed.has(d))
    );
    // Nothing became ready: the rest is a cycle. validateSpec refuses these, so
    // reaching here means an unvalidated spec — stop rather than loop forever.
    if (!wave.length) break;
    for (const u of wave) {
      remaining.delete(u.id);
      landed.add(u.id);
    }
    waves.push(wave);
  }
  return waves;
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
    failed: 0,
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
    else if (FAILED_STATUSES.has(u.status)) state.failed++;
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
  const failed = entries.filter(([, u]) => FAILED_STATUSES.has(u.status)).map(([id]) => id);
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
