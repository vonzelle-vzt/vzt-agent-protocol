// VS Code side of agent spawning (u4): spawnAgent + AgentRegistry, driven with a
// fake bus run, createTerminal and launch.
//
// registry.js and spawn.js are imported from the COMPILED extension
// (vscode/out) — run `npm --prefix vscode run compile` first. Both are
// deliberately vscode-free at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(REPO_ROOT, 'vscode');
const OUT = path.join(VSCODE, 'out', 'bus');

async function load(name) {
  const file = path.join(OUT, `${name}.js`);
  if (!fs.existsSync(file)) assert.fail(`vscode/out/bus/${name}.js missing — run \`npm --prefix vscode run compile\` before testing`);
  return import(pathToFileURL(file).href);
}

// Stand-ins for what `bus argv` / `bus bootstrap-prompt` return. The test never
// cares what they are, only that spawn passes them through untouched.
const ARGV = { claude: ['CLAUDE-BIN', '--house-flag'], codex: ['CODEX-BIN', '--house-flag'] };
const promptFor = (alias, peer) => `PROMPT(${alias}${peer ? `,${peer}` : ''})`;

function fakeTerminal(opts) {
  return {
    opts,
    exitStatus: undefined,
    shown: [],
    show(preserveFocus) { this.shown.push(preserveFocus); },
  };
}

async function harness({ trusted = true } = {}) {
  const { spawnAgent } = await load('spawn');
  const { AgentRegistry } = await load('registry');
  const events = [];
  const calls = [];
  let n = 0;
  const run = async (args, cwd) => {
    calls.push({ args, cwd });
    events.push(`run:${args[0]}`);
    switch (args[0]) {
      case 'trust-claude': return { trusted: true };
      case 'register': return { agent_id: `ag-${++n}` };
      case 'argv': return ARGV[args[args.indexOf('--kind') + 1]];
      case 'bootstrap-prompt': {
        const alias = args[args.indexOf('--alias') + 1];
        const peer = args.includes('--peer') ? args[args.indexOf('--peer') + 1] : undefined;
        return { prompt: promptFor(alias, peer) };
      }
      default: throw new Error(`unexpected bus verb ${args[0]}`);
    }
  };
  const terminals = [];
  const launches = [];
  const registry = new AgentRegistry();
  const deps = {
    run,
    createTerminal: (opts) => { events.push('createTerminal'); const t = fakeTerminal(opts); terminals.push(t); return t; },
    launch: (terminal, cmd, label) => { events.push('launch'); launches.push({ terminal, cmd, label }); },
    windowId: 'win-1',
    registry,
    isTrusted: () => trusted,
  };
  return { spawn: (req) => spawnAgent(deps, req), rawRun: run, events, calls, terminals, launches, registry };
}

const shq = (s) => `'${s.replace(/'/g, "'\\''")}'`;

test('spawn registers then launches', async () => {
  const h = await harness();
  const r = await h.spawn({ kind: 'codex', alias: 'codex', cwd: '/p/app' });
  assert.deepEqual(h.events, ['run:register', 'run:argv', 'run:bootstrap-prompt', 'createTerminal', 'launch']);
  const reg = h.calls.find((c) => c.args[0] === 'register');
  assert.deepEqual(reg.args, ['register', '--alias', 'codex', '--kind', 'codex', '--window', 'win-1', '--workspace', '/p/app']);
  assert.equal(reg.cwd, '/p/app');
  assert.equal(r.agent_id, 'ag-1');
  assert.equal(r.terminal, h.terminals[0]);
  assert.equal(h.registry.get('ag-1').terminal, r.terminal, 'registered before launch');
  assert.deepEqual({ alias: h.registry.get('ag-1').alias, cwd: h.registry.get('ag-1').cwd }, { alias: 'codex', cwd: '/p/app' });
  assert.equal(h.launches[0].terminal, r.terminal);
  assert.equal(h.launches[0].cmd, [...ARGV.codex, promptFor('codex')].map(shq).join(' '));
  assert.match(h.launches[0].label, /ag-1/);
});

test('spawn refuses untrusted workspace', async () => {
  const h = await harness({ trusted: false });
  await assert.rejects(h.spawn({ kind: 'claude', alias: 'claude', cwd: '/p/app' }), /trust this workspace/);
  assert.deepEqual(h.calls, [], 'nothing reaches the bus — not even trust-claude');
  assert.deepEqual(h.terminals, []);
  assert.deepEqual(h.launches, []);
  assert.equal(h.registry.size, 0);
});

test('spawn pre-trusts claude only', async () => {
  const h = await harness();
  await h.spawn({ kind: 'claude', alias: 'claude', cwd: '/p/app' });
  assert.deepEqual(h.calls[0], { args: ['trust-claude', '--workspace', '/p/app'], cwd: '/p/app' });
  assert.equal(h.events.indexOf('run:trust-claude'), 0, 'trust before register');

  const c = await harness();
  await c.spawn({ kind: 'codex', alias: 'codex', cwd: '/p/app' });
  assert.ok(!c.calls.some((x) => x.args[0] === 'trust-claude'), 'codex never pre-accepts claude trust');
});

test('spawn names terminal worktree dot alias', async () => {
  const h = await harness();
  await h.spawn({ kind: 'claude', alias: 'fix-login-claude', cwd: '/p/app-worktrees/fix-login' });
  assert.equal(h.terminals[0].opts.name, 'fix-login·fix-login-claude');
  assert.equal(h.terminals[0].opts.cwd, '/p/app-worktrees/fix-login');
  assert.ok(!('location' in h.terminals[0].opts), 'no parentTerminal → no split location');
});

test('spawn env carries bus identity', async () => {
  const h = await harness();
  await h.spawn({ kind: 'claude', alias: 'claude', cwd: '/p/app' });
  await h.spawn({ kind: 'codex', alias: 'codex', cwd: '/p/app' });
  assert.deepEqual(h.terminals[0].opts.env, {
    VZT_BUS_AGENT: 'ag-1', VZT_BUS_KIND: 'claude', VZT_BUS_WINDOW: 'win-1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  });
  assert.deepEqual(h.terminals[1].opts.env, { VZT_BUS_AGENT: 'ag-2', VZT_BUS_KIND: 'codex', VZT_BUS_WINDOW: 'win-1' });
});

test('task is appended to prompt', async () => {
  const h = await harness();
  const task = "fix the login bug — don't touch auth.ts";
  await h.spawn({ kind: 'codex', alias: 'a', cwd: '/p/app', task });
  const prompt = `${promptFor('a')}\n\nYour first task: ${task}`;
  assert.equal(h.launches[0].cmd, [...ARGV.codex, prompt].map(shq).join(' '), 'prompt (quoted) is the final argv word');
  const bp = h.calls.find((c) => c.args[0] === 'bootstrap-prompt');
  assert.ok(!bp.args.includes(task), 'the task is appended locally, never sent as a bus flag');

  const n = await harness();
  await n.spawn({ kind: 'codex', alias: 'a', cwd: '/p/app' });
  assert.ok(!n.launches[0].cmd.includes('Your first task'), 'no task → bare bootstrap prompt');
});

test('three agents across two worktrees', async () => {
  const h = await harness();
  const a = await h.spawn({ kind: 'claude', alias: 'wt-a-claude', cwd: '/p/app-worktrees/wt-a' });
  const b = await h.spawn({ kind: 'codex', alias: 'wt-a-codex', cwd: '/p/app-worktrees/wt-a' });
  const c = await h.spawn({ kind: 'claude', alias: 'wt-b-claude', cwd: '/p/app-worktrees/wt-b' });
  assert.equal(h.registry.size, 3);
  assert.equal(new Set([a.agent_id, b.agent_id, c.agent_id]).size, 3);
  assert.deepEqual(h.terminals.map((t) => t.opts.name), ['wt-a·wt-a-claude', 'wt-a·wt-a-codex', 'wt-b·wt-b-claude']);
  const workspaces = h.calls.filter((x) => x.args[0] === 'register').map((x) => x.args[x.args.indexOf('--workspace') + 1]);
  assert.deepEqual(workspaces, ['/p/app-worktrees/wt-a', '/p/app-worktrees/wt-a', '/p/app-worktrees/wt-b']);
  assert.deepEqual([...h.registry.entries()].map(([id, e]) => [id, e.cwd]), [
    [a.agent_id, '/p/app-worktrees/wt-a'], [b.agent_id, '/p/app-worktrees/wt-a'], [c.agent_id, '/p/app-worktrees/wt-b'],
  ]);
  // Closing one terminal forgets only its agent.
  h.registry.removeTerminal(b.terminal);
  assert.deepEqual([...h.registry.entries()].map(([id]) => id), [a.agent_id, c.agent_id]);
});

test('pair passes peer', async () => {
  const h = await harness();
  const claude = await h.spawn({ kind: 'claude', alias: 'claude', cwd: '/p/app', peer: 'codex' });
  await h.spawn({ kind: 'codex', alias: 'codex', cwd: '/p/app', peer: 'claude', parentTerminal: claude.terminal });
  const bps = h.calls.filter((c) => c.args[0] === 'bootstrap-prompt').map((c) => c.args);
  assert.deepEqual(bps, [
    ['bootstrap-prompt', '--alias', 'claude', '--peer', 'codex'],
    ['bootstrap-prompt', '--alias', 'codex', '--peer', 'claude'],
  ], 'with --peer the CLI returns the byte-identical paired prompt');
  assert.deepEqual(h.terminals[1].opts.location, { parentTerminal: claude.terminal }, 'codex splits beside claude');
  assert.equal(h.terminals[0].opts.name, 'app·claude');

  // A spawn without a peer asks for the multi-agent prompt (no --peer at all).
  const solo = await harness();
  await solo.spawn({ kind: 'claude', alias: 'x', cwd: '/p/app' });
  assert.ok(!solo.calls.find((c) => c.args[0] === 'bootstrap-prompt').args.includes('--peer'));

  // And pair.ts really does wire the peers that way.
  const pair = fs.readFileSync(path.join(VSCODE, 'src', 'bus', 'pair.ts'), 'utf8');
  assert.match(pair, /kind: "claude", alias: alias\.claude, cwd, peer: alias\.codex/);
  assert.match(pair, /peer: alias\.claude,\s+parentTerminal: claude\.terminal/);
});

test('pair in a linked worktree gets worktree-prefixed aliases', async () => {
  const { pairAliases } = await load('spawn');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-pair-'));
  const main = path.join(root, 'app');
  const wt = path.join(root, 'feat-a');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../app/.git/worktrees/feat-a\n');
  assert.deepEqual(pairAliases(main), { claude: 'claude', codex: 'codex' });
  assert.deepEqual(pairAliases(wt), { claude: 'feat-a-claude', codex: 'feat-a-codex' });
  assert.deepEqual(pairAliases(path.join(root, 'missing')), { claude: 'claude', codex: 'codex' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('registry focus false for exited terminal', async () => {
  const { AgentRegistry } = await load('registry');
  const reg = new AgentRegistry();
  const live = fakeTerminal({});
  const dead = fakeTerminal({});
  dead.exitStatus = { code: 0, reason: 1 };
  reg.set('live', { alias: 'a', cwd: '/p', terminal: live });
  reg.set('dead', { alias: 'b', cwd: '/p', terminal: dead });
  assert.equal(reg.focus('live'), true);
  assert.deepEqual(live.shown, [false], 'focus takes keyboard focus (show(false))');
  assert.equal(reg.focus('dead'), false);
  assert.deepEqual(dead.shown, [], 'an exited terminal is never shown');
  assert.equal(reg.focus('nope'), false);
  assert.equal(reg.size, 2);
  assert.equal(reg.delete('dead'), true);
  assert.equal(reg.get('dead'), undefined);
});

test('spawn never hand-writes argv', () => {
  for (const name of ['spawn.ts', 'pair.ts']) {
    const src = fs.readFileSync(path.join(VSCODE, 'src', 'bus', name), 'utf8');
    assert.ok(!src.includes('dangerously'), `${name} hard-codes an agent permission flag — argv comes from \`bus argv\``);
    assert.ok(!src.includes('claude --'), `${name} writes a claude command line — argv comes from \`bus argv\``);
    assert.ok(!src.includes('codex --'), `${name} writes a codex command line — argv comes from \`bus argv\``);
  }
  for (const name of ['spawn.ts', 'registry.ts']) {
    const src = fs.readFileSync(path.join(VSCODE, 'src', 'bus', name), 'utf8');
    assert.ok(!/^import (?!type\b).*from "vscode"/m.test(src), `${name} must import vscode as a type only`);
  }
});

// --- 0.10.0: agents in tmux sessions, alias auto-suffix, plain shells --------

const BIN = '/opt/fake/bin/tmux';
const CONF = '/home/u/.vzt/mux/tmux.conf';

/** spawn deps with a Tmux over a fake exec; `sessions` = names that already exist. */
async function tmuxHarness({ sessions = new Set(), trusted = true, register } = {}) {
  const { Tmux } = await load('tmux');
  const h = await harness({ trusted });
  const tmuxCalls = [];
  const exec = async (file, args) => {
    assert.equal(file, BIN);
    tmuxCalls.push(args);
    h.events.push(`tmux:${args[2] === '-f' ? args[4] : args[2]}`);
    const verb = args[2] === '-f' ? args[4] : args[2];
    if (verb === 'has-session' && !sessions.has(args[4].slice(1))) throw new Error("can't find session");
    if (verb === 'new-session') sessions.add(args[args.indexOf('-s') + 1]);
    if (verb === 'capture-pane') return { stdout: 'user@host app % ' };
    return { stdout: '' };
  };
  const tmux = new Tmux({ bin: BIN, exec, conf: CONF, sleep: async () => {} });
  const logs = [];
  const deps = {
    run: async (args, cwd) => {
      if (args[0] === 'register' && register) return register(args, cwd);
      const r = await h.rawRun(args, cwd);
      return args[0] === 'register' ? { ...r, project: '/p/app' } : r;
    },
    createTerminal: (opts) => { h.events.push('createTerminal'); const t = fakeTerminal(opts); h.terminals.push(t); return t; },
    launch: () => { h.events.push('launch'); },
    windowId: 'win-1',
    registry: h.registry,
    isTrusted: () => trusted,
    tmux,
    projectOf: async (cwd) => `PROJECT(${cwd})`,
    log: (l) => logs.push(l),
  };
  return { ...h, deps, tmux, tmuxCalls, sessions, logs };
}

const settle = async (pred) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r));
};

test('tmux: an agent starts in a detached session vzt-<agent_id>; no terminal until its project is shown', async () => {
  const { spawnAgent } = await load('spawn');
  const h = await tmuxHarness();
  const r = await spawnAgent(h.deps, { kind: 'claude', alias: 'app-claude', cwd: '/p/app' });
  assert.equal(r.terminal, undefined);
  assert.equal(r.project, '/p/app', "the bus's own project answer is cached");
  assert.deepEqual(h.terminals, [], 'no VS Code terminal yet: showProject attaches it');
  assert.ok(!h.events.includes('launch'), 'sendWhenReady is for direct terminals only');

  const entry = h.registry.get(r.agent_id);
  assert.deepEqual({ ...entry }, { alias: 'app-claude', kind: 'claude', cwd: '/p/app', session: `vzt-${r.agent_id}`, project: '/p/app' });

  const created = h.tmuxCalls.find((a) => a.includes('new-session'));
  assert.deepEqual(created, ['-L', 'vzt-mux', '-f', CONF, 'new-session', '-d', '-s', `vzt-${r.agent_id}`, '-c', '/p/app',
    '-e', `VZT_BUS_AGENT=${r.agent_id}`, '-e', 'VZT_BUS_KIND=claude', '-e', 'VZT_BUS_WINDOW=win-1', '-e', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1'],
  'the same env a direct terminal gets');

  // The command — the same quoted words as a direct terminal — is typed into the shell, then Enter.
  await settle(() => h.tmuxCalls.filter((a) => a.includes('send-keys')).length >= 2);
  const keys = h.tmuxCalls.filter((a) => a.includes('send-keys'));
  assert.deepEqual(keys, [
    ['-L', 'vzt-mux', 'send-keys', '-t', `=vzt-${r.agent_id}:`, '-l', '--', [...ARGV.claude, promptFor('app-claude')].map(shq).join(' ')],
    ['-L', 'vzt-mux', 'send-keys', '-t', `=vzt-${r.agent_id}:`, 'Enter'],
  ]);
  const order = h.events.filter((e) => !/^tmux:(capture|send|copy)/.test(e));
  assert.deepEqual(order, ['run:trust-claude', 'run:register', 'tmux:has-session', 'run:argv', 'run:bootstrap-prompt', 'tmux:new-session']);
  await settle(() => h.logs.length > 0);
  assert.match(h.logs[0], /launched bus app-claude/);
});

test('tmux: a session of that name already running IS the agent — kept, nothing typed', async () => {
  const { startAgent } = await load('spawn');
  const h = await tmuxHarness({ sessions: new Set(['vzt-ag-7']) });
  const t = await startAgent(h.deps, { kind: 'codex', alias: 'app-codex', cwd: '/p/app', agent_id: 'ag-7', project: '/p/app' });
  assert.equal(t, undefined);
  assert.equal(h.registry.get('ag-7').session, 'vzt-ag-7');
  assert.ok(!h.tmuxCalls.some((a) => a.includes('new-session') || a.includes('send-keys')));
  assert.deepEqual(h.calls, [], 'no argv asked for either');
});

test('tmux: a project unknown to the CLI answer comes from projectOf', async () => {
  const { startAgent } = await load('spawn');
  const h = await tmuxHarness();
  await startAgent(h.deps, { kind: 'codex', alias: 'x', cwd: '/p/app-wt/feat', agent_id: 'ag-9' });
  assert.equal(h.registry.get('ag-9').project, 'PROJECT(/p/app-wt/feat)');
});

test('alias auto-suffix: retried ONLY on the bus refusing a taken alias', async () => {
  const { spawnAgent, aliasTaken } = await load('spawn');
  const taken = (alias) => Object.assign(new Error(`vzt-agent bus register failed (exit 4): vzt-agent bus register: alias "${alias}" is already used in this project by /p/app-wt/x`), {
    exitCode: 4, stderr: `vzt-agent bus register: alias "${alias}" is already used in this project by /p/app-wt/x\n`,
  });
  const tried = [];
  let n = 0;
  const h = await tmuxHarness({
    register: (args) => {
      const alias = args[args.indexOf('--alias') + 1];
      tried.push(alias);
      if (alias === 'app-claude' || alias === 'app-claude-2') throw taken(alias);
      return { agent_id: `ag-${++n}`, project: '/p/app' };
    },
  });
  const r = await spawnAgent(h.deps, { kind: 'claude', alias: 'app-claude', cwd: '/p/app', autoSuffix: true });
  assert.deepEqual(tried, ['app-claude', 'app-claude-2', 'app-claude-3']);
  assert.equal(r.alias, 'app-claude-3');
  assert.equal(h.registry.get(r.agent_id).alias, 'app-claude-3');

  // An alias this window's own agent holds is skipped without asking: the bus
  // would hand that live agent back ("reused") instead of refusing.
  tried.length = 0;
  const r2 = await spawnAgent(h.deps, { kind: 'claude', alias: 'app-claude', cwd: '/p/app', autoSuffix: true });
  assert.deepEqual(tried, ['app-claude', 'app-claude-2', 'app-claude-4']);
  assert.equal(r2.alias, 'app-claude-4');

  // Any other failure — even exit 4 for something else — is not retried.
  for (const err of [
    Object.assign(new Error('x'), { exitCode: 2, stderr: '--alias must be 1-64 chars' }),
    Object.assign(new Error('x'), { exitCode: 4, stderr: 'agent ag-1 is live in another window (w2)' }),
    Object.assign(new Error('x'), { exitCode: 1, stderr: 'database is locked' }),
  ]) {
    const calls = [];
    const g = await tmuxHarness({ register: (args) => { calls.push(args); throw err; } });
    await assert.rejects(spawnAgent(g.deps, { kind: 'codex', alias: 'app-codex', cwd: '/p/app', autoSuffix: true }), (e) => e === err);
    assert.equal(calls.length, 1, `not retried: ${err.stderr}`);
  }
  assert.equal(aliasTaken(Object.assign(new Error(''), { exitCode: 4, stderr: 'alias "a" is live in another window (w); lease expires in 9s' })), true);
  assert.equal(aliasTaken(Object.assign(new Error(''), { exitCode: 4, stderr: 'alias "a" is registered as kind codex' })), true);

  // Without autoSuffix a taken alias is an error, as before.
  const s = await tmuxHarness({ register: (args) => { throw taken(args[args.indexOf('--alias') + 1]); } });
  await assert.rejects(spawnAgent(s.deps, { kind: 'claude', alias: 'app-claude', cwd: '/p/app' }), /already used/);

  // All nine taken.
  const all = await tmuxHarness({ register: (args) => { throw taken(args[args.indexOf('--alias') + 1]); } });
  await assert.rejects(spawnAgent(all.deps, { kind: 'claude', alias: 'app-claude', cwd: '/p/app', autoSuffix: true }), /app-claude to app-claude-9 is taken/);
});

test('defaultAlias: <folder>-<kind>, made bus-safe, room left for -9', async () => {
  const { defaultAlias, aliasCandidates } = await load('spawn');
  assert.equal(defaultAlias('vzt-orca-flow', 'claude'), 'vzt-orca-flow-claude');
  assert.equal(defaultAlias('My App (v2)', 'codex'), 'My-App-v2-codex');
  assert.equal(defaultAlias('-.hidden', 'codex'), 'hidden-codex');
  assert.equal(defaultAlias('日本', 'claude'), 'agent-claude');
  const long = defaultAlias('x'.repeat(100), 'claude');
  assert.ok(`${long}-9`.length <= 64 && /^[A-Za-z0-9._-]+$/.test(long), long);
  assert.deepEqual(aliasCandidates('a'), ['a', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6', 'a-7', 'a-8', 'a-9']);
});

test('startShell: a plain login shell in its own session; no bus, numbered per folder', async () => {
  const { startShell } = await load('spawn');
  const h = await tmuxHarness();
  const a = await startShell(h.deps, '/p/app');
  const b = await startShell(h.deps, '/p/app');
  assert.match(a, /^vzt-sh-[0-9a-f]{8}$/);
  assert.deepEqual({ ...h.registry.get(a) }, { alias: 'shell', kind: 'shell', cwd: '/p/app', session: a, project: 'PROJECT(/p/app)' });
  assert.equal(h.registry.get(b).alias, 'shell-2');
  assert.deepEqual(h.calls, [], 'a shell never touches the bus');
  assert.deepEqual(h.tmuxCalls.filter((x) => x.includes('new-session'))[0], ['-L', 'vzt-mux', '-f', CONF, 'new-session', '-d', '-s', a, '-c', '/p/app']);
  assert.ok(!h.tmuxCalls.some((x) => x.includes('send-keys')), 'nothing is typed into a shell');
  assert.deepEqual(h.registry.saved().agents, [], 'not a bus agent');

  const u = await tmuxHarness({ trusted: false });
  await assert.rejects(startShell(u.deps, '/p/app'), /trust this workspace/);
  assert.deepEqual(u.tmuxCalls, []);
});

test("projectOf: the bus's rule — the git common dir's main checkout, realpath'd", async () => {
  const { projectOf } = await load('spawn');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-projof-')));
  fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bare.git'));
  const seen = [];
  const exec = (common) => async (file, args) => {
    seen.push([file, ...args]);
    if (common === null) throw new Error('fatal: not a git repository');
    return { stdout: `${common}\n` };
  };
  assert.equal(await projectOf(exec(path.join(root, 'app', '.git')), path.join(root, 'wt')), path.join(root, 'app'));
  assert.deepEqual(seen[0], ['git', '-C', path.join(root, 'wt'), 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  assert.equal(await projectOf(exec(path.join(root, 'bare.git')), root), path.join(root, 'bare.git'), 'a bare repo is its own project');
  assert.equal(await projectOf(exec(null), path.join(root, 'app')), path.join(root, 'app'), 'not git: the folder');
  fs.rmSync(root, { recursive: true, force: true });
});
