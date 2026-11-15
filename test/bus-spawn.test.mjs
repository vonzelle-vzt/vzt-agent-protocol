// Agent-spawned workers (cli/bus/spawnq.mjs) — Orca's worker-start over the
// bus: request -> one window claims -> worker started -> task queued from the
// requester -> worker completes -> requester gets the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../cli/bus/store.mjs';
import { claimSpawns, requestSpawn, settleSpawn, spawnStatus, SPAWN_CLAIM_TTL_MS } from '../cli/bus/spawnq.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs');
const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_BUS_AGENT', 'VZT_BUS_AGENT_ID', 'VZT_BUS_KIND', 'VZT_BUS_DIR', 'VZT_BUS_WINDOW', 'VZT_PANE_MAX']) delete BASE_ENV[k];

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-bus-spawn-')));
  const env = { VZT_BUS_DIR: dir };
  const store = openStore({ dir });
  const lead = store.register({ workspace: '/w/p', alias: 'lead', kind: 'claude', window: 'win-1' });
  return { dir, env, store, lead: store.agent(lead.agent_id) };
}

test('spawn -> claim -> settle queues the task from the requester; complete reports back', () => {
  const { env, store, lead } = setup();
  try {
    const req = requestSpawn(store, lead, { kind: 'codex', task: 'write hello.txt\nwith "hi" in it' }, { env });
    assert.equal(req.status, 'queued');
    assert.equal(req.subject, 'write hello.txt', 'subject defaults to the first line');
    assert.equal(req.depth, 1);
    assert.deepEqual(claimSpawns('other-window', { env }), [], 'only the requester\'s window claims it');
    const [claimed] = claimSpawns('win-1', { env });
    assert.equal(claimed.id, req.id);
    assert.deepEqual(claimSpawns('win-1', { env }), [], 'claimed once');

    const w = store.register({ workspace: '/w/p', alias: 'codex-worker', kind: 'codex', window: 'win-1' });
    const done = settleSpawn(store, req.id, { worker: w.agent_id }, { env });
    assert.equal(done.status, 'started');
    assert.equal(done.worker_alias, 'codex-worker');
    assert.deepEqual(spawnStatus(req.id, { env }).status, 'started');

    // The worker reads its task (from the requester), acks and completes it.
    const [task] = store.check(w.agent_id).messages;
    assert.equal(task.type, 'task');
    assert.equal(task.from, lead.agent_id);
    assert.match(task.body, /with "hi" in it/);
    store.ack(w.agent_id, task.id);
    store.complete(w.agent_id, task.id, 'succeeded', 'wrote hello.txt');
    const [report] = store.check(lead.agent_id).messages;
    assert.equal(report.type, 'report');
    assert.equal(report.subject, 'succeeded: write hello.txt');
    assert.equal(report.body, 'wrote hello.txt');
  } finally {
    store.close();
  }
});

test('bounds: live workers per requester (VZT_PANE_MAX) and depth 2', () => {
  const { env, store, lead } = setup();
  try {
    const e = { ...env, VZT_PANE_MAX: '2' };
    requestSpawn(store, lead, { kind: 'codex', task: 'a' }, { env: e });
    requestSpawn(store, lead, { kind: 'claude', task: 'b' }, { env: e });
    assert.throws(() => requestSpawn(store, lead, { kind: 'codex', task: 'c' }, { env: e }), /already has 2 live worker/);

    // A worker may start a worker; that worker may not.
    const [r1] = claimSpawns('win-1', { env });
    const w1 = store.register({ workspace: '/w/p', alias: 'w1', kind: 'codex', window: 'win-1' });
    settleSpawn(store, r1.id, { worker: w1.agent_id }, { env });
    const r2 = requestSpawn(store, store.agent(w1.agent_id), { kind: 'codex', task: 'sub' }, { env });
    assert.equal(r2.depth, 2);
    claimSpawns('win-1', { env });
    const w2 = store.register({ workspace: '/w/p', alias: 'w2', kind: 'codex', window: 'win-1' });
    settleSpawn(store, r2.id, { worker: w2.agent_id }, { env });
    assert.throws(() => requestSpawn(store, store.agent(w2.agent_id), { kind: 'codex', task: 'x' }, { env }), /depth 3 is over 2/);

    assert.throws(() => requestSpawn(store, lead, { kind: 'gpt', task: 'x' }, { env }), /--kind/);
    assert.throws(() => requestSpawn(store, lead, { kind: 'codex', task: '  ' }, { env }), /--task is required/);
    assert.throws(() => requestSpawn(store, undefined, { kind: 'codex', task: 'x' }, { env }), /agent verb/);
  } finally {
    store.close();
  }
});

test('a request no window claims in time fails with a reason; a failed start is reported', () => {
  const { env, store, lead } = setup();
  try {
    const req = requestSpawn(store, lead, { kind: 'codex', task: 't' }, { env, nowMs: 1_000 });
    assert.deepEqual(claimSpawns('win-1', { env, nowMs: 1_000 + SPAWN_CLAIM_TTL_MS + 1 }), []);
    assert.equal(spawnStatus(req.id, { env }).status, 'failed');
    assert.match(spawnStatus(req.id, { env }).error, /no VS Code window claimed it/);

    const r2 = requestSpawn(store, lead, { kind: 'codex', task: 't2' }, { env });
    claimSpawns('win-1', { env });
    const failed = settleSpawn(store, r2.id, { error: 'tmux missing' }, { env });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'tmux missing');
    assert.deepEqual(store.check(lead.agent_id).messages, [], 'no task queued for a worker that never started');
  } finally {
    store.close();
  }
});

test('CLI: spawn --no-wait queues for the caller; spawn-claim / spawn-done / spawn-status', () => {
  const { dir, store, lead } = setup();
  store.close();
  const env = { ...BASE_ENV, VZT_BUS_DIR: dir, VZT_BUS_AGENT: lead.agent_id };
  const run = (args, e = env) => spawnSync('node', [CLI, ...args, '--json'], { env: e, encoding: 'utf8' });
  const q = run(['spawn', '--kind', 'codex', '--task', 'do it', '--no-wait']);
  assert.equal(q.status, 0, q.stderr);
  const { request_id } = JSON.parse(q.stdout);
  const claimed = run(['spawn-claim', '--window', 'win-1'], { ...BASE_ENV, VZT_BUS_DIR: dir });
  assert.deepEqual(JSON.parse(claimed.stdout).map((r) => r.id), [request_id]);
  const done = run(['spawn-done', '--request', request_id, '--error', 'nope'], { ...BASE_ENV, VZT_BUS_DIR: dir });
  assert.equal(JSON.parse(done.stdout).status, 'failed');
  assert.equal(JSON.parse(run(['spawn-status', '--request', request_id]).stdout).error, 'nope');
  // Waiting spawn returns the failure as an error exit.
  const w = run(['spawn', '--kind', 'codex', '--task', 'x', '--timeout-ms', '10']);
  assert.equal(w.status, 0, 'a still-queued request is reported, not an error');
  assert.equal(JSON.parse(w.stdout).status, 'queued');
});
