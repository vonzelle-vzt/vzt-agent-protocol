// Orca's terminal mouse (right-click pastes, selecting copies), written to the
// user's settings once, only where nothing is set (vscode/src/terminalDefaults.ts).
// As configurationDefaults (0.10.3–0.11.2) they never took effect in the
// user's VS Code: right-click still opened the context menu.
//
// Imported from the COMPILED extension — run `npm --prefix vscode run compile` first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vscode', 'out', 'terminalDefaults.js');

async function load() {
  if (!fs.existsSync(OUT)) assert.fail('vscode/out/terminalDefaults.js missing — run `npm --prefix vscode run compile` before testing');
  return import(pathToFileURL(OUT).href);
}

function fake({ set = {}, applied = false } = {}) {
  const writes = [];
  let marked = applied;
  return {
    writes,
    get marked() { return marked; },
    deps: {
      isSet: (key) => key in set,
      write: async (key, value) => { writes.push([key, value]); },
      applied: () => marked,
      markApplied: async () => { marked = true; },
    },
  };
}

test('first start: both settings written to the user settings, then marked', async () => {
  const { applyTerminalDefaults } = await load();
  const f = fake();
  assert.deepEqual(await applyTerminalDefaults(f.deps), ['terminal.integrated.rightClickBehavior', 'terminal.integrated.copyOnSelection']);
  assert.deepEqual(f.writes, [['terminal.integrated.rightClickBehavior', 'paste'], ['terminal.integrated.copyOnSelection', true]]);
  assert.equal(f.marked, true);
});

test('a setting the user already chose is never overwritten', async () => {
  const { applyTerminalDefaults } = await load();
  const f = fake({ set: { 'terminal.integrated.rightClickBehavior': 'selectWord' } });
  await applyTerminalDefaults(f.deps);
  assert.deepEqual(f.writes, [['terminal.integrated.copyOnSelection', true]]);
});

test('once applied, never again — a user who later removes or changes them keeps their choice', async () => {
  const { applyTerminalDefaults } = await load();
  const f = fake({ applied: true });
  assert.deepEqual(await applyTerminalDefaults(f.deps), []);
  assert.deepEqual(f.writes, []);
});

test('package.json no longer contributes them as configurationDefaults (they did not take effect)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.configurationDefaults, undefined);
  const ext = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(ext, /applyTerminalDefaults\(/);
  assert.match(ext, /ConfigurationTarget\.Global/);
});
