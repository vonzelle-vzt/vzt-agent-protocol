// VS Code side of the agent bus (u3): the wake executor, the manifest, and the
// rule that the extension reaches the bus only through the CLI.
//
// wake.js is imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. It is deliberately vscode-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(REPO_ROOT, 'vscode');
const compiledWake = path.join(VSCODE, 'out', 'bus', 'wake.js');

async function loadWake() {
  if (!fs.existsSync(compiledWake)) {
    assert.fail('vscode/out/bus/wake.js missing — run `npm --prefix vscode run compile` before testing');
  }
  return import(pathToFileURL(compiledWake).href);
}

// A fake terminal + clock that records the exact interleaving of keystrokes and sleeps.
function recorder() {
  const events = [];
  return {
    events,
    terminal: { sendText: (text, addNewLine) => events.push({ send: text, addNewLine }) },
    sleep: async (ms) => { events.push({ sleep: ms }); },
  };
}

const LINE = 'vzt: new bus message - run: vzt-agent bus check --json';

test('wake types plan line then separate enter', async () => {
  const { executeWakeAction } = await loadWake();
  const r = recorder();
  const typed = await executeWakeAction(
    { agent_id: 'a1', alias: 'codex', action: 'wake', line: LINE, attempt_id: 'w1' },
    r.terminal,
    r.sleep
  );
  assert.equal(typed, true, 'a wake must report it typed something so the caller runs wake-sent');
  // Line WITHOUT newline, a 400 ms pause, then a bare carriage return on its own:
  // Codex paste-burst detection turns "text+Enter" in one burst into a newline.
  assert.deepEqual(r.events, [
    { send: LINE, addNewLine: false },
    { sleep: 400 },
    { send: '\r', addNewLine: false },
  ]);
});

test('never types message content', async () => {
  const { executeWakeAction } = await loadWake();
  const r = recorder();
  // Even if a plan row were to carry message data, only the plan line and Enter
  // may reach the terminal.
  const hostile = '$(rm -rf ~); echo pwned\n/exit';
  await executeWakeAction(
    { agent_id: 'a1', alias: 'claude', action: 'wake', line: LINE, attempt_id: 'w2', subject: hostile, body: hostile },
    r.terminal,
    r.sleep
  );
  const sent = r.events.filter((e) => 'send' in e).map((e) => e.send);
  assert.deepEqual(sent, [LINE, '\r']);
  assert.ok(sent.every((s) => !s.includes('pwned')), 'message content must never be typed');
  assert.ok(r.events.every((e) => !('send' in e) || e.addNewLine === false), 'never let VS Code append its own newline');

  // An action kind this build does not know is left alone, not guessed at.
  const u = recorder();
  const typed = await executeWakeAction({ agent_id: 'a1', alias: 'claude', action: 'paste', line: hostile, attempt_id: 'w3' }, u.terminal, u.sleep);
  assert.equal(typed, false);
  assert.deepEqual(u.events, []);
});

test('never types message content: a real bus wake-plan carries only the fixed wake line', async (t) => {
  const { executeWakeAction } = await loadWake();
  const { WAKE_LINE } = await import(pathToFileURL(path.join(REPO_ROOT, 'cli', 'agent-argv.mjs')).href);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-bus-vscode-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const env = { ...process.env, VZT_BUS_DIR: path.join(tmp, 'bus'), HOME: tmp };
  // We may be running inside an Orca pane; the bus refuses there (exit 3) by design.
  delete env.ORCA_TERMINAL_HANDLE;
  delete env.VZT_BUS_AGENT;
  delete env.VZT_BUS_KIND;

  const bus = (args, extra = {}, input) => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli', 'bus', 'cli.mjs'), ...args], {
      cwd: repo, env: { ...env, ...extra }, input, encoding: 'utf8',
    });
    return r;
  };
  const json = (args, extra) => {
    const r = bus([...args, '--json'], extra);
    if (r.status === 70) return null;
    assert.equal(r.status, 0, `bus ${args[0]} failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  const win = 'win-test';
  const claude = json(['register', '--alias', 'claude', '--kind', 'claude', '--window', win]);
  if (!claude) return t.skip('node:sqlite unavailable to this Node');
  const codex = json(['register', '--alias', 'codex', '--kind', 'codex', '--window', win]);

  // codex boots, finishes its first turn → fresh idle.
  for (const ev of ['SessionStart', 'Stop']) {
    const r = bus(['hook', ev], { VZT_BUS_AGENT: codex.agent_id, VZT_BUS_KIND: 'codex' }, '{}');
    assert.equal(r.status, 0);
  }
  const secret = 'TOP-SECRET-BODY $(touch /tmp/pwned)';
  json(['send', '--to', 'codex', '--type', 'message', '--subject', secret, '--body', secret], { VZT_BUS_AGENT: claude.agent_id });

  const plan = json(['wake-plan', '--window', win]);
  assert.equal(plan.length, 1, `expected exactly one wake, got ${JSON.stringify(plan)}`);
  assert.equal(plan[0].action, 'wake');
  assert.equal(plan[0].agent_id, codex.agent_id);
  assert.equal(plan[0].line, WAKE_LINE);

  const r = recorder();
  await executeWakeAction(plan[0], r.terminal, r.sleep);
  const typed = r.events.filter((e) => 'send' in e).map((e) => e.send).join('');
  assert.equal(typed, `${WAKE_LINE}\r`);
  assert.ok(!typed.includes('TOP-SECRET'), 'message content must never reach the terminal');

  const sent = json(['wake-sent', '--attempt', plan[0].attempt_id]);
  assert.equal(sent.status, 'sent');
});

test('retry-enter sends only enter', async () => {
  const { executeWakeAction } = await loadWake();
  const r = recorder();
  const typed = await executeWakeAction(
    { agent_id: 'a1', alias: 'codex', action: 'retry-enter', line: LINE, attempt_id: 'w4' },
    r.terminal,
    r.sleep
  );
  assert.equal(typed, true);
  assert.deepEqual(r.events, [{ send: '\r', addNewLine: false }], 'a retry re-presses Enter; it never retypes the line');
});

test('contributes pair command', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VSCODE, 'package.json'), 'utf8'));
  assert.equal(m.version, '0.7.0');
  const commands = new Map((m.contributes.commands || []).map((c) => [c.command, c.title]));
  assert.equal(commands.get('vzt-mux.bus.pair'), 'VZT: Pair Claude + Codex');
  assert.ok(commands.has('vzt-mux.bus.refresh'), 'vzt-mux.bus.refresh must be contributed');
  const shipViews = (m.contributes.views.vztShip || []).map((v) => v.id);
  assert.ok(shipViews.includes('vztBus'), 'the vztBus view must live in the existing VZT Ship container');
  assert.ok(shipViews.includes('vztShipRun'), 'the Ship Run view must stay');
  const setting = m.contributes.configuration.properties['vztMux.busCommand'];
  assert.ok(setting, 'vztMux.busCommand must be configurable');
  assert.equal(setting.default, '', 'empty default = auto-resolve');

  const ext = fs.readFileSync(path.join(VSCODE, 'src', 'extension.ts'), 'utf8');
  assert.ok(ext.includes('registerAgentBus('), 'activate() must register the agent bus');
  const pair = fs.readFileSync(path.join(VSCODE, 'src', 'bus', 'pair.ts'), 'utf8');
  assert.match(pair, /registerCommand\("vzt-mux\.bus\.pair"/);
  assert.match(pair, /parentTerminal: claude/, 'codex must open split beside claude');
  assert.match(pair, /CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY/);
  assert.match(pair, /"argv", "--kind"/, 'the agent argv must come from `bus argv`, never be hard-coded');
  assert.match(pair, /"bootstrap-prompt"/);
});

test('extension never opens the db', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(path.join(VSCODE, 'src'));
  assert.ok(files.some((f) => f.endsWith(path.join('bus', 'busCli.ts'))), 'bus sources must be present');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/sqlite/i.test(src), `${path.relative(REPO_ROOT, f)} mentions sqlite — the extension must reach the bus only via the CLI`);
    assert.ok(!/dangerously/.test(src), `${path.relative(REPO_ROOT, f)} hard-codes an agent permission flag — argv comes from \`bus argv\``);
    assert.ok(!src.includes('bus check --json'), `${path.relative(REPO_ROOT, f)} hard-codes the wake line — it comes from \`bus wake-plan\``);
  }
  const cli = fs.readFileSync(path.join(VSCODE, 'src', 'bus', 'busCli.ts'), 'utf8');
  assert.match(cli, /execFile\(/, 'bus calls go through child_process.execFile');
  assert.match(cli, /"--json"/);

  const wakeSrc = fs.readFileSync(path.join(VSCODE, 'src', 'bus', 'wake.ts'), 'utf8');
  assert.ok(!/from "vscode"/.test(wakeSrc), 'wake.ts must stay importable without the vscode module');
});
