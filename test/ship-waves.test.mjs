/**
 * The wave scheduler and the concurrency cap.
 *
 * Before this, Phase 2 was `spec.units.map(dispatch)`: every unit launched at
 * once, then waited on in spec order. A 12-unit spec started 12 claude processes
 * and 12 integrated terminals simultaneously, and the only way to express "u2
 * needs what u1 produces" was to promote it to the single barrier.
 *
 * These drive the REAL `ship-watch` against a repo where each unit is satisfied
 * by a trivial oracle, and read the observable consequences — how many worktrees
 * exist at a given moment, which units were dispatched at all, and what the
 * ledger recorded. Asserting that planWaves returns waves would only restate its
 * own arithmetic; this asserts that shipWatch OBEYS it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * @param units spec units (ids u1..uN)
 * @param oracle per-unit machineCheck; `true` passes, `false` fails
 */
function scaffold(units) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-waves-'));
  const repo = path.join(tmp, 'repo');
  const muxDir = path.join(tmp, 'mux');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'user.email', 't@t.local');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const spec = {
    specVersion: 1, slug: 'wave', title: 'Wave', root: repo, contract: 'c',
    manifest: units.map((u) => ({ path: `${u.id}.txt`, op: 'new' })),
    units: units.map((u) => ({
      id: u.id, title: u.id, agentType: 'vzt-builder',
      filesInScope: [`${u.id}.txt`], brief: 'b',
      machineCheck: u.fail ? 'false' : 'true', expect: 'exit 0',
      ...(u.dependsOn ? { dependsOn: u.dependsOn } : {}),
    })),
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'wave');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Wave\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, repo, muxDir, specPath, specDir };
}

/** Run ship-watch to completion. No VS Code host is listening, so every unit's
 *  queue record goes unclaimed and waitIdle returns at once — which is exactly
 *  what makes this fast and deterministic. The scheduler is still fully exercised. */
function watch(specPath, muxDir, extra = []) {
  try {
    return execFileSync(process.execPath, [CLI, 'ship-watch', specPath, '--mux', 'vscode', ...extra], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '30', VZT_START_GRACE_MS: '30' },
    });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`; // non-zero exit is normal when a unit fails
  }
}

const ledger = (specDir) =>
  fs.readFileSync(path.join(specDir, 'LEDGER.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('ship-watch runs units in dependency waves, not one flat fan-out', () => {
  const { tmp, muxDir, specPath } = scaffold([
    { id: 'u1' },
    { id: 'u2', dependsOn: ['u1'] },
    { id: 'u3', dependsOn: ['u1'] },
    { id: 'u4', dependsOn: ['u2', 'u3'] },
  ]);
  try {
    const out = watch(specPath, muxDir);
    assert.match(out, /3 wave\(s\)/, `expected 3 waves, got:\n${out}`);
    assert.match(out, /wave 1\/3: u1/);
    assert.match(out, /wave 2\/3: u2, u3/);
    assert.match(out, /wave 3\/3: u4/);
    // Ordering must hold in the DISPATCH stream too, not just the banner.
    const at = (id) => out.indexOf(`dispatched ${id} `);
    assert.ok(at('u1') < at('u2') && at('u2') < at('u4'), 'units were dispatched out of dependency order');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The control for the test above: with NO dependsOn anywhere, the same machinery
// must collapse to exactly one wave. If both shapes report the same thing, the
// wave banner is decoration rather than a measurement.
test('a spec with no dependsOn still runs as a single wave (old specs unchanged)', () => {
  const { tmp, muxDir, specPath } = scaffold([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }]);
  try {
    const out = watch(specPath, muxDir);
    assert.match(out, /1 wave\(s\)/);
    assert.match(out, /wave 1\/1: u1, u2, u3, u4/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--max-concurrent bounds how many units are in flight; 0 restores the old fan-out', () => {
  const spec = () => [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }, { id: 'u5' }];

  // The observable proof is the unit RECORD's dispatchedAt: with a cap of 2 the
  // fifth unit cannot be dispatched until earlier ones have been verified, so
  // the dispatch timestamps spread out into groups. Counting simultaneous
  // terminals is not available here (no extension host), so measure the thing
  // that is: the cap must change the ORDER of dispatch vs verification.
  const capped = scaffold(spec());
  const uncapped = scaffold(spec());
  try {
    const a = watch(capped.specPath, capped.muxDir, ['--max-concurrent', '2']);
    const b = watch(uncapped.specPath, uncapped.muxDir, ['--max-concurrent', '0']);

    assert.match(a, /max 2 at a time/);
    assert.match(b, /no concurrency cap/);

    // With a cap, dispatch and verification INTERLEAVE: u3 cannot start before
    // something has been verified. Without one, all five dispatch first.
    const firstVerify = (out) => out.search(/^ {2}u\d+ … (PASS|FAIL)/m);
    const lastDispatch = (out) => out.lastIndexOf('dispatched u');
    assert.ok(firstVerify(a) < lastDispatch(a), `capped run should interleave dispatch and verify:\n${a}`);
    assert.ok(firstVerify(b) > lastDispatch(b), `uncapped run should dispatch everything first:\n${b}`);
  } finally {
    fs.rmSync(capped.tmp, { recursive: true, force: true });
    fs.rmSync(uncapped.tmp, { recursive: true, force: true });
  }
});

test('a unit whose dependency FAILED is BLOCKED, never dispatched against a broken base', () => {
  const { tmp, muxDir, specPath, specDir } = scaffold([
    { id: 'u1', fail: true },
    { id: 'u2', dependsOn: ['u1'] },
    { id: 'u3' }, // independent — must still run
  ]);
  try {
    const out = watch(specPath, muxDir);
    assert.match(out, /u2 … BLOCKED \(dependency u1 did not pass\)/);
    // Dispatching u2 anyway would seed it from a failed unit and then blame u2
    // for a failure that belongs to u1 — the operator debugs the wrong unit.
    assert.ok(!/dispatched u2 /.test(out), 'u2 must not be dispatched when its dependency failed');
    assert.match(out, /dispatched u3 /, 'an independent unit must still run when an unrelated one fails');

    const results = Object.fromEntries(ledger(specDir).filter((e) => e.kind === 'unit_result').map((e) => [e.unit, e.status]));
    assert.equal(results.u1, 'FAIL');
    assert.equal(results.u2, 'BLOCKED');
    assert.equal(results.u3, 'PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ship-dispatch prints one phase per wave so a dry run shows the real order', () => {
  const { tmp, muxDir, specPath } = scaffold([{ id: 'u1' }, { id: 'u2', dependsOn: ['u1'] }]);
  try {
    const out = execFileSync(process.execPath, [CLI, 'ship-dispatch', specPath, '--mux', 'vscode'], {
      encoding: 'utf8', env: { ...process.env, VZT_VSCODE_DIR: muxDir },
    });
    assert.match(out, /PHASE 1 — wave 1\/2/);
    assert.match(out, /PHASE 2 — wave 2\/2.*waits on wave 1/);
    assert.match(out, /# seeded from: u1/, 'the dry run must show what a dependent will be seeded with');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ship-dispatch has no wait — it is the manual escape hatch, and that was
// harmless while units were independent. With `dependsOn` it became a trap: a
// later wave's worktree is seeded from a dependency whose agent has not written
// anything, so the seed is EMPTY and the unit builds against nothing. An empty
// patch applies cleanly by doing nothing, so without this the failure is silent.
test('ship-dispatch --execute warns when a multi-wave spec will seed from nothing', () => {
  const { tmp, muxDir, specPath } = scaffold([
    { id: 'u1' },
    { id: 'u2', dependsOn: ['u1'] },
    { id: 'u3', dependsOn: ['u2'] },
  ]);
  try {
    const out = execFileSync(process.execPath, [CLI, 'ship-dispatch', specPath, '--mux', 'vscode', '--execute'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '30' },
    });
    assert.match(out, /3 dependency waves and ship-dispatch does NOT wait/);
    assert.match(out, /u2, u3 will be dispatched against dependencies that have not run yet/);
    assert.match(out, /ship-watch/, 'the warning must name the command that DOES stage the run');
    // Per-unit, an empty seed must be reported as such rather than looking done.
    assert.match(out, /u2 produced no work yet|u1 produced no work yet/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// CONTROL for the test above: a single-wave spec has no ordering to violate, so
// it must NOT carry the warning. If both shapes warned, the warning would be
// noise and would be trained away.
test('a single-wave spec gets no wave warning from ship-dispatch', () => {
  const { tmp, muxDir, specPath } = scaffold([{ id: 'u1' }, { id: 'u2' }]);
  try {
    const out = execFileSync(process.execPath, [CLI, 'ship-dispatch', specPath, '--mux', 'vscode', '--execute'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '30' },
    });
    assert.ok(!/does NOT wait/.test(out), `single-wave spec should not warn:\n${out}`);
    assert.match(out, /seeded from: \(nothing to wait on/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
