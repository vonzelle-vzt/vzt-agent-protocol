#!/usr/bin/env node
// `vzt-agent bus <verb>` — the VZT agent bus CLI.
// Contract: .vzt/ship/vscode-agent-bus/SPEC.md ("CLI", "Hooks", "Wake protocol").
// Exit codes: 0 ok, 2 usage/validation, 3 inside Orca, 4 conflict, 5 ask timeout,
// 70 no node:sqlite. stdout is JSON only with --json; diagnostics go to stderr.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AGENT_ARGV, BOOTSTRAP_PROMPT, RESUME_ARGV } from '../agent-argv.mjs';
import { trustClaudeWorkspace } from '../claude-trust.mjs';

export const BUS_HOOK_MARKER = 'vzt-bus-hook-form=1';
export const BUS_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const EVENT_SNAKE = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  PermissionRequest: 'permission_request',
};

const NO_SQLITE = 'vzt-agent bus needs node:sqlite (Node >= 22.13); this is Node ' + process.versions.node;
const ORCA_EXEMPT = ['doctor', 'argv', 'bootstrap-prompt'];
const ORCA_REFUSAL = 'inside Orca, use `orca orchestration send/check/reply`';

const OPTIONS = {
  json: { type: 'boolean' },
  alias: { type: 'string' },
  kind: { type: 'string' },
  window: { type: 'string' },
  workspace: { type: 'string' },
  peer: { type: 'string' },
  to: { type: 'string' },
  type: { type: 'string' },
  subject: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  thread: { type: 'string' },
  'reply-to': { type: 'string' },
  key: { type: 'string' },
  payload: { type: 'string' },
  'cross-workspace': { type: 'string' },
  peek: { type: 'boolean' },
  wait: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  id: { type: 'string' },
  outcome: { type: 'string' },
  decision: { type: 'string' },
  agents: { type: 'string' },
  attempt: { type: 'string' },
  all: { type: 'boolean' },
  project: { type: 'boolean' },
  resume: { type: 'string' },
  agent: { type: 'string' },
  'from-window': { type: 'string' },
  task: { type: 'string' },
  request: { type: 'string' },
  worker: { type: 'string' },
  error: { type: 'string' },
  'no-wait': { type: 'boolean' },
};

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function loadStore() {
  try {
    await import('node:sqlite');
  } catch {
    throw new CliError(70, NO_SQLITE);
  }
  return import('./store.mjs');
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

export function resolveWorkspace(dir) {
  const start = path.resolve(dir || process.cwd());
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return fs.realpathSync(top);
  } catch {
    if (!fs.existsSync(start)) throw new CliError(2, `workspace ${start} does not exist`);
    return fs.realpathSync(start);
  }
}

// The project is the main checkout every worktree of a repo shares: the parent
// of `git rev-parse --git-common-dir` (or the common dir itself for a bare repo).
export function resolveProject(dir) {
  const start = path.resolve(dir || process.cwd());
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return resolveWorkspace(dir);
  }
  return fs.realpathSync(path.basename(common) === '.git' ? path.dirname(common) : common);
}

function req(values, name) {
  const v = values[name];
  if (v === undefined || v === '') throw new CliError(2, `--${name} is required`);
  return v;
}

function timeoutMs(values, dflt) {
  if (values['timeout-ms'] === undefined) return dflt;
  const n = Number(values['timeout-ms']);
  if (!Number.isFinite(n) || n < 0) throw new CliError(2, '--timeout-ms must be a non-negative number');
  return n;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-=./:@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function emit(out, result, json) {
  if (json) {
    out.write(JSON.stringify(result) + '\n');
  } else if (typeof result === 'string') {
    out.write(result + '\n');
  } else {
    out.write(JSON.stringify(result, null, 2) + '\n');
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---------- doctor ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function markedEvents(hooksObj) {
  const wired = [];
  for (const ev of BUS_HOOK_EVENTS) {
    const groups = (hooksObj && hooksObj[ev]) || [];
    if (groups.some((g) => (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(BUS_HOOK_MARKER)))) {
      wired.push(ev);
    }
  }
  return wired;
}

// Minimal reader for `[hooks.state."<key>"]` tables in Codex config.toml.
export function parseHookTrust(toml) {
  const state = new Map();
  let current = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const m = line.match(/^\[\s*hooks\.state\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]$/);
      current = m ? (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]) : null;
      if (current !== null) state.set(current, {});
      continue;
    }
    if (current === null) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    let v = kv[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (v === 'true' || v === 'false') v = v === 'true';
    state.get(current)[kv[1]] = v;
  }
  return state;
}

export function doctor({ sqlite }) {
  const home = homeDir();
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  const claudeWired = markedEvents((readJson(claudeSettings) || {}).hooks);

  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const configPath = path.join(codexHome, 'config.toml');
  const hooksJson = readJson(hooksPath) || {};
  let trustState = new Map();
  try { trustState = parseHookTrust(fs.readFileSync(configPath, 'utf8')); } catch { /* no config */ }
  const wired = [];
  const trusted = [];
  const untrusted = [];
  for (const ev of BUS_HOOK_EVENTS) {
    const groups = (hooksJson.hooks && hooksJson.hooks[ev]) || [];
    groups.forEach((g, i) => (g.hooks || []).forEach((h, j) => {
      if (typeof h.command !== 'string' || !h.command.includes(BUS_HOOK_MARKER)) return;
      if (!wired.includes(ev)) wired.push(ev);
      const key = `${hooksPath}:${EVENT_SNAKE[ev]}:${i}:${j}`;
      const st = trustState.get(key);
      const ok = st && typeof st.trusted_hash === 'string' && st.trusted_hash !== '' && st.enabled !== false;
      (ok ? trusted : untrusted).push(key);
    }));
  }
  const dir = process.env.VZT_BUS_DIR || path.join(home, '.vzt', 'bus');
  const dbPath = path.join(dir, 'bus.db');
  return {
    node_sqlite: sqlite,
    node_version: process.versions.node,
    db: { path: dbPath, exists: fs.existsSync(dbPath) },
    claude_hooks: {
      settings: claudeSettings,
      wired: claudeWired,
      missing: BUS_HOOK_EVENTS.filter((e) => !claudeWired.includes(e)),
    },
    codex_hooks: {
      hooks_json: hooksPath,
      wired,
      missing: BUS_HOOK_EVENTS.filter((e) => !wired.includes(e)),
      trusted,
      untrusted,
    },
  };
}

// ---------- self-joined agents (VZT_BUS_AGENT=auto) ----------

// A VS Code window exports VZT_BUS_AGENT=auto (and VZT_BUS_WINDOW) to every
// terminal, so claude/codex started there by hand joins the bus the way an
// Orca pane's agent joins Orca. Agents the extension starts itself carry their
// id in VZT_BUS_AGENT_ID, which wins.
export const AUTO = 'auto';

/** [{pid, ppid, comm}] of every process; [] when ps fails. */
export function psTable() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] }));
  } catch {
    return [];
  }
}

/** `start` and its ancestors, nearest first, each with its command name. */
export function ancestry(start, rows) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain = [];
  for (let pid = start, n = 0; pid > 1 && n < 64; n += 1) {
    const r = byPid.get(pid);
    if (!r) break;
    chain.push(r);
    pid = r.ppid;
  }
  return chain;
}

/** The nearest claude/codex process above the caller: {pid, kind} or undefined. */
export function agentProcess(chain) {
  for (const r of chain) {
    const name = path.basename(r.comm).replace(/^-/, '');
    if (name === 'claude' || name === 'codex') return { pid: r.pid, kind: name };
  }
  return undefined;
}

/** The caller's agent_id: VZT_BUS_AGENT_ID, an explicit VZT_BUS_AGENT, or (auto) its process tree. */
export function callerAgent(store, env = process.env, chain = () => ancestry(process.pid, psTable())) {
  if (env.VZT_BUS_AGENT_ID) return env.VZT_BUS_AGENT_ID;
  const v = env.VZT_BUS_AGENT;
  if (v !== AUTO) return v;
  const a = store.agentByPids(chain().map((r) => r.pid));
  return a ? a.agent_id : undefined;
}

// ---------- hook ----------

// Register (or find) the self-joined agent behind this hook. Undefined when
// the hook does not run under claude/codex or the window is unknown.
function autoJoin(store, input) {
  const window = process.env.VZT_BUS_WINDOW;
  if (!window) return undefined;
  const proc = agentProcess(ancestry(process.ppid, psTable()));
  if (!proc) return undefined;
  const cwd = typeof input.cwd === 'string' && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  const workspace = resolveWorkspace(cwd);
  const r = store.autoRegister({
    workspace,
    project: resolveProject(cwd),
    base: path.basename(workspace),
    kind: proc.kind,
    window,
    sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
    agentPid: proc.pid,
  });
  return { agent_id: r.agent_id, alias: r.alias, kind: proc.kind, fresh: !r.reused };
}

async function runHook(event, io) {
  // Exits 0 ALWAYS: a broken bus must never wedge an agent.
  let agentId = process.env.VZT_BUS_AGENT_ID || process.env.VZT_BUS_AGENT;
  if (!agentId) return 0;
  try {
    if (process.env.ORCA_TERMINAL_HANDLE) {
      io.err.write(`vzt-bus hook: ${ORCA_REFUSAL}\n`);
      return 0;
    }
    let input = {};
    const raw = readStdin();
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object') input = parsed;
    } catch {
      io.err.write('vzt-bus hook: stdin is not JSON; continuing\n');
    }
    const { openStore } = await loadStore();
    const store = openStore();
    try {
      let kind = process.env.VZT_BUS_KIND || undefined;
      let joined;
      if (agentId === AUTO) {
        joined = autoJoin(store, input);
        if (!joined) return 0;
        agentId = joined.agent_id;
        kind = joined.kind;
      }
      const { block, unread } = store.beat(agentId, event, input, kind, { startIdle: !!joined });
      if (joined && event === 'SessionStart') {
        // Tell the agent it is on the bus, as a spawned agent's first prompt does.
        io.out.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: BOOTSTRAP_PROMPT(joined.alias) },
        }) + '\n');
      }
      if (block) {
        io.out.write(JSON.stringify({
          decision: 'block',
          reason: `VZT: ${unread} new bus message(s). Run: vzt-agent bus check --json`,
        }) + '\n');
      }
    } finally {
      store.close();
    }
  } catch (err) {
    io.err.write(`vzt-bus hook ${event}: ${err && err.message ? err.message : err}\n`);
  }
  return 0;
}

// ---------- main ----------

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const [verb, ...rest] = argv;
  if (!verb || verb === 'help' || verb === '--help') {
    io.err.write('usage: vzt-agent bus <register|adopt|argv|bootstrap-prompt|trust-claude|send|check|ack|reply|ask|complete|gate-resolve|agents|inbox|lease|wake-plan|wake-sent|spawn|spawn-claim|spawn-done|spawn-status|hook|doctor> [--json]\n');
    return verb ? 0 : 2;
  }
  if (verb === 'hook') return runHook(rest[0], io);
  let json = false;
  try {
    // Orca seam: verbs that touch the bus refuse inside Orca. doctor, argv and
    // bootstrap-prompt only print constants/diagnostics, so they stay usable.
    if (!ORCA_EXEMPT.includes(verb) && process.env.ORCA_TERMINAL_HANDLE) throw new CliError(3, ORCA_REFUSAL);
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }));
    } catch (err) {
      throw new CliError(2, err.message);
    }
    json = !!values.json;

    if (verb === 'doctor') {
      let sqlite = true;
      try { await import('node:sqlite'); } catch { sqlite = false; }
      emit(io.out, doctor({ sqlite }), json);
      return 0;
    }
    if (verb === 'argv') {
      const kind = req(values, 'kind');
      if (!AGENT_ARGV[kind]) throw new CliError(2, `--kind must be one of ${Object.keys(AGENT_ARGV).join('|')}`);
      let argvOut;
      try {
        argvOut = values.resume !== undefined ? RESUME_ARGV(kind, values.resume) : [...AGENT_ARGV[kind]];
      } catch (err) {
        throw new CliError(2, `--resume: ${err.message}`);
      }
      emit(io.out, json ? argvOut : argvOut.map(shellQuote).join(' '), json);
      return 0;
    }
    if (verb === 'trust-claude') {
      // Pre-accept Claude's folder-trust dialog (see cli/claude-trust.mjs) for
      // the folder claude will start in AND its git workspace. The CALLER owns
      // the decision: the VS Code pair only calls this when VS Code itself
      // trusts the workspace.
      const dirs = [...new Set([fs.realpathSync(path.resolve(values.workspace || process.cwd())), resolveWorkspace(values.workspace)])];
      const results = dirs.map((d) => ({ dir: d, trusted: trustClaudeWorkspace(d, { log: (m) => io.err.write(m + '\n') }) }));
      const ok = results.every((r) => r.trusted);
      emit(io.out, json ? { trusted: ok, dirs: results } : results.map((r) => `${r.trusted ? 'trusted' : 'NOT trusted'} ${r.dir}`).join('\n'), json);
      return ok ? 0 : 1;
    }
    if (verb === 'bootstrap-prompt') {
      const prompt = BOOTSTRAP_PROMPT(req(values, 'alias'), values.peer || undefined);
      emit(io.out, json ? { prompt } : prompt, json);
      return 0;
    }

    const { openStore, BusError, sleepMs } = await loadStore();
    let store;
    try {
      store = openStore();
      const me = callerAgent(store);
      const result = await runVerb(verb, values, store, me, sleepMs);
      if (result && result.exitCode) {
        io.err.write(result.message + '\n');
        return result.exitCode;
      }
      emit(io.out, result, json);
      return 0;
    } catch (err) {
      if (err instanceof BusError) throw new CliError(err.code, err.message);
      throw err;
    } finally {
      if (store) store.close();
    }
  } catch (err) {
    if (err instanceof CliError) {
      io.err.write(`vzt-agent bus ${verb}: ${err.message}\n`);
      return err.code;
    }
    io.err.write(`vzt-agent bus ${verb}: ${err && err.stack ? err.stack : err}\n`);
    return 1;
  }
}

async function runVerb(verb, values, store, me, sleepMs) {
  switch (verb) {
    case 'register': {
      const r = store.register({
        workspace: resolveWorkspace(values.workspace),
        project: resolveProject(values.workspace),
        alias: req(values, 'alias'),
        kind: req(values, 'kind'),
        window: req(values, 'window'),
      });
      return { agent_id: r.agent_id, alias: r.alias, workspace: r.workspace, project: r.project, reused: r.reused };
    }
    case 'adopt':
      return store.adopt(req(values, 'agent'), req(values, 'window'), values['from-window']);
    case 'send': {
      if (values.body !== undefined && values['body-file'] !== undefined) throw new CliError(2, 'use --body or --body-file, not both');
      let body = values.body ?? '';
      if (values['body-file'] !== undefined) {
        try { body = fs.readFileSync(values['body-file'], 'utf8'); } catch (err) { throw new CliError(2, `--body-file: ${err.message}`); }
      }
      return store.send({
        fromId: me,
        toAlias: req(values, 'to'),
        type: req(values, 'type'),
        subject: req(values, 'subject'),
        body,
        threadId: values.thread,
        replyTo: values['reply-to'],
        key: values.key,
        payload: values.payload,
        workspace: values['cross-workspace'] !== undefined ? resolveWorkspace(values['cross-workspace']) : undefined,
      });
    }
    case 'check': {
      const deadline = Date.now() + timeoutMs(values, 30_000);
      for (;;) {
        const r = store.check(me, { peek: !!values.peek });
        if (!values.wait || r.messages.length || Date.now() >= deadline) return r;
        sleepMs(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    case 'ack':
      return store.ack(me, req(values, 'id'));
    case 'reply':
      return store.reply(me, req(values, 'id'), values.body ?? '');
    case 'ask': {
      const sent = store.send({
        fromId: me, toAlias: req(values, 'to'), type: 'question',
        subject: req(values, 'subject'), body: values.body ?? '',
      });
      const deadline = Date.now() + timeoutMs(values, 600_000);
      for (;;) {
        const answer = store.answerTo(sent.id);
        if (answer) return { id: sent.id, answer };
        if (Date.now() >= deadline) return { exitCode: 5, message: `vzt-agent bus ask: no answer to ${sent.id} before timeout` };
        sleepMs(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    case 'complete':
      return store.complete(me, req(values, 'id'), req(values, 'outcome'), values.body ?? '');
    case 'gate-resolve':
      return store.gateResolve(me, req(values, 'id'), req(values, 'decision'));
    case 'agents':
      if (values.all) return { agents: store.agents({}) };
      return { agents: store.agents(values.project ? { project: resolveProject(values.workspace) } : { workspace: resolveWorkspace(values.workspace) }) };
    case 'inbox':
      return { threads: store.inbox(values.project ? { project: resolveProject(values.workspace) } : resolveWorkspace(values.workspace)) };
    case 'lease': {
      const pairs = req(values, 'agents').split(',').filter(Boolean).map((p) => {
        const [agent_id, pid] = p.split(':');
        if (!agent_id || !/^\d+$/.test(pid || '')) throw new CliError(2, `--agents entry "${p}" must be id:pid`);
        return { agent_id, pid: Number(pid) };
      });
      return store.lease(req(values, 'window'), pairs);
    }
    case 'wake-plan':
      return store.wakePlan(req(values, 'window'));
    case 'spawn': {
      // Orca worker-start: a worker pane beside the caller, its task queued from the caller.
      const { requestSpawn, spawnStatus } = await import('./spawnq.mjs');
      const caller = me ? store.agent(me) : undefined;
      if (me && !caller) throw new CliError(2, `unknown agent ${me}`);
      let task = values.task;
      if (task === undefined && values['body-file'] !== undefined) {
        try { task = fs.readFileSync(values['body-file'], 'utf8'); } catch (err) { throw new CliError(2, `--body-file: ${err.message}`); }
      }
      const r = requestSpawn(store, caller, {
        kind: req(values, 'kind'), task, subject: values.subject,
        workspace: values.workspace ? resolveWorkspace(values.workspace) : undefined,
      });
      if (values['no-wait']) return { request_id: r.id, status: r.status };
      // Wait for the window to start it (it polls every 3 s), so the caller learns the worker's alias now.
      const deadline = Date.now() + timeoutMs(values, 60_000);
      for (;;) {
        const s = spawnStatus(r.id) || r;
        if (s.status === 'started') {
          return { request_id: r.id, status: 'started', worker: s.worker_alias, task_message: s.message,
            next: `end your turn; you are woken when ${s.worker_alias} reports (bus complete)` };
        }
        if (s.status === 'failed') return { exitCode: 1, message: `vzt-agent bus spawn: worker not started — ${s.error}` };
        if (Date.now() >= deadline) {
          return { request_id: r.id, status: s.status, next: `still ${s.status}; check with: vzt-agent bus spawn-status --request ${r.id}` };
        }
        sleepMs(250);
      }
    }
    case 'spawn-claim': {
      const { claimSpawns } = await import('./spawnq.mjs');
      return claimSpawns(req(values, 'window'));
    }
    case 'spawn-done': {
      const { settleSpawn } = await import('./spawnq.mjs');
      return settleSpawn(store, req(values, 'request'), { worker: values.worker, error: values.error });
    }
    case 'spawn-status': {
      const { spawnStatus } = await import('./spawnq.mjs');
      const s = spawnStatus(req(values, 'request'));
      if (!s) throw new CliError(2, `no spawn request ${values.request}`);
      return s;
    }
    case 'wake-sent':
      return store.wakeSent(req(values, 'attempt'));
    default:
      throw new CliError(2, `unknown verb "${verb}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
