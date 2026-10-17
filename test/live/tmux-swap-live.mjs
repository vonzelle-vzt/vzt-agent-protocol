#!/usr/bin/env node
// Live gate for the tmux-backed project swap (vzt-mux 0.10.0): REAL tmux, no
// agents. Contract: .vzt/ship/vscode-project-swap/SPEC.md (Oracle 3).
//
// Two sessions in two temp git repos run `cat`; a line goes in through the wake
// sink and comes back in capture-pane; pane pids are read both ways; a real
// `attach-session` client under a pty (pty_host.py) is attached, swapped away
// (session survives), reattached (history redrawn) and user-closed (session
// killed). Actions go through the compiled vscode/out/bus/{tmux,registry}.js;
// every check is a raw tmux call of its own.
//
// Never touches the real agent server: it runs its own socket
// (vzt-mux-test-<pid>), kills only that server, and asserts the real vzt-mux
// server's session list is the same before and after.
//
// NOT part of `npm test`: needs tmux and python3. Compile first:
//   npm --prefix vscode run compile && node test/live/tmux-swap-live.mjs
//
// Exit 0 = pass; 1 = fail (reason on stderr).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = path.join(REPO, 'vscode', 'out', 'bus');
const PTY_HOST = path.join(HERE, 'pty_host.py');
const SOCKET = `vzt-mux-test-${process.pid}`;
const DEADLINE_MS = 10_000;

const log = (line) => process.stderr.write(`[tmux-live] ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  throw new Error(msg);
}

/** tmux and its clients must not think they run inside some other tmux. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

// The exec handed to the code under test (the extension's is in pair.ts).
const exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: cleanEnv(), timeout: 15_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout) });
      reject(Object.assign(new Error(`${path.basename(file)}: ${String(stderr).trim() || err.message}`), { stderr: String(stderr) }));
    });
  });

let BIN;
/** A raw check against the TEST socket, independent of tmux.ts. */
function raw(...args) {
  return execFileSync(BIN, ['-L', SOCKET, ...args], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function rawOk(...args) {
  try {
    raw(...args);
    return true;
  } catch {
    return false;
  }
}
/** The real agent server's sessions — read only, to prove the test never touched it. */
function realSessions() {
  try {
    return execFileSync(BIN, ['-L', 'vzt-mux', 'list-sessions', '-F', '#{session_name}'], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '(no server)';
  }
}

async function until(what, pred) {
  const end = Date.now() + DEADLINE_MS;
  for (;;) {
    let ok = false;
    try {
      ok = await pred();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > end) fail(`timed out waiting for: ${what}`);
    await sleep(100);
  }
}

const screen = (session) => raw('capture-pane', '-p', '-J', '-S', '-200', '-t', `=${session}:`);
const count = (text, needle) => text.split('\n').filter((l) => l.includes(needle)).length;
const clients = () =>
  raw('list-clients', '-F', '#{client_pid}\t#{session_name}')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));

/** A VS Code terminal stand-in: the attach client under a real pty. */
const ptys = [];
function ptyTerminal(opts) {
  const child = spawn('python3', [PTY_HOST, '--cwd', opts.cwd, '--cols', '120', '--rows', '40', '--', opts.shellPath, ...opts.shellArgs], {
    env: cleanEnv(),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const t = {
    name: opts.name,
    opts,
    exitStatus: undefined,
    shown: [],
    child,
    lines: [],
    pid: undefined,
    show(preserveFocus) {
      this.shown.push(preserveFocus);
    },
    dispose() {
      if (child.exitCode === null) child.stdin.write(JSON.stringify({ type: 'kill' }) + '\n');
    },
    send(data) {
      child.stdin.write(JSON.stringify({ type: 'text', data }) + '\n');
    },
    async tail() {
      const before = this.lines.length;
      child.stdin.write(JSON.stringify({ type: 'tail' }) + '\n');
      await until('a pty tail reply', () => this.lines.slice(before).some((l) => l.type === 'tail'));
      return this.lines.slice(before).find((l) => l.type === 'tail').data;
    },
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        t.lines.push(msg);
        if (msg.type === 'started') t.pid = msg.pid;
        if (msg.type === 'exit') t.exitStatus = { code: msg.code, reason: 2 };
      } catch {
        // not one of pty_host's JSON lines
      }
    }
  });
  child.on('exit', () => {
    if (!t.exitStatus) t.exitStatus = { code: child.exitCode, reason: 2 };
  });
  ptys.push(t);
  return t;
}

async function main() {
  for (const name of ['tmux', 'registry']) {
    if (!fs.existsSync(path.join(OUT, `${name}.js`))) fail(`vscode/out/bus/${name}.js missing — run \`npm --prefix vscode run compile\` first`);
  }
  const { Tmux, findTmux, writeConf } = await import(pathToFileURL(path.join(OUT, 'tmux.js')).href);
  const { AgentRegistry } = await import(pathToFileURL(path.join(OUT, 'registry.js')).href);

  BIN = findTmux(process.env.PATH || '');
  if (!BIN) fail('tmux not found (PATH, /opt/homebrew/bin, /usr/local/bin)');
  log(`tmux ${execFileSync(BIN, ['-V'], { encoding: 'utf8' }).trim()} at ${BIN}, socket ${SOCKET}`);
  if (rawOk('list-sessions')) fail(`socket ${SOCKET} already has a server — refusing to touch it`);
  const realBefore = realSessions();

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-tmux-live-')));
  const repoA = path.join(tmp, 'alpha');
  const repoB = path.join(tmp, 'beta');
  for (const r of [repoA, repoB]) {
    fs.mkdirSync(r);
    execFileSync('git', ['init', '-q'], { cwd: r });
  }
  const conf = path.join(tmp, 'mux', 'tmux.conf');
  writeConf(conf);
  const tmux = new Tmux({ bin: BIN, exec, conf, socket: SOCKET });
  const A = 'vzt-live-a';
  const B = 'vzt-live-b';

  try {
    // --- two sessions, each typing its "agent" into a login shell
    await tmux.newSession(A, repoA, { VZT_BUS_AGENT: 'live-a' });
    await tmux.newSession(B, repoB, { VZT_BUS_AGENT: 'live-b' });
    if (!rawOk('has-session', '-t', `=${A}`) || !rawOk('has-session', '-t', `=${B}`)) fail('sessions were not created');
    const opt = (scope, name) => raw('show-options', scope, name).trim();
    for (const [scope, name, want] of [['-g', 'mouse', 'mouse on'], ['-g', 'status', 'status off'], ['-g', 'history-limit', 'history-limit 50000'],
      ['-s', 'escape-time', 'escape-time 0'], ['-g', 'default-terminal', 'default-terminal tmux-256color'], ['-gw', 'window-size', 'window-size latest']]) {
      const got = opt(scope, name).replace(/"/g, '');
      if (got !== want) fail(`config not applied: ${name} is "${got}", want "${want}"`);
    }
    log('2 sessions up; config applied');

    await Promise.all([tmux.launch(A, 'echo "agent=$VZT_BUS_AGENT"; cat'), tmux.launch(B, 'echo "agent=$VZT_BUS_AGENT"; cat')]);
    for (const s of [A, B]) await until(`${s} runs cat`, () => raw('display-message', '-p', '-t', `=${s}:`, '#{pane_current_command}').trim() === 'cat');
    if (!screen(A).includes('agent=live-a') || !screen(B).includes('agent=live-b')) fail('the -e env did not reach the shells');
    log('typed into the login shells; -e env present; cat running');

    // --- a line through the wake sink, into a pane the user left scrolled up
    // (copy-mode eats typed keys) — and a trailing ";" (the separator trap)
    raw('copy-mode', '-t', `=${A}:`);
    if (raw('display-message', '-p', '-t', `=${A}:`, '#{pane_in_mode}').trim() !== '1') fail('could not put the pane in copy-mode');
    const LINE = 'hello-from-sink-A;';
    const sink = tmux.sink(A);
    sink.sendText(LINE, false);
    sink.sendText('\r', false);
    await sink.done();
    await until('the sink line echoed and printed back by cat', () => count(screen(A), LINE) >= 2);
    if (screen(B).includes(LINE)) fail('the sink typed into the wrong session');
    if (raw('display-message', '-p', '-t', `=${A}:`, '#{pane_in_mode}').trim() !== '0') fail('the sink left the pane in copy-mode');
    log(`sink line "${LINE}" typed into a copy-mode pane: seen ${count(screen(A), LINE)}x in ${A} (echo + cat), not in ${B}`);

    // --- pane pids, both ways, and that they are the processes cat runs under
    const pidA = await tmux.panePid(A);
    const pids = await tmux.panePids();
    const rawPid = Number(raw('list-panes', '-t', `=${A}:`, '-F', '#{pane_pid}').trim());
    if (!pidA || pidA !== pids.get(A) || pidA !== rawPid) fail(`pane pid mismatch: display-message ${pidA}, list-panes -a ${pids.get(A)}, raw ${rawPid}`);
    process.kill(pidA, 0);
    const kids = execFileSync('pgrep', ['-P', String(pidA)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (!kids.length) fail(`nothing runs under pane pid ${pidA}`);
    log(`pane pid ${A} = ${pidA} (cat ${kids.join(',')} under it); ${B} = ${pids.get(B)}`);

    // --- the swap, through the real registry with pty-hosted attach clients
    const registry = new AgentRegistry(() => {}, {
      createTerminal: (opts) => ptyTerminal(opts),
      tmux: () => tmux,
      log: (l) => log(`registry: ${l}`),
    });
    registry.set('a', { alias: 'alpha-claude', kind: 'claude', cwd: repoA, session: A, project: repoA });
    registry.set('b', { alias: 'beta-claude', kind: 'claude', cwd: repoB, session: B, project: repoB });

    registry.showProject(repoA, { show: false });
    const clientA = registry.get('a').terminal;
    if (!clientA || registry.get('b').terminal) fail('showProject(alpha) must attach only alpha');
    await until(`a client attached to ${A}`, () => clients().some(([, s]) => s === A));
    clientA.send('typed-through-client\r');
    await until('a keystroke through the attach client reached the session', () => count(screen(A), 'typed-through-client') >= 2);
    log(`attached ${A} under a pty (client pid ${clientA.pid}); typed through it`);

    registry.showProject(repoB, { show: false });
    await until(`the ${A} client detached`, () => !clients().some(([, s]) => s === A));
    await until(`a client attached to ${B}`, () => clients().some(([, s]) => s === B));
    if (!rawOk('has-session', '-t', `=${A}`)) fail('a project swap killed the other session');
    if (registry.get('a').terminal !== undefined) fail('the swapped-away entry must be detached');
    await registry.closed(clientA, 'other'); // VS Code's close event for the swap's own dispose
    if (!registry.get('a') || !rawOk('has-session', '-t', `=${A}`)) fail("the swap's close event ended the session");
    log(`swapped to beta: ${A} detached and still running; ${B} attached`);

    registry.showProject(repoA, { show: false });
    const clientA2 = registry.get('a').terminal;
    if (!clientA2 || clientA2 === clientA) fail('showing alpha again must attach a new client');
    await until(`a client re-attached to ${A}`, () => clients().some(([, s]) => s === A));
    await until('the reattached client redraws the session (history kept)', async () => (await clientA2.tail()).includes('hello-from-sink-A'));
    log(`reattached ${A}: the earlier lines are on the new client's screen`);

    // --- the user closes alpha's terminal: Orca semantics, the session ends
    clientA2.dispose();
    await registry.closed(clientA2, 'user');
    if (rawOk('has-session', '-t', `=${A}`)) fail('a user-closed terminal must kill its session');
    if (registry.get('a')) fail('a user-closed entry must be forgotten');
    if (!rawOk('has-session', '-t', `=${B}`)) fail('killing alpha touched beta');
    log(`user-closed ${A}: has-session false; ${B} unaffected`);
  } finally {
    for (const t of ptys) {
      try {
        t.child.stdin.end();
      } catch {
        // already gone
      }
    }
    let socketPath = '';
    try {
      socketPath = raw('display-message', '-p', '#{socket_path}').trim();
    } catch {
      // server already gone
    }
    try {
      raw('kill-server');
    } catch {
      // nothing left to kill
    }
    if (socketPath && path.basename(socketPath) === SOCKET) fs.rmSync(socketPath, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await until('every pty client exited', () => ptys.every((t) => t.child.exitCode !== null || t.child.signalCode !== null));
  if (rawOk('list-sessions')) fail(`sessions left behind on ${SOCKET}`);
  const realAfter = realSessions();
  if (realAfter !== realBefore) fail(`the real vzt-mux server changed: before ${JSON.stringify(realBefore)}, after ${JSON.stringify(realAfter)}`);
  log(`no sessions left on ${SOCKET}; real vzt-mux server untouched (${realAfter || 'no sessions'})`);
}

main().then(
  () => {
    log('PASS');
    process.exit(0);
  },
  (err) => {
    log(`FAIL: ${err.message}`);
    for (const t of ptys) t.child.kill('SIGTERM');
    try {
      if (BIN) execFileSync(BIN, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // nothing to kill
    }
    process.exit(1);
  }
);
