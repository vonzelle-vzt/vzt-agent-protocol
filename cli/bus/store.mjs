// VZT agent bus — durable local store (WAL SQLite via node:sqlite).
// Contract: .vzt/ship/vscode-agent-bus/SPEC.md, section "Interfaces".
// No daemon: every call is one short BEGIN IMMEDIATE transaction; leases and
// visibility timeouts are evaluated lazily at read time against nowMs().

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WAKE_LINE } from '../agent-argv.mjs';

export const SCHEMA_VERSION = 2;
export const LEASE_TTL_MS = 30_000;
export const NEVER_STARTED_MS = 90_000;
export const VISIBILITY_TIMEOUT_MS = 300_000;
export const WAKE_CONFIRM_MS = 20_000;
export const SUBJECT_MAX = 200;
export const BODY_MAX_BYTES = 64 * 1024;

export const KINDS = ['claude', 'codex'];
export const AGENT_STATES = ['launching', 'working', 'idle', 'blocked'];
export const TYPES = ['message', 'task', 'question', 'reply', 'gate', 'report'];
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];

// The legal-transition table. transition() is the only writer of messages.state
// after insert; anything not listed here is refused.
const COMMON = { queued: ['delivered', 'seen'], delivered: ['seen'], seen: ['acknowledged', 'queued'] };
const BY_TYPE = {
  task: { acknowledged: ['completed', 'failed'] },
  question: { seen: ['answered'], acknowledged: ['answered'] },
  gate: { seen: ['approved', 'rejected'], acknowledged: ['approved', 'rejected'] },
};

export function isLegalTransition(type, from, to) {
  if ((COMMON[from] || []).includes(to)) return true;
  return ((BY_TYPE[type] || {})[from] || []).includes(to);
}

export class BusError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const usage = (msg) => new BusError(2, msg);

export function busDir(env = process.env) {
  return env.VZT_BUS_DIR || path.join(env.HOME || os.homedir(), '.vzt', 'bus');
}

const SCHEMA = `
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
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
CREATE INDEX agents_project ON agents (project, alias);
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

// v1 -> v2: agents gain a project (the main checkout shared by a repo's
// worktrees). Existing rows keep project = workspace, so they stay isolated
// per worktree until they re-register.
const MIGRATE_V1_V2 = `
ALTER TABLE agents ADD COLUMN project TEXT NOT NULL DEFAULT '';
UPDATE agents SET project = workspace WHERE project = '';
CREATE INDEX agents_project ON agents (project, alias);
`;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openStore(opts = {}) {
  const dir = opts.dir || busDir(opts.env);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const dbPath = path.join(dir, 'bus.db');
  if (!fs.existsSync(dbPath)) fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
  fs.chmodSync(dbPath, 0o600);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const store = new Store(db, dbPath, opts.nowMs || Date.now);
  store.migrate();
  return store;
}

const opt = (v) => (v === undefined ? null : v);

export class Store {
  constructor(db, dbPath, nowMs) {
    this.db = db;
    this.path = dbPath;
    this.nowMs = nowMs;
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  migrate() {
    if (this.get('PRAGMA user_version').user_version === SCHEMA_VERSION) return;
    this.tx(() => {
      const v = this.get('PRAGMA user_version').user_version;
      if (v === SCHEMA_VERSION) return;
      if (v === 0) this.db.exec(SCHEMA);
      else if (v === 1) this.db.exec(MIGRATE_V1_V2);
      else throw new BusError(2, `bus.db schema version ${v} is newer than this vzt-agent (${SCHEMA_VERSION})`);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  event(kind, f = {}) {
    this.run(
      `INSERT INTO events (ts_ms, agent_id, message_id, attempt_id, kind, from_state, to_state, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.nowMs(), opt(f.agent_id), opt(f.message_id), opt(f.attempt_id), kind,
      opt(f.from), opt(f.to), f.detail === undefined ? null : JSON.stringify(f.detail),
    );
  }

  events(filter = {}) {
    const where = [];
    const args = [];
    for (const k of ['agent_id', 'message_id', 'attempt_id', 'kind']) {
      if (filter[k] !== undefined) { where.push(`${k} = ?`); args.push(filter[k]); }
    }
    return this.all(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, ...args);
  }

  // The single state-machine function for messages. Must run inside tx().
  transition(messageId, to, detail) {
    const m = this.get('SELECT * FROM messages WHERE id = ?', messageId);
    if (!m) throw usage(`no such message ${messageId}`);
    if (!isLegalTransition(m.type, m.state, to)) {
      throw usage(`illegal transition ${m.state}→${to} for type ${m.type}`);
    }
    const now = this.nowMs();
    if (m.state === 'seen' && to === 'queued') {
      this.run('UPDATE messages SET state = ?, delivery_count = delivery_count + 1, visible_after_ms = ?, updated_ms = ? WHERE id = ?',
        to, now, now, messageId);
    } else if (to === 'seen') {
      this.run('UPDATE messages SET state = ?, visible_after_ms = ?, updated_ms = ? WHERE id = ?',
        to, now + VISIBILITY_TIMEOUT_MS, now, messageId);
    } else {
      this.run('UPDATE messages SET state = ?, updated_ms = ? WHERE id = ?', to, now, messageId);
    }
    this.event('message_state', { agent_id: m.to_agent, message_id: messageId, from: m.state, to, detail });
    return { ...m, state: to };
  }

  // ---------- agents ----------

  agent(agentId) {
    return this.get('SELECT * FROM agents WHERE agent_id = ?', agentId);
  }

  requireAgent(agentId) {
    if (!agentId) throw usage('VZT_BUS_AGENT is not set (agent-side verbs need the caller\'s agent_id)');
    const a = this.agent(agentId);
    if (!a) throw usage(`unknown agent ${agentId}`);
    return a;
  }

  agentByAlias(workspace, alias) {
    return this.get('SELECT * FROM agents WHERE workspace = ? AND alias = ?', workspace, alias);
  }

  agentByProjectAlias(project, alias) {
    // A stale holder may share the alias with a live one in another worktree
    // (register lets a live agent take over a dead one's alias): prefer the live one.
    return this.get(
      'SELECT * FROM agents WHERE project = ? AND alias = ? ORDER BY (lease_expires_ms > ?) DESC, registered_ms DESC LIMIT 1',
      project, alias, this.nowMs(),
    );
  }

  register({ workspace, project = workspace, alias, kind, window, sessionId, terminalPid }) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias || '')) throw usage('--alias must be 1-64 chars of [A-Za-z0-9._-]');
    if (!KINDS.includes(kind)) throw usage(`--kind must be one of ${KINDS.join('|')}`);
    if (!window) throw usage('--window is required');
    return this.tx(() => {
      const now = this.nowMs();
      const lease = now + LEASE_TTL_MS;
      // Only a live holder reserves the alias; a crashed or removed worktree's agent must not hold it forever.
      const held = this.get(
        'SELECT workspace FROM agents WHERE project = ? AND alias = ? AND workspace != ? AND lease_expires_ms > ? LIMIT 1',
        project, alias, workspace, now,
      );
      if (held) throw new BusError(4, `alias "${alias}" is already used in this project by ${held.workspace}`);
      const existing = this.agentByAlias(workspace, alias);
      if (existing) {
        if (existing.window_id !== window && existing.lease_expires_ms > now) {
          throw new BusError(4, `alias "${alias}" is live in another window (${existing.window_id}); lease expires in ${Math.ceil((existing.lease_expires_ms - now) / 1000)}s`);
        }
        if (existing.kind !== kind) throw new BusError(4, `alias "${alias}" is registered as kind ${existing.kind}`);
        this.run(
          `UPDATE agents SET project = ?, window_id = ?, terminal_pid = ?, session_id = ?, lease_expires_ms = ?, state = 'launching',
             state_ts_ms = ?, registered_ms = ?, session_started_ms = NULL, wake_unconfirmed = 0 WHERE agent_id = ?`,
          project, window, opt(terminalPid), opt(sessionId), lease, now, now, existing.agent_id,
        );
        this.event('agent_registered', { agent_id: existing.agent_id, from: existing.state, to: 'launching', detail: { window, reused: true } });
        return { agent_id: existing.agent_id, alias, workspace, project, reused: true };
      }
      const id = randomUUID();
      this.run(
        `INSERT INTO agents (agent_id, workspace, project, alias, kind, session_id, window_id, terminal_pid, lease_expires_ms,
           state, state_ts_ms, created_ms, registered_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching', ?, ?, ?)`,
        id, workspace, project, alias, kind, opt(sessionId), window, opt(terminalPid), lease, now, now, now,
      );
      this.event('agent_registered', { agent_id: id, to: 'launching', detail: { window, reused: false } });
      return { agent_id: id, alias, workspace, project, reused: false };
    });
  }

  // Hand an agent to a new window (the same VS Code window after a reload or a
  // restart) WITHOUT resetting its state or session: unlike register, the agent
  // may still be running. `fromWindow` is the window the caller saved the agent
  // under; while another window holds a live lease on it, adopt refuses (exit 4)
  // so two windows can never both drive one agent. Returns the shell pid last
  // leased, which identifies a terminal that survived a reload.
  adopt(agentId, window, fromWindow) {
    if (!window) throw usage('--window is required');
    return this.tx(() => {
      const a = this.requireAgent(agentId);
      const now = this.nowMs();
      if (a.window_id !== window && a.window_id !== fromWindow && a.lease_expires_ms > now) {
        throw new BusError(4, `agent ${agentId} is live in another window (${a.window_id})`);
      }
      this.run('UPDATE agents SET window_id = ?, lease_expires_ms = ? WHERE agent_id = ?', window, now + LEASE_TTL_MS, a.agent_id);
      this.event('agent_adopted', { agent_id: a.agent_id, detail: { from_window: a.window_id, window } });
      const { agent_id, alias, kind, workspace, project, session_id, state, terminal_pid } = a;
      return { agent_id, alias, kind, workspace, project, session_id, state, terminal_pid };
    });
  }

  liveness(a, now = this.nowMs()) {
    if (a.session_started_ms == null && now - a.registered_ms > NEVER_STARTED_MS) return 'never-started';
    return a.lease_expires_ms > now ? 'live' : 'stale';
  }

  agents({ workspace, project } = {}) {
    const now = this.nowMs();
    const rows = project
      ? this.all('SELECT * FROM agents WHERE project = ? ORDER BY workspace, alias', project)
      : workspace
        ? this.all('SELECT * FROM agents WHERE workspace = ? ORDER BY alias', workspace)
        : this.all('SELECT * FROM agents ORDER BY workspace, alias');
    return rows.map((a) => ({
      ...a,
      wake_unconfirmed: !!a.wake_unconfirmed,
      liveness: this.liveness(a, now),
      unread: this.visibleUnread(a.agent_id, now).length,
    }));
  }

  // Renew leases for agents this window owns. pairs: [{agent_id, pid}]
  lease(window, pairs) {
    return this.tx(() => {
      const now = this.nowMs();
      const renewed = [];
      const refused = [];
      for (const { agent_id, pid } of pairs) {
        const a = this.agent(agent_id);
        if (!a || a.window_id !== window) { refused.push(agent_id); continue; }
        this.run('UPDATE agents SET lease_expires_ms = ?, terminal_pid = ? WHERE agent_id = ?', now + LEASE_TTL_MS, opt(pid), agent_id);
        renewed.push(agent_id);
      }
      return { renewed, refused, lease_expires_ms: now + LEASE_TTL_MS };
    });
  }

  setAgentState(a, to, extra = {}) {
    const now = this.nowMs();
    const sets = ['state = ?', 'state_ts_ms = ?'];
    const args = [to, now];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v); }
    this.run(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`, ...args, a.agent_id);
    this.event('agent_state', { agent_id: a.agent_id, from: a.state, to, detail: Object.keys(extra).length ? extra : undefined });
  }

  // ---------- messages ----------

  send({ fromId, toAlias, type, subject, body = '', threadId, replyTo, key, payload, workspace }) {
    if (!TYPES.includes(type)) throw usage(`--type must be one of ${TYPES.join('|')}`);
    if (typeof subject !== 'string' || subject.length === 0) throw usage('--subject is required');
    if (subject.length > SUBJECT_MAX) throw usage(`subject exceeds ${SUBJECT_MAX} chars`);
    if (/[\r\n]/.test(subject)) throw usage('subject must be a single line');
    if (typeof body !== 'string') throw usage('body must be text');
    if (Buffer.byteLength(body, 'utf8') > BODY_MAX_BYTES) throw usage(`body exceeds ${BODY_MAX_BYTES} bytes`);
    if (type === 'task' && !key) throw usage('--key is required for type task');
    let payloadJson = null;
    if (payload !== undefined && payload !== null) {
      let parsed;
      try { parsed = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { throw usage('--payload is not valid JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usage('--payload must be a JSON object');
      payloadJson = JSON.stringify(parsed);
    }
    return this.tx(() => {
      const from = this.requireAgent(fromId);
      const targetWs = workspace || from.workspace;
      // Without --cross-workspace: the sender's workspace first, then its project.
      const to = this.agentByAlias(targetWs, toAlias) || (workspace ? null : this.agentByProjectAlias(from.project, toAlias));
      if (!to) {
        throw usage(workspace
          ? `no agent "${toAlias}" in workspace ${targetWs}`
          : `no agent "${toAlias}" in workspace ${from.workspace} or project ${from.project} (use --cross-workspace <dir> to address another workspace)`);
      }
      if (key) {
        const dup = this.get('SELECT id, seq FROM messages WHERE workspace = ? AND from_agent = ? AND idem_key = ?', from.workspace, from.agent_id, key);
        if (dup) return { id: dup.id, seq: dup.seq, duplicate: true };
      }
      let thread = threadId || null;
      if (replyTo) {
        const parent = this.get('SELECT thread_id FROM messages WHERE id = ?', replyTo);
        if (!parent) throw usage(`--reply-to: no such message ${replyTo}`);
        thread = thread || parent.thread_id;
      }
      return this.insertMessage({ from, to, type, subject, body, thread, replyTo, key, payloadJson });
    });
  }

  // Must run inside tx().
  insertMessage({ from, to, type, subject, body, thread, replyTo, key, payloadJson }) {
    const now = this.nowMs();
    const id = randomUUID();
    const seq = this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages').s;
    // Messages live in the sender's workspace (idempotency scope) even when cross-workspace.
    this.run(
      `INSERT INTO messages (id, seq, workspace, from_agent, to_agent, type, thread_id, reply_to, subject, body,
         payload_json, idem_key, state, delivery_count, visible_after_ms, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      id, seq, from.workspace, from.agent_id, to.agent_id, type, thread || id, opt(replyTo), subject, body,
      opt(payloadJson), opt(key), now, now, now,
    );
    this.event('message_sent', { agent_id: to.agent_id, message_id: id, to: 'queued', detail: { from: from.agent_id, type } });
    return { id, seq, duplicate: false };
  }

  message(id) {
    return this.get('SELECT * FROM messages WHERE id = ?', id);
  }

  // What `check` would hand this agent right now, in FIFO order, honouring
  // visibility timeouts and one-task-in-flight. Pure read.
  visibleUnread(agentId, now = this.nowMs()) {
    const rows = this.all(
      `SELECT * FROM messages WHERE to_agent = ? AND visible_after_ms <= ?
         AND (state IN ('queued','delivered') OR state = 'seen') ORDER BY seq`,
      agentId, now,
    );
    let taskBusy = !!this.get(
      `SELECT 1 AS x FROM messages WHERE to_agent = ? AND type = 'task'
         AND (state = 'acknowledged' OR (state = 'seen' AND visible_after_ms > ?)) LIMIT 1`,
      agentId, now,
    );
    const out = [];
    for (const m of rows) {
      if (m.type === 'task') {
        if (taskBusy) continue;
        taskBusy = true;
      }
      out.push(m);
    }
    return out;
  }

  check(agentId, { peek = false } = {}) {
    return this.tx(() => {
      const me = this.requireAgent(agentId);
      const now = this.nowMs();
      const batch = this.visibleUnread(me.agent_id, now);
      const pub = (m) => ({ ...publicMessage(m), from_alias: this.agent(m.from_agent)?.alias ?? null });
      if (peek) return { messages: batch.map(pub), redelivered: [] };
      const redelivered = [];
      const out = [];
      for (const m of batch) {
        let cur = m;
        if (cur.state === 'seen') {
          cur = this.transition(cur.id, 'queued', { reason: 'visibility-timeout' });
          redelivered.push(cur.id);
        }
        this.transition(cur.id, 'seen');
        out.push(this.message(cur.id));
      }
      return { messages: out.map(pub), redelivered };
    });
  }

  ownMessage(agentId, id) {
    const me = this.requireAgent(agentId);
    const m = this.message(id);
    if (!m || m.to_agent !== me.agent_id) throw usage(`no message ${id} addressed to ${me.alias}`);
    return { me, m };
  }

  ack(agentId, id) {
    return this.tx(() => {
      this.ownMessage(agentId, id);
      return publicMessage(this.transition(id, 'acknowledged'));
    });
  }

  reply(agentId, id, body = '') {
    return this.tx(() => {
      const { me, m } = this.ownMessage(agentId, id);
      if (m.type === 'question') this.transition(id, 'answered');
      const to = this.agent(m.from_agent);
      return this.insertMessage({
        from: me, to, type: 'reply', subject: clip(`Re: ${m.subject}`), body: checkBody(body),
        thread: m.thread_id, replyTo: m.id,
      });
    });
  }

  complete(agentId, id, outcome, body = '') {
    if (!['succeeded', 'failed'].includes(outcome)) throw usage('--outcome must be succeeded|failed');
    return this.tx(() => {
      const { me, m } = this.ownMessage(agentId, id);
      if (m.type !== 'task') throw usage(`illegal transition ${m.state}→${outcome === 'succeeded' ? 'completed' : 'failed'} for type ${m.type}`);
      this.transition(id, outcome === 'succeeded' ? 'completed' : 'failed');
      return this.insertMessage({
        from: me, to: this.agent(m.from_agent), type: 'report', subject: clip(`${outcome}: ${m.subject}`),
        body: checkBody(body), thread: m.thread_id, replyTo: m.id, payloadJson: JSON.stringify({ outcome }),
      });
    });
  }

  gateResolve(agentId, id, decision) {
    if (!['approve', 'reject'].includes(decision)) throw usage('--decision must be approve|reject');
    const to = decision === 'approve' ? 'approved' : 'rejected';
    return this.tx(() => {
      const { me, m } = this.ownMessage(agentId, id);
      this.transition(id, to);
      return this.insertMessage({
        from: me, to: this.agent(m.from_agent), type: 'report', subject: clip(`gate ${to}: ${m.subject}`),
        body: '', thread: m.thread_id, replyTo: m.id, payloadJson: JSON.stringify({ decision: to }),
      });
    });
  }

  answerTo(questionId) {
    const q = this.message(questionId);
    if (!q || q.state !== 'answered') return null;
    const r = this.get("SELECT * FROM messages WHERE reply_to = ? AND type = 'reply' ORDER BY seq LIMIT 1", questionId);
    return r ? publicMessage(r) : null;
  }

  // inbox(workspace) or inbox({ project }): threads in a workspace, or threads
  // whose sender or recipient belongs to the project.
  inbox(scope) {
    const rows = typeof scope === 'object' && scope && scope.project
      ? this.all(
        `SELECT m.*, fa.alias AS from_alias, ta.alias AS to_alias FROM messages m
           JOIN agents fa ON fa.agent_id = m.from_agent JOIN agents ta ON ta.agent_id = m.to_agent
         WHERE fa.project = ? OR ta.project = ? ORDER BY m.seq`,
        scope.project, scope.project,
      )
      : this.all(
        `SELECT m.*, fa.alias AS from_alias, ta.alias AS to_alias FROM messages m
           JOIN agents fa ON fa.agent_id = m.from_agent JOIN agents ta ON ta.agent_id = m.to_agent
         WHERE m.workspace = ? OR ta.workspace = ? ORDER BY m.seq`,
        scope, scope,
      );
    const threads = new Map();
    for (const m of rows) {
      let t = threads.get(m.thread_id);
      if (!t) {
        t = { thread_id: m.thread_id, subject: m.subject, participants: [], count: 0, last_seq: 0, updated_ms: 0, messages: [] };
        threads.set(m.thread_id, t);
      }
      for (const a of [m.from_alias, m.to_alias]) if (!t.participants.includes(a)) t.participants.push(a);
      t.count += 1;
      t.last_seq = m.seq;
      t.updated_ms = Math.max(t.updated_ms, m.updated_ms);
      t.messages.push({
        id: m.id, seq: m.seq, type: m.type, from: m.from_alias, to: m.to_alias, subject: m.subject,
        state: m.state, reply_to: m.reply_to, created_ms: m.created_ms,
      });
    }
    return [...threads.values()].sort((a, b) => b.last_seq - a.last_seq);
  }

  // ---------- hooks ----------

  // Lifecycle beat from an agent hook. Returns {block, unread}; block is only
  // ever true for a Claude Stop with stop_hook_active=false and unread mail.
  beat(agentId, event, input = {}, kind) {
    if (!HOOK_EVENTS.includes(event)) throw usage(`unknown hook event ${event}`);
    return this.tx(() => {
      const a = this.requireAgent(agentId);
      const now = this.nowMs();
      const effectiveKind = kind || a.kind;
      const sessionId = typeof input.session_id === 'string' ? input.session_id : a.session_id;
      if (event === 'SessionStart') {
        this.setAgentState(a, 'working', { session_started_ms: now, session_id: opt(sessionId) });
        return { block: false, unread: 0 };
      }
      if (event === 'PermissionRequest') {
        this.setAgentState(a, 'blocked');
        return { block: false, unread: 0 };
      }
      if (event === 'UserPromptSubmit') {
        this.confirmWakes(a, now);
        this.setAgentState(a, 'working', { last_prompt_ts_ms: now, session_started_ms: a.session_started_ms ?? now });
        return { block: false, unread: 0 };
      }
      // Stop
      const unread = this.visibleUnread(a.agent_id, now).length;
      const block = effectiveKind === 'claude' && input.stop_hook_active !== true && unread > 0;
      if (block) {
        // Claude keeps going with the block reason; it is not idle, so no wake.
        this.event('stop_blocked', { agent_id: a.agent_id, detail: { unread } });
        this.setAgentState(a, 'working', { wake_unconfirmed: 0, session_started_ms: a.session_started_ms ?? now });
      } else {
        this.setAgentState(a, 'idle', { last_stop_ts_ms: now, wake_unconfirmed: 0, session_started_ms: a.session_started_ms ?? now });
      }
      return { block, unread };
    });
  }

  // A UserPromptSubmit beat confirms open wake attempts made since the previous prompt.
  confirmWakes(a, now) {
    const since = a.last_prompt_ts_ms ?? -Infinity;
    const open = this.all("SELECT * FROM wakes WHERE agent_id = ? AND status IN ('planned','sent') ORDER BY planned_ms", a.agent_id);
    let confirmed = 0;
    for (const w of open) {
      const t0 = w.sent_ms ?? w.planned_ms;
      if (w.planned_ms <= since || now - t0 > WAKE_CONFIRM_MS) continue;
      this.run("UPDATE wakes SET status = 'confirmed', resolved_ms = ? WHERE attempt_id = ?", now, w.attempt_id);
      this.event('wake_confirmed', { agent_id: a.agent_id, attempt_id: w.attempt_id, from: w.status, to: 'confirmed' });
      confirmed += 1;
    }
    if (confirmed) {
      const queued = this.all("SELECT id FROM messages WHERE to_agent = ? AND state = 'queued' AND visible_after_ms <= ? ORDER BY seq", a.agent_id, now);
      for (const m of queued) this.transition(m.id, 'delivered', { reason: 'wake-confirmed' });
      if (a.wake_unconfirmed) this.run('UPDATE agents SET wake_unconfirmed = 0 WHERE agent_id = ?', a.agent_id);
    }
    return confirmed;
  }

  // ---------- wake planner ----------

  freshIdle(a, now) {
    return a.lease_expires_ms > now && a.state === 'idle' && a.last_stop_ts_ms != null &&
      a.last_stop_ts_ms > (a.last_prompt_ts_ms ?? -Infinity);
  }

  planAttempt(a, window, action, parent) {
    const id = randomUUID();
    const now = this.nowMs();
    this.run(
      "INSERT INTO wakes (attempt_id, agent_id, window_id, action, parent_attempt, status, planned_ms) VALUES (?, ?, ?, ?, ?, 'planned', ?)",
      id, a.agent_id, window, action, opt(parent), now,
    );
    this.event('wake_planned', { agent_id: a.agent_id, attempt_id: id, to: 'planned', detail: { action, window } });
    return { agent_id: a.agent_id, alias: a.alias, action, line: action === 'wake' ? WAKE_LINE : '\r', attempt_id: id };
  }

  wakePlan(window) {
    if (!window) throw usage('--window is required');
    return this.tx(() => {
      const now = this.nowMs();
      const plan = [];
      for (const a of this.all('SELECT * FROM agents WHERE window_id = ? ORDER BY alias', window)) {
        // 1. Resolve open attempts whose confirm window has passed.
        let open = false;
        for (const w of this.all("SELECT * FROM wakes WHERE agent_id = ? AND status IN ('planned','sent') ORDER BY planned_ms", a.agent_id)) {
          const t0 = w.sent_ms ?? w.planned_ms;
          if (now - t0 <= WAKE_CONFIRM_MS) { open = true; continue; }
          const status = w.status === 'sent' ? 'unconfirmed' : 'abandoned';
          this.run('UPDATE wakes SET status = ?, resolved_ms = ? WHERE attempt_id = ?', status, now, w.attempt_id);
          this.event(`wake_${status}`, { agent_id: a.agent_id, attempt_id: w.attempt_id, from: w.status, to: status, detail: { action: w.action } });
          if (status !== 'unconfirmed') continue;
          if (w.action === 'wake' && this.freshIdle(a, now) && !a.wake_unconfirmed) {
            plan.push(this.planAttempt(a, window, 'retry-enter', w.attempt_id));
            open = true;
          } else if (w.action === 'retry-enter') {
            this.run('UPDATE agents SET wake_unconfirmed = 1 WHERE agent_id = ?', a.agent_id);
            a.wake_unconfirmed = 1;
            this.event('wake_flagged_unconfirmed', { agent_id: a.agent_id, attempt_id: w.attempt_id });
          }
        }
        if (open || a.wake_unconfirmed || !this.freshIdle(a, now)) continue;
        // 2. New wake only for mail queued since the last confirmed wake.
        if (!this.visibleUnread(a.agent_id, now).some((m) => m.state === 'queued')) continue;
        plan.push(this.planAttempt(a, window, 'wake'));
      }
      return plan;
    });
  }

  wakeSent(attemptId) {
    return this.tx(() => {
      const w = this.get('SELECT * FROM wakes WHERE attempt_id = ?', attemptId);
      if (!w) throw usage(`no such wake attempt ${attemptId}`);
      const now = this.nowMs();
      if (w.status === 'planned') {
        this.run("UPDATE wakes SET status = 'sent', sent_ms = ? WHERE attempt_id = ?", now, attemptId);
        this.event('wake_sent', { agent_id: w.agent_id, attempt_id: attemptId, from: 'planned', to: 'sent' });
        return { attempt_id: attemptId, status: 'sent' };
      }
      // Already confirmed (prompt beat raced the wake-sent call) or resolved: record, keep status.
      if (w.sent_ms == null) this.run('UPDATE wakes SET sent_ms = ? WHERE attempt_id = ?', now, attemptId);
      this.event('wake_sent', { agent_id: w.agent_id, attempt_id: attemptId, from: w.status, to: w.status });
      return { attempt_id: attemptId, status: w.status };
    });
  }

  wakes(agentId) {
    return this.all('SELECT * FROM wakes WHERE agent_id = ? ORDER BY planned_ms', agentId);
  }
}

function clip(s) {
  const line = s.replace(/[\r\n]+/g, ' ');
  return line.length > SUBJECT_MAX ? line.slice(0, SUBJECT_MAX) : line;
}

function checkBody(body) {
  if (typeof body !== 'string') throw usage('body must be text');
  if (Buffer.byteLength(body, 'utf8') > BODY_MAX_BYTES) throw usage(`body exceeds ${BODY_MAX_BYTES} bytes`);
  return body;
}

export function publicMessage(m) {
  return {
    id: m.id, seq: m.seq, type: m.type, from: m.from_agent, to: m.to_agent, thread_id: m.thread_id,
    reply_to: m.reply_to, subject: m.subject, body: m.body,
    payload: m.payload_json ? JSON.parse(m.payload_json) : null,
    state: m.state, delivery_count: m.delivery_count, created_ms: m.created_ms,
  };
}

export { sleepMs };
