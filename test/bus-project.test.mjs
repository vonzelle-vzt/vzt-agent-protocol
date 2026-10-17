import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../cli/bus/store.mjs';
import { resolveProject, resolveWorkspace } from '../cli/bus/cli.mjs';
import { BOOTSTRAP_PROMPT } from '../cli/agent-argv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs');

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_BUS_AGENT', 'VZT_BUS_KIND', 'VZT_BUS_DIR']) delete BASE_ENV[k];

// The v1 schema exactly as shipped before the project column (fixture).
const V1_SCHEMA = `
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  alias TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude','codex')),
  session_id TEXT,
  window_id TEXT,
  terminal_pid INTEGER,
  lease_expires_ms INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('launching','working','idle','blocked')),
  state_ts_ms INTEGER NOT NULL,
  last_stop_ts_ms INTEGER,
  last_prompt_ts_ms INTEGER,
  created_ms INTEGER NOT NULL,
  registered_ms INTEGER NOT NULL,
  session_started_ms INTEGER,
  wake_unconfirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace, alias)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  from_agent TEXT NOT NULL REFERENCES agents(agent_id),
  to_agent TEXT NOT NULL REFERENCES agents(agent_id),
  type TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT,
  idem_key TEXT,
  state TEXT NOT NULL,
  delivery_count INTEGER NOT NULL DEFAULT 0,
  visible_after_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  UNIQUE (workspace, from_agent, idem_key)
);
CREATE INDEX messages_inbox ON messages (to_agent, state, seq);
CREATE INDEX messages_thread ON messages (workspace, thread_id, seq);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  agent_id TEXT,
  message_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail_json TEXT
);
CREATE TABLE wakes (
  attempt_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  window_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('wake','retry-enter')),
  parent_attempt TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned','sent','confirmed','unconfirmed','abandoned')),
  planned_ms INTEGER NOT NULL,
  sent_ms INTEGER,
  resolved_ms INTEGER
);
CREATE INDEX wakes_agent ON wakes (agent_id, status);
`;

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: BASE_ENV,
  });
}

function repo(prefix) {
  const dir = tmp(prefix);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', 'README');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// Project A = a main checkout plus a second worktree; project B = a separate repo.
function fixture() {
  const main = repo('vzt-proj-a-');
  const wt = path.join(tmp('vzt-proj-a-wt-'), 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const other = repo('vzt-proj-b-');
  return { bus: tmp('vzt-bus-'), main, wt: fs.realpathSync(wt), other };
}

function cli(args, { env = {}, cwd } = {}) {
  const r = spawnSync('node', [CLI, ...args], { env: { ...BASE_ENV, ...env }, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function register(f, alias, kind, workspace) {
  const r = cli(['register', '--alias', alias, '--kind', kind, '--window', 'w1', '--workspace', workspace, '--json'],
    { env: { VZT_BUS_DIR: f.bus } });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

function send(f, fromId, to, extra = [], cwd) {
  return cli(['send', '--to', to, '--type', 'message', '--subject', 'hi', '--json', ...extra],
    { env: { VZT_BUS_DIR: f.bus, VZT_BUS_AGENT: fromId }, cwd });
}

test('migrates v1 db to v2', () => {
  const dir = tmp('vzt-bus-v1-');
  const ws = repo('vzt-proj-v1-');
  const db = new DatabaseSync(path.join(dir, 'bus.db'));
  db.exec(V1_SCHEMA);
  db.exec('PRAGMA user_version = 1');
  db.prepare(`INSERT INTO agents (agent_id, workspace, alias, kind, state, state_ts_ms, created_ms, registered_ms)
    VALUES ('a1', ?, 'claude', 'claude', 'idle', 1, 1, 1)`).run(ws);
  db.close();

  const s = openStore({ dir });
  try {
    assert.equal(s.get('PRAGMA user_version').user_version, 2);
    const row = s.agent('a1');
    assert.equal(row.project, ws);
    assert.equal(row.project, row.workspace);
    assert.ok(s.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'agents_project'"));
  } finally {
    s.close();
  }
  // Re-opening a v2 DB is a no-op; a newer version is refused.
  openStore({ dir }).close();
  const db2 = new DatabaseSync(path.join(dir, 'bus.db'));
  db2.exec('PRAGMA user_version = 3');
  db2.close();
  assert.throws(() => openStore({ dir }), /schema version 3 is newer/);
});

test('project is the main checkout', () => {
  const f = fixture();
  assert.equal(resolveProject(f.main), f.main);
  assert.equal(resolveProject(f.wt), f.main);
  assert.equal(resolveWorkspace(f.wt), f.wt);
  fs.mkdirSync(path.join(f.wt, 'sub'));
  assert.equal(resolveProject(path.join(f.wt, 'sub')), f.main);
  assert.equal(resolveProject(f.other), f.other);
  const plain = tmp('vzt-plain-');
  assert.equal(resolveProject(plain), plain);

  const r = register(f, 'claude', 'claude', f.wt);
  assert.equal(r.workspace, f.wt);
  assert.equal(r.project, f.main);
});

test('send reaches another worktree of the project', () => {
  const f = fixture();
  const a = register(f, 'claude', 'claude', f.main);
  const b = register(f, 'codex', 'codex', f.wt);
  const r = send(f, a.agent_id, 'codex');
  assert.equal(r.code, 0, r.err);
  const back = send(f, b.agent_id, 'claude');
  assert.equal(back.code, 0, back.err);

  const chk = cli(['check', '--json'], { env: { VZT_BUS_DIR: f.bus, VZT_BUS_AGENT: b.agent_id } });
  assert.equal(chk.code, 0, chk.err);
  const msgs = JSON.parse(chk.out).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from_alias, 'claude');
});

test('other project refused', () => {
  const f = fixture();
  register(f, 'claude', 'claude', f.main);
  const stranger = register(f, 'stranger', 'codex', f.other);
  const r = send(f, stranger.agent_id, 'claude');
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`no agent "claude" in workspace ${f.other}`), r.err);
  assert.ok(r.err.includes(`or project ${f.other}`), r.err);
  assert.match(r.err, /--cross-workspace/);
});

test('cross-workspace still works', () => {
  const f = fixture();
  register(f, 'claude', 'claude', f.main);
  const stranger = register(f, 'stranger', 'codex', f.other);
  const ok = send(f, stranger.agent_id, 'claude', ['--cross-workspace', f.main]);
  assert.equal(ok.code, 0, ok.err);
  // --cross-workspace addresses exactly that workspace: no project fallback.
  const sibling = register(f, 'codex', 'codex', f.wt);
  const miss = send(f, sibling.agent_id, 'stranger', ['--cross-workspace', f.main]);
  assert.equal(miss.code, 2);
  assert.ok(miss.err.includes(`no agent "stranger" in workspace ${f.main}`), miss.err);
});

test('alias unique per project', () => {
  const f = fixture();
  const first = register(f, 'claude', 'claude', f.main);
  const dup = cli(['register', '--alias', 'claude', '--kind', 'claude', '--window', 'w2', '--workspace', f.wt, '--json'],
    { env: { VZT_BUS_DIR: f.bus } });
  assert.equal(dup.code, 4);
  assert.ok(dup.err.includes(`alias "claude" is already used in this project by ${f.main}`), dup.err);
  // Same workspace and alias: reuse, unchanged.
  const again = register(f, 'claude', 'claude', f.main);
  assert.equal(again.agent_id, first.agent_id);
  assert.equal(again.reused, true);
  // Another project may use the same alias.
  const elsewhere = register(f, 'claude', 'claude', f.other);
  assert.notEqual(elsewhere.agent_id, first.agent_id);
});

test('agents --project lists both worktrees', () => {
  const f = fixture();
  register(f, 'claude', 'claude', f.main);
  register(f, 'codex', 'codex', f.wt);
  register(f, 'stranger', 'codex', f.other);
  const env = { VZT_BUS_DIR: f.bus };

  const proj = cli(['agents', '--project', '--json'], { env, cwd: f.wt });
  assert.equal(proj.code, 0, proj.err);
  const rows = JSON.parse(proj.out).agents;
  assert.deepEqual(rows.map((a) => a.alias).sort(), ['claude', 'codex']);
  assert.deepEqual([...new Set(rows.map((a) => a.workspace))].sort(), [f.main, f.wt].sort());
  for (const a of rows) assert.equal(a.project, f.main);

  const ws = JSON.parse(cli(['agents', '--json', '--workspace', f.wt], { env }).out).agents;
  assert.deepEqual(ws.map((a) => a.alias), ['codex']);
  assert.equal(ws[0].project, f.main);

  const all = JSON.parse(cli(['agents', '--all', '--json'], { env }).out).agents;
  assert.equal(all.length, 3);
  assert.ok(all.every((a) => typeof a.project === 'string' && a.project !== ''));
  assert.equal(all.find((a) => a.alias === 'stranger').project, f.other);
});

test('inbox --project', () => {
  const f = fixture();
  const a = register(f, 'claude', 'claude', f.main);
  register(f, 'codex', 'codex', f.wt);
  const s1 = register(f, 's1', 'codex', f.other);
  register(f, 's2', 'claude', f.other);
  assert.equal(send(f, a.agent_id, 'codex').code, 0);
  assert.equal(send(f, s1.agent_id, 's2').code, 0);
  const env = { VZT_BUS_DIR: f.bus };

  const proj = cli(['inbox', '--project', '--json', '--workspace', f.wt], { env });
  assert.equal(proj.code, 0, proj.err);
  const threads = JSON.parse(proj.out).threads;
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].participants, ['claude', 'codex']);

  const other = JSON.parse(cli(['inbox', '--project', '--json'], { env, cwd: f.other }).out).threads;
  assert.equal(other.length, 1);
  assert.deepEqual(other[0].participants, ['s1', 's2']);
});

test('paired prompt unchanged', () => {
  const expected =
    'You are "claude", paired with "codex" over the VZT bus in this workspace. ' +
    'Talk to codex ONLY via: vzt-agent bus send --to codex --type message|task|question --subject ... --body ... ; ' +
    'read with: vzt-agent bus check --json ; ack each id with: vzt-agent bus ack --id ID ; ' +
    'answer questions with: vzt-agent bus reply --id ID --body ... ; ' +
    'finish tasks with: vzt-agent bus complete --id ID --outcome succeeded|failed. ' +
    'When you see "vzt: new bus message", run the check command. Now run: vzt-agent bus check --json';
  assert.equal(BOOTSTRAP_PROMPT('claude', 'codex'), expected);
  const r = cli(['bootstrap-prompt', '--alias', 'claude', '--peer', 'codex']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, expected + '\n');
  const j = cli(['bootstrap-prompt', '--alias', 'claude', '--peer', 'codex', '--json']);
  assert.deepEqual(JSON.parse(j.out), { prompt: expected });
});

test('multi-agent prompt names agents --project', () => {
  const expected =
    'You are "feat-claude", one of the agents working on this project over the VZT bus. ' +
    'See who is up with: vzt-agent bus agents --project --json . ' +
    'Talk to another agent ONLY via: vzt-agent bus send --to <alias> --type message|task|question --subject ... --body ... ; ' +
    'read your inbox with: vzt-agent bus check --json ; ' +
    'answer questions with: vzt-agent bus reply --id <id> --body ... . ' +
    'A line starting "vzt: new bus message" means run that check.';
  assert.equal(BOOTSTRAP_PROMPT('feat-claude'), expected);
  const r = cli(['bootstrap-prompt', '--alias', 'feat-claude']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, expected + '\n');
  assert.ok(r.out.includes('vzt-agent bus agents --project --json'));
});

test('stale holder releases the alias and send prefers the live agent', () => {
  const f = fixture();
  let now = 1_000_000;
  const s = openStore({ dir: f.bus, nowMs: () => now });
  try {
    const dead = s.register({ workspace: f.main, project: f.main, alias: 'claude', kind: 'claude', window: 'w1' });
    const sender = s.register({ workspace: f.wt, project: f.main, alias: 'harness', kind: 'codex', window: 'w2' });
    assert.throws(
      () => s.register({ workspace: f.wt, project: f.main, alias: 'claude', kind: 'claude', window: 'w2' }),
      (e) => e.code === 4,
    );
    now += 31_000; // the first claude's lease lapses; it crashed
    s.lease('w2', [{ agent_id: sender.agent_id, pid: 1 }]);
    const live = s.register({ workspace: f.wt, project: f.main, alias: 'claude', kind: 'claude', window: 'w2' });
    assert.notEqual(live.agent_id, dead.agent_id);
    assert.equal(s.agentByProjectAlias(f.main, 'claude').agent_id, live.agent_id);
  } finally {
    s.close();
  }
});
