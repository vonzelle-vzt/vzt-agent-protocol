// Workspace file builder (pick projects → .code-workspace). workspaceFile.js is
// imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. It is vscode-free so plain node loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(REPO_ROOT, 'vscode');

async function load(name) {
  const file = path.join(VSCODE, 'out', 'projects', `${name}.js`);
  if (!fs.existsSync(file)) {
    assert.fail(`vscode/out/projects/${name}.js missing — run \`npm --prefix vscode run compile\` before testing`);
  }
  return import(pathToFileURL(file).href);
}

const P = (name, root) => ({ name, root });

test('order of picked is kept', async () => {
  const { buildWorkspace } = await load('workspaceFile');
  const ws = buildWorkspace([P('b', '/r/b'), P('a', '/r/a'), P('c', '/r/c')]);
  assert.deepEqual(ws.folders, [
    { name: 'b', path: '/r/b' },
    { name: 'a', path: '/r/a' },
    { name: 'c', path: '/r/c' },
  ]);
});

test('dedupes by path, first wins', async () => {
  const { buildWorkspace } = await load('workspaceFile');
  const ws = buildWorkspace([P('one', '/r/a'), P('b', '/r/b'), P('two', '/r/a')]);
  assert.deepEqual(ws.folders, [
    { name: 'one', path: '/r/a' },
    { name: 'b', path: '/r/b' },
  ]);
});

test('default settings without an existing workspace', async () => {
  const { buildWorkspace } = await load('workspaceFile');
  assert.deepEqual(buildWorkspace([]).settings, { 'git.autoRepositoryDetection': 'openEditors' });
});

test('existing settings and other keys survive, folders are replaced', async () => {
  const { buildWorkspace } = await load('workspaceFile');
  const existing = {
    folders: [{ path: '/old' }],
    settings: { 'editor.fontSize': 15 },
    extensions: { recommendations: ['a.b'] },
    launch: { version: '0.2.0' },
  };
  const ws = buildWorkspace([P('a', '/r/a')], existing);
  assert.deepEqual(ws.folders, [{ name: 'a', path: '/r/a' }]);
  assert.deepEqual(ws.settings, { 'editor.fontSize': 15 });
  assert.deepEqual(ws.extensions, { recommendations: ['a.b'] });
  assert.deepEqual(ws.launch, { version: '0.2.0' });
  assert.deepEqual(existing.folders, [{ path: '/old' }], 'input not mutated');
});

test('non-object existing falls back to defaults', async () => {
  const { buildWorkspace } = await load('workspaceFile');
  for (const bad of [null, 'x', 7, [1]]) {
    assert.deepEqual(buildWorkspace([], bad).settings, { 'git.autoRepositoryDetection': 'openEditors' });
  }
});

test('workspaceFilePath joins and validates the name', async () => {
  const { workspaceFilePath } = await load('workspaceFile');
  assert.equal(workspaceFilePath('/base', 'orca'), '/base/orca.code-workspace');
  assert.equal(workspaceFilePath('/base', 'my ws-1.x_y'), '/base/my ws-1.x_y.code-workspace');
  assert.equal(workspaceFilePath('/base', 'a'.repeat(64)), `/base/${'a'.repeat(64)}.code-workspace`);
  for (const bad of ['../x', '', '-x', 'a'.repeat(65), 'a/b', '.hidden']) {
    assert.throws(() => workspaceFilePath('/base', bad), /invalid workspace name/, JSON.stringify(bad));
  }
});

test('writeWorkspaceFile writes valid JSON atomically, creating parents', async () => {
  const { writeWorkspaceFile } = await load('workspaceFile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-ws-'));
  const file = path.join(dir, 'deep', 'er', 'orca.code-workspace');
  writeWorkspaceFile(file, { folders: [{ name: 'a', path: '/r/a' }], settings: {} });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n  "folders"'));
  assert.deepEqual(JSON.parse(text).folders, [{ name: 'a', path: '/r/a' }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644 & ~process.umask());
  writeWorkspaceFile(file, { folders: [], settings: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).folders, []);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['orca.code-workspace'], 'no tmp left behind');
});
