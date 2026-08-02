/**
 * The unit worktree's BASE — does a dependent actually see what it depends on?
 *
 * 🔴 The bug these tests were written against. Every `git worktree add` in the
 * CLI bases off the primary checkout's HEAD, on all three backends, and nothing
 * ever merged, rebased, or cherry-picked. So the barrier wrote the shared
 * contract on its own branch in its own worktree, and every unit briefed to
 * "build against the interface in types.ts" opened a tree where types.ts did not
 * exist. The unit then either failed its own oracle or breached scope to create
 * the file itself. Only the integration gate ever saw the pieces together — at
 * the very end, after the whole run had been paid for.
 *
 * These assert on FILES ON DISK in real worktrees, not on the seeding function's
 * own idea of what it did. A seeding routine that reports success into a tree
 * that does not contain the file is the exact failure being guarded against.
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

/** A throwaway repo plus a SPEC whose units form barrier → u1 → u2. */
function scaffold() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-deps-'));
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
    specVersion: 1,
    slug: 'deps',
    title: 'Deps',
    root: repo,
    contract: 'c',
    manifest: [{ path: 'types.txt', op: 'new' }, { path: 'a.txt', op: 'new' }, { path: 'b.txt', op: 'new' }],
    barrier: { id: 'u0', title: 'Contract', agentType: 'vzt-builder', filesInScope: ['types.txt'], brief: 'contract', machineCheck: 'true', expect: 'exit 0' },
    units: [
      { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['a.txt'], brief: 'a', machineCheck: 'true', expect: 'exit 0' },
      { id: 'u2', title: 'B', agentType: 'vzt-builder', dependsOn: ['u1'], filesInScope: ['b.txt'], brief: 'b', machineCheck: 'true', expect: 'exit 0' },
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'deps');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Deps\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, repo, muxDir, specPath };
}

/** Run a real `ship-dispatch --execute --mux vscode`. No extension is running, so
 *  every unit reports "no window claimed this unit" — irrelevant here: the
 *  worktree creation and seeding both happen before that check. */
function dispatch(specPath, muxDir) {
  return execFileSync(process.execPath, [CLI, 'ship-dispatch', specPath, '--mux', 'vscode', '--execute'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '50' },
  });
}

const wt = (muxDir, id) => path.join(muxDir, 'worktrees', `deps-${id}`);
const unitRecord = (muxDir, id) => JSON.parse(fs.readFileSync(path.join(muxDir, 'units', `deps-${id}.json`), 'utf8'));

test('a unit worktree contains the BARRIER\'s work (the bug: it used to be empty)', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir); // creates all three worktrees; nothing written yet

    // Simulate the barrier's agent: write the shared contract and leave it
    // UNCOMMITTED, which is what agents actually do most of the time.
    fs.writeFileSync(path.join(wt(muxDir, 'u0'), 'types.txt'), 'export type T = 1\n');

    dispatch(specPath, muxDir); // re-dispatch: worktrees are reused, seeding runs

    const seen = path.join(wt(muxDir, 'u1'), 'types.txt');
    assert.ok(fs.existsSync(seen), 'u1 cannot see the barrier\'s types.txt — the unit is building against a file that is not there');
    assert.equal(fs.readFileSync(seen, 'utf8'), 'export type T = 1\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dependencies are seeded TRANSITIVELY (u2 gets u1\'s work AND the barrier\'s)', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u0'), 'types.txt'), 'T\n');
    dispatch(specPath, muxDir); // u1 + u2 now hold the barrier
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'a.txt'), 'A\n');
    dispatch(specPath, muxDir); // u2 now holds u1 as well

    // The grandparent is the one that goes missing if the walk is not transitive:
    // once u1's seed is committed, its captured patch no longer contains the
    // barrier's file, so seeding u2 from u1 alone would silently drop types.txt.
    assert.ok(fs.existsSync(path.join(wt(muxDir, 'u2'), 'a.txt')), 'u2 is missing its direct dependency u1');
    assert.ok(fs.existsSync(path.join(wt(muxDir, 'u2'), 'types.txt')), 'u2 is missing the barrier — the dependency walk is not transitive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seeding is idempotent — re-dispatching a unit does not fail on its own seed', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u0'), 'types.txt'), 'T\n');
    dispatch(specPath, muxDir);
    // A correction round re-dispatches the same unit into the SAME worktree. If
    // the seed applied twice, `git apply` dies with "already exists" and an
    // ordinary retry becomes a permanent dispatch failure.
    const out = dispatch(specPath, muxDir) + dispatch(specPath, muxDir);
    assert.ok(!/seed conflict/.test(out), `re-dispatch hit a seed conflict:\n${out}`);
    assert.ok(fs.existsSync(path.join(wt(muxDir, 'u1'), 'types.txt')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the seed is COMMITTED and recorded as baseSha, so layers compose exactly once', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u0'), 'types.txt'), 'T\n');
    dispatch(specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'a.txt'), 'A\n');
    dispatch(specPath, muxDir);

    const rec = unitRecord(muxDir, 'u2');
    assert.match(rec.baseSha || '', /^[0-9a-f]{40}$/, 'unit record carries no baseSha — the scope audit has no baseline');
    // baseSha must be a real commit in that worktree, not a string that looks like one.
    assert.equal(git(wt(muxDir, 'u2'), 'rev-parse', 'HEAD').trim(), rec.baseSha);
    assert.deepEqual(rec.dependsOn, ['u1']);
    assert.equal(rec.wave, 2, 'u2 depends on u1, so it belongs to wave 2');

    // The seed being COMMITTED is what keeps each layer out of the next unit's
    // own patch. If it were left uncommitted, u2's diff would carry u1's a.txt
    // too and the integration gate would try to apply that file twice.
    const own = git(wt(muxDir, 'u2'), 'status', '--porcelain', '--untracked-files=all').trim();
    assert.equal(own, '', `u2's worktree should be clean after seeding, got:\n${own}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a REUSED worktree that has fallen behind gets a BASE DRIFT block in its prompt', () => {
  const { tmp, repo, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir);
    const prompt = () => fs.readFileSync(path.join(muxDir, 'prompts', 'deps-u1.txt'), 'utf8');
    assert.ok(!/BASE DRIFT/.test(prompt()), 'a freshly created worktree is at HEAD and must emit no drift section');

    // The primary checkout moves on; the unit's worktree does not.
    fs.writeFileSync(path.join(repo, 'NEW.md'), 'later\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'a commit the unit worktree has never seen');

    dispatch(specPath, muxDir);
    const p = prompt();
    assert.match(p, /BASE DRIFT/, 'a reused worktree behind HEAD must say so on line 1, not leave it to be inferred');
    assert.match(p, /a commit the unit worktree has never seen/, 'the drift block must name the missing commits');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the prompt tells a dependent which files are its dependencies\' and off-limits', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    dispatch(specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u0'), 'types.txt'), 'T\n');
    dispatch(specPath, muxDir);
    const p = fs.readFileSync(path.join(muxDir, 'prompts', 'deps-u2.txt'), 'utf8');
    // Seeded files are a trap without this: they are present, relevant, and
    // outside FILES_IN_SCOPE, so "improving" one is a scope breach.
    assert.match(p, /ALREADY IN THIS WORKTREE/);
    assert.match(p, /u0/);
    assert.match(p, /scope breach/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
