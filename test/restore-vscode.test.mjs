// Agent restore after a window reload or restart (restore.ts) and the
// registry's saved form, driven with a fake bus, fake terminals and ps rows.
//
// Imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. Both modules are vscode-free at runtime.

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

const ARGV = { claude: ['CLAUDE-BIN', '--house-flag'], codex: ['CODEX-BIN', '--house-flag'] };
const shq = (s) => `'${s.replace(/'/g, "'\\''")}'`;

function fakeTerminal(name) {
  return {
    name,
    exitStatus: undefined,
    disposed: false,
    dispose() { this.disposed = true; },
  };
}

async function harness({ trusted = true } = {}) {
  const { restoreAgent, adoptSaved } = await load('restore');
  const { AgentRegistry } = await load('registry');
  const calls = [];
  let adoptResult = () => ({});
  const run = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case 'adopt': return adoptResult(args);
      case 'trust-claude': return { trusted: true };
      case 'argv': {
        const kind = args[args.indexOf('--kind') + 1];
        return args.includes('--resume') ? [...ARGV[kind], 'RESUME', args[args.indexOf('--resume') + 1]] : ARGV[kind];
      }
      case 'bootstrap-prompt': return { prompt: `PROMPT(${args[args.indexOf('--alias') + 1]})` };
      default: throw new Error(`unexpected bus verb ${args[0]}`);
    }
  };
  const created = [];
  const launches = [];
  const registry = new AgentRegistry();
  const deps = {
    run,
    createTerminal: (opts) => { const t = { ...fakeTerminal(opts.name), opts }; created.push(t); return t; },
    launch: (terminal, cmd) => launches.push({ terminal, cmd }),
    windowId: 'win-new',
    registry,
    isTrusted: () => trusted,
  };
  return {
    restore: (saved, adopted, terms, ps) => restoreAgent(deps, saved, adopted, terms, ps),
    adopt: (saved, from, result) => { adoptResult = result; return adoptSaved(deps, saved, from); },
    calls, created, launches, registry,
  };
}

const SAVED = { agent_id: 'ag-1', alias: 'feat-claude', kind: 'claude', cwd: '/p/app-worktrees/feat' };
const NAME = 'feat·feat-claude';
const ADOPTED = { agent_id: 'ag-1', session_id: 'sess-1', terminal_pid: 100 };
const SHELL_WITH_AGENT = [{ pid: 100, ppid: 1, comm: '-zsh' }, { pid: 101, ppid: 100, comm: '/opt/node' }];

test('parsePs, hasChildren and shellAlive', async () => {
  const { parsePs, hasChildren, shellAlive } = await load('restore');
  const rows = parsePs('  100     1 -zsh\n  200   100 node\n  300     1 /usr/bin/python3\n  301   300 x\nnoise\n');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { pid: 200, ppid: 100, comm: 'node' });
  assert.equal(hasChildren(100, rows), true);
  assert.equal(hasChildren(200, rows), false);
  assert.equal(shellAlive(100, rows), true, 'a login shell with a child');
  assert.equal(shellAlive(300, rows), false, 'a reused pid that is not a shell');
  assert.equal(shellAlive(200, rows), false);
  assert.equal(shellAlive(null, rows), false);
});

test('adoptSaved names the old window and sorts failures: 2 gone, 4 elsewhere, others throw', async () => {
  const h = await harness();
  const fail = (exitCode) => () => { throw Object.assign(new Error('x'), { exitCode }); };
  assert.deepEqual(await h.adopt(SAVED, 'win-old', () => ADOPTED), ADOPTED);
  assert.deepEqual(h.calls[0], ['adopt', '--agent', 'ag-1', '--window', 'win-new', '--from-window', 'win-old']);
  assert.equal(await h.adopt(SAVED, 'win-old', fail(2)), 'gone');
  assert.equal(await h.adopt(SAVED, 'win-old', fail(4)), 'elsewhere');
  await assert.rejects(h.adopt(SAVED, 'win-old', fail(1)), 'a transient failure must not drop the agent');
});

test('a reload keeps the terminal: the one with the leased shell pid is adopted, nothing typed', async () => {
  const h = await harness();
  const mine = fakeTerminal(NAME);
  const impostor = fakeTerminal(NAME); // same name, someone else's shell
  const terms = [{ terminal: impostor, pid: 555 }, { terminal: mine, pid: 100 }];
  const ps = [...SHELL_WITH_AGENT, { pid: 555, ppid: 1, comm: 'zsh' }, { pid: 556, ppid: 555, comm: 'claude' }];
  assert.equal(await h.restore(SAVED, ADOPTED, terms, ps), 'adopted');
  assert.equal(h.registry.get('ag-1').terminal, mine, 'matched by pid, not by name');
  assert.equal(mine.disposed || impostor.disposed, false);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.launches, []);
});

test('the old shell is alive but its terminal has not shown up: nothing launches', async () => {
  const h = await harness();
  assert.equal(await h.restore(SAVED, ADOPTED, [], SHELL_WITH_AGENT), 'waiting');
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.launches, []);
});

test('a restart leaves a revived bare shell: the session resumes, then the shell is closed', async () => {
  const h = await harness();
  const revived = fakeTerminal(NAME);
  const busy = fakeTerminal(NAME);
  const terms = [{ terminal: revived, pid: 700 }, { terminal: busy, pid: 800 }];
  const ps = [{ pid: 700, ppid: 1, comm: 'zsh' }, { pid: 800, ppid: 1, comm: 'zsh' }, { pid: 801, ppid: 800, comm: 'vim' }];
  assert.equal(await h.restore(SAVED, ADOPTED, terms, ps), 'resumed');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].opts.name, NAME);
  assert.equal(h.created[0].opts.env.VZT_BUS_AGENT, 'ag-1');
  assert.deepEqual(h.calls.map((c) => c[0]), ['trust-claude', 'argv']);
  assert.equal(h.launches[0].cmd, [...ARGV.claude, 'RESUME', 'sess-1'].map(shq).join(' '), 'no bootstrap prompt on resume');
  assert.equal(revived.disposed, true);
  assert.equal(busy.disposed, false, 'never close a terminal with something running in it');
  assert.equal(h.registry.get('ag-1').terminal, h.created[0]);
});

test('the agent exited in its own terminal: relaunch, then close that terminal', async () => {
  const h = await harness();
  const own = fakeTerminal(NAME);
  const r = await h.restore({ ...SAVED, kind: 'codex', alias: 'feat-codex' }, { ...ADOPTED, session_id: null },
    [{ terminal: own, pid: 100 }], [{ pid: 100, ppid: 1, comm: 'zsh' }]);
  assert.equal(r, 'relaunched');
  assert.deepEqual(h.calls.map((c) => c[0]), ['argv', 'bootstrap-prompt']);
  assert.equal(h.launches[0].cmd, [...ARGV.codex, 'PROMPT(feat-codex)'].map(shq).join(' '));
  assert.equal(own.disposed, true);
});

test('a failed launch closes nothing; an untrusted window launches nothing', async () => {
  const h = await harness({ trusted: false });
  const revived = fakeTerminal(NAME);
  await assert.rejects(h.restore(SAVED, ADOPTED, [{ terminal: revived, pid: 700 }], [{ pid: 700, ppid: 1, comm: 'zsh' }]), /trust this workspace/);
  assert.equal(revived.disposed, false);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.launches, []);
});

test('the registry reports its saved form on every change, terminals left out', async () => {
  const { AgentRegistry } = await load('registry');
  const saves = [];
  const reg = new AgentRegistry((s) => saves.push(s));
  const t = { exitStatus: undefined };
  reg.set('a', { alias: 'x', kind: 'codex', cwd: '/w', terminal: t });
  assert.deepEqual(saves.at(-1), [{ agent_id: 'a', alias: 'x', kind: 'codex', cwd: '/w' }]);
  reg.removeTerminal({});
  assert.equal(saves.length, 1, 'removing an unknown terminal is not a change');
  reg.removeTerminal(t);
  assert.deepEqual(saves.at(-1), []);
});
