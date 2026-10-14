import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');
const MARKER = 'vzt-bus-hook-form=1';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const EVENT_SNAKE = { SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit', Stop: 'stop', PermissionRequest: 'permission_request' };
const expectedCommand = (ev) => `: ${MARKER}; [ -n "\${VZT_BUS_AGENT-}" ] && exec vzt-agent bus hook ${ev} || :`;

// Fresh HOME + CODEX_HOME per test: install --global writes ~/.claude,
// ~/.orca/vzt and $CODEX_HOME/hooks.json, none of which may be the real ones.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-bus-install-home-'));
  const codexHome = path.join(home, 'codex-home');
  const busDir = path.join(home, 'bus');
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, VZT_BUS_DIR: busDir, VZT_ROUTER_STATE_DIR: path.join(home, 'state') };
  // This suite runs inside Orca panes; the bus refuses there (exit 3) by design.
  delete env.ORCA_TERMINAL_HANDLE;
  const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env });
  return {
    home,
    codexHome,
    env,
    run,
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    codexHooks: path.join(codexHome, 'hooks.json'),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const marked = (hooksObj, ev) =>
  (hooksObj?.[ev] || []).flatMap((g) => g.hooks || []).filter((h) => typeof h.command === 'string' && h.command.includes(MARKER));

const ORCA_GROUP = {
  hooks: [{ type: 'command', command: ': orca-agent-hook-form=1; [ -n "${ORCA_PANE_KEY-}" ] && exec orca-agent-hook || :', timeout: 5 }],
};

test('install wires claude bus hooks', () => {
  const s = sandbox();
  try {
    const out = s.run('install', '--global');
    assert.match(out, /hooks:\s+4 installed/);
    assert.match(out, /bus hooks: 4 claude \+ 4 codex/);
    const settings = readJson(s.claudeSettings);
    for (const ev of EVENTS) {
      const hs = marked(settings.hooks, ev);
      assert.equal(hs.length, 1, `${ev} wired once`);
      assert.equal(hs[0].command, expectedCommand(ev));
      assert.equal(hs[0]._managedBy, 'vzt-agent-protocol');
      assert.equal(hs[0].type, 'command');
    }
    // The existing lifecycle sentinels are still wired alongside.
    assert.ok(settings.hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes('vzt-vscode-agent-state.sh'))));

    // Bus hooks are per-user: a project install/uninstall neither wires them
    // into the project nor touches the user's (other tests run `install
    // --target` against the real HOME).
    const target = path.join(s.home, 'proj');
    const codexBefore = fs.readFileSync(s.codexHooks, 'utf8');
    const userBefore = fs.readFileSync(s.claudeSettings, 'utf8');
    assert.match(s.run('install', '--target', target), /bus hooks: skipped/);
    const proj = readJson(path.join(target, '.claude', 'settings.json'));
    for (const ev of EVENTS) assert.equal(marked(proj.hooks, ev).length, 0);
    s.run('uninstall', '--target', target);
    assert.equal(fs.readFileSync(s.codexHooks, 'utf8'), codexBefore);
    assert.equal(fs.readFileSync(s.claudeSettings, 'utf8'), userBefore);
  } finally {
    s.cleanup();
  }
});

test('install wires codex hooks with marker', () => {
  const s = sandbox();
  try {
    assert.ok(!fs.existsSync(s.codexHooks));
    s.run('install', '--global');
    const data = readJson(s.codexHooks);
    for (const ev of EVENTS) {
      const hs = marked(data.hooks, ev);
      assert.equal(hs.length, 1, `${ev} wired once`);
      assert.deepEqual(hs[0], { type: 'command', command: expectedCommand(ev), timeout: 10 });
    }
    assert.deepEqual(Object.keys(data.hooks).sort(), [...EVENTS].sort());
  } finally {
    s.cleanup();
  }
});

test('install is idempotent', () => {
  const s = sandbox();
  try {
    s.run('install', '--global');
    const claude1 = fs.readFileSync(s.claudeSettings, 'utf8');
    const codex1 = fs.readFileSync(s.codexHooks, 'utf8');
    s.run('install', '--global');
    assert.equal(fs.readFileSync(s.claudeSettings, 'utf8'), claude1);
    assert.equal(fs.readFileSync(s.codexHooks, 'utf8'), codex1);
    for (const ev of EVENTS) assert.equal(marked(readJson(s.codexHooks).hooks, ev).length, 1);
  } finally {
    s.cleanup();
  }
});

test('uninstall removes only marked entries', () => {
  const s = sandbox();
  try {
    // A foreign codex handler sharing a GROUP with ours must survive; so must a
    // user's own claude Stop hook.
    fs.mkdirSync(s.codexHome, { recursive: true });
    const userStop = { hooks: [{ type: 'command', command: 'echo user-stop', timeout: 3 }] };
    fs.writeFileSync(s.codexHooks, JSON.stringify({ hooks: { Stop: [userStop] }, other: { keep: true } }, null, 2));
    fs.mkdirSync(path.dirname(s.claudeSettings), { recursive: true });
    fs.writeFileSync(s.claudeSettings, JSON.stringify({ model: 'opus', hooks: { Stop: [userStop] } }, null, 2));

    s.run('install', '--global');
    const mixed = readJson(s.codexHooks);
    mixed.hooks.Stop[1].hooks.push({ type: 'command', command: 'echo shares-a-group' });
    fs.writeFileSync(s.codexHooks, JSON.stringify(mixed, null, 2));

    const out = s.run('uninstall', '--global');
    assert.match(out, /bus hooks: removed 4 claude \+ 4 codex/);

    const codex = readJson(s.codexHooks);
    assert.deepEqual(codex, {
      hooks: { Stop: [userStop, { hooks: [{ type: 'command', command: 'echo shares-a-group' }] }] },
      other: { keep: true },
    });
    const claude = readJson(s.claudeSettings);
    assert.equal(claude.model, 'opus');
    assert.deepEqual(claude.hooks, { Stop: [userStop] });
    for (const ev of EVENTS) assert.equal(marked(claude.hooks, ev).length, 0);
  } finally {
    s.cleanup();
  }
});

test('preserves orca codex hooks', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.codexHome, { recursive: true });
    const seeded = { hooks: { SessionStart: [ORCA_GROUP], Stop: [ORCA_GROUP], PreToolUse: [ORCA_GROUP] } };
    fs.writeFileSync(s.codexHooks, JSON.stringify(seeded, null, 2));

    s.run('install', '--global');
    const installed = readJson(s.codexHooks);
    // Orca's groups keep their position (Codex trust keys are index-based) and content.
    assert.deepEqual(installed.hooks.SessionStart[0], ORCA_GROUP);
    assert.deepEqual(installed.hooks.Stop[0], ORCA_GROUP);
    assert.deepEqual(installed.hooks.PreToolUse, [ORCA_GROUP]);
    assert.equal(marked(installed.hooks, 'SessionStart').length, 1);

    s.run('uninstall', '--global');
    assert.deepEqual(readJson(s.codexHooks), seeded);
  } finally {
    s.cleanup();
  }
});

test('hook command is byte-stable', () => {
  const a = sandbox();
  const b = sandbox();
  try {
    a.run('install', '--global');
    b.run('install', '--global');
    a.run('install', '--global');
    const cmds = (s) => EVENTS.map((ev) => marked(readJson(s.codexHooks).hooks, ev)[0].command);
    // Different HOMEs, repeat installs: the string must not embed any path.
    assert.deepEqual(cmds(a), cmds(b));
    assert.deepEqual(cmds(a), EVENTS.map(expectedCommand));
    const claudeCmds = EVENTS.map((ev) => marked(readJson(a.claudeSettings).hooks, ev)[0].command);
    assert.deepEqual(claudeCmds, cmds(a));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('doctor reports untrusted codex hooks', () => {
  const s = sandbox();
  try {
    s.run('install', '--global');
    let out;
    try {
      out = s.run('doctor', '--global');
    } catch (err) {
      out = err.stdout; // other checks (vscode extension) may fail in a bare HOME
    }
    assert.match(out, /\nbus:/);
    assert.match(out, /"untrusted"/);
    assert.match(out, /open codex, run \/hooks, trust the 4 vzt-bus hooks/);

    // Trust all four the way Codex records it; the action line must go away.
    const toml = EVENTS.map((ev) => `[hooks.state."${s.codexHooks}:${EVENT_SNAKE[ev]}:0:0"]\ntrusted_hash = "sha256:abc"\n`).join('\n');
    fs.writeFileSync(path.join(s.codexHome, 'config.toml'), toml);
    try {
      out = s.run('doctor', '--global');
    } catch (err) {
      out = err.stdout;
    }
    assert.match(out, /\nbus:/);
    assert.doesNotMatch(out, /trust the 4 vzt-bus hooks/);
  } finally {
    s.cleanup();
  }
});

test('bus subcommand dispatches', () => {
  const s = sandbox();
  try {
    const agents = JSON.parse(s.run('bus', 'agents', '--json'));
    assert.ok(Array.isArray(agents) || (agents && typeof agents === 'object'));
    const argv = JSON.parse(s.run('bus', 'argv', '--kind', 'codex', '--json'));
    assert.ok(argv.some((a) => a.includes('check_for_update_on_startup=false')));
    // Exit codes propagate through the wrapper.
    assert.throws(
      () => execFileSync('node', [CLI, 'bus', 'agents', '--json'], { env: { ...s.env, ORCA_TERMINAL_HANDLE: 'term_x' }, stdio: 'pipe' }),
      (err) => err.status === 3
    );
    assert.throws(() => s.run('bus', 'no-such-verb'), (err) => err.status === 2);
  } finally {
    s.cleanup();
  }
});
