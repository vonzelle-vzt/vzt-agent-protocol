// claudeIdePort (vscode/src/bus/ide.ts): which ~/.claude/ide/<port>.lock a
// tmux-hosted claude connects to. Imported from the COMPILED extension — run
// `npm --prefix vscode run compile` first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vscode', 'out', 'bus');
const { claudeIdePort } = await import(pathToFileURL(path.join(OUT, 'ide.js')).href);

function lockDir(locks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-ide-'));
  for (const [port, body] of Object.entries(locks)) {
    fs.writeFileSync(path.join(dir, `${port}.lock`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const lock = (pid, folders) => ({ pid, workspaceFolders: folders, ideName: 'Visual Studio Code', transport: 'ws', authToken: 'x' });
const LIVE = new Set([100, 200]);
const isAlive = (pid) => LIVE.has(pid);

test("the window's own lock: exactly its folders, in any order", () => {
  const dir = lockDir({ 1111: lock(100, ['/p/a', '/p/b']), 2222: lock(100, ['/p/a']) });
  assert.equal(claudeIdePort(dir, ['/p/b', '/p/a'], '/p/a', isAlive), '1111');
  assert.equal(claudeIdePort(dir, ['/p/a'], '/p/a', isAlive), '2222');
});

test('no exact window match: the only lock with a folder holding cwd', () => {
  const dir = lockDir({ 1111: lock(100, ['/p/a']), 2222: lock(200, ['/p/b']) });
  assert.equal(claudeIdePort(dir, [], '/p/b/src', isAlive), '2222');
  assert.equal(claudeIdePort(dir, [], '/p/bb', isAlive), undefined, 'a sibling with a shared prefix is not inside');
});

test('ambiguous or nothing: undefined, never a guessed window', () => {
  const dir = lockDir({ 1111: lock(100, ['/p']), 2222: lock(200, ['/p/a']) });
  assert.equal(claudeIdePort(dir, [], '/p/a', isAlive), undefined);
  assert.equal(claudeIdePort(path.join(dir, 'missing'), ['/p'], '/p', isAlive), undefined);
});

test('dead pids and unreadable files are skipped', () => {
  const dir = lockDir({ 1111: lock(999, ['/p/a']), 2222: '{half', 3333: lock(100, ['/p/a']), 'x': lock(100, ['/p/a']) });
  assert.equal(claudeIdePort(dir, ['/p/a'], '/p/a', isAlive), '3333');
});
