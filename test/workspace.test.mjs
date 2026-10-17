import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'workspace', 'cli.mjs');

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_PROJECTS_FILE']) delete BASE_ENV[k];

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// A fresh repo with one commit on `main`, in its own parent dir so the
// sibling `<name>-worktrees/` directory stays inside the temp tree.
function gitRepo(name = 'proj') {
  const dir = path.join(tmp('vzt-ws-'), name);
  fs.mkdirSync(dir);
  git(['init', '-q', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function registry() {
  return path.join(tmp('vzt-ws-reg-'), 'nested', 'projects.json');
}

function cli(file, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...BASE_ENV, VZT_PROJECTS_FILE: file }, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

function ok(file, args) {
  const r = cli(file, [...args, '--json']);
  assert.equal(r.code, 0, `${args.join(' ')} failed: ${r.err}`);
  return r.json();
}

test('add registers the main checkout from a worktree path', () => {
  const repo = gitRepo();
  const wt = path.join(path.dirname(repo), 'side');
  git(['worktree', 'add', '-q', '-b', 'side', wt], repo);
  const sub = path.join(wt, 'deep');
  fs.mkdirSync(sub);
  const file = registry();
  const p = ok(file, ['projects', 'add', sub]);
  assert.deepEqual(p, { name: 'proj', root: repo, baseRef: 'main' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, projects: [p] });
  const named = ok(registry(), ['projects', 'add', repo, '--name', 'Other', '--base', 'side']);
  assert.deepEqual(named, { name: 'Other', root: repo, baseRef: 'side' });
});

test('add refuses non-git dir', () => {
  const file = registry();
  const r = cli(file, ['projects', 'add', tmp('vzt-ws-plain-')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not a git repository/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(cli(file, ['projects', 'add', gitRepo(), '--name', '-bad']).code, 2);
});

test('add refuses duplicate', () => {
  const file = registry();
  const a = gitRepo('alpha');
  const b = gitRepo('beta');
  ok(file, ['projects', 'add', a]);
  assert.equal(cli(file, ['projects', 'add', a, '--name', 'again']).code, 4, 'same root');
  assert.equal(cli(file, ['projects', 'add', b, '--name', 'alpha']).code, 4, 'same name');
  assert.equal(ok(file, ['projects', 'list']).length, 1);
});

test('registry file is 0600', () => {
  const file = registry();
  ok(file, ['projects', 'add', gitRepo()]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['projects.json'], 'no tmp file left behind');
});

test('list shows worktrees', () => {
  const file = registry();
  assert.deepEqual(ok(file, ['projects', 'list']), []);
  const repo = gitRepo();
  ok(file, ['projects', 'add', repo]);
  const wt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'task-1']);
  const detached = path.join(path.dirname(repo), 'detached');
  git(['worktree', 'add', '-q', '--detach', detached], repo);
  const [p] = ok(file, ['projects', 'list']);
  assert.equal(p.exists, true);
  assert.equal(p.baseRef, 'main');
  const head = git(['rev-parse', 'HEAD'], repo);
  assert.deepEqual(p.worktrees, [
    { path: repo, branch: 'main', head, main: true },
    { path: detached, branch: null, head, main: false },
    { path: wt.path, branch: 'task-1', head, main: false },
  ], 'main first, then git\'s path order');
  const human = cli(file, ['projects', 'list']);
  assert.equal(human.code, 0);
  assert.match(human.out, /task-1/);
});

test('list marks missing root', () => {
  const file = registry();
  const repo = gitRepo();
  ok(file, ['projects', 'add', repo]);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(ok(file, ['projects', 'list']), [
    { name: 'proj', root: repo, baseRef: 'main', exists: false, worktrees: [] },
  ]);
});

test('create makes worktree on base', () => {
  const file = registry();
  const repo = gitRepo();
  git(['checkout', '-q', '-b', 'feature'], repo);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'feature'], repo);
  const featureHead = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'main'], repo);
  const mainHead = git(['rev-parse', 'HEAD'], repo);
  ok(file, ['projects', 'add', repo]);

  const expected = path.join(path.dirname(repo), 'proj-worktrees', 'on-feature');
  const wt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'on-feature', '--base', 'feature']);
  assert.deepEqual(wt, { path: expected, branch: 'on-feature', base: 'feature', head: featureHead });
  assert.equal(git(['branch', '--show-current'], expected), 'on-feature');
  assert.ok(fs.existsSync(path.join(expected, 'f.txt')));

  const dflt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'on-main']);
  assert.equal(dflt.base, 'main');
  assert.equal(dflt.head, mainHead);

  assert.equal(cli(file, ['worktree', 'create', '--project', 'nope', '--name', 'x']).code, 2);
  assert.equal(cli(file, ['worktree', 'create', '--project', 'proj', '--name', 'y', '--base', 'no-such-ref']).code, 2);
});

test('create refuses existing slug', () => {
  const file = registry();
  const repo = gitRepo();
  ok(file, ['projects', 'add', repo]);
  ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'dup']);
  assert.equal(cli(file, ['worktree', 'create', '--project', 'proj', '--name', 'dup']).code, 4, 'path exists');

  git(['branch', 'taken'], repo);
  const r = cli(file, ['worktree', 'create', '--project', 'proj', '--name', 'taken']);
  assert.equal(r.code, 4, 'branch exists');
  assert.equal(fs.existsSync(path.join(path.dirname(repo), 'proj-worktrees', 'taken')), false);
});

test('create refuses bad slug', () => {
  const file = registry();
  ok(file, ['projects', 'add', gitRepo()]);
  for (const slug of ['Upper', '-lead', '../escape', 'a/b', 'x'.repeat(64), '']) {
    const r = cli(file, ['worktree', 'create', '--project', 'proj', '--name', slug]);
    assert.equal(r.code, 2, `slug ${JSON.stringify(slug)}`);
  }
  assert.equal(cli(file, ['worktree', 'create', '--project', 'proj']).code, 2, 'missing --name');
});

test('create symlinks node_modules', () => {
  const file = registry();
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, 'vscode'));
  fs.writeFileSync(path.join(repo, 'vscode', 'package.json'), '{}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'vscode'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'vscode', 'node_modules', 'dep2'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'untracked', 'node_modules'), { recursive: true });
  ok(file, ['projects', 'add', repo]);

  const wt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'linked']);
  for (const rel of ['node_modules', path.join('vscode', 'node_modules')]) {
    const dst = path.join(wt.path, rel);
    assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${rel} is a symlink`);
    assert.equal(fs.readlinkSync(dst), path.join(repo, rel));
  }
  assert.equal(fs.existsSync(path.join(wt.path, 'untracked')), false, 'no dirs invented in the worktree');
});

test('remove keeps the branch', () => {
  const file = registry();
  const repo = gitRepo();
  ok(file, ['projects', 'add', repo]);
  const wt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'gone']);
  fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'x\n');
  assert.equal(cli(file, ['worktree', 'remove', '--project', 'proj', '--name', 'gone']).code, 4, 'dirty without --force');
  assert.ok(fs.existsSync(wt.path));

  ok(file, ['worktree', 'remove', '--project', 'proj', '--name', 'gone', '--force']);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(git(['rev-parse', '--verify', 'refs/heads/gone'], repo), wt.head);
  assert.equal(cli(file, ['worktree', 'remove', '--project', 'proj', '--name', 'gone']).code, 2, 'already removed');
});

test('remove project leaves disk untouched', () => {
  const file = registry();
  const repo = gitRepo();
  ok(file, ['projects', 'add', repo]);
  const wt = ok(file, ['worktree', 'create', '--project', 'proj', '--name', 'stay']);
  const removed = ok(file, ['projects', 'remove', 'proj']);
  assert.equal(removed.name, 'proj');
  assert.deepEqual(ok(file, ['projects', 'list']), []);
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));
  assert.ok(fs.existsSync(wt.path));
  assert.equal(git(['rev-parse', '--verify', 'refs/heads/stay'], repo), wt.head);
  assert.equal(cli(file, ['projects', 'remove', 'proj']).code, 2, 'unknown name');
});

test('usage errors exit 2', () => {
  const file = registry();
  assert.equal(cli(file, []).code, 2);
  assert.equal(cli(file, ['projects', 'frob']).code, 2);
  assert.equal(cli(file, ['projects', 'list', '--bogus']).code, 2);
});

function orcaJson(repos, envelope = true) {
  const f = path.join(tmp('vzt-ws-orca-'), 'repos.json');
  fs.writeFileSync(f, JSON.stringify(envelope ? { result: { repos } } : repos));
  return f;
}

test('import from orca adds git repos in order', () => {
  const a = gitRepo('alpha');
  const b = gitRepo('beta');
  const file = registry();
  const src = orcaJson([{ path: b, displayName: 'Beta App', kind: 'git' }, { path: a, displayName: 'alpha' }]);
  const r = ok(file, ['projects', 'import', '--from-orca', '--orca-json', src]);
  assert.deepEqual(r, { added: ['Beta-App', 'alpha'], skipped: [] });
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(reg.projects.map((p) => [p.name, p.root, p.baseRef]), [['Beta-App', b, 'main'], ['alpha', a, 'main']]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // a bare array is accepted too
  const bare = ok(registry(), ['projects', 'import', '--from-orca', '--orca-json', orcaJson([{ path: a, displayName: 'a' }], false)]);
  assert.deepEqual(bare.added, ['a']);
});

test('import from orca is idempotent', () => {
  const a = gitRepo('alpha');
  const file = registry();
  const src = orcaJson([{ path: a, displayName: 'alpha' }]);
  assert.deepEqual(ok(file, ['projects', 'import', '--from-orca', '--orca-json', src]).added, ['alpha']);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(ok(file, ['projects', 'import', '--from-orca', '--orca-json', src]), { added: [], skipped: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('import from orca skips missing and non-git paths', () => {
  const a = gitRepo('alpha');
  const plain = tmp('vzt-ws-plain-');
  const gone = path.join(plain, 'nope');
  const file = registry();
  const src = orcaJson([{ path: gone, displayName: 'gone' }, { path: plain, displayName: 'plain' }, { path: a, displayName: 'alpha' }]);
  const r = ok(file, ['projects', 'import', '--from-orca', '--orca-json', src]);
  assert.deepEqual(r.added, ['alpha']);
  assert.deepEqual(r.skipped.map((s) => s.path), [gone, plain]);
  const bad = path.join(tmp('vzt-ws-orca-'), 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.equal(cli(file, ['projects', 'import', '--from-orca', '--orca-json', bad]).code, 2);
});

test('import from orca sanitizes names', () => {
  const a = gitRepo('one');
  const b = gitRepo('two');
  const c = gitRepo('three');
  const file = registry();
  const long = 'x'.repeat(80);
  const src = orcaJson([
    { path: a, displayName: 'my repo/v2' },
    { path: b, displayName: 'my repo/v2' },
    { path: c, displayName: long },
  ]);
  const r = ok(file, ['projects', 'import', '--from-orca', '--orca-json', src]);
  assert.deepEqual(r.added, ['my-repo-v2', 'my-repo-v2-2', 'x'.repeat(63)]);
});
