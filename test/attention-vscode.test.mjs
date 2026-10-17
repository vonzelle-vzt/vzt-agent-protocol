// Attention (u5): working → needs-you / done transitions and the needs-you count.
//
// watcher.js is imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. It is deliberately vscode-free so
// plain node can load it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCHER = path.join(REPO_ROOT, 'vscode', 'out', 'attention', 'watcher.js');

async function load() {
  if (!fs.existsSync(WATCHER)) {
    assert.fail('vscode/out/attention/watcher.js missing — run `npm --prefix vscode run compile` before testing');
  }
  return import(pathToFileURL(WATCHER).href);
}

const NOW = 1_800_000_000_000;
const SEC = 1_000;

function agent(over = {}) {
  return {
    agent_id: 'a1',
    workspace: '/r/app',
    project: '/r/app',
    alias: 'claude',
    kind: 'claude',
    state: 'working',
    state_ts_ms: NOW,
    liveness: 'live',
    wake_unconfirmed: false,
    unread: 0,
    window_id: 'w1',
    ...over,
  };
}

test('first sighting never notifies', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  assert.deepEqual(w.update([agent({ state: 'blocked' }), agent({ agent_id: 'a2', state: 'idle' })], NOW), []);
});

test('working to needs-you notifies once', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  assert.deepEqual(w.update([agent()], NOW), []);
  assert.deepEqual(w.update([agent({ state: 'blocked' })], NOW + 2 * SEC), [
    { agent_id: 'a1', alias: 'claude', project: '/r/app', to: 'needs-you' },
  ]);
  assert.deepEqual(w.update([agent({ state: 'blocked' })], NOW + 4 * SEC), []);
});

test('working to done notifies once', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  assert.deepEqual(w.update([agent({ state: 'launching' })], NOW), []);
  assert.deepEqual(w.update([agent({ state: 'working' })], NOW + 2 * SEC), []);
  const done = agent({ state: 'idle', state_ts_ms: NOW + 3 * SEC });
  assert.deepEqual(w.update([done], NOW + 4 * SEC), [
    { agent_id: 'a1', alias: 'claude', project: '/r/app', to: 'done' },
  ]);
  assert.deepEqual(w.update([done], NOW + 6 * SEC), []);
});

test('foreign window never notifies', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  const other = { window_id: 'w2' };
  const none = { agent_id: 'a2', window_id: null };
  w.update([agent(other), agent(none)], NOW);
  assert.deepEqual(w.update([agent({ ...other, state: 'blocked' }), agent({ ...none, state: 'idle' })], NOW + 2 * SEC), []);
});

test('idle to idle is silent', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  const quiet = agent({ state: 'idle', state_ts_ms: NOW - SEC });
  w.update([quiet], NOW);
  assert.deepEqual(w.update([quiet], NOW + 2 * SEC), []);
  // done → needs-you was never "working", so it is silent too
  assert.deepEqual(w.update([agent({ state: 'blocked' })], NOW + 4 * SEC), []);
});

test('needs-you counts all projects', async () => {
  const { needsYou } = await load();
  const agents = [
    agent({ state: 'blocked' }),
    agent({ agent_id: 'a2', project: '/r/other', window_id: 'w2', state: 'blocked' }),
    agent({ agent_id: 'a3', project: '/r/third', window_id: null, state: 'blocked' }),
    agent({ agent_id: 'a4', state: 'working' }),
    agent({ agent_id: 'a5', state: 'blocked', liveness: 'stale' }),
  ];
  assert.equal(needsYou(agents, NOW), 3);
  assert.equal(needsYou([], NOW), 0);
});

test('forgets vanished agents', async () => {
  const { AttentionWatcher } = await load();
  const w = new AttentionWatcher('w1');
  w.update([agent()], NOW);
  w.update([], NOW + 2 * SEC);
  // back again already blocked: a first sighting, not a transition
  assert.deepEqual(w.update([agent({ state: 'blocked' })], NOW + 4 * SEC), []);
});
