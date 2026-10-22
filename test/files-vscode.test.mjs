// Files view (0.12): the active project's directory listing — folders first,
// .git and files.exclude hidden, never throws, never follows a symlink loop.
//
// files.js is imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. It is vscode-free so plain node can
// load it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(REPO_ROOT, 'vscode', 'out', 'projects', 'files.js');

async function load() {
  if (!fs.existsSync(FILE)) {
    assert.fail('vscode/out/projects/files.js missing — run `npm --prefix vscode run compile` before testing');
  }
  return import(pathToFileURL(FILE).href);
}

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-files-'));
  for (const d of ['.git', 'src', 'Docs', 'node_modules', 'src/deep']) fs.mkdirSync(path.join(root, d));
  for (const f of ['b.txt', 'A.md', '.DS_Store', 'src/x.ts', 'src/x.js', 'src/deep/y.ts']) fs.writeFileSync(path.join(root, f), '');
  return root;
}

const names = (listing) => listing.entries.map((e) => e.name);

test('folders first, each group sorted case-insensitively; .git always hidden', async () => {
  const { listDir } = await load();
  const root = tree();
  const l = listDir(root, root, []);
  assert.equal(l.error, undefined);
  assert.deepEqual(names(l), ['Docs', 'node_modules', 'src', '.DS_Store', 'A.md', 'b.txt']);
  assert.deepEqual(l.entries.slice(0, 3).map((e) => e.dir), [true, true, true]);
});

test('files.exclude globs hide matches at any depth; false and `when` entries do not', async () => {
  const { listDir, excludeGlobs } = await load();
  const root = tree();
  const exclude = excludeGlobs({
    '**/node_modules': true,
    '**/.DS_Store': true,
    '**/*.js': true,
    'Docs': false,
    '**/*.ts': { when: '$(basename).js' },
  });
  assert.deepEqual(names(listDir(root, root, exclude)), ['Docs', 'src', 'A.md', 'b.txt']);
  assert.deepEqual(names(listDir(path.join(root, 'src'), root, exclude)), ['deep', 'x.ts']);
});

test('globToRegExp: ** spans folders, * and ? stay inside one segment, dots are literal', async () => {
  const { globToRegExp } = await load();
  assert.ok(globToRegExp('**/node_modules').test('node_modules'));
  assert.ok(globToRegExp('**/node_modules').test('a/b/node_modules'));
  assert.ok(!globToRegExp('*.js').test('src/x.js'));
  assert.ok(globToRegExp('src/?.ts').test('src/x.ts'));
  assert.ok(!globToRegExp('*.js').test('xjs'));
  assert.ok(globToRegExp('out/**').test('out/a/b'));
});

test('globToRegExp: {a,b} alternation, [abc]/[!abc] classes and a trailing /** that hides the folder too', async () => {
  const { globToRegExp } = await load();
  const ext = globToRegExp('**/*.{pyc,map}');
  assert.ok(ext.test('a/b.pyc') && ext.test('c.map') && !ext.test('c.js'));
  const dirs = globToRegExp('**/{dist,build}');
  assert.ok(dirs.test('dist') && dirs.test('pkg/build') && !dirs.test('src'));
  assert.ok(globToRegExp('[ab].txt').test('a.txt') && !globToRegExp('[ab].txt').test('c.txt'));
  assert.ok(globToRegExp('[!ab].txt').test('c.txt') && !globToRegExp('[!ab].txt').test('a.txt'));
  const tail = globToRegExp('**/coverage/**');
  assert.ok(tail.test('coverage') && tail.test('pkg/coverage/x.html') && !tail.test('coveragex'));
  assert.equal(globToRegExp('[').test('['), true); // an unclosed [ is a literal, never a throw
});

test('an unreadable or missing folder returns [] with an error, never throws', async () => {
  const { listDir } = await load();
  const root = tree();
  const missing = listDir(path.join(root, 'nope'), root, []);
  assert.deepEqual(missing.entries, []);
  assert.ok(missing.error);
  if (process.getuid && process.getuid() !== 0) {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const l = listDir(locked, root, []);
      assert.deepEqual(l.entries, []);
      assert.ok(l.error);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  }
});

test('a symlink to a folder is listed as a file, so a loop never recurses', async () => {
  const { listDir } = await load();
  const root = tree();
  fs.symlinkSync(root, path.join(root, 'loop'));
  const loop = listDir(root, root, []).entries.find((e) => e.name === 'loop');
  assert.ok(loop);
  assert.equal(loop.symlink, true);
  assert.equal(loop.dir, false);
});
