// Self-joined agents: claude/codex started by hand in a VS Code terminal whose
// window exported VZT_BUS_AGENT=auto joins the bus from its own hooks, and its
// verbs find their agent by walking up their process tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../cli/bus/store.mjs';
import { agentProcess, ancestry, callerAgent } from '../cli/bus/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs');

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_BUS_AGENT', 'VZT_BUS_AGENT_ID', 'VZT_BUS_KIND', 'VZT_BUS_DIR', 'VZT_BUS_WINDOW']) delete BASE_ENV[k];

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function repo(prefix) {
  const dir = tmp(prefix);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git('add', 'README');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('ancestry walks up and agentProcess finds the nearest claude/codex', () => {
  const rows = [
    { pid: 10, ppid: 1, comm: '-zsh' },
    { pid: 20, ppid: 10, comm: '/Users/x/.local/bin/codex' },
    { pid: 30, ppid: 20, comm: '/bin/sh' },
    { pid: 40, ppid: 30, comm: 'node' },
  ];
  const chain = ancestry(40, rows);
  assert.deepEqual(chain.map((r) => r.pid), [40, 30, 20, 10]);
  assert.deepEqual(agentProcess(chain), { pid: 20, kind: 'codex' });
  assert.equal(agentProcess(ancestry(10, rows)), undefined);
  // A cycle or a missing parent ends the walk instead of looping.
  assert.deepEqual(ancestry(5, [{ pid: 5, ppid: 6, comm: 'a' }, { pid: 6, ppid: 5, comm: 'b' }]).length, 64);
});

test('autoRegister: one agent per session, free aliases, pid lookup', () => {
  const s = openStore({ dir: tmp('vzt-bus-auto-') });
  try {
    const ws = '/w/proj';
    const a = s.autoRegister({ workspace: ws, base: 'proj', kind: 'codex', window: 'w1', sessionId: 's1', agentPid: 111 });
    assert.equal(a.alias, 'proj-codex');
    assert.equal(a.reused, false);
    // Later hooks of the same session land on the same agent.
    const again = s.autoRegister({ workspace: ws, base: 'proj', kind: 'codex', window: 'w1', sessionId: 's1', agentPid: 111 });
    assert.equal(again.agent_id, a.agent_id);
    // A second live codex in the same project gets the next alias.
    const b = s.autoRegister({ workspace: ws, base: 'proj', kind: 'codex', window: 'w1', sessionId: 's2', agentPid: 222 });
    assert.equal(b.alias, 'proj-codex-2');
    // A claude never collides with the codex aliases.
    const c = s.autoRegister({ workspace: ws, base: 'proj', kind: 'claude', window: 'w1', sessionId: 's3', agentPid: 333 });
    assert.equal(c.alias, 'proj-claude');
    // The nearest ancestor that is an agent process wins.
    assert.equal(s.agentByPids([999, 222, 111]).agent_id, b.agent_id);
    assert.equal(s.agentByPids([999]), undefined);
    // The env id always wins; auto resolves through the chain; a plain id passes through.
    assert.equal(callerAgent(s, { VZT_BUS_AGENT: 'auto', VZT_BUS_AGENT_ID: 'x' }, () => []), 'x');
    assert.equal(callerAgent(s, { VZT_BUS_AGENT: 'auto' }, () => [{ pid: 4 }, { pid: 333 }]), c.agent_id);
    assert.equal(callerAgent(s, { VZT_BUS_AGENT: 'abc' }, () => []), 'abc');
    assert.equal(callerAgent(s, { VZT_BUS_AGENT: 'auto' }, () => [{ pid: 4 }]), undefined);
  } finally {
    s.close();
  }
});

test('a dead holder frees its alias for the next session', () => {
  let now = 1_000_000;
  const s = openStore({ dir: tmp('vzt-bus-auto-'), nowMs: () => now });
  try {
    const a = s.autoRegister({ workspace: '/w/p', base: 'p', kind: 'claude', window: 'w1', sessionId: 's1', agentPid: 1 });
    now += 10 * 60_000; // lease long expired
    const b = s.autoRegister({ workspace: '/w/p', base: 'p', kind: 'claude', window: 'w1', sessionId: 's2', agentPid: 2 });
    assert.equal(b.alias, 'p-claude');
    assert.equal(b.agent_id, a.agent_id, 'the stale row is reused, not duplicated');
    assert.equal(s.agent(a.agent_id).session_id, 's2');
    assert.equal(s.agent(a.agent_id).agent_pid, 2);
    // After a reload the new window adopts it; the old terminal's hooks keep
    // naming the old window but never pull a leased agent back.
    s.adopt(b.agent_id, 'w2', 'w1');
    s.autoRegister({ workspace: '/w/p', base: 'p', kind: 'claude', window: 'w1', sessionId: 's2', agentPid: 2 });
    assert.equal(s.agent(b.agent_id).window_id, 'w2');
    now += 10 * 60_000; // ...unless nobody leases it any more
    s.autoRegister({ workspace: '/w/p', base: 'p', kind: 'claude', window: 'w1', sessionId: 's2', agentPid: 2 });
    assert.equal(s.agent(b.agent_id).window_id, 'w1');
  } finally {
    s.close();
  }
});

// End to end through the real CLI: a process named "codex" (a node binary
// linked under that name) runs the hook and then sends a message, as a hand-
// started Codex would from its shell tool.
test('hook with VZT_BUS_AGENT=auto joins, tells the agent, and its verbs resolve', () => {
  const bus = tmp('vzt-bus-auto-');
  const ws = repo('vzt-auto-ws-');
  const bin = tmp('vzt-auto-bin-');
  const fakeCodex = path.join(bin, 'codex');
  fs.symlinkSync(process.execPath, fakeCodex);
  const env = { ...BASE_ENV, VZT_BUS_DIR: bus, VZT_BUS_AGENT: 'auto', VZT_BUS_WINDOW: 'win-1' };

  // A peer to talk to, registered the normal way.
  const peer = spawnSync('node', [CLI, 'register', '--alias', 'lead', '--kind', 'claude', '--window', 'win-1', '--workspace', ws, '--json'],
    { env: { ...BASE_ENV, VZT_BUS_DIR: bus }, encoding: 'utf8' });
  assert.equal(peer.status, 0, peer.stderr);
  const lead = JSON.parse(peer.stdout).agent_id;

  const driver = path.join(bin, 'driver.mjs');
  fs.writeFileSync(driver, `
    import { spawnSync } from 'node:child_process';
    const [cli, ws] = process.argv.slice(2);
    const run = (args, input) => spawnSync(process.execPath, [cli, ...args],
      { cwd: ws, input, encoding: 'utf8' });
    const hook = run(['hook', 'SessionStart'], JSON.stringify({ session_id: 'sess-1', cwd: ws }));
    const prompt = run(['hook', 'UserPromptSubmit'], JSON.stringify({ session_id: 'sess-1', cwd: ws }));
    const sent = run(['send', '--to', 'lead', '--type', 'message', '--subject', 'hello from codex', '--json']);
    process.stdout.write(JSON.stringify({ hook, prompt, sent }));
  `);
  const r = spawnSync(fakeCodex, [driver, CLI, ws], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { hook, sent } = JSON.parse(r.stdout);
  assert.equal(hook.status, 0, hook.stderr);
  const ctx = JSON.parse(hook.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, new RegExp(`You are "${path.basename(ws)}-codex"`));
  assert.equal(sent.status, 0, sent.stderr);

  const s = openStore({ dir: bus });
  try {
    const me = s.all("SELECT * FROM agents WHERE kind = 'codex'");
    assert.equal(me.length, 1);
    assert.equal(me[0].alias, `${path.basename(ws)}-codex`);
    assert.equal(me[0].window_id, 'win-1');
    assert.equal(me[0].state, 'working', 'SessionStart left it idle; the prompt made it working');
    const inbox = s.check(lead, { peek: true }).messages;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].subject, 'hello from codex');
  } finally {
    s.close();
  }
});

test('a self-joined agent is idle (wakeable) right after SessionStart; a spawned one is working', () => {
  let now = 5_000;
  const s = openStore({ dir: tmp('vzt-bus-auto-'), nowMs: () => now });
  try {
    const self = s.autoRegister({ workspace: '/w/p', base: 'p', kind: 'claude', window: 'w1', sessionId: 's1', agentPid: 7 });
    s.beat(self.agent_id, 'SessionStart', { session_id: 's1' }, 'claude', { startIdle: true });
    assert.equal(s.agent(self.agent_id).state, 'idle');
    const spawned = s.register({ workspace: '/w/p', alias: 'lead', kind: 'claude', window: 'w1' });
    s.beat(spawned.agent_id, 'SessionStart', {}, 'claude');
    assert.equal(s.agent(spawned.agent_id).state, 'working');
    // Mail for the idle self-joined agent is planned as a wake at once.
    now += 1;
    s.send({ fromId: spawned.agent_id, toAlias: 'p-claude', type: 'message', subject: 'hi' });
    const plan = s.wakePlan('w1');
    assert.deepEqual(plan.map((p) => [p.alias, p.action]), [['p-claude', 'wake']]);
  } finally {
    s.close();
  }
});

test('hook with auto but no VZT_BUS_WINDOW stays silent', () => {
  const bus = tmp('vzt-bus-auto-');
  const r = spawnSync('node', [CLI, 'hook', 'SessionStart'],
    { env: { ...BASE_ENV, VZT_BUS_DIR: bus, VZT_BUS_AGENT: 'auto' }, input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const s = openStore({ dir: bus });
  try {
    assert.equal(s.all('SELECT * FROM agents').length, 0);
  } finally {
    s.close();
  }
});
