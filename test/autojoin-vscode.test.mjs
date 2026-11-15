// Self-joined agents (vscode/src/bus/autojoin.ts): where a claude/codex the
// user started by hand runs, so the window can lease and wake it — and never
// types into anything that is not provably that agent's terminal or pane.
// Imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'vscode', 'out', 'bus');

async function load(name) {
  const file = path.join(OUT, `${name}.js`);
  if (!fs.existsSync(file)) assert.fail(`vscode/out/bus/${name}.js missing — run \`npm --prefix vscode run compile\` before testing`);
  return import(pathToFileURL(file).href);
}

// VS Code's pty host -> terminal shells 100 and 200; codex (150) under shell 100,
// claude (250) under a zsh (240) the user started in shell 200; the private
// tmux server (300) -> pane shell 310 -> claude 320; an unrelated codex (900).
const PS = [
  { pid: 50, ppid: 1, comm: 'Code Helper' },
  { pid: 100, ppid: 50, comm: '-zsh' },
  { pid: 150, ppid: 100, comm: 'codex' },
  { pid: 200, ppid: 50, comm: '-zsh' },
  { pid: 240, ppid: 200, comm: 'zsh' },
  { pid: 250, ppid: 240, comm: 'claude' },
  { pid: 300, ppid: 1, comm: 'tmux' },
  { pid: 310, ppid: 300, comm: '-zsh' },
  { pid: 320, ppid: 310, comm: 'claude' },
  { pid: 900, ppid: 1, comm: 'codex' },
];

test('hostOf: the nearest terminal shell or tmux pane above the agent', async () => {
  const { hostOf, ancestors } = await load('autojoin');
  assert.deepEqual(ancestors(250, PS), [250, 240, 200, 50]);
  const terminals = [100, undefined, 200];
  const panes = new Map([['vzt-sh-1', 310]]);
  assert.deepEqual(hostOf(150, terminals, panes, PS), { terminal: 0, pid: 100 });
  assert.deepEqual(hostOf(250, terminals, panes, PS), { terminal: 2, pid: 200 }, 'through a nested shell');
  assert.deepEqual(hostOf(320, terminals, panes, PS), { session: 'vzt-sh-1', pid: 310 });
  assert.equal(hostOf(900, terminals, panes, PS), undefined, 'another window or app: never ours');
  assert.equal(hostOf(320, terminals, undefined, PS), undefined, 'panes unknown: no tmux host');
});

test('candidates: self-joined, not spawned here, process alive', async () => {
  const { candidates } = await load('autojoin');
  const rows = [
    { agent_id: 'spawned', alias: 'a', kind: 'claude', window_id: 'w', agent_pid: null },
    { agent_id: 'mine', alias: 'b', kind: 'claude', window_id: 'w', agent_pid: 250 },
    { agent_id: 'owned', alias: 'c', kind: 'codex', window_id: 'w', agent_pid: 150 },
    { agent_id: 'dead', alias: 'd', kind: 'codex', window_id: 'w', agent_pid: 777 },
  ];
  const got = candidates(rows, (id) => id === 'owned', (pid) => pid !== 777);
  assert.deepEqual(got.map((r) => r.agent_id), ['mine']);
});

test('processAlive: this process yes, a free pid no', async () => {
  const { processAlive } = await load('autojoin');
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(2 ** 22 + 12345), false);
});
