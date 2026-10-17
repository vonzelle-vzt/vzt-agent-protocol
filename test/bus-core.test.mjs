import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  openStore, LEASE_TTL_MS, NEVER_STARTED_MS, VISIBILITY_TIMEOUT_MS, WAKE_CONFIRM_MS,
} from '../cli/bus/store.mjs';
import { WAKE_LINE } from '../cli/agent-argv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs');
const STORE_URL = pathToFileURL(path.join(__dirname, '..', 'cli', 'bus', 'store.mjs')).href;

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_BUS_AGENT', 'VZT_BUS_KIND', 'VZT_BUS_DIR']) delete BASE_ENV[k];

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo() {
  const dir = tmp('vzt-bus-ws-');
  execFileSync('git', ['init', '-q', dir]);
  return fs.realpathSync(dir);
}

function cli(args, { env = {}, input = '', cwd } = {}) {
  const r = spawnSync('node', [CLI, ...args], { env: { ...BASE_ENV, ...env }, input, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A bus in a temp dir with an injectable clock and one workspace.
function harness() {
  const dir = tmp('vzt-bus-');
  const ws = gitRepo();
  const clock = { now: Date.now(), t0: Date.now() };
  const store = openStore({ dir, nowMs: () => clock.now });
  const reg = (alias, kind = 'codex', window = 'w1', workspace = ws) =>
    store.register({ workspace, alias, kind, window }).agent_id;
  return { dir, ws, clock, store, reg };
}

// Codex agent that has started and stopped: fresh idle in window w1.
function idleCodex(h, alias = 'codex') {
  const id = h.reg(alias, 'codex');
  h.store.beat(id, 'SessionStart', {});
  h.clock.now += 1000;
  h.store.beat(id, 'Stop', { stop_hook_active: false });
  return id;
}

test('orders FIFO across senders by seq', () => {
  const h = harness();
  const to = h.reg('to');
  const a = h.reg('a');
  const b = h.reg('b');
  const ids = [];
  for (const [from, n] of [[a, 1], [b, 2], [a, 3], [b, 4]]) {
    ids.push(h.store.send({ fromId: from, toAlias: 'to', type: 'message', subject: `m${n}` }).id);
  }
  const got = h.store.check(to).messages;
  assert.deepEqual(got.map((m) => m.id), ids);
  assert.deepEqual(got.map((m) => m.subject), ['m1', 'm2', 'm3', 'm4']);
  assert.ok(got.every((m, i) => i === 0 || m.seq > got[i - 1].seq));
  assert.ok(got.every((m) => m.state === 'seen'));
  assert.deepEqual(h.store.check(to).messages, []);
});

test('idempotent task send: key required, repeat returns original id', () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const env = { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: a };
  const noKey = cli(['send', '--to', 'b', '--type', 'task', '--subject', 'do it', '--json'], { env, cwd: h.ws });
  assert.equal(noKey.code, 2, noKey.err);
  assert.match(noKey.err, /--key is required/);
  const first = cli(['send', '--to', 'b', '--type', 'task', '--subject', 'do it', '--key', 'k1', '--json'], { env, cwd: h.ws });
  assert.equal(first.code, 0, first.err);
  const second = cli(['send', '--to', 'b', '--type', 'task', '--subject', 'do it', '--key', 'k1', '--json'], { env, cwd: h.ws });
  assert.equal(second.code, 0, second.err);
  const r1 = JSON.parse(first.out);
  const r2 = JSON.parse(second.out);
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.id, r1.id);
  h.clock.now = Date.now();
  assert.equal(h.store.check(b).messages.length, 1);
});

test('illegal transition refused (store and CLI)', () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const { id } = h.store.send({ fromId: a, toAlias: 'b', type: 'message', subject: 's' });
  assert.throws(() => h.store.tx(() => h.store.transition(id, 'acknowledged')),
    (e) => e.code === 2 && /illegal transition queued→acknowledged for type message/.test(e.message));
  assert.throws(() => h.store.tx(() => h.store.transition(id, 'completed')), /illegal transition queued→completed/);
  const env = { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: b };
  const ack = cli(['ack', '--id', id, '--json'], { env, cwd: h.ws });
  assert.equal(ack.code, 2);
  assert.match(ack.err, /illegal transition queued→acknowledged for type message/);
  h.store.check(b);
  const done = cli(['complete', '--id', id, '--outcome', 'succeeded'], { env, cwd: h.ws });
  assert.equal(done.code, 2);
  assert.match(done.err, /illegal transition/);
  assert.equal(cli(['ack', '--id', id, '--json'], { env, cwd: h.ws }).code, 0);
  assert.equal(h.store.message(id).state, 'acknowledged');
  // a refused transition writes no event and changes nothing
  const before = h.store.events({ message_id: id }).length;
  assert.throws(() => h.store.tx(() => h.store.transition(id, 'answered')));
  assert.equal(h.store.events({ message_id: id }).length, before);
});

test('redelivers after visibility timeout', () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const { id } = h.store.send({ fromId: a, toAlias: 'b', type: 'message', subject: 's' });
  assert.equal(h.store.check(b).messages.length, 1);
  h.clock.now += VISIBILITY_TIMEOUT_MS - 1;
  assert.equal(h.store.check(b).messages.length, 0);
  h.clock.now += 2;
  const r = h.store.check(b);
  assert.deepEqual(r.redelivered, [id]);
  assert.equal(r.messages[0].id, id);
  assert.equal(r.messages[0].delivery_count, 1);
  assert.ok(h.store.events({ message_id: id }).some((e) => e.from_state === 'seen' && e.to_state === 'queued'));
  // once acknowledged it is never redelivered
  h.store.ack(b, id);
  h.clock.now += VISIBILITY_TIMEOUT_MS * 2;
  assert.equal(h.store.check(b).messages.length, 0);
});

test('lease expires: stale after 30 s, renewed by lease', () => {
  const h = harness();
  const id = h.reg('a');
  h.store.beat(id, 'SessionStart', {});
  const live = () => h.store.agents({ workspace: h.ws })[0].liveness;
  assert.equal(live(), 'live');
  h.clock.now += LEASE_TTL_MS + 1;
  assert.equal(live(), 'stale');
  assert.deepEqual(h.store.lease('w1', [{ agent_id: id, pid: 123 }]).renewed, [id]);
  assert.equal(live(), 'live');
  // another window cannot renew it
  assert.deepEqual(h.store.lease('w2', [{ agent_id: id, pid: 9 }]).refused, [id]);
  const r = cli(['lease', '--window', 'w1', '--agents', `${id}:42`, '--json'], { env: { VZT_BUS_DIR: h.dir }, cwd: h.ws });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).renewed, [id]);
});

test('never-started after 90s without SessionStart', () => {
  const h = harness();
  const late = h.reg('late');
  const ok = h.reg('ok');
  h.store.beat(ok, 'SessionStart', {});
  for (let t = 0; t < 4; t++) {
    h.clock.now += 25_000;
    h.store.lease('w1', [{ agent_id: late, pid: 1 }, { agent_id: ok, pid: 2 }]);
  }
  assert.ok(h.clock.now - h.clock.t0 > NEVER_STARTED_MS);
  const by = Object.fromEntries(h.store.agents({ workspace: h.ws }).map((a) => [a.alias, a.liveness]));
  assert.deepEqual(by, { late: 'never-started', ok: 'live' });
  h.store.beat(late, 'SessionStart', {});
  assert.equal(h.store.agents({ workspace: h.ws }).find((a) => a.alias === 'late').liveness, 'live');
});

test('cross-workspace refused unless named', () => {
  const h = harness();
  const other = gitRepo();
  const a = h.reg('a');
  h.reg('far', 'claude', 'w1', other);
  const env = { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: a };
  const refused = cli(['send', '--to', 'far', '--type', 'message', '--subject', 's', '--json'], { env, cwd: h.ws });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--cross-workspace/);
  const ok = cli(['send', '--to', 'far', '--type', 'message', '--subject', 's', '--cross-workspace', other, '--json'], { env, cwd: h.ws });
  assert.equal(ok.code, 0, ok.err);
  // registering by --workspace resolves the git toplevel (subdir → same workspace)
  fs.mkdirSync(path.join(other, 'sub'));
  const r = cli(['register', '--alias', 'far', '--kind', 'claude', '--window', 'w1', '--workspace', path.join(other, 'sub'), '--json'], { env: { VZT_BUS_DIR: h.dir } });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).workspace, other);
});

test('shell-like body round-trips byte-for-byte', () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const nasty = "$(rm -rf /) `id` ${HOME} \"q\" 'single' \\ \n'; DROP TABLE messages; --\nnul-free\ttab é 🚀 \r\n%s %n";
  const bodyFile = path.join(h.dir, 'body.txt');
  fs.writeFileSync(bodyFile, nasty);
  const env = { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: a };
  const viaFile = cli(['send', '--to', 'b', '--type', 'message', '--subject', '$(x) `y` "z"', '--body-file', bodyFile, '--json'], { env, cwd: h.ws });
  assert.equal(viaFile.code, 0, viaFile.err);
  const viaArg = cli(['send', '--to', 'b', '--type', 'message', '--subject', 'arg', `--body=${nasty}`, '--payload', '{"k":"$(v)"}', '--json'], { env, cwd: h.ws });
  assert.equal(viaArg.code, 0, viaArg.err);
  const got = cli(['check', '--json'], { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: b }, cwd: h.ws });
  assert.equal(got.code, 0, got.err);
  const msgs = JSON.parse(got.out).messages;
  assert.equal(msgs[0].body, nasty);
  assert.equal(msgs[0].subject, '$(x) `y` "z"');
  assert.equal(msgs[1].body, nasty);
  assert.deepEqual(msgs[1].payload, { k: '$(v)' });
  // validation: multi-line subject, oversize body, non-object payload
  const bad = (extra) => cli(['send', '--to', 'b', '--type', 'message', ...extra, '--json'], { env, cwd: h.ws }).code;
  assert.equal(bad(['--subject', 'a\nb']), 2);
  assert.equal(bad(['--subject', 'x'.repeat(201)]), 2);
  assert.equal(bad(['--subject', 's', `--body=${'x'.repeat(64 * 1024 + 1)}`]), 2);
  assert.equal(bad(['--subject', 's', '--payload', '[1]']), 2);
  assert.equal(bad(['--subject', 's', '--type', 'nope']), 2);
});

test('concurrent writers lose nothing (2 processes x 200 sends)', async () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const to = h.reg('to');
  h.store.close();
  const script = `
    import { openStore } from ${JSON.stringify(STORE_URL)};
    const s = openStore({ dir: process.argv[1] });
    const out = [];
    for (let i = 0; i < 200; i++) out.push(s.send({ fromId: process.argv[2], toAlias: 'to', type: 'message', subject: 'm' + i }));
    s.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const runChild = (from) => new Promise((resolve, reject) => {
    const p = spawn('node', ['--input-type=module', '-e', script, h.dir, from], { env: BASE_ENV });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
  const [ra, rb] = await Promise.all([runChild(a), runChild(b)]);
  for (const r of [ra, rb]) {
    assert.equal(r.length, 200);
    assert.ok(r.every((x, i) => i === 0 || x.seq > r[i - 1].seq), 'per-writer seq strictly increasing');
  }
  const all = [...ra, ...rb];
  assert.equal(new Set(all.map((x) => x.id)).size, 400);
  assert.equal(new Set(all.map((x) => x.seq)).size, 400);
  const s2 = openStore({ dir: h.dir });
  const got = s2.check(to).messages;
  s2.close();
  assert.equal(got.length, 400);
  assert.ok(got.every((m, i) => i === 0 || m.seq > got[i - 1].seq), 'FIFO seq strictly increasing');
});

test('claude stop hook blocks once, then lets Claude stop', () => {
  const h = harness();
  const claude = h.reg('claude', 'claude');
  const peer = h.reg('peer');
  h.store.send({ fromId: peer, toAlias: 'claude', type: 'message', subject: 's' });
  const env = { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: claude, VZT_BUS_KIND: 'claude' };
  const first = cli(['hook', 'Stop'], { env, input: JSON.stringify({ session_id: 's1', stop_hook_active: false }) });
  assert.equal(first.code, 0);
  assert.deepEqual(JSON.parse(first.out), {
    decision: 'block', reason: 'VZT: 1 new bus message(s). Run: vzt-agent bus check --json',
  });
  assert.equal(h.store.agent(claude).state, 'working', 'a blocked Stop is not idle');
  const again = cli(['hook', 'Stop'], { env, input: JSON.stringify({ stop_hook_active: true }) });
  assert.equal(again.code, 0);
  assert.equal(again.out, '', 'stop_hook_active=true never blocks');
  assert.equal(h.store.agent(claude).state, 'idle');
  h.store.check(claude);
  const after = cli(['hook', 'Stop'], { env, input: JSON.stringify({ stop_hook_active: false }) });
  assert.equal(after.out, '', 'no unread → no block');
});

test('codex stop hook never blocks', () => {
  const h = harness();
  const codex = h.reg('codex', 'codex');
  const peer = h.reg('peer');
  for (let i = 0; i < 3; i++) h.store.send({ fromId: peer, toAlias: 'codex', type: 'message', subject: `s${i}` });
  for (const env of [
    { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: codex, VZT_BUS_KIND: 'codex' },
    { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: codex }, // kind from the registry
  ]) {
    const r = cli(['hook', 'Stop'], { env, input: JSON.stringify({ stop_hook_active: false }) });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  }
  assert.equal(h.store.agent(codex).state, 'idle');
});

test('hook never fails', () => {
  const h = harness();
  const id = h.reg('a');
  const noAgentDir = tmp('vzt-bus-none-');
  const cases = [
    { env: { VZT_BUS_DIR: noAgentDir }, input: '{}', args: ['Stop'] },
    { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: id }, input: 'not json {', args: ['Stop'] },
    { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: 'no-such-agent' }, input: '{}', args: ['Stop'] },
    { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: id }, input: '{}', args: ['Bogus'] },
    { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: id }, input: '{}', args: [] },
    { env: { VZT_BUS_DIR: path.join(h.dir, 'bus.db', 'nope'), VZT_BUS_AGENT: id }, input: '{}', args: ['Stop'] },
    { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: id, ORCA_TERMINAL_HANDLE: 't' }, input: '{}', args: ['Stop'] },
  ];
  for (const c of cases) {
    const r = cli(['hook', ...c.args], c);
    assert.equal(r.code, 0, `${JSON.stringify(c)} → ${r.err}`);
    assert.equal(r.out, '');
  }
  assert.ok(!fs.existsSync(path.join(noAgentDir, 'bus.db')), 'no VZT_BUS_AGENT → DB never opened');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    assert.equal(cli(['hook', ev], { env: { VZT_BUS_DIR: h.dir, VZT_BUS_AGENT: id }, input: '{}' }).code, 0);
  }
  assert.equal(h.store.agent(id).state, 'idle');
});

test('wake plan requires fresh idle, own window, live lease and queued mail', () => {
  const h = harness();
  const codex = h.reg('codex');
  const peer = h.reg('peer', 'claude', 'w9');
  h.store.beat(codex, 'SessionStart', {});
  h.store.send({ fromId: peer, toAlias: 'codex', type: 'message', subject: 's' });
  assert.deepEqual(h.store.wakePlan('w1'), [], 'working → no wake');
  h.store.beat(codex, 'PermissionRequest', {});
  assert.deepEqual(h.store.wakePlan('w1'), [], 'blocked → no wake');
  h.clock.now += 1000;
  h.store.beat(codex, 'Stop', {});
  h.clock.now += 1000;
  h.store.beat(codex, 'UserPromptSubmit', {});
  h.store.setAgentState(h.store.agent(codex), 'idle');
  assert.deepEqual(h.store.wakePlan('w1'), [], 'idle but last prompt after last stop → not fresh');
  h.clock.now += 1000;
  h.store.beat(codex, 'Stop', {});
  assert.deepEqual(h.store.wakePlan('w2'), [], 'other window never wakes it');
  h.clock.now += LEASE_TTL_MS + 1;
  assert.deepEqual(h.store.wakePlan('w1'), [], 'expired lease → no wake');
  h.store.lease('w1', [{ agent_id: codex, pid: 7 }]);
  const plan = h.store.wakePlan('w1');
  assert.equal(plan.length, 1);
  assert.deepEqual(Object.keys(plan[0]).sort(), ['action', 'agent_id', 'alias', 'attempt_id', 'line']);
  assert.equal(plan[0].action, 'wake');
  assert.equal(plan[0].line, WAKE_LINE);
  assert.equal(plan[0].alias, 'codex');
  assert.deepEqual(h.store.wakePlan('w1'), [], 'open attempt → no second wake');
  // confirmation: wake-sent then a prompt beat inside 20 s → delivered
  h.store.wakeSent(plan[0].attempt_id);
  h.clock.now += 5000;
  h.store.beat(codex, 'UserPromptSubmit', {});
  assert.equal(h.store.wakes(codex)[0].status, 'confirmed');
  assert.equal(h.store.visibleUnread(codex)[0].state, 'delivered');
  h.clock.now += 1000;
  h.store.beat(codex, 'Stop', {});
  assert.deepEqual(h.store.wakePlan('w1'), [], 'delivered mail does not re-wake');
  // no mail at all → no wake
  h.store.check(codex);
  assert.deepEqual(h.store.wakePlan('w1'), []);
  // the CLI only plans for its own window
  const r = cli(['wake-plan', '--window', 'w2', '--json'], { env: { VZT_BUS_DIR: h.dir } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), []);
});

test('wake retry then unconfirmed, cleared by next Stop', () => {
  const h = harness();
  const codex = idleCodex(h);
  const peer = h.reg('peer', 'claude', 'w9');
  h.store.send({ fromId: peer, toAlias: 'codex', type: 'message', subject: 's' });
  const [wake] = h.store.wakePlan('w1');
  assert.equal(wake.action, 'wake');
  h.store.wakeSent(wake.attempt_id);
  h.clock.now += WAKE_CONFIRM_MS - 1;
  assert.deepEqual(h.store.wakePlan('w1'), [], 'still inside the confirm window');
  h.clock.now += 2;
  const [retry] = h.store.wakePlan('w1');
  assert.equal(retry.action, 'retry-enter');
  assert.equal(retry.line, '\r');
  h.store.wakeSent(retry.attempt_id);
  h.clock.now += WAKE_CONFIRM_MS + 1;
  assert.deepEqual(h.store.wakePlan('w1'), []);
  const a = h.store.agents({ workspace: h.ws }).find((x) => x.alias === 'codex');
  assert.equal(a.wake_unconfirmed, true);
  h.clock.now += WAKE_CONFIRM_MS * 3;
  assert.deepEqual(h.store.wakePlan('w1'), [], 'flagged agent is never re-woken');
  const kinds = h.store.events({ agent_id: codex }).map((e) => e.kind).filter((k) => k.startsWith('wake_'));
  assert.deepEqual(kinds, ['wake_planned', 'wake_sent', 'wake_unconfirmed', 'wake_planned', 'wake_sent', 'wake_unconfirmed', 'wake_flagged_unconfirmed']);
  h.store.lease('w1', [{ agent_id: codex, pid: 7 }]);
  h.store.beat(codex, 'Stop', {});
  assert.equal(h.store.agent(codex).wake_unconfirmed, 0);
  assert.equal(h.store.wakePlan('w1')[0].action, 'wake');
});

test('second window refused while the alias lease is live', () => {
  const h = harness();
  const env = { VZT_BUS_DIR: h.dir };
  const reg = (window) => cli(['register', '--alias', 'claude', '--kind', 'claude', '--window', window, '--json'], { env, cwd: h.ws });
  const first = reg('win-A');
  assert.equal(first.code, 0, first.err);
  const id = JSON.parse(first.out).agent_id;
  const second = reg('win-B');
  assert.equal(second.code, 4);
  assert.match(second.err, /live in another window/);
  const same = reg('win-A');
  assert.equal(JSON.parse(same.out).agent_id, id, 'same window re-registers the same id');
  // after the lease lapses another window may take it over — same agent_id, queue intact
  h.clock.now = Date.now() + LEASE_TTL_MS + 1000;
  const taken = h.store.register({ workspace: h.ws, alias: 'claude', kind: 'claude', window: 'win-B' });
  assert.equal(taken.agent_id, id);
  assert.equal(h.store.agent(id).window_id, 'win-B');
});

test('one task in flight per agent', () => {
  const h = harness();
  const a = h.reg('a');
  const b = h.reg('b');
  const t1 = h.store.send({ fromId: a, toAlias: 'b', type: 'task', subject: 't1', key: 'k1' }).id;
  const t2 = h.store.send({ fromId: a, toAlias: 'b', type: 'task', subject: 't2', key: 'k2' }).id;
  const m = h.store.send({ fromId: a, toAlias: 'b', type: 'message', subject: 'm' }).id;
  assert.deepEqual(h.store.check(b).messages.map((x) => x.id), [t1, m]);
  assert.deepEqual(h.store.check(b).messages, [], 't2 held while t1 seen');
  h.store.ack(b, t1);
  assert.deepEqual(h.store.check(b).messages, [], 't2 held while t1 acknowledged');
  const report = h.store.complete(b, t1, 'succeeded', 'done');
  assert.equal(h.store.message(t1).state, 'completed');
  const rep = h.store.message(report.id);
  assert.equal(rep.type, 'report');
  assert.equal(rep.reply_to, t1);
  assert.equal(rep.to_agent, a);
  assert.deepEqual(h.store.check(b).messages.map((x) => x.id), [t2]);
  // questions and gates
  const q = h.store.send({ fromId: a, toAlias: 'b', type: 'question', subject: 'q?' }).id;
  const g = h.store.send({ fromId: a, toAlias: 'b', type: 'gate', subject: 'ship?' }).id;
  h.store.check(b);
  h.store.reply(b, q, '42');
  assert.equal(h.store.message(q).state, 'answered');
  assert.equal(h.store.answerTo(q).body, '42');
  h.store.gateResolve(b, g, 'approve');
  assert.equal(h.store.message(g).state, 'approved');
});

test('orca seam exits 3 (doctor, argv, bootstrap-prompt exempt)', () => {
  const h = harness();
  const env = { VZT_BUS_DIR: h.dir, ORCA_TERMINAL_HANDLE: 'term_x' };
  for (const args of [['agents', '--json'], ['check', '--json'], ['register', '--alias', 'x', '--kind', 'claude', '--window', 'w'], ['wake-plan', '--window', 'w']]) {
    const r = cli(args, { env, cwd: h.ws });
    assert.equal(r.code, 3, args.join(' '));
    assert.match(r.err, /orca orchestration send\/check\/reply/);
    assert.equal(r.out, '');
  }
  const doc = cli(['doctor', '--json'], { env: { ...env, HOME: tmp('vzt-home-') } });
  assert.equal(doc.code, 0, doc.err);
  assert.equal(JSON.parse(doc.out).node_sqlite, true);
  assert.equal(cli(['argv', '--kind', 'claude', '--json'], { env }).code, 0);
  assert.equal(cli(['bootstrap-prompt', '--alias', 'a', '--peer', 'b'], { env }).code, 0);
});

test('doctor reports wired, trusted and untrusted bus hooks', () => {
  const home = tmp('vzt-home-');
  const codexHome = path.join(home, 'custom-codex');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const cmd = (ev) => `: vzt-bus-hook-form=1; [ -n "\${VZT_BUS_AGENT-}" ] && exec vzt-agent bus hook ${ev} || :`;
  const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd('Stop') }] }] },
  }));
  const hooksJson = path.join(codexHome, 'hooks.json');
  const hooks = { hooks: {} };
  for (const ev of events) {
    hooks.hooks[ev] = [
      { hooks: [{ type: 'command', command: ': orca-agent-hook-form=1; true', timeout: 10 }] },
      { hooks: [{ type: 'command', command: cmd(ev), timeout: 10 }] },
    ];
  }
  fs.writeFileSync(hooksJson, JSON.stringify(hooks));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    '[hooks.state]',
    `[hooks.state."${hooksJson}:stop:1:0"]`, 'enabled = true', 'trusted_hash = "sha256:abc"',
    `[hooks.state."${hooksJson}:session_start:1:0"]`, 'trusted_hash = "sha256:def"',
    `[hooks.state."${hooksJson}:user_prompt_submit:1:0"]`, 'enabled = false', 'trusted_hash = "sha256:x"',
    '',
  ].join('\n'));
  const r = cli(['doctor', '--json'], { env: { HOME: home, CODEX_HOME: codexHome } });
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.deepEqual(d.claude_hooks.wired, ['Stop']);
  assert.deepEqual(d.codex_hooks.wired, events);
  assert.deepEqual(d.codex_hooks.trusted, [`${hooksJson}:session_start:1:0`, `${hooksJson}:stop:1:0`]);
  assert.deepEqual(d.codex_hooks.untrusted, [`${hooksJson}:user_prompt_submit:1:0`, `${hooksJson}:permission_request:1:0`]);
});

test('store files are private and schema is versioned', () => {
  const h = harness();
  const st = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(st(path.join(h.dir, 'bus.db')), 0o600);
  const fresh = path.join(tmp('vzt-bus-parent-'), 'nested', 'bus');
  const s = openStore({ dir: fresh });
  assert.equal(st(fresh), 0o700);
  assert.equal(s.get('PRAGMA user_version').user_version, 2);
  assert.equal(s.get('PRAGMA journal_mode').journal_mode, 'wal');
  s.close();
});
