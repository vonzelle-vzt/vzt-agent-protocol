// Stage 1 acceptance, second half:
//
//   "Killing and restarting the herdr server leaves the extension RECONNECTING
//    rather than wedged."
//
// Run against a controllable fake daemon rather than the real one, because the
// real one owns live agent sessions and this needs to kill it repeatedly. What
// is under test is the extension's reconnect path, which is ours; herdr's own
// restart is not.
//
// The failure this guards is not a crash. It is the client quietly giving up —
// staying "connected" against a dead socket and showing a fleet that no longer
// exists, or dropping to offline and never retrying. Both look like a working
// panel that has stopped telling the truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(REPO_ROOT, 'vscode', 'out', 'herdr');
const req = createRequire(import.meta.url);

const PROTOCOL = req(path.join(OUT, 'types.gen.js')).HERDR_PROTOCOL;

function vscodeStub() {
  return {
    EventEmitter: class {
      constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; }
      fire(v) { for (const fn of this.l) fn(v); }
      dispose() { this.l = []; }
    },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: { showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {} },
  };
}

function load(file) {
  const orig = Module._load;
  Module._load = function (r, p, m) { return r === 'vscode' ? vscodeStub() : orig.call(this, r, p, m); };
  try {
    const full = path.join(OUT, file);
    delete req.cache[req.resolve(full)];
    return req(full);
  } finally {
    Module._load = orig;
  }
}

/**
 * A fake herdr: one request per connection and close, EXCEPT events.subscribe
 * which acks and holds the socket open. That asymmetry is the real protocol —
 * a fake that keeps every connection open would let a broken client pass.
 */
function startDaemon(sockPath, snapshotAgents) {
  // Every accepted socket is tracked, because `server.close()` only stops NEW
  // connections and then waits for the open ones — and events.subscribe holds
  // one open forever by design. Closing without destroying these never resolves,
  // which hangs the suite rather than failing it. (It did, once.)
  const open = new Set();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (frame.method === 'ping') {
          sock.write(JSON.stringify({ id: frame.id, result: { version: '0.7.5-fake', protocol: PROTOCOL } }) + '\n');
          sock.end();
        } else if (frame.method === 'session.snapshot') {
          const panes = snapshotAgents.map((id, i) => ({
            pane_id: id, tab_id: `t${i}`, workspace_id: `w${i}`, agent: 'claude', agent_status: 'idle',
          }));
          sock.write(JSON.stringify({
            id: frame.id,
            result: { snapshot: {
              version: '0.7.5-fake', protocol: PROTOCOL,
              workspaces: snapshotAgents.map((_, i) => ({ workspace_id: `w${i}`, number: i, label: `ws${i}` })),
              tabs: snapshotAgents.map((_, i) => ({ tab_id: `t${i}`, workspace_id: `w${i}`, number: 1, label: 'main' })),
              panes, agents: panes,
            } },
          }) + '\n');
          sock.end();
        } else if (frame.method === 'events.subscribe') {
          sock.write(JSON.stringify({ id: frame.id, result: { type: 'subscription_started' } }) + '\n');
          // held open deliberately
        } else {
          sock.write(JSON.stringify({ id: frame.id, result: {} }) + '\n');
          sock.end();
        }
      }
    });
  });
  server.killNow = () =>
    new Promise((res) => {
      for (const s of open) s.destroy();
      open.clear();
      server.close(res);
    });
  return new Promise((res) => server.listen(sockPath, () => res(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate rather than sleeping a guessed interval. Bounded — an
 *  unbounded wait hangs the suite instead of failing it. */
async function until(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(50);
  }
  assert.fail(`timed out after ${ms}ms waiting for: ${what}`);
}

test('killing the daemon leaves the client RECONNECTING, and it recovers when the daemon returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-reconnect-'));
  const sockPath = path.join(dir, 'herdr.sock');
  const prev = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sockPath;

  let server = await startDaemon(sockPath, ['w1:p1', 'w2:p1']);
  const { HerdrClient } = load('client.js');
  const { FleetModel, FLEET_SUBSCRIPTIONS } = load('model.js');

  const model = new FleetModel();
  const client = new HerdrClient({ appendLine() {}, show() {} });
  const states = [];
  client.onDidChangeState((s) => {
    states.push(s.kind);
    if (s.kind === 'offline' || s.kind === 'protocolMismatch') model.clear();
  });
  client.onDidSeed((snap) => model.seed(snap));

  try {
    // 1. up
    client.start(FLEET_SUBSCRIPTIONS);
    await until(() => client.getState().kind === 'connected', 5000, 'initial connect');
    await until(() => model.getAgents().length === 2, 5000, 'initial seed');

    // 2. the daemon dies — sockets destroyed, exactly as a killed server does
    await server.killNow();
    await until(() => client.getState().kind !== 'connected', 8000, 'the client to notice the daemon died');

    const afterKill = client.getState().kind;
    assert.ok(
      afterKill === 'offline' || afterKill === 'connecting',
      `after the daemon dies the client must be offline or reconnecting, not "${afterKill}"`
    );
    assert.equal(
      model.getAgents().length,
      0,
      'the model must be emptied — leaving the last-known fleet on screen looks live and is a lie'
    );

    // 3. and comes back. The client must find it on its own, with no user action:
    //    the acceptance check is "reconnecting rather than wedged".
    server = await startDaemon(sockPath, ['w1:p1', 'w2:p1', 'w3:p1']);
    await until(() => client.getState().kind === 'connected', 20000, 'automatic reconnect');
    await until(() => model.getAgents().length === 3, 10000, 're-seed after reconnect');

    // The re-seed must reflect the NEW world (3 agents), not replay the old one.
    assert.equal(model.getAgents().length, 3, 'reconnect must re-seed from a fresh snapshot');
    assert.ok(states.includes('connected'), 'state history should show it reached connected again');
  } finally {
    client.stop?.();
    client.dispose?.();
    model.dispose();
    await server.killNow();
    if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon that never comes back does not wedge or spin the client', async () => {
  // Backoff, not a hot loop: a fleet panel left open against a stopped herdr
  // must not sit reconnecting hundreds of times a second.
  //
  // 🔴 THIS RUNS IN A CHILD PROCESS ON A HARD DEADLINE, and that is the whole
  // design of the oracle. Mutating the backoff to `const delay = 0` does not
  // merely produce a high transition count — the reconnect loop starves its own
  // event loop, so an in-process assertion never gets to run and the suite HANGS
  // instead of failing. A hanging gate is no better than one never run. Here a
  // starved child simply misses the deadline, which is a clean FAIL.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-noserver-'));
  const sockPath = path.join(dir, 'herdr.sock'); // deliberately nothing listening
  const probe = path.join(dir, 'probe.mjs');

  fs.writeFileSync(
    probe,
    `
import Module from 'node:module';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const stub = { EventEmitter: class { constructor(){this.l=[];this.event=(f)=>{this.l.push(f);return {dispose(){}}}} fire(v){for(const f of this.l)f(v)} dispose(){this.l=[]} },
  workspace:{getConfiguration:()=>({get:()=>undefined})}, window:{showErrorMessage(){},showWarningMessage(){},showInformationMessage(){}} };
const orig = Module._load;
Module._load = function (r,p,m){ return r === 'vscode' ? stub : orig.call(this,r,p,m); };
const { HerdrClient } = req(${JSON.stringify(path.join(OUT, 'client.js'))});
const { FLEET_SUBSCRIPTIONS } = req(${JSON.stringify(path.join(OUT, 'model.js'))});
const client = new HerdrClient({ appendLine(){}, show(){} });
let n = 0;
client.onDidChangeState(() => n++);
client.start(FLEET_SUBSCRIPTIONS);
setTimeout(() => { console.log('TRANSITIONS=' + n); client.stop(); process.exit(0); }, 2500);
`,
    'utf8'
  );

  const prev = process.env.HERDR_SOCKET_PATH;
  try {
    const res = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, HERDR_SOCKET_PATH: sockPath },
    });

    assert.ok(
      !res.error || res.error.code !== 'ETIMEDOUT',
      'the client spun hard enough to starve its own event loop — reconnect must back off'
    );
    const m = /TRANSITIONS=(\d+)/.exec(res.stdout ?? '');
    assert.ok(m, `probe produced no result — stdout: ${res.stdout} stderr: ${res.stderr}`);
    assert.ok(
      Number(m[1]) < 20,
      `reconnect must back off, not spin — ${m[1]} state changes in 2.5s`
    );
  } finally {
    if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
