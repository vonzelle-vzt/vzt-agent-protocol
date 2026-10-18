// tmux-backed project swap (vzt-mux 0.10.0): every tmux argv (tmux.ts), the
// registry with detached entries, showProject, terminal close handling and the
// poller's lease plan (registry.ts). Contract: .vzt/ship/vscode-project-swap/SPEC.md.
//
// Imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. Both modules are vscode-free at
// runtime; tmux is a fake exec here (test/live/tmux-swap-live.mjs runs the real one).

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

const BIN = '/opt/fake/bin/tmux';
const CONF = '/home/u/.vzt/mux/tmux.conf';

/** A fake exec: records every call, answers by tmux verb (the word after -L/-f). */
function fakeExec(answer = () => ({ stdout: '' })) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    let i = 0;
    while (args[i] === '-L' || args[i] === '-f') i += 2;
    const r = await answer(args[i], args.slice(i), args);
    return r ?? { stdout: '' };
  };
  return { exec, calls };
}

const noServer = () => { throw Object.assign(new Error('tmux: no server running on /tmp/tmux-501/vzt-mux'), { stderr: 'no server running on /tmp/tmux-501/vzt-mux\n' }); };

async function makeTmux(answer, extra = {}) {
  const { Tmux } = await load('tmux');
  const f = fakeExec(answer);
  const sleeps = [];
  const tmux = new Tmux({ bin: BIN, exec: f.exec, conf: CONF, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  return { tmux, calls: f.calls, sleeps };
}

const argvs = (calls) => calls.map((c) => c.args);
const LEAVE_MODE = (s) => ['-L', 'vzt-mux', 'copy-mode', '-q', '-t', `=${s}:`];
/** The calls minus the copy-mode exits that precede typing (asserted on their own below). */
const typing = (calls) => argvs(calls).filter((a) => a[2] !== 'copy-mode');

// --- tmux.ts: argv ----------------------------------------------------------

test('every call targets the private server; -f only where a server can start', async () => {
  const { tmux, calls } = await makeTmux();
  await tmux.newSession('vzt-a1', '/p/app', { VZT_BUS_AGENT: 'a1', VZT_BUS_KIND: 'claude', SPACED: 'a b=c' });
  await tmux.hasSession('vzt-a1');
  await tmux.killSession('vzt-a1');
  await tmux.sendEnter('vzt-a1');
  await tmux.capture('vzt-a1');
  assert.ok(calls.every((c) => c.file === BIN), 'the resolved binary, never a bare "tmux"');
  assert.deepEqual(argvs(calls), [
    ['-L', 'vzt-mux', '-f', CONF, 'new-session', '-d', '-s', 'vzt-a1', '-c', '/p/app',
      '-e', 'VZT_BUS_AGENT=a1', '-e', 'VZT_BUS_KIND=claude', '-e', 'SPACED=a b=c'],
    ['-L', 'vzt-mux', 'has-session', '-t', '=vzt-a1'],
    ['-L', 'vzt-mux', 'kill-session', '-t', '=vzt-a1'],
    LEAVE_MODE('vzt-a1'),
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', 'Enter'],
    ['-L', 'vzt-mux', 'capture-pane', '-p', '-t', '=vzt-a1:'],
  ]);
  assert.deepEqual(tmux.attachOptions('vzt-a1'), {
    shellPath: BIN,
    // attach-session can start a server ("no sessions"), so it carries -f too.
    shellArgs: ['-L', 'vzt-mux', '-f', CONF, 'attach-session', '-t', '=vzt-a1'],
    env: { TMUX: null, TMUX_PANE: null },
  });
});

test('a test socket name replaces vzt-mux everywhere', async () => {
  const { tmux, calls } = await makeTmux(undefined, { socket: 'vzt-mux-test-1' });
  await tmux.newSession('s', '/p', {});
  await tmux.hasSession('s');
  assert.ok(argvs(calls).every((a) => a[0] === '-L' && a[1] === 'vzt-mux-test-1'));
  assert.equal(tmux.attachOptions('s').shellArgs[1], 'vzt-mux-test-1');
  const { Tmux, SOCKET } = await load('tmux');
  assert.equal(SOCKET, 'vzt-mux');
  assert.equal(new Tmux({ bin: BIN, exec: async () => ({ stdout: '' }), conf: CONF }).socket, 'vzt-mux', 'default socket');
});

test('send-keys is literal, after --, and Enter is its own key', async () => {
  const { tmux, calls } = await makeTmux();
  await tmux.sendText('vzt-a1', "-n 'quoted' $HOME #{pane_pid}");
  await tmux.sendEnter('vzt-a1');
  assert.deepEqual(argvs(calls), [
    LEAVE_MODE('vzt-a1'),
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', '-l', '--', "-n 'quoted' $HOME #{pane_pid}"],
    LEAVE_MODE('vzt-a1'),
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', 'Enter'],
  ]);
});

test('typing first leaves copy-mode: keys sent to a scrolled-up pane would never reach the agent', async () => {
  const { tmux, calls } = await makeTmux();
  await tmux.sendText('s', 'x'.repeat(10_000)); // several chunks: one exit, before the first
  assert.deepEqual(calls[0].args, LEAVE_MODE('s'));
  assert.equal(argvs(calls).filter((a) => a[2] === 'copy-mode').length, 1);
  calls.length = 0;
  await tmux.sendText('s', '');
  assert.deepEqual(calls, [], 'nothing to type, nothing sent');
  const sink = tmux.sink('s');
  sink.sendText('line', false);
  sink.sendText('\r', false);
  await sink.done();
  assert.deepEqual(argvs(calls).map((a) => a[2]), ['copy-mode', 'send-keys', 'copy-mode', 'send-keys'],
    'the wake Enter 400 ms later leaves a mode entered meanwhile, too');
});

test('a trailing semicolon goes as a hex key: tmux would eat it as a command separator', async () => {
  const { tmux, calls } = await makeTmux();
  await tmux.sendText('s', 'a;b;;');
  await tmux.sendText('s', ';');
  assert.deepEqual(typing(calls), [
    ['-L', 'vzt-mux', 'send-keys', '-t', '=s:', '-l', '--', 'a;b'],
    ['-L', 'vzt-mux', 'send-keys', '-t', '=s:', '-H', '3b', '3b'],
    ['-L', 'vzt-mux', 'send-keys', '-t', '=s:', '-H', '3b'],
  ]);
  for (const c of calls) {
    const last = c.args.at(-1);
    assert.ok(!last.endsWith(';'), `no argument may end in ";": ${last}`);
  }
});

test('long text is chunked under the byte budget, never inside a code point', async () => {
  const { literalChunks, CHUNK_BYTES } = await load('tmux');
  const text = 'x'.repeat(CHUNK_BYTES - 1) + '🙂' + 'é'.repeat(3000) + 'tail';
  const chunks = literalChunks(text);
  assert.equal(chunks.join(''), text, 'lossless');
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= CHUNK_BYTES, `chunk of ${Buffer.byteLength(c)} bytes`);
  assert.ok(!chunks[0].includes('🙂'), 'the emoji did not fit: it starts the next chunk whole');
  assert.ok(chunks[1].startsWith('🙂'));
  assert.deepEqual(literalChunks(''), []);

  const { tmux, calls } = await makeTmux();
  await tmux.sendText('s', 'y'.repeat(CHUNK_BYTES * 2 + 5));
  const sends = typing(calls);
  assert.equal(sends.length, 3);
  assert.ok(sends.every((a) => a.length === 8 && a[5] === '-l'));
});

test('hasSession: true on exit 0, false on any failure', async () => {
  let live = true;
  const { tmux } = await makeTmux((verb) => { if (verb === 'has-session' && !live) throw new Error("can't find session"); });
  assert.equal(await tmux.hasSession('s'), true);
  live = false;
  assert.equal(await tmux.hasSession('s'), false);
});

test('pane pids: display-message for one, list-panes for all; a stopped server has none', async () => {
  let mode = 'ok';
  const { tmux, calls } = await makeTmux((verb) => {
    if (verb === 'display-message') return { stdout: '4242\n' };
    if (verb === 'list-panes') {
      if (mode === 'none') noServer();
      if (mode === 'broken') throw Object.assign(new Error('tmux: protocol version mismatch'), { stderr: 'protocol version mismatch' });
      return { stdout: 'vzt-a1\t100\nvzt-a1\t101\nvzt-sh-0f\t200\n\ngarbage\n' };
    }
  });
  assert.equal(await tmux.panePid('vzt-a1'), 4242);
  assert.deepEqual(calls[0].args, ['-L', 'vzt-mux', 'display-message', '-p', '-t', '=vzt-a1:', '#{pane_pid}']);
  const pids = await tmux.panePids();
  assert.deepEqual([...pids], [['vzt-a1', 100], ['vzt-sh-0f', 200]], "a session's FIRST pane is the agent's");
  assert.deepEqual(calls[1].args, ['-L', 'vzt-mux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']);
  mode = 'none';
  assert.deepEqual([...(await tmux.panePids())], []);
  mode = 'broken';
  await assert.rejects(tmux.panePids(), /protocol version mismatch/, 'an unknown failure is not "no sessions"');
});

test('launch waits for the shell to draw, then types the command and Enter', async () => {
  let polls = 0;
  const { tmux, calls, sleeps } = await makeTmux((verb) => {
    if (verb === 'capture-pane') return { stdout: ++polls < 3 ? '\n\n' : 'user@host app % \n' };
  });
  await tmux.launch('vzt-a1', "'CLAUDE-BIN' 'PROMPT'");
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [100, 100]);
  assert.deepEqual(typing(calls).slice(-2), [
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', '-l', '--', "'CLAUDE-BIN' 'PROMPT'"],
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', 'Enter'],
  ]);

  // A shell that never draws still gets its command once the polls run out.
  const blank = await makeTmux((verb) => (verb === 'capture-pane' ? { stdout: '' } : undefined));
  await blank.tmux.launch('s', 'cmd', 4, 10);
  assert.deepEqual(blank.sleeps, [10, 10, 10, 10]);
  assert.equal(blank.calls.filter((c) => c.args.includes('send-keys')).length, 2);
});

test('the wake sink types the line, then Enter for "\\r", in order; a failure rejects done()', async () => {
  const { executeWakeAction } = await load('wake');
  const { tmux, calls } = await makeTmux();
  const sink = tmux.sink('vzt-a1');
  const LINE = 'vzt: new bus message';
  const typed = await executeWakeAction({ agent_id: 'a1', alias: 'codex', action: 'wake', line: LINE, attempt_id: 'w1' }, sink, async () => {});
  assert.equal(typed, true);
  await sink.done();
  assert.deepEqual(typing(calls), [
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', '-l', '--', LINE],
    ['-L', 'vzt-mux', 'send-keys', '-t', '=vzt-a1:', 'Enter'],
  ], 'line WITHOUT a newline, then a separate Enter (Codex paste-burst rule)');

  const failing = await makeTmux((verb) => { if (verb === 'send-keys') throw new Error("can't find pane"); });
  const bad = failing.tmux.sink('gone');
  bad.sendText('x', false);
  bad.sendText('\r', false);
  await assert.rejects(bad.done(), /can't find pane/);
  assert.deepEqual(typing(failing.calls).length, 1, 'the Enter after a failed line is never sent');
});

test('session names: vzt-<agent_id>, vzt-sh-<random>; tmux-unsafe characters replaced', async () => {
  const { agentSession, shellSession } = await load('tmux');
  assert.equal(agentSession('3f2a-11'), 'vzt-3f2a-11');
  assert.equal(agentSession('a.b:c'), 'vzt-a_b_c', 'tmux rewrites . and : — the name must match its =target');
  assert.match(shellSession(), /^vzt-sh-[0-9a-f]{8}$/);
  assert.notEqual(shellSession(), shellSession());
  assert.equal(shellSession(() => 'abc'), 'vzt-sh-abc');
});

test('the config: listed options, pbcopy copy on macOS only, written atomically', async () => {
  const { confText, writeConf, defaultConfPath } = await load('tmux');
  const mac = confText('darwin');
  for (const line of [
    'set -g mouse on', 'set -g status off', 'set -g history-limit 50000', 'set -s escape-time 0',
    'set -g default-terminal "tmux-256color"', 'set -g window-size latest', 'set -s set-clipboard on',
    'set -as terminal-features ",xterm-256color:RGB"', 'set -as terminal-features ",tmux-256color:RGB"', 'set-environment -g COLORTERM truecolor',
    'set -g prefix None', 'unbind-key C-b', 'unbind-key -n MouseDown3Pane',
    'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
    'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
  ]) assert.ok(mac.split('\n').includes(line), `missing: ${line}`);
  assert.ok(!confText('linux').includes('pbcopy'));
  assert.equal(defaultConfPath('/home/u'), '/home/u/.vzt/mux/tmux.conf');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-tmux-conf-'));
  const file = path.join(dir, 'mux', 'tmux.conf');
  writeConf(file, 'darwin');
  writeConf(file, 'darwin'); // rewritten on every activation
  assert.equal(fs.readFileSync(file, 'utf8'), mac);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tmux.conf'], 'no tmp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findTmux: PATH first, then /opt/homebrew/bin and /usr/local/bin; null when absent', async () => {
  const { findTmux } = await load('tmux');
  const has = (set) => (f) => set.has(f);
  assert.equal(findTmux('/usr/bin:/custom/bin', has(new Set(['/custom/bin/tmux', '/opt/homebrew/bin/tmux']))), '/custom/bin/tmux');
  assert.equal(findTmux('/usr/bin:/bin', has(new Set(['/opt/homebrew/bin/tmux']))), '/opt/homebrew/bin/tmux', "launchd's bare PATH");
  assert.equal(findTmux('', has(new Set(['/usr/local/bin/tmux']))), '/usr/local/bin/tmux');
  assert.equal(findTmux('/usr/bin', has(new Set())), null);
});

test('only tmux.ts builds a tmux argv', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(VSCODE, 'src'));
  const offenders = files.filter((f) => /"-L"|'-L'|"attach-session"|"send-keys"|"new-session"|"kill-session"/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(VSCODE, f)), ['src/bus/tmux.ts']);
  for (const name of ['tmux.ts', 'registry.ts', 'restore.ts', 'spawn.ts']) {
    const src = fs.readFileSync(path.join(VSCODE, 'src', 'bus', name), 'utf8');
    assert.ok(!/^import (?!type\b).*from "vscode"/m.test(src), `${name} must import vscode as a type only`);
  }
  assert.ok(!/from "child_process"|require\("child_process"\)/.test(fs.readFileSync(path.join(VSCODE, 'src', 'bus', 'tmux.ts'), 'utf8')),
    'tmux.ts runs nothing itself: exec is injected');
});

// --- registry.ts: detached entries, showProject, closing ----------------------

function fakeTerminal(opts = {}) {
  return {
    opts,
    name: opts.name,
    exitStatus: undefined,
    disposed: false,
    shown: [],
    processId: opts.pid,
    dispose() { this.disposed = true; },
    show(preserveFocus) { this.shown.push(preserveFocus); },
  };
}

/**
 * A fake tmux server for the swap: agent sessions are alive per `live`; layout
 * sessions keep their panes (session → pane id) the way the real one does.
 */
async function swapHarness({ live = () => true, tmuxPresent = true, editorColumn, layouts = new Map(), raceNewLayout = false } = {}) {
  const { AgentRegistry } = await load('registry');
  let nextPane = 1;
  const owner = new Map(); // pane id → layout
  const newPane = (layout) => { const pane = `%${nextPane++}`; owner.set(pane, layout); return { stdout: `${pane}\n` }; };
  const { tmux, calls } = await makeTmux((verb, rest) => {
    const t = rest[rest.indexOf('-t') + 1];
    if (verb === 'has-session' && !live(t.slice(1))) throw new Error("can't find session");
    if (verb === 'list-panes' && rest.includes('-s')) {
      const panes = layouts.get(t.slice(1));
      if (!panes) throw new Error(`can't find session: ${t.slice(1)}`);
      // A key starting with "?" is an unmarked pane: only its attach command names the session.
      return { stdout: [...panes].map(([sess, pane]) => sess.startsWith('?')
        ? `\t${pane}\tenv -u TMUX ${BIN} -L vzt-mux attach-session -t =${sess.slice(1)}\n`
        : `${sess}\t${pane}\tcmd\n`).join('') };
    }
    if (verb === 'new-session' && rest.includes('-P')) {
      const name = rest[rest.indexOf('-s') + 1];
      layouts.set(name, new Map());
      if (raceNewLayout) { raceNewLayout = false; throw new Error(`duplicate session: ${name}`); }
      return newPane(name);
    }
    if (verb === 'split-window') return newPane(t.slice(1, -1));
    if (verb === 'set-option' && rest.includes('@vzt-session')) layouts.get(owner.get(t))?.set(rest.at(-1), t);
    if (verb === 'kill-session') layouts.delete(t.slice(1));
  });
  const created = [];
  const events = [];
  const saves = [];
  const registry = new AgentRegistry((agents, shells) => saves.push({ agents, shells }), {
    createTerminal: (opts) => { const t = fakeTerminal(opts); created.push(t); return t; },
    tmux: () => (tmuxPresent ? tmux : undefined),
    reveal: (root) => events.push(`reveal:${root}`),
    onActive: (root) => events.push(`active:${root}`),
    editorColumn,
    log: (l) => events.push(`log:${l}`),
  });
  return { registry, created, events, saves, calls, layouts };
}

const P = '/r/app';
const WT = '/r/app-worktrees/feat';
const Q = '/r/other';

function seed(registry, entries) {
  for (const [id, e] of entries) registry.set(id, e);
}

const verbs = (calls, verb) => calls.map((c) => c.args).filter((a) => a[2] === verb || a[4] === verb);
const ATTACH = (s) => ['--', 'env', '-u', 'TMUX', BIN, '-L', 'vzt-mux', 'attach-session', '-t', `=${s}`];

test('layoutSession: one stable, tmux-safe name per worktree path', async () => {
  const { layoutSession } = await load('tmux');
  assert.match(layoutSession(P), /^vzt-lay-[0-9a-f]{12}$/);
  assert.equal(layoutSession(P), layoutSession(P));
  assert.notEqual(layoutSession(P), layoutSession(WT));
});

test('registry: entries outlive their terminal; the saved form carries session and project', async () => {
  const { registry, saves } = await swapHarness();
  registry.set('a1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-a1', project: P });
  registry.set('vzt-sh-01', { alias: 'shell', kind: 'shell', cwd: P, session: 'vzt-sh-01', project: P });
  registry.set('old', { alias: 'legacy', kind: 'codex', cwd: Q, terminal: fakeTerminal() });
  assert.equal(registry.get('a1').terminal, undefined, 'detached');
  assert.equal(registry.size, 3);
  assert.deepEqual(saves.at(-1), {
    agents: [
      { agent_id: 'a1', alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-a1', project: P },
      { agent_id: 'old', alias: 'legacy', kind: 'codex', cwd: Q },
    ],
    shells: [{ session: 'vzt-sh-01', alias: 'shell', cwd: P, project: P }],
  }, 'shells are saved apart from bus agents; a legacy entry keeps its pre-0.10 shape');
});

test('showProject: other projects detach WITHOUT killing; each worktree gets ONE terminal on a layout of split panes', async () => {
  const { layoutSession } = await load('tmux');
  const h = await swapHarness();
  const qTerm = fakeTerminal({ name: 'other·agents' });
  const legacy = fakeTerminal({ name: 'other·legacy' });
  seed(h.registry, [
    ['q1', { alias: 'other-claude', kind: 'claude', cwd: Q, session: 'vzt-q1', project: Q, terminal: qTerm }],
    ['q2', { alias: 'legacy', kind: 'codex', cwd: Q, project: Q, terminal: legacy }],
    ['w1', { alias: 'feat-claude', kind: 'claude', cwd: WT, session: 'vzt-w1', project: P }],
    ['m1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'app-codex', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
    ['vzt-sh-01', { alias: 'shell', kind: 'shell', cwd: P, session: 'vzt-sh-01', project: P }],
  ]);
  h.registry.active = Q;

  const lead = await h.registry.showProject(P);

  assert.equal(qTerm.disposed, true, "the other project's attach client is disposed");
  assert.equal(h.registry.get('q1').terminal, undefined, '…and its entry is detached, not forgotten');
  assert.equal(legacy.disposed, false, 'a legacy terminal IS its agent: never disposed by a swap');
  assert.deepEqual(verbs(h.calls, 'kill-session'), [], 'a swap never kills a session');

  const LP = layoutSession(P);
  const LW = layoutSession(WT);
  const made = h.calls.map((c) => c.args).filter((a) => a.includes('new-session') || a.includes('split-window'));
  assert.deepEqual(made, [
    ['-L', 'vzt-mux', '-f', CONF, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', LP, '-c', P, ...ATTACH('vzt-m1')],
    ['-L', 'vzt-mux', 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', `=${LP}:`, '-c', P, ...ATTACH('vzt-m2')],
    ['-L', 'vzt-mux', 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', `=${LP}:`, '-c', P, ...ATTACH('vzt-sh-01')],
    ['-L', 'vzt-mux', '-f', CONF, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', LW, '-c', WT, ...ATTACH('vzt-w1')],
  ], 'main checkout first, then worktrees; a pane per session split to the right without taking focus');
  assert.deepEqual([...h.layouts.get(LP)], [['vzt-m1', '%1'], ['vzt-m2', '%2'], ['vzt-sh-01', '%3']]);
  assert.ok(h.calls.some((c) => c.args.join(' ') === `-L vzt-mux set-option -p -t %2 @vzt-label app-codex`), 'each pane is titled with its agent');
  assert.ok(h.calls.some((c) => c.args.join(' ') === `-L vzt-mux set-option -w -t =${LP}: pane-border-status top`));

  assert.deepEqual(h.created.map((t) => t.opts.name), ['app·agents', 'feat·agents'], 'one terminal per worktree');
  const [tp, tw] = h.created;
  for (const [t, layout] of [[tp, LP], [tw, LW]]) {
    assert.equal(t.opts.shellPath, BIN);
    assert.deepEqual(t.opts.shellArgs, ['-L', 'vzt-mux', '-f', CONF, 'attach-session', '-t', `=${layout}`]);
    assert.equal(t.opts.isTransient, true, 'VS Code must not revive a stale attach client after a reload');
    assert.deepEqual(t.opts.env, { TMUX: null, TMUX_PANE: null });
    assert.ok(!('location' in t.opts));
  }
  for (const id of ['m1', 'm2', 'vzt-sh-01']) assert.equal(h.registry.get(id).terminal, tp);
  assert.equal(h.registry.get('w1').terminal, tw);
  assert.equal(lead, tp);
  assert.deepEqual(tp.shown, [true], 'the lead terminal is shown, keyboard focus left alone');
  assert.equal(h.registry.active, P);
  assert.deepEqual(h.events, [`active:${P}`, `reveal:${P}`]);

  // Showing it again creates nothing and does not re-reveal by default.
  h.events.length = 0;
  const before = h.calls.length;
  await h.registry.showProject(P);
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.calls.slice(before).map((c) => c.args[2]), ['list-panes', 'list-panes'], 'only looks');
  assert.deepEqual(h.events, []);
});

test('a new agent of the shown project opens its pane at once, beside its worktree, with no new terminal (Orca)', async () => {
  const { layoutSession } = await load('tmux');
  const h = await swapHarness();
  seed(h.registry, [['w1', { alias: 'feat-claude', kind: 'claude', cwd: WT, session: 'vzt-w1', project: P }]]);
  await h.registry.showProject(P);
  const [tw] = h.created;

  h.registry.set('w2', { alias: 'feat-codex', kind: 'codex', cwd: WT, session: 'vzt-w2', project: P });
  await h.registry.idle();
  assert.deepEqual(verbs(h.calls, 'split-window').at(-1).slice(-1), ['=vzt-w2']);
  assert.deepEqual([...h.layouts.get(layoutSession(WT)).keys()], ['vzt-w1', 'vzt-w2']);
  assert.equal(h.created.length, 1);
  assert.equal(h.registry.get('w2').terminal, tw);
  assert.deepEqual(tw.shown, [true], 'not raised again: the split keeps focus where it is');

  // An agent of a project not shown waits detached.
  h.registry.set('q1', { alias: 'q', kind: 'claude', cwd: Q, session: 'vzt-q1', project: Q });
  await h.registry.idle();
  assert.equal(h.registry.get('q1').terminal, undefined);
  assert.equal(h.layouts.get(layoutSession(Q)), undefined);
});

test('a session that already ended gets no pane, and one failed pane does not stop the rest', async () => {
  const { layoutSession } = await load('tmux');
  const h = await swapHarness({ live: (sess) => sess !== 'vzt-m1' });
  seed(h.registry, [
    ['m1', { alias: 'gone', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'b', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
    ['m3', { alias: 'c', kind: 'codex', cwd: P, session: 'vzt-m3', project: P }],
  ]);
  await h.registry.showProject(P);
  assert.deepEqual([...h.layouts.get(layoutSession(P)).keys()], ['vzt-m2', 'vzt-m3'], 'the ended session is skipped; the next one starts the layout');
  assert.equal(h.created.length, 1);
});

test('two windows starting one worktree layout at once: the loser splits into the winner\'s', async () => {
  const { layoutSession } = await load('tmux');
  const h = await swapHarness({ raceNewLayout: true });
  seed(h.registry, [['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }]]);
  await h.registry.showProject(P);
  assert.deepEqual([...h.layouts.get(layoutSession(P)).keys()], ['vzt-m1']);
  assert.equal(h.created.length, 1, 'still gets its terminal');
});

test('a pane split but never marked (a reload in between) is known by its attach command: no duplicate', async () => {
  const { layoutSession } = await load('tmux');
  const LP = layoutSession(P);
  const h = await swapHarness({ layouts: new Map([[LP, new Map([['?vzt-m1', '%4']])]]) });
  seed(h.registry, [['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }]]);
  await h.registry.showProject(P);
  assert.deepEqual(verbs(h.calls, 'split-window'), []);
  assert.deepEqual(verbs(h.calls, 'new-session'), []);
});

test('re-registering an attached entry keeps its terminal (no orphan, no second terminal)', async () => {
  const h = await swapHarness();
  seed(h.registry, [['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }]]);
  const t = await h.registry.showProject(P);
  h.registry.set('m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P });
  await h.registry.idle();
  assert.equal(h.registry.get('m1').terminal, t);
  assert.equal(h.created.length, 1);
});

test('a layout that outlived the window (a reload) is reattached as it is; only missing panes are added', async () => {
  const { layoutSession } = await load('tmux');
  const LP = layoutSession(P);
  const h = await swapHarness({ layouts: new Map([[LP, new Map([['vzt-m1', '%7']])]]) });
  seed(h.registry, [
    ['m1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'app-codex', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
  ]);
  await h.registry.showProject(P);
  assert.deepEqual(verbs(h.calls, 'new-session'), [], 'the user\'s split arrangement is kept: no new layout');
  assert.deepEqual(verbs(h.calls, 'split-window').map((a) => a.at(-1)), ['=vzt-m2']);
  assert.deepEqual(h.created[0].opts.shellArgs.slice(-2), ['-t', `=${LP}`]);
});

test('a worktree terminal moved into an editor column comes back there after a swap; panel ones stay in the panel', async () => {
  const columns = new Map();
  const h = await swapHarness({ editorColumn: (t) => columns.get(t) });
  seed(h.registry, [
    ['m1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'app-codex', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
    ['w1', { alias: 'feat-claude', kind: 'claude', cwd: WT, session: 'vzt-w1', project: P }],
    ['q1', { alias: 'other-claude', kind: 'claude', cwd: Q, session: 'vzt-q1', project: Q }],
  ]);
  await h.registry.showProject(P);
  const [tp] = h.created;
  columns.set(tp, 2); // the user dragged app's terminal into the editor area, column 2

  await h.registry.showProject(Q);
  assert.equal(tp.disposed, true);
  await h.registry.showProject(P);

  const [np, nw] = h.created.slice(-2);
  assert.deepEqual(np.opts.location, { viewColumn: 2, preserveFocus: true }, 'back in the column the user put it in');
  assert.ok(!('location' in nw.opts), 'the other worktree stays in the panel');
  assert.equal(h.registry.get('m1').column, 2, 'kept while attached');
  assert.equal(h.saves.at(-1).agents.find((a) => a.agent_id === 'm2').column, 2, 'saved for every entry it shows, so a reload keeps it');

  // Moved back to the panel: the next swap returns it to the panel.
  await h.registry.showProject(Q);
  await h.registry.showProject(P);
  assert.ok(!('location' in h.created.at(-2).opts));
  assert.equal(h.saves.at(-1).agents.find((a) => a.agent_id === 'm1').column, undefined);
});

test('placed: a move is saved at once for every entry the terminal shows; the same place saves nothing', async () => {
  const h = await swapHarness();
  seed(h.registry, [
    ['m1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['vzt-sh-01', { alias: 'shell', kind: 'shell', cwd: P, session: 'vzt-sh-01', project: P }],
  ]);
  const t = await h.registry.showProject(P);
  const before = h.saves.length;
  h.registry.placed(t, 2);
  assert.equal(h.saves.length, before + 1, 'one save');
  assert.equal(h.saves.at(-1).agents[0].column, 2);
  assert.equal(h.saves.at(-1).shells[0].column, 2, 'shells keep their place too');
  h.registry.placed(t, 2);
  assert.equal(h.saves.length, before + 1, 'unchanged: no save');
  h.registry.placed(fakeTerminal(), 4);
  assert.equal(h.saves.length, before + 1, 'a terminal the registry does not own changes nothing');
  h.registry.placed(t, undefined);
  assert.equal(h.registry.get('m1').column, undefined, 'back in the panel');
});

test("a swap's own disposal closes nothing; a user close ends every session in the worktree terminal", async () => {
  const { layoutSession } = await load('tmux');
  const h = await swapHarness();
  const qTerm = fakeTerminal();
  seed(h.registry, [
    ['q1', { alias: 'other-claude', kind: 'claude', cwd: Q, session: 'vzt-q1', project: Q, terminal: qTerm }],
    ['m1', { alias: 'app-claude', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'app-codex', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
  ]);
  await h.registry.showProject(P);
  // VS Code reports the swap's dispose as an extension close; even "user" must not end it.
  await h.registry.closed(qTerm, 'user');
  assert.ok(h.registry.get('q1'), 'still known');
  assert.deepEqual(verbs(h.calls, 'kill-session'), []);

  await h.registry.closed(h.registry.get('m1').terminal, 'user');
  assert.deepEqual(verbs(h.calls, 'kill-session'), [
    ['-L', 'vzt-mux', 'kill-session', '-t', '=vzt-m1'],
    ['-L', 'vzt-mux', 'kill-session', '-t', '=vzt-m2'],
    ['-L', 'vzt-mux', 'kill-session', '-t', `=${layoutSession(P)}`],
  ], 'Orca: closing a tab ends its panes');
  assert.equal(h.registry.get('m1'), undefined);
  assert.equal(h.registry.get('m2'), undefined);
  assert.ok(h.registry.get('q1'));
});

test("a user close leaves the layout alone while it shows another window's agents", async () => {
  const { layoutSession } = await load('tmux');
  const LP = layoutSession(P);
  const h = await swapHarness({ layouts: new Map([[LP, new Map([['vzt-other-window', '%9']])]]) });
  seed(h.registry, [['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }]]);
  const t = await h.registry.showProject(P);
  await h.registry.closed(t, 'user');
  assert.deepEqual(verbs(h.calls, 'kill-session').map((a) => a.at(-1)), ['=vzt-m1'], 'only its own session; the layout stays');
});

test('a worktree terminal that exits by itself: gone sessions are forgotten, live ones (a detach) kept detached', async () => {
  const alive = new Set(['vzt-m2']);
  const h = await swapHarness({ live: (s) => alive.has(s) });
  seed(h.registry, [
    ['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'b', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
  ]);
  const t = await h.registry.showProject(P);
  await h.registry.closed(t, 'other');
  assert.equal(h.registry.get('m1'), undefined, 'its shell exited: the session ended by itself');
  assert.ok(h.registry.get('m2'), 'detached — the agent runs on');
  assert.equal(h.registry.get('m2').terminal, undefined);
  assert.deepEqual(verbs(h.calls, 'kill-session'), [], 'never killed');
});

test('shutdown keeps everything; a legacy terminal closing forgets only its agent', async () => {
  const h = await swapHarness();
  const legacy = fakeTerminal();
  seed(h.registry, [
    ['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['old', { alias: 'b', kind: 'codex', cwd: P, project: P, terminal: legacy }],
  ]);
  await h.registry.showProject(P);
  h.calls.length = 0;
  await h.registry.closed(h.created[0], 'shutdown');
  await h.registry.closed(legacy, 'shutdown');
  assert.equal(h.registry.size, 2);
  assert.equal(h.registry.get('m1').terminal, h.created[0]);
  assert.deepEqual(h.calls, [], 'not even a has-session on shutdown');

  await h.registry.closed(legacy, 'user');
  assert.equal(h.registry.get('old'), undefined);
  assert.deepEqual(h.calls, [], 'a legacy entry has no session to kill');
  await h.registry.closed(fakeTerminal(), 'user'); // a terminal this registry never owned
  assert.equal(h.registry.size, 1);
});

test('focus: an agent of another project shows that project first, selects its pane, then takes focus', async () => {
  const h = await swapHarness();
  const qTerm = fakeTerminal();
  seed(h.registry, [
    ['q1', { alias: 'q', kind: 'claude', cwd: Q, session: 'vzt-q1', project: Q, terminal: qTerm }],
    ['m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P }],
    ['m2', { alias: 'b', kind: 'codex', cwd: P, session: 'vzt-m2', project: P }],
  ]);
  h.registry.active = Q;
  assert.equal(h.registry.focus('m2'), true);
  await h.registry.idle();
  assert.equal(qTerm.disposed, true);
  assert.equal(h.registry.active, P);
  assert.deepEqual(verbs(h.calls, 'select-pane'), [['-L', 'vzt-mux', 'select-pane', '-t', '%2']], "m2's pane");
  assert.deepEqual(h.created[0].shown, [false], 'focus takes keyboard focus; the swap did not raise the lead itself');
  assert.equal(h.registry.focus('nope'), false);

  // No tmux binary any more: a detached session cannot be attached, so nothing is shown.
  const n = await swapHarness({ tmuxPresent: false });
  n.registry.set('m1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-m1', project: P });
  assert.equal(n.registry.focus('m1'), false, 'so the caller can fall back');
  await n.registry.idle();
  assert.deepEqual(n.created, []);
});

test('leasePlan: pane pid for tmux entries, terminal pid for legacy, no shells; a gone session = ended, attached or not', async () => {
  const { leasePlan } = await load('registry');
  const entries = [
    ['a1', { alias: 'a', kind: 'claude', cwd: P, session: 'vzt-a1', project: P }],
    ['a2', { alias: 'b', kind: 'codex', cwd: P, session: 'vzt-a2', project: P }],
    ['a3', { alias: 'c', kind: 'codex', cwd: P, session: 'vzt-a3', project: P, terminal: fakeTerminal() }],
    ['old', { alias: 'd', kind: 'claude', cwd: P, terminal: fakeTerminal({ pid: Promise.resolve(777) }) }],
    ['vzt-sh-01', { alias: 'shell', kind: 'shell', cwd: P, session: 'vzt-sh-01', project: P }],
    ['vzt-sh-02', { alias: 'shell-2', kind: 'shell', cwd: P, session: 'vzt-sh-02', project: P }],
  ];
  const panes = new Map([['vzt-a1', 100], ['vzt-sh-01', 300]]);
  const { pairs, ended } = await leasePlan(entries, panes);
  assert.deepEqual(pairs, ['a1:100', 'old:777'], 'the lease pid is the pane pid; shells never lease');
  assert.deepEqual(ended.map(([id]) => id), ['a2', 'a3', 'vzt-sh-02'],
    'an agent that exits only closes its pane: the shared terminal stays, so the poller forgets it');

  const unknown = await leasePlan(entries, undefined);
  assert.deepEqual(unknown, { pairs: ['old:777'], ended: [] }, 'a failed listing ends nothing');
});
