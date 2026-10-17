import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../cli/bus/store.mjs';
import { AGENT_ARGV, RESUME_ARGV } from '../cli/agent-argv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs');

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_BUS_AGENT', 'VZT_BUS_KIND', 'VZT_BUS_DIR']) delete BASE_ENV[k];

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...BASE_ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-restore-'));

test('argv --resume appends each CLI\'s own resume form to the house argv', () => {
  const id = '3f2a9c1e-0b7d-4e51-9a6f-2c8d1e4b7a90';
  assert.deepEqual(RESUME_ARGV('claude', id), [...AGENT_ARGV.claude, '--resume', id]);
  assert.deepEqual(RESUME_ARGV('codex', id), [...AGENT_ARGV.codex, 'resume', id]);

  const r = cli(['argv', '--kind', 'codex', '--resume', id, '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), [...AGENT_ARGV.codex, 'resume', id]);
});

test('argv --resume refuses a session id that could smuggle shell or flags', () => {
  for (const bad of ['', '--yolo', 'a b', 'x;rm', 'x'.repeat(129)]) {
    assert.throws(() => RESUME_ARGV('claude', bad));
  }
  const r = cli(['argv', '--kind', 'claude', '--resume', '$(id)', '--json']);
  assert.equal(r.code, 2);
});

test('adopt hands an agent to a new window without resetting its state or session', () => {
  const dir = tmp();
  const ws = tmp();
  let now = 1_000_000;
  const s = openStore({ dir, nowMs: () => now });
  try {
    const { agent_id } = s.register({ workspace: ws, alias: 'claude', kind: 'claude', window: 'w-old' });
    s.beat(agent_id, 'SessionStart', { session_id: 'sess-1' });
    s.beat(agent_id, 'Stop', {});
    const before = s.agent(agent_id);

    // The reloaded window: the old lease is still live, register would refuse.
    now += 5_000;
    assert.throws(() => s.register({ workspace: ws, alias: 'claude', kind: 'claude', window: 'w-new' }), (e) => e.code === 4);

    s.lease('w-old', [{ agent_id, pid: 4242 }]);
    // A window that does not name the old one cannot take a live agent.
    assert.throws(() => s.adopt(agent_id, 'w-other'), (e) => e.code === 4);
    assert.throws(() => s.adopt(agent_id, 'w-other', 'w-wrong'), (e) => e.code === 4);

    const r = s.adopt(agent_id, 'w-new', 'w-old');
    assert.deepEqual(r, {
      agent_id, alias: 'claude', kind: 'claude', workspace: before.workspace, project: before.project,
      session_id: 'sess-1', state: 'idle', terminal_pid: 4242,
    });
    const after = s.agent(agent_id);
    assert.equal(after.window_id, 'w-new');
    assert.equal(after.state, 'idle');
    assert.equal(after.session_started_ms, before.session_started_ms);
    assert.equal(after.lease_expires_ms, now + 30_000);
    assert.equal(s.liveness(after), 'live');

    // The old window can no longer renew it; the new one can.
    assert.deepEqual(s.lease('w-old', [{ agent_id, pid: 1 }]).refused, [agent_id]);
    assert.deepEqual(s.lease('w-new', [{ agent_id, pid: 1 }]).renewed, [agent_id]);

    // Once the lease lapses (that window is gone), anyone may adopt it.
    now += 31_000;
    assert.equal(s.adopt(agent_id, 'w-third').agent_id, agent_id);
  } finally {
    s.close();
  }
});

test('bus adopt over the CLI: unknown agent is exit 2, a known one returns its session', () => {
  const dir = tmp();
  const ws = tmp();
  const env = { VZT_BUS_DIR: dir };
  const reg = cli(['register', '--alias', 'codex', '--kind', 'codex', '--window', 'w1', '--workspace', ws, '--json'], env);
  assert.equal(reg.code, 0, reg.err);
  const { agent_id } = JSON.parse(reg.out);

  assert.equal(cli(['adopt', '--agent', 'nope', '--window', 'w2', '--json'], env).code, 2);
  assert.equal(cli(['adopt', '--agent', agent_id, '--window', 'w2', '--json'], env).code, 4, 'w1 still holds the lease');
  const r = cli(['adopt', '--agent', agent_id, '--window', 'w2', '--from-window', 'w1', '--json'], env);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.agent_id, agent_id);
  assert.equal(out.kind, 'codex');
  assert.equal(out.session_id, null);
});
