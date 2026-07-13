import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateSpec, reduceLedger, nextAction, AGENT_TYPES } from '../cli/ship-lib.mjs';
import { reduceLedgerInline } from '../hooks/vzt-route-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO_ROOT, 'workflows', 'vzt-ship.js');

const validSpec = () => ({
  specVersion: 1,
  slug: 'demo',
  title: 'Demo',
  root: '/abs/repo',
  contract: 'Do the thing.',
  manifest: [{ path: 'a.ts', op: 'new' }, { path: 'b.ts', op: 'new' }],
  units: [
    { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['a.ts'], brief: 'build a', machineCheck: 'npm test a', expect: 'exit 0' },
    { id: 'u2', title: 'B', agentType: 'vzt-builder', filesInScope: ['b.ts'], brief: 'build b', machineCheck: 'npm test b', expect: 'exit 0' },
  ],
  integration: { machineCheck: 'npm test', expect: 'exit 0' },
});

// ——— the workflow script's hard runtime constraint ————————————————————————

// Workflow scripts use top-level `await` AND top-level `return` (Anthropic's own
// official scripts do), which means the harness wraps the source in an async
// function before evaluating it. A bare `node --check` therefore rejects a
// PERFECTLY VALID workflow script. Model the real wrapper instead: strip the
// `export` off meta, wrap the body, and syntax-check that.
test('workflows/vzt-ship.js is syntactically valid as the harness evaluates it', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta');
  const wrapped = `async function __wf(args, agent, parallel, pipeline, phase, log) {\n${src}\n}\n`;
  const tmp = path.join(fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-wf-')), 'check.mjs');
  try {
    fs.writeFileSync(tmp, wrapped);
    execFileSync(process.execPath, ['--check', tmp]); // throws on syntax error
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});

// Anthropic: "workflow scripts have no filesystem access." A script that reaches
// for fs fails at RUNTIME — which is to say, after the chair has already paid for
// the spec and dispatched the barrier. Catch it statically instead.
test('workflow script never touches the filesystem (no fs / child_process / require)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  // Strip comments — the doctrine explains the constraint in prose above the code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['require(', 'node:fs', 'node:child_process', 'child_process', 'readFileSync', 'writeFileSync']) {
    assert.ok(!code.includes(banned), `workflows/vzt-ship.js must not use "${banned}" — workflow scripts have no filesystem access`);
  }
  assert.ok(!/^\s*import\s/m.test(code), 'workflow script must not import anything');
});

test('every agentType named in the workflow is an agent install() actually ships', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const used = [...src.matchAll(/agentType:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'expected the workflow to name at least one agentType');
  for (const a of used) assert.ok(AGENT_TYPES.includes(a), `workflow names unknown agentType "${a}"`);
  // Every agent named must also exist as a shipped .md file.
  for (const a of new Set(used)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'agents', `${a}.md`)), `agents/${a}.md does not exist`);
  }
});

test('the workflow verifies with a DIFFERENT agent than the one that built (no self-grading)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(/verifyPrompt/.test(src), 'workflow must have a separate verify step');
  assert.ok(/You are a VERIFIER/.test(src), 'the verifier must be told it is a verifier');
  assert.ok(/CANNOT_RUN/.test(src), 'an unrunnable check must be CANNOT_RUN, never a silent PASS');
});

// ——— parseSpec ————————————————————————————————————————————————————————————

test('parseSpec extracts the machine block from the shipped template', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'spec.md'), 'utf8');
  const { spec, error } = parseSpec(md);
  assert.equal(error, null);
  assert.equal(spec.specVersion, 1);
  assert.ok(Array.isArray(spec.units));
});

test('parseSpec reports a missing marker rather than throwing', () => {
  const { spec, error } = parseSpec('# just prose, no marker');
  assert.equal(spec, null);
  assert.match(error, /marker/);
});

// ——— validateSpec: the collision boundary as an exit code ————————————————

test('validateSpec accepts a well-formed spec', () => {
  assert.deepEqual(validateSpec(validSpec()), []);
});

test('validateSpec REJECTS overlapping FILES_IN_SCOPE (the silent-clobber failure)', () => {
  const s = validSpec();
  s.units[1].filesInScope = ['a.ts']; // now both units claim a.ts
  const errs = validateSpec(s);
  assert.ok(errs.some((e) => /collision/i.test(e) && e.includes('a.ts')), `expected a collision error, got: ${errs.join('; ')}`);
});

test('validateSpec REJECTS a barrier that collides with a unit', () => {
  const s = validSpec();
  s.barrier = { id: 'u0', filesInScope: ['a.ts'], brief: 'types', machineCheck: 'tsc', expect: 'exit 0' };
  assert.ok(validateSpec(s).some((e) => /collision/i.test(e)));
});

test('validateSpec REJECTS a unit with no oracle', () => {
  const s = validSpec();
  delete s.units[0].machineCheck;
  assert.ok(validateSpec(s).some((e) => /machineCheck/.test(e)));
});

test('validateSpec REJECTS a manifest file no unit owns (nobody would write it)', () => {
  const s = validSpec();
  s.manifest.push({ path: 'orphan.ts', op: 'new' });
  assert.ok(validateSpec(s).some((e) => /orphan\.ts/.test(e) && /no unit/.test(e)));
});

test('validateSpec REJECTS an unknown agentType and a relative root', () => {
  const s = validSpec();
  s.units[0].agentType = 'vzt-nonexistent';
  s.root = './relative';
  const errs = validateSpec(s);
  assert.ok(errs.some((e) => /unknown agentType/.test(e)));
  assert.ok(errs.some((e) => /absolute/.test(e)));
});

test('validateSpec REJECTS duplicate unit ids', () => {
  const s = validSpec();
  s.units[1].id = 'u1';
  assert.ok(validateSpec(s).some((e) => /duplicate/.test(e)));
});

// ——— reduceLedger ————————————————————————————————————————————————————————

const ledger = [
  '{"kind":"run_started","runId":"ship_1","slug":"demo","specPath":"/abs/repo/.vzt/ship/demo/SPEC.md"}',
  '{"kind":"gate_passed","runId":"ship_1"}',
  '{"kind":"workflow_launched","wfRunId":"wf_abc123"}',
  '{"kind":"unit_result","unit":"u1","status":"PASS","round":0}',
  '{"kind":"unit_result","unit":"u2","status":"ORACLE_FAIL","round":0}',
  '{"kind":"unit_result","unit":"u2","status":"BLOCKED","round":2}',
].join('\n') + '\n';

test('reduceLedger reconstructs run state from an append-only log', () => {
  const s = reduceLedger(ledger);
  assert.equal(s.runId, 'ship_1');
  assert.equal(s.wfRunId, 'wf_abc123');
  assert.equal(s.units.u1.status, 'PASS');
  assert.equal(s.units.u2.status, 'BLOCKED'); // last write wins
  assert.equal(s.units.u2.round, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.active, true);
});

// A half-written final line is the EXPECTED state after a crash. A reducer that
// throws on it is a reducer that fails exactly when it is needed.
test('reduceLedger survives a TRUNCATED final line (the post-crash state)', () => {
  const truncated = ledger + '{"kind":"unit_result","unit":"u3","stat';
  const s = reduceLedger(truncated);
  assert.equal(s.runId, 'ship_1');
  assert.equal(s.units.u3, undefined);
  assert.equal(s.active, true);
});

test('reduceLedger marks a run inactive once run_complete lands', () => {
  const s = reduceLedger(ledger + '{"kind":"run_complete","passed":1,"blocked":1}\n');
  assert.equal(s.active, false);
  assert.match(nextAction(s), /complete/);
});

test('nextAction routes a BLOCKED unit to exactly ONE tier of escalation', () => {
  const s = reduceLedger(ledger);
  const n = nextAction(s);
  assert.match(n, /u2/);
  assert.match(n, /ONE tier/);
  assert.match(n, /vzt-heavy-builder/);
});

// The hook cannot import cli/ship-lib.mjs — it installs to ~/.claude/hooks/vzt-router/,
// where cli/ does not exist. So the reducer is duplicated, and duplication drifts.
// Guard it with a command instead of with discipline.
test('the hook-inlined reducer and ship-lib agree (drift guard)', () => {
  for (const text of [ledger, ledger + '{"trunc', '', '{"kind":"run_started","runId":"x"}\n{"kind":"run_complete"}']) {
    const a = reduceLedger(text);
    const b = reduceLedgerInline(text);
    assert.equal(b.runId, a.runId, 'runId drift');
    assert.equal(b.active, a.active, 'active drift');
    assert.equal(b.wfRunId, a.wfRunId, 'wfRunId drift');
    assert.deepEqual(Object.keys(b.units).sort(), Object.keys(a.units).sort(), 'unit-set drift');
    for (const id of Object.keys(a.units)) {
      assert.equal(b.units[id].status, a.units[id].status, `status drift on ${id}`);
    }
  }
});
