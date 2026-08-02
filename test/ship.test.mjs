import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateSpec, planWaves, reduceLedger, nextAction, AGENT_TYPES } from '../cli/ship-lib.mjs';
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

// The test above checks workflow -> AGENT_TYPES. This checks the OTHER
// direction, which is the one that actually drifted: agents/vzt-architect.md
// shipped, the router demoted routine planning onto it, and AGENT_TYPES never
// learned about it — so ship-check rejected every spec naming the agent the
// doctrine told you to plan with. An agent you ship must be an agent a spec
// may name.
test('every agent install() ships is accepted by validateSpec (AGENT_TYPES has no drift)', () => {
  const shipped = fs
    .readdirSync(path.join(REPO_ROOT, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  assert.ok(shipped.length > 0, 'expected install() to ship at least one agent');
  for (const a of shipped) {
    assert.ok(AGENT_TYPES.includes(a), `agents/${a}.md ships but AGENT_TYPES omits it — ship-check would reject a spec naming it`);
  }
  for (const a of AGENT_TYPES) {
    assert.ok(shipped.includes(a), `AGENT_TYPES lists "${a}" but agents/${a}.md is not shipped`);
  }
});

test('a FAILED unit reports why — oracle output, worktree, and whether the agent ever ran', () => {
  // Orca can stream a running agent's output (`terminal read`); herdr and vscode
  // cannot, and the VS Code extension API gives no read access to terminal
  // contents at all. So a failing unit used to print a bare "FAIL" and nothing
  // else — the diagnosis had to be reconstructed by hand, which on 2026-07-28
  // cost about an hour to conclude "the agent never started".
  //
  // Everything asserted here is already in hand at verification time. The
  // transcript's ABSENCE is the most valuable line of the three: no Claude Code
  // session directory means the agent never ran, which is the most common unit
  // failure and the least obvious from the outside.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-diag-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });

  const specDir = path.join(repo, '.vzt', 'ship', 'diag');
  fs.mkdirSync(specDir, { recursive: true });
  const spec = {
    specVersion: 1, slug: 'diag', title: 'T', root: repo, contract: 'c',
    manifest: [{ path: 'a.txt', op: 'new' }, { path: 'b.txt', op: 'new' }],
    units: [
      { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['a.txt'], brief: 'x', machineCheck: 'cat a.txt', expect: 'exit 0' },
      { id: 'u2', title: 'B', agentType: 'vzt-builder', filesInScope: ['b.txt'], brief: 'x', machineCheck: 'true', expect: 'exit 0' },
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# T\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);

  // Create the unit worktrees the way a dispatch would, so resolve() finds them.
  // Without a worktree the run falls back to the primary checkout and the
  // transcript branch is never reached — the diagnostics being tested here only
  // make sense for a unit that actually had somewhere to work.
  const muxDir = path.join(repo, 'mux');
  for (const id of ['u1', 'u2']) {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', `diag-${id}`, path.join(muxDir, 'worktrees', `diag-${id}`), 'HEAD'], { stdio: 'ignore' });
  }

  // ship-supervise verifies without dispatching, so no agent is spent. It exits
  // NON-ZERO when a unit fails — which is correct — so read stdout off the throw.
  let out = ''
  try {
    out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'cli', 'vzt-agent.js'), 'ship-supervise', specPath, '--mux', 'vscode'], {
      cwd: repo,
      env: { ...process.env, VZT_VSCODE_DIR: path.join(repo, 'mux') },
      encoding: 'utf8',
    });
    assert.fail('ship-supervise must exit non-zero when a unit fails');
  } catch (e) {
    out = `${e.stdout || ''}`;
    assert.ok(out, `expected stdout from the failing run, got: ${e.message}`);
  }

  assert.match(out, /u1 … FAIL/, 'the failing unit is reported');
  assert.match(out, /oracle: cat a\.txt/, 'the oracle COMMAND is echoed, so the check itself is reviewable');
  assert.match(out, /No such file/, "the oracle's own output is shown, not swallowed");
  assert.match(out, /agent transcript: none — the agent never started/, 'a missing transcript is called out explicitly');
  // A passing unit must stay quiet — diagnostics on success is noise.
  const u2 = out.slice(out.indexOf('u2 …'));
  assert.doesNotMatch(u2, /agent transcript/, 'a PASSing unit must not print failure diagnostics');
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

// The harness can hand `args` to a workflow script as a STRING, not an object.
// A script that assumes an object throws on line 1 — before a single agent is
// spawned — and the error ("requires args:{spec}") blames the spec when the real
// fault is the decode. Cost us two dead launches on the first real run.
test('the workflow decodes args whether it arrives as an object OR a JSON string', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(src, /typeof args === 'string'/, 'vzt-ship.js must tolerate args arriving as a JSON string');
  assert.match(src, /JSON\.parse\(args\)/, 'vzt-ship.js must JSON.parse a stringified args');
  // And the decode must happen BEFORE the spec is read off it.
  const decodeAt = src.indexOf('typeof args');
  const specAt = src.indexOf('input && input.spec');
  assert.ok(decodeAt > 0 && specAt > decodeAt, 'args must be decoded before spec is read');
});

// The first real /vzt-ship run BLOCKED its own barrier on a FALSE scope breach.
// The verifier read `git status --porcelain` and treated every dirty path as
// something the worker wrote — but the repo already had 3 untracked one-off
// scripts, plus the .vzt/ spec dir the chair itself had just created. A correct
// worker got punished through both correction rounds and the run aborted.
// A verifier that manufactures failures is worse than no verifier.
test('the verifier ignores pre-existing dirt (no false SCOPE_BREACH)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(src, /spec\.preexisting/, 'workflow must accept a pre-existing-dirt baseline');
  assert.match(src, /PRE-EXISTING DIRT/, 'the verifier prompt must tell the agent which paths it did NOT write');
  assert.match(src, /NOT a scope breach/i, 'the verifier must be told pre-existing dirt is not a breach');
  // and the ignore list must actually reach the verify prompt
  assert.match(src, /\$\{ignoreLine\}/, 'ignoreLine must be interpolated into verifyPrompt');
});

// ——— the DAG: dependsOn, waves, cycles ————————————————————————————————————
//
// Disjoint FILES_IN_SCOPE kills the SPATIAL collision — two units writing one
// file. It says nothing about the TEMPORAL one: a unit reading a file another
// unit is still writing. Before `dependsOn`, every unit fanned out at once and
// the only ordering primitive in the whole spec was the single barrier.

const depSpec = (units, barrier) => ({
  specVersion: 1, slug: 'dag', title: 'DAG', root: '/abs/repo', contract: 'c',
  ...(barrier ? { barrier } : {}),
  units,
  integration: { machineCheck: 'npm test', expect: 'exit 0' },
});
const depUnit = (id, file, dependsOn) => ({
  id, title: id, agentType: 'vzt-builder', filesInScope: [file],
  brief: 'b', machineCheck: 'npm t', expect: 'exit 0',
  ...(dependsOn ? { dependsOn } : {}),
});

test('planWaves orders a diamond into three waves', () => {
  const spec = depSpec([
    depUnit('u1', 'a.ts'),
    depUnit('u2', 'b.ts', ['u1']),
    depUnit('u3', 'c.ts', ['u1']),
    depUnit('u4', 'd.ts', ['u2', 'u3']),
  ]);
  assert.deepEqual(validateSpec(spec), []);
  assert.deepEqual(
    planWaves(spec).map((w) => w.map((u) => u.id)),
    [['u1'], ['u2', 'u3'], ['u4']]
  );
});

// Back-compat is the whole reason `dependsOn` is optional. Every SPEC written
// before this release has no edges at all, and must keep behaving EXACTLY like
// the flat fan-out it was written for — one wave, everything parallel.
test('a spec with no dependsOn yields exactly one wave (old specs unchanged)', () => {
  const spec = depSpec([depUnit('u1', 'a.ts'), depUnit('u2', 'b.ts'), depUnit('u3', 'c.ts')]);
  assert.deepEqual(validateSpec(spec), []);
  const waves = planWaves(spec);
  assert.equal(waves.length, 1);
  assert.deepEqual(waves[0].map((u) => u.id), ['u1', 'u2', 'u3']);
});

// A cycle is the failure that costs the most if it escapes: the scheduler finds
// nothing ready, dispatches nothing, and the run reports "done" having built
// zero units. It has to be an exit code at ship-check, naming the units.
test('a dependsOn cycle is refused by validateSpec, and planWaves does not hang', () => {
  const spec = depSpec([depUnit('u1', 'a.ts', ['u2']), depUnit('u2', 'b.ts', ['u1'])]);
  const errs = validateSpec(spec);
  const cycle = errs.filter((e) => /cycle/.test(e));
  assert.equal(cycle.length, 1, `expected exactly one cycle error, got: ${JSON.stringify(errs)}`);
  assert.match(cycle[0], /u1/);
  assert.match(cycle[0], /u2/);
  assert.deepEqual(planWaves(spec), []); // refuses to emit a partial plan
});

test('a three-unit cycle is caught too (not just the two-unit case)', () => {
  const spec = depSpec([
    depUnit('u1', 'a.ts', ['u3']),
    depUnit('u2', 'b.ts', ['u1']),
    depUnit('u3', 'c.ts', ['u2']),
  ]);
  assert.ok(validateSpec(spec).some((e) => /cycle/.test(e)));
});

// An edge naming a unit that does not exist is worse than a hard error: it
// silently DROPS the ordering the planner meant to express, and the run looks
// fine right up until the dependent reads a file nobody wrote yet.
test('dependsOn naming an unknown unit is an error, not a silently dropped edge', () => {
  const spec = depSpec([depUnit('u1', 'a.ts'), depUnit('u2', 'b.ts', ['u-nope'])]);
  const errs = validateSpec(spec).filter((e) => /dependsOn/.test(e));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /u-nope/);
});

test('dependsOn rejects self-reference, a non-array, and naming the barrier', () => {
  const selfDep = depSpec([depUnit('u1', 'a.ts', ['u1']), depUnit('u2', 'b.ts')]);
  assert.ok(validateSpec(selfDep).some((e) => /lists itself/.test(e)));

  const notArray = depSpec([depUnit('u1', 'a.ts'), { ...depUnit('u2', 'b.ts'), dependsOn: 'u1' }]);
  assert.ok(validateSpec(notArray).some((e) => /must be an array/.test(e)));

  // The barrier already gates every unit. Letting a spec name it would imply
  // there is a choice about it, and a planner would then reasonably assume that
  // omitting it means "do not wait for the barrier" — which is not true.
  const barrier = { id: 'u0', title: 'B', agentType: 'vzt-builder', filesInScope: ['z.ts'], brief: 'b', machineCheck: 'npm t', expect: 'exit 0' };
  const namesBarrier = depSpec([depUnit('u1', 'a.ts', ['u0']), depUnit('u2', 'b.ts')], barrier);
  assert.ok(validateSpec(namesBarrier).some((e) => /implicit dependency/.test(e)));
});

// A DAG is only reachable if the thing that WRITES specs knows the field exists.
// Shipping the scheduler without documenting `dependsOn` would leave every
// generated spec edge-free and the whole wave machinery dead code — the exact
// "a gate in a dead workflow enforces nothing" shape this repo has hit before.
test('dependsOn is documented where specs are actually authored', () => {
  const tmpl = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'spec.md'), 'utf8');
  assert.match(tmpl, /"dependsOn"/, 'templates/spec.md must show dependsOn in the json block');
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-ship', 'SKILL.md'), 'utf8');
  assert.match(skill, /dependsOn/, 'skills/vzt-ship/SKILL.md must tell the chair the field exists');
});

// A hand copy is a drift risk, so it gets a guard.
//
// Workflow scripts cannot import, so workflows/vzt-ship.js carries its own copy
// of planWaves/depsOf. The failure that copy invites is not a crash — it is the
// two engines quietly disagreeing about what order the units run in, which shows
// up as a unit graded against work that was never produced. Same arrangement as
// the reduceLedgerInline guard above.
test('the workflow-inlined planWaves and ship-lib agree (drift guard)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const depsFn = src.match(/const depsOf = \([\s\S]*?\n\n/);
  const wavesFn = src.match(/function planWaves\(units\) \{[\s\S]*?\n\}\n/);
  assert.ok(depsFn, 'workflows/vzt-ship.js must define depsOf');
  assert.ok(wavesFn, 'workflows/vzt-ship.js must define planWaves');
  // eslint-disable-next-line no-new-func
  const inlinePlanWaves = new Function(`${depsFn[0]}\n${wavesFn[0]}\nreturn planWaves;`)();

  const shapes = [
    [], // no edges at all — must be one wave, the old flat fan-out
    [['u2', ['u1']]],
    [['u2', ['u1']], ['u3', ['u1']], ['u4', ['u2', 'u3']]], // diamond
    [['u3', ['u2']], ['u2', ['u1']]], // chain declared out of order
    [['u4', ['u1']]], // a late unit depending on the first
  ];
  for (const edges of shapes) {
    const units = ['u1', 'u2', 'u3', 'u4'].map((id) => {
      const e = edges.find(([who]) => who === id);
      return { id, title: id, agentType: 'vzt-builder', filesInScope: [`${id}.ts`], brief: 'b', machineCheck: 'x', expect: 'y', ...(e ? { dependsOn: e[1] } : {}) };
    });
    const spec = { specVersion: 1, slug: 's', title: 'S', root: '/abs/r', contract: 'c', units, integration: { machineCheck: 'x', expect: 'y' } };
    assert.deepEqual(validateSpec(spec), [], `fixture itself must be valid: ${JSON.stringify(edges)}`);
    assert.deepEqual(
      inlinePlanWaves(units).map((w) => w.map((u) => u.id)),
      planWaves(spec).map((w) => w.map((u) => u.id)),
      `inlined planWaves disagrees with ship-lib for edges ${JSON.stringify(edges)}`
    );
  }
});

// The headless path fanned every unit out at once and ignored dependsOn
// entirely — a field ship-check accepts and one of the two engines drops.
test('the headless workflow honours dependsOn instead of one flat fan-out', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(!/parallel\(spec\.units\.map\(/.test(src), 'the flat fan-out over ALL units must be gone');
  assert.match(src, /for \(let i = 0; i < WAVES\.length; i\+\+\)/, 'units must be dispatched wave by wave');
  assert.match(src, /BLOCKED — dependency/, 'a unit whose dependency failed must be BLOCKED, not dispatched');
  assert.match(src, /dependsOn cycle/, 'a cycle must throw before any agent is spawned');
  assert.match(src, /dependsOn names unknown unit/, 'an unknown dependency id must throw');
});
