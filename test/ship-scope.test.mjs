/**
 * The RUNTIME scope audit — does a unit that writes outside FILES_IN_SCOPE get
 * caught while the run is still going?
 *
 * FILES_IN_SCOPE used to be enforced in two places, and neither ran on the
 * supervised path: a plan-time disjointness check (which cannot see what an
 * agent actually did) and a SCOPE_BREACH verdict living only in the headless
 * Workflow driver. So on `ship-watch` the first sign of a breach was a failed
 * `git apply` in the integration gate — at the very end, after every unit's
 * budget was spent, blamed on whichever unit happened to be applied second.
 *
 * The other half of these tests matters just as much. The first real /vzt-ship
 * run BLOCKED its own barrier on a FALSE breach, because the verifier read raw
 * `git status` and counted pre-existing untracked files as the worker's writes.
 * A verifier that manufactures failures is worse than no verifier, so every
 * "catches it" test here has a "does not cry wolf" twin.
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

function scaffold({ gitignore } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-scope-'));
  const repo = path.join(tmp, 'repo');
  const muxDir = path.join(tmp, 'mux');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'user.email', 't@t.local');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  if (gitignore) fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const spec = {
    specVersion: 1, slug: 'scope', title: 'Scope', root: repo, contract: 'c',
    manifest: [{ path: 'a.txt', op: 'new' }, { path: 'b.txt', op: 'new' }],
    units: [
      { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['a.txt'], brief: 'a', machineCheck: 'true', expect: 'exit 0' },
      { id: 'u2', title: 'B', agentType: 'vzt-builder', dependsOn: ['u1'], filesInScope: ['b.txt'], brief: 'b', machineCheck: 'true', expect: 'exit 0' },
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'scope');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Scope\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, repo, muxDir, specPath, specDir };
}

const wt = (muxDir, id) => path.join(muxDir, 'worktrees', `scope-${id}`);
const env = (muxDir) => ({ ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '30', VZT_START_GRACE_MS: '30' });

function run(cmd, specPath, muxDir) {
  try {
    return execFileSync(process.execPath, [CLI, cmd, specPath, '--mux', 'vscode', ...(cmd === 'ship-dispatch' ? ['--execute'] : [])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env(muxDir),
    });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

const ledger = (specDir) =>
  Object.fromEntries(
    fs.readFileSync(path.join(specDir, 'LEDGER.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'unit_result')
      .map((e) => [e.unit, e])
  );

test('a unit that writes OUTSIDE its scope is SCOPE_BREACH — caught mid-run, not at the gate', () => {
  const { tmp, muxDir, specPath, specDir } = scaffold();
  try {
    run('ship-dispatch', specPath, muxDir); // creates the worktrees
    // Simulate the agent: writes what it was asked for, plus one file it was not.
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'a.txt'), 'ok\n');
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'somewhere-else.txt'), 'not mine\n');

    const out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … SCOPE_BREACH/);
    assert.match(out, /somewhere-else\.txt/, 'the breach must name the offending path, not just report a count');
    assert.ok(!/somewhere-else/.test(out.split('u2 …')[1] || ''), 'the breach must be attributed to u1 only');

    const rows = ledger(specDir);
    assert.equal(rows.u1.status, 'SCOPE_BREACH');
    assert.match(rows.u1.output, /somewhere-else\.txt/, 'the ledger must record WHICH file, so a post-compaction chair can act on it');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// THE CONTROL. Same scaffold, same commands, one difference: the unit stays
// inside its scope. If this also reported a breach, the check above would be
// measuring nothing but "a unit ran".
test('a unit that stays inside its scope PASSes — the audit does not cry wolf', () => {
  const { tmp, muxDir, specPath, specDir } = scaffold();
  try {
    run('ship-dispatch', specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'a.txt'), 'ok\n');

    const out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … PASS/);
    assert.ok(!/SCOPE_BREACH/.test(out), `clean unit reported a breach:\n${out}`);
    assert.equal(ledger(specDir).u1.status, 'PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The seeded-dependency case is the one a naive implementation gets wrong. u2's
// worktree legitimately CONTAINS a.txt — it was seeded from u1 — and a.txt is
// emphatically not in u2's FILES_IN_SCOPE. Diffing against the worktree's
// creation point instead of the seed commit reports it as u2's own write, and
// every dependent unit in every run fails for a reason that is not its fault.
test('seeded dependency files are NOT counted as the dependent\'s writes', () => {
  const { tmp, muxDir, specPath, specDir } = scaffold();
  try {
    run('ship-dispatch', specPath, muxDir);
    fs.writeFileSync(path.join(wt(muxDir, 'u1'), 'a.txt'), 'from u1\n');
    run('ship-dispatch', specPath, muxDir); // u2 is now seeded with u1's a.txt

    assert.ok(fs.existsSync(path.join(wt(muxDir, 'u2'), 'a.txt')), 'precondition: u2 must actually hold the seeded file');
    fs.writeFileSync(path.join(wt(muxDir, 'u2'), 'b.txt'), 'from u2\n');

    const out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u2 … PASS/, `a seeded dependency was mistaken for a breach:\n${out}`);
    assert.equal(ledger(specDir).u2.status, 'PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The bootstrap symlinks node_modules and .env* into every worktree before the
// agent starts. Those are the unit's environment, not its output.
test('gitignored build artifacts (node_modules, .env) are not a breach', () => {
  const { tmp, muxDir, specPath } = scaffold({ gitignore: 'node_modules/\n.env\n' });
  try {
    run('ship-dispatch', specPath, muxDir);
    const w = wt(muxDir, 'u1');
    fs.writeFileSync(path.join(w, 'a.txt'), 'ok\n');
    fs.mkdirSync(path.join(w, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(w, 'node_modules', 'left-pad', 'index.js'), '//\n');
    fs.writeFileSync(path.join(w, '.env'), 'SECRET=1\n');

    const out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … PASS/, `gitignored environment files were read as writes:\n${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a breach is caught even when the agent COMMITTED it (not just left it dirty)', () => {
  const { tmp, muxDir, specPath } = scaffold();
  try {
    run('ship-dispatch', specPath, muxDir);
    const w = wt(muxDir, 'u1');
    fs.writeFileSync(path.join(w, 'a.txt'), 'ok\n');
    fs.writeFileSync(path.join(w, 'sneaky.txt'), 'committed out of scope\n');
    // `git status` is clean after this. An audit that only reads the working
    // tree would see nothing at all.
    git(w, 'add', '-A');
    git(w, '-c', 'user.email=a@b.c', '-c', 'user.name=A', 'commit', '-qm', 'work');

    const out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … SCOPE_BREACH/);
    assert.match(out, /sneaky\.txt/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a directory scope entry ending in / covers everything beneath it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-scopedir-'));
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
    specVersion: 1, slug: 'dir', title: 'Dir', root: repo, contract: 'c',
    manifest: [{ path: 'src/api/x.ts', op: 'new' }, { path: 'other.txt', op: 'new' }],
    units: [
      { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['src/api/'], brief: 'a', machineCheck: 'true', expect: 'exit 0' },
      { id: 'u2', title: 'B', agentType: 'vzt-builder', filesInScope: ['other.txt'], brief: 'b', machineCheck: 'true', expect: 'exit 0' },
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'dir');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Dir\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  try {
    run('ship-dispatch', specPath, muxDir);
    const w = path.join(muxDir, 'worktrees', 'dir-u1');
    fs.mkdirSync(path.join(w, 'src', 'api', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(w, 'src', 'api', 'x.ts'), '1\n');
    fs.writeFileSync(path.join(w, 'src', 'api', 'deep', 'y.ts'), '2\n');
    let out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … PASS/, `nested files under a declared directory were flagged:\n${out}`);

    // ...and a sibling directory is still outside it.
    fs.mkdirSync(path.join(w, 'src', 'web'), { recursive: true });
    fs.writeFileSync(path.join(w, 'src', 'web', 'z.ts'), '3\n');
    out = run('ship-supervise', specPath, muxDir);
    assert.match(out, /u1 … SCOPE_BREACH/);
    assert.match(out, /src\/web\/z\.ts/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
