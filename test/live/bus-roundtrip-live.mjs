#!/usr/bin/env node
// Live gate for the VZT agent bus: a real Claude → Codex → Claude round trip.
// Contract: .vzt/ship/vscode-agent-bus/SPEC.md ("Wake protocol", "VS Code (u3)").
//
// This plays the VS Code extension without VS Code: two real agents run under
// PTYs (test/live/pty_host.py), and every 1500 ms the harness renews their
// leases, asks `bus wake-plan` what to type, types it exactly as the extension
// does (line, 400 ms, bare '\r'; retry-enter = '\r' only), then `bus wake-sent`.
//
// NOT part of `npm test`: it launches real agents, takes minutes and spends
// model quota. Run it by hand after `vzt-agent install` and trusting the four
// Codex hooks via /hooks:   node test/live/bus-roundtrip-live.mjs
//
// Exit 0 = pass; 1 = fail (reason and each PTY's screen tail on stderr).

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.resolve(HERE, '..', '..'));
const PTY_HOST = path.join(HERE, 'pty_host.py');
const WINDOW = 'live';
const HARNESS_WINDOW = 'live-harness';
const POLL_MS = 1500;
const ENTER_DELAY_MS = 400;
const NEVER_STARTED_MS = 90_000;
const DEADLINE_MS = 10 * 60_000;

const RUN = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const RUN_DIR = path.join(REPO, '.vzt', 'live-bus', RUN);
const BUS_DIR = path.join(RUN_DIR, 'bus');
const ANSWER = path.join(RUN_DIR, 'answer.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stderr.write(`[live-bus] ${line}\n`);

// Children must not look like they run inside Orca (the bus exits 3 there, and
// Orca's own agent hooks would fire) or inside this Claude Code session.
function baseEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ORCA_')) delete env[k];
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.VZT_BUS_AGENT;
  delete env.VZT_BUS_KIND;
  delete env.VZT_BUS_WINDOW;
  env.VZT_BUS_DIR = BUS_DIR;
  return env;
}

// `vzt-agent bus <args>` by name — the same binary the agents and their hooks call.
function bus(args, { agent, json = true } = {}) {
  const env = baseEnv();
  if (agent) env.VZT_BUS_AGENT = agent;
  const argv = ['bus', ...args, ...(json ? ['--json'] : [])];
  return new Promise((resolve, reject) => {
    execFile('vzt-agent', argv, { cwd: REPO, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`vzt-agent ${argv.join(' ')} failed (exit ${err.code}): ${String(stderr || err.message).trim()}`));
        return;
      }
      if (!json) return resolve(stdout);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`vzt-agent ${argv.join(' ')} did not print JSON — is the installed vzt-agent too old to have \`bus\`? stdout began: ${stdout.slice(0, 120)}`));
      }
    });
  });
}

// ---------- PTY hosts ----------

class PtyAgent {
  constructor(alias, argv, env) {
    this.alias = alias;
    this.pid = null;
    this.exited = false;
    this.tailWaiters = [];
    this.proc = spawn('python3', [PTY_HOST, '--cwd', REPO, '--', ...argv], {
      cwd: REPO, env, stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.started = new Promise((resolve, reject) => {
      this.proc.once('error', reject);
      let pending = '';
      this.proc.stdout.on('data', (chunk) => {
        pending += chunk;
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'started') { this.pid = msg.pid; resolve(msg.pid); }
          if (msg.type === 'tail') this.tailWaiters.shift()?.(msg.data);
          if (msg.type === 'exit') this.exited = true;
        }
      });
    });
    this.proc.once('exit', () => {
      this.exited = true;
      for (const w of this.tailWaiters.splice(0)) w('(pty host exited)');
    });
  }

  command(obj) {
    if (this.exited || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  text(data) {
    return this.command({ type: 'text', data });
  }

  tail() {
    return new Promise((resolve) => {
      if (!this.command({ type: 'tail' })) return resolve('(pty host exited)');
      this.tailWaiters.push(resolve);
      setTimeout(() => resolve('(no tail reply within 3 s)'), 3000).unref();
    });
  }

  alive() {
    if (this.exited || !this.pid) return false;
    try { process.kill(this.pid, 0); return true; } catch { return false; }
  }

  kill() {
    if (this.proc.exitCode !== null) return;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

const ptys = [];
function killAll() {
  for (const p of ptys) p.kill();
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAll(); process.exit(1); });
}

async function fail(reason) {
  log(`FAIL: ${reason}`);
  for (const p of ptys) {
    const tail = await p.tail();
    process.stderr.write(`\n----- ${p.alias} screen tail (pid ${p.pid}) -----\n${tail}\n----- end ${p.alias} -----\n`);
  }
  if (fs.existsSync(RUN_DIR)) log(`run dir: ${RUN_DIR}`);
  killAll();
  process.exit(1);
}

// ---------- the extension's poll, replayed ----------

async function executeWakeAction(action, pty) {
  if (action.action === 'wake') {
    pty.text(action.line);
    await sleep(ENTER_DELAY_MS);
    pty.text('\r');
  } else if (action.action === 'retry-enter') {
    pty.text('\r');
  }
}

async function poll(byId) {
  const pairs = [...byId].filter(([, p]) => p.alive()).map(([id, p]) => `${id}:${p.pid}`);
  if (pairs.length) await bus(['lease', '--window', WINDOW, '--agents', pairs.join(',')]);
  const plan = await bus(['wake-plan', '--window', WINDOW]);
  for (const action of plan) {
    const pty = byId.get(action.agent_id);
    if (!pty) continue;
    log(`${action.action} → ${action.alias}`);
    await executeWakeAction(action, pty);
    await bus(['wake-sent', '--attempt', action.attempt_id]);
  }
}

// ---------- main ----------

async function main() {
  // 1. Preflight — refuse exactly where the Pair command refuses, plus missing hooks.
  let doctor;
  try {
    doctor = await bus(['doctor']);
  } catch (err) {
    await fail(`\`vzt-agent bus doctor --json\`: ${err.message}`);
  }
  if (doctor.node_sqlite !== true) {
    await fail(`node_sqlite is false — vzt-agent runs on Node ${doctor.node_version}; the bus needs Node >= 22.13`);
  }
  const codex = doctor.codex_hooks || {};
  const claude = doctor.claude_hooks || {};
  if ((codex.untrusted || []).length) {
    await fail(`Codex bus hooks are untrusted (${codex.untrusted.length}): open codex, run /hooks, trust the 4 vzt-bus hooks`);
  }
  if ((codex.missing || []).length || (claude.missing || []).length) {
    await fail(`bus hooks not installed (codex missing: ${(codex.missing || []).join(',') || '-'}; claude missing: ${(claude.missing || []).join(',') || '-'}) — run \`vzt-agent install\``);
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  log(`run ${RUN}; workspace ${REPO}; VZT_BUS_DIR ${BUS_DIR}`);

  // 2. Register the pair (window 'live') and the scenario driver (its own window,
  //    so the wake planner never types into a terminal that does not exist).
  const reg = {};
  for (const [alias, kind, window] of [['claude', 'claude', WINDOW], ['codex', 'codex', WINDOW], ['harness', 'claude', HARNESS_WINDOW]]) {
    reg[alias] = (await bus(['register', '--alias', alias, '--kind', kind, '--window', window, '--workspace', REPO])).agent_id;
  }

  // 3. Launch both agents exactly as Pair does: pre-accept Claude's folder-trust
  //    dialog (Pair does this once VS Code trusts the workspace; this repo is
  //    the operator's own), then house argv + one bootstrap prompt.
  await bus(['trust-claude', '--workspace', REPO]);
  const byId = new Map();
  for (const [alias, peer] of [['claude', 'codex'], ['codex', 'claude']]) {
    const argv = await bus(['argv', '--kind', alias]);
    const { prompt } = await bus(['bootstrap-prompt', '--alias', alias, '--peer', peer]);
    const env = {
      ...baseEnv(),
      VZT_BUS_AGENT: reg[alias],
      VZT_BUS_KIND: alias,
      VZT_BUS_WINDOW: WINDOW,
      ...(alias === 'claude' ? { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' } : {}),
    };
    const pty = new PtyAgent(alias, [...argv, prompt], env);
    ptys.push(pty);
    await pty.started;
    byId.set(reg[alias], pty);
    log(`launched ${alias} (pid ${pty.pid})`);
  }

  // 4. The scenario: harness hands claude a task that needs codex's answer.
  const body = [
    'Live bus gate. Do exactly this, using the shell:',
    '1. Ack this task: vzt-agent bus ack --id <this task id from your check output>',
    "2. Ask codex: vzt-agent bus ask --to codex --subject 'value of 6*7' --body 'What is 6*7? Reply via vzt-agent bus reply with only the number.' --timeout-ms 110000 --json",
    '   If it exits 5 (timeout), do NOT ask again: run vzt-agent bus check --wait --timeout-ms 110000 --json until the reply from codex arrives.',
    `3. Write ONLY the answer (no other text) to: ${ANSWER}`,
    '4. Finish: vzt-agent bus complete --id <this task id> --outcome succeeded',
  ].join('\n');
  const task = await bus(['send', '--to', 'claude', '--type', 'task', '--key', 'live-1',
    '--subject', 'live gate: ask codex for 6*7', '--body', body], { agent: reg.harness });
  log(`task ${task.id} sent to claude`);

  // 5. Poll like the extension until pass, fail, or the deadline.
  const t0 = Date.now();
  const { DatabaseSync } = await import('node:sqlite');
  let lastErr = '';
  while (Date.now() - t0 < DEADLINE_MS) {
    const tick = Date.now();
    try {
      await poll(byId);
      lastErr = '';
    } catch (err) {
      if (err.message !== lastErr) log(`poll error: ${err.message}`);
      lastErr = err.message;
    }

    const { agents } = await bus(['agents', '--workspace', REPO]);
    for (const a of agents) {
      if (!byId.has(a.agent_id)) continue;
      if (a.liveness === 'never-started' && Date.now() - t0 >= NEVER_STARTED_MS) {
        await fail(`${a.alias} is never-started: no SessionStart beat ${Math.round((Date.now() - t0) / 1000)} s after launch (hook not firing, or the TUI is stuck on a dialog)`);
      }
      if (a.wake_unconfirmed) {
        await fail(`${a.alias} ended wake_unconfirmed: the wake line and a retry Enter were typed but no UserPromptSubmit beat arrived`);
      }
    }
    for (const p of ptys) if (p.exited) await fail(`${p.alias} exited before the round trip finished`);

    const answer = fs.existsSync(ANSWER) ? fs.readFileSync(ANSWER, 'utf8') : '';
    const db = new DatabaseSync(path.join(BUS_DIR, 'bus.db'), { readOnly: true });
    let taskRow; let report; let codexConfirmed;
    try {
      taskRow = db.prepare('SELECT state FROM messages WHERE id = ?').get(task.id);
      report = db.prepare("SELECT payload_json FROM messages WHERE reply_to = ? AND type = 'report'").get(task.id);
      codexConfirmed = db.prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind = 'wake_confirmed'").get(reg.codex).n;
    } finally {
      db.close();
    }
    const outcome = report && report.payload_json ? JSON.parse(report.payload_json).outcome : null;

    if (taskRow?.state === 'failed') await fail(`claude completed the task as failed`);
    if (/\b42\b/.test(answer) && taskRow?.state === 'completed' && outcome === 'succeeded' && codexConfirmed >= 1) {
      log(`PASS in ${Math.round((Date.now() - t0) / 1000)} s: answer.txt=${JSON.stringify(answer.trim())}, task completed/succeeded, codex confirmed wakes=${codexConfirmed}`);
      killAll();
      process.exit(0);
    }

    await sleep(Math.max(0, POLL_MS - (Date.now() - tick)));
  }
  await fail(`no round trip within ${DEADLINE_MS / 60_000} min (answer.txt ${fs.existsSync(ANSWER) ? 'present' : 'absent'})`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
