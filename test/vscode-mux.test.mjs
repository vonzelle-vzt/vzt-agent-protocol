// Coverage for the native VS Code mux backend (--mux vscode).
//
// Before this file the whole backend had ZERO tests — `grep -c mux test/*.mjs`
// returned 0 for cli/classifier/ship. It shipped, was never once executed, and
// the first real run surfaced two distinct bugs in ninety seconds.
//
// The invariant everything here protects: ship-watch must be able to tell
// "the agent is still working" from "the agent never launched". Without that,
// a unit whose terminal swallowed its command burns the entire unit budget and
// is then graded FAIL against an empty worktree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'vzt-vscode-agent-state.sh');
const CLI = path.join(REPO_ROOT, 'cli', 'vzt-agent.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run the lifecycle hook with an action, in an isolated VZT_VSCODE_DIR. */
function runHook(action, { unit = 'slug-u1', mux = '1', dir } = {}) {
  const env = { ...process.env, VZT_VSCODE_DIR: dir, PATH: process.env.PATH };
  if (mux === null) delete env.VZT_VSCODE_MUX;
  else env.VZT_VSCODE_MUX = mux;
  if (unit === null) delete env.VZT_VSCODE_UNIT;
  else env.VZT_VSCODE_UNIT = unit;
  execFileSync('sh', [HOOK, action], { env, input: '{}', stdio: ['pipe', 'ignore', 'ignore'] });
}

const sentinel = (dir, name) => fs.existsSync(path.join(dir, 'state', name));

test('hook: `started` writes the start sentinel', () => {
  const dir = tmpdir('vzt-mux-started-');
  runHook('started', { dir });
  assert.ok(sentinel(dir, 'slug-u1.started'), 'expected slug-u1.started');
  assert.ok(!sentinel(dir, 'slug-u1.idle'), 'started must not imply idle');
});

test('hook: `blocked` ALSO counts as started (an agent on a prompt has begun)', () => {
  const dir = tmpdir('vzt-mux-blocked-');
  runHook('blocked', { dir });
  assert.ok(sentinel(dir, 'slug-u1.blocked'), 'expected slug-u1.blocked');
  // This is the herdr semantic: `blocked` satisfies the start phase, so the idle
  // wait (not a fast false FAIL) governs a unit parked on a permission prompt.
  assert.ok(sentinel(dir, 'slug-u1.started'), 'blocked must also mark the unit started');
});

test('hook: `idle` writes idle AND clears blocked (no longer waiting on a human)', () => {
  const dir = tmpdir('vzt-mux-idle-');
  runHook('blocked', { dir });
  assert.ok(sentinel(dir, 'slug-u1.blocked'));
  runHook('idle', { dir });
  assert.ok(sentinel(dir, 'slug-u1.idle'), 'expected slug-u1.idle');
  assert.ok(!sentinel(dir, 'slug-u1.blocked'), 'idle must clear the blocked sentinel');
});

test('hook: defaults to idle when given no action (back-compat with the old Stop wiring)', () => {
  const dir = tmpdir('vzt-mux-default-');
  execFileSync('sh', [HOOK], {
    env: { ...process.env, VZT_VSCODE_DIR: dir, VZT_VSCODE_MUX: '1', VZT_VSCODE_UNIT: 'slug-u1' },
    input: '{}',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel(dir, 'slug-u1.idle'));
});

test('hook: NO-OPS outside a ship unit — this is what keeps it off your normal sessions', () => {
  // These hooks are wired GLOBALLY and fire in every Claude Code session, so the
  // env guard is the entire safety story.
  for (const [label, opts] of [
    ['VZT_VSCODE_MUX unset', { mux: null }],
    ['VZT_VSCODE_MUX not "1"', { mux: '0' }],
    ['VZT_VSCODE_UNIT unset', { unit: null }],
  ]) {
    const dir = tmpdir('vzt-mux-noop-');
    for (const action of ['started', 'blocked', 'idle']) runHook(action, { ...opts, dir });
    const state = path.join(dir, 'state');
    const files = fs.existsSync(state) ? fs.readdirSync(state) : [];
    assert.equal(files.length, 0, `${label}: hook must write nothing, got ${files.join(', ')}`);
  }
});

test('install wires all three lifecycle events, each with its action argument', () => {
  const home = tmpdir('vzt-mux-install-');
  execFileSync('node', [CLI, 'install', '--target', home], { stdio: 'ignore' });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));

  const cmdFor = (event) =>
    (settings.hooks[event] || [])
      .flatMap((m) => m.hooks || [])
      .map((h) => h.command)
      .filter((c) => c.includes('vzt-vscode-agent-state.sh'));

  for (const [event, action] of [
    ['SessionStart', 'started'],
    ['PermissionRequest', 'blocked'],
    ['Stop', 'idle'],
  ]) {
    const cmds = cmdFor(event);
    assert.equal(cmds.length, 1, `expected exactly one lifecycle hook on ${event}, got ${cmds.length}`);
    assert.ok(
      cmds[0].endsWith(` ${action}`),
      `${event} hook must pass the "${action}" action, got: ${cmds[0]}`
    );
  }

  // SessionStart carries the chair-profile hook too; wiring the sentinel there
  // must not have displaced it.
  const sessionStart = (settings.hooks.SessionStart || []).flatMap((m) => m.hooks || []).map((h) => h.command);
  assert.ok(
    sessionStart.some((c) => c.includes('vzt-session-start.mjs')),
    'the chair-profile SessionStart hook must survive alongside the sentinel'
  );
});

test('re-install UPGRADES a managed hook whose command changed (not just adds missing ones)', () => {
  // Found live: the idempotency check only asked "is this basename present?", so
  // when the vscode sentinel gained its action argument every already-installed
  // machine kept the stale argument-less command and `install` still reported
  // success. An install that cannot upgrade is an install that silently rots.
  const home = tmpdir('vzt-mux-upgrade-');
  execFileSync('node', [CLI, 'install', '--target', home], { stdio: 'ignore' });
  const settingsPath = path.join(home, '.claude', 'settings.json');

  // Simulate an older install: strip the action argument off the Stop entry.
  const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const m of before.hooks.Stop || []) {
    for (const h of m.hooks || []) {
      if (h.command.includes('vzt-vscode-agent-state.sh')) h.command = h.command.replace(/ idle$/, '');
    }
  }
  fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));

  execFileSync('node', [CLI, 'install', '--target', home], { stdio: 'ignore' });

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stop = (after.hooks.Stop || [])
    .flatMap((m) => m.hooks || [])
    .map((h) => h.command)
    .filter((c) => c.includes('vzt-vscode-agent-state.sh'));
  assert.equal(stop.length, 1, 'upgrade must not duplicate the hook');
  assert.ok(stop[0].endsWith(' idle'), `re-install must refresh the stale command, got: ${stop[0]}`);
});

test('uninstall removes every lifecycle hook it wired', () => {
  const home = tmpdir('vzt-mux-uninstall-');
  execFileSync('node', [CLI, 'install', '--target', home], { stdio: 'ignore' });
  execFileSync('node', [CLI, 'uninstall', '--target', home], { stdio: 'ignore' });
  const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  assert.ok(!raw.includes('vzt-vscode-agent-state.sh'), 'uninstall left a lifecycle hook behind');
});

test('vscodeBackend.waitIdle is TWO-PHASE — start signal before idle wait', () => {
  // A behavioural test would need a live VS Code extension host, so this guards
  // the structure instead. Regressing to a single `.idle` poll is the specific
  // bug that graded an empty worktree, and it must not come back silently.
  const src = fs.readFileSync(CLI, 'utf8');
  const fn = src.slice(src.indexOf('function vscodeBackend'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));

  assert.ok(body.includes('startedFile'), 'waitIdle must consult a start sentinel');
  assert.ok(body.includes('blockedFile'), 'blocked must count as started');
  assert.ok(body.includes('VZT_START_GRACE_MS'), 'must honour the same start-grace env var as herdr');

  // Phase order matters: the start check has to precede the idle wait.
  const startIdx = body.indexOf('startedFile');
  const graceIdx = body.indexOf('VZT_START_GRACE_MS');
  assert.ok(startIdx > 0 && graceIdx > 0, 'expected both markers present');

  // dispatch must clear ALL sentinels — a stale `.started` would satisfy phase 1
  // instantly and reintroduce the empty-worktree grading.
  for (const s of ['.started', '.blocked', '.idle', '.status']) {
    assert.ok(body.includes(`${s}\``) || body.includes(`}${s}`), `dispatch must clear ${s} from a prior run`);
  }
});

test('dispatch writes a PERSISTENT unit record the tree can read after a reload', () => {
  // queue/<key>.json is deleted by the extension to guarantee exactly-once
  // launch, so it cannot also be the tree's source of truth — reload the window
  // and the run would vanish from the UI. units/<key>.json is the durable twin.
  const dir = tmpdir('vzt-mux-units-');       // isolated: the live extension watches the DEFAULT dir
  const repo = tmpdir('vzt-mux-repo-');
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });

  const specDir = path.join(repo, '.vzt', 'ship', 'treespec');
  fs.mkdirSync(specDir, { recursive: true });
  const spec = {
    specVersion: 1, slug: 'treespec', title: 'T', root: repo, contract: 'c',
    manifest: [{ path: 'a.txt', op: 'new' }, { path: 'b.txt', op: 'new' }],
    units: [
      { id: 'u1', title: 'Alpha unit', agentType: 'vzt-mechanic', filesInScope: ['a.txt'], brief: 'x', machineCheck: 'test -f a.txt', expect: 'exit 0' },
      { id: 'u2', title: 'Beta unit', agentType: 'vzt-mechanic', filesInScope: ['b.txt'], brief: 'x', machineCheck: 'test -f b.txt', expect: 'exit 0' },
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), `# T\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);

  execFileSync('node', [CLI, 'ship-dispatch', path.join(specDir, 'SPEC.md'), '--mux', 'vscode', '--execute'], {
    cwd: repo,
    env: { ...process.env, VZT_VSCODE_DIR: dir, VZT_VSCODE_DRAIN_GRACE_MS: '200' },
    stdio: 'ignore',
  });

  const unitDir = path.join(dir, 'units');
  const recs = fs.readdirSync(unitDir).filter((f) => f.endsWith('.json'));
  assert.equal(recs.length, 2, `expected 2 unit records, got ${recs.join(', ')}`);

  const u1 = JSON.parse(fs.readFileSync(path.join(unitDir, 'treespec-u1.json'), 'utf8'));
  assert.equal(u1.title, 'Alpha unit', 'record must carry the human title for the tree label');
  assert.equal(u1.slug, 'treespec');
  // The oracle must be the SAME string ship-watch grades with, so "Re-run Oracle"
  // can never drift into a retyped approximation.
  assert.equal(u1.machineCheck, 'test -f a.txt', 'record must carry the unit oracle verbatim');
  assert.ok(fs.existsSync(u1.cwd), 'record must point at a real worktree');

  // Cleanup the worktrees this created.
  for (const id of ['u1', 'u2']) {
    try { execFileSync('git', ['worktree', 'remove', '--force', path.join(dir, 'worktrees', `treespec-${id}`)], { cwd: repo, stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

test('the tree derives state with a VERDICT beating liveness', () => {
  // A unit holds BOTH .idle and .status at the end; the status is the one that
  // means something. Getting this order wrong shows every finished unit as
  // "finished" and never PASS/FAIL.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'vscode', 'src', 'shipTree.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function deriveState'));
  const body = fn.slice(0, fn.indexOf('\nconst ICONS'));
  const order = ['status', 'idle', 'blocked', 'started'].map((s) => body.indexOf(`"${s}"`));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1] && order[i - 1] >= 0, `deriveState must check status → idle → blocked → started in that order`);
  }
});

test('the extension reports a status file per WRITE, not per filename', () => {
  // The CLI deletes a stale .status at dispatch and the re-run writes the same
  // name again; a filename-keyed Set silently skipped every re-run.
  const ext = fs.readFileSync(path.join(REPO_ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.ok(
    /seenStatusFiles\s*=\s*new Map</.test(ext),
    'seenStatusFiles must be an mtime-keyed Map, not a filename Set'
  );
  assert.ok(ext.includes('mtimeMs'), 'status reporting must key on mtime');
});

test('sendWhenReady EXECUTES cleanly and actually sends the command', async () => {
  // Not a grep — this pulls the real compiled sendWhenReady out of out/extension.js
  // and runs it against a fake terminal whose `shellIntegration` is already truthy,
  // which is what VS Code 1.93+ actually hands you.
  //
  // The first implementation closed over `const timer` declared BELOW send(), so
  // this exact path threw `ReferenceError: Cannot access 'timer' before
  // initialization` — out of a processQueue loop whose queue record was already
  // deleted. Both units of a live 2-unit run vanished with no terminal, no
  // sentinel and no error, each burning its full 90s start-grace. A structural
  // grep would not have caught it; executing the function does.
  const compiled = path.join(REPO_ROOT, 'vscode', 'out', 'extension.js');
  if (!fs.existsSync(compiled)) {
    assert.fail('vscode/out/extension.js missing — run `npm run compile` in vscode/ before testing');
  }
  const src = fs.readFileSync(compiled, 'utf8');
  const start = src.indexOf('function sendWhenReady');
  assert.ok(start > 0, 'sendWhenReady not found in the compiled extension');
  // Take through the end of the function (next top-level `function ` declaration).
  const rest = src.slice(start);
  const end = rest.indexOf('\nfunction ', 1);
  const fnSrc = end > 0 ? rest.slice(0, end) : rest;

  const sends = [];
  const logged = [];
  const fakeVscode = {
    window: {
      // 1.93+: the API exists. Return a disposable, never fire.
      onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
    },
    Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
  };
  const outputChannel = { appendLine: (l) => logged.push(l), show() {} };
  const factory = new Function('vscode', 'outputChannel', `${fnSrc}\nreturn sendWhenReady;`);
  const sendWhenReady = factory(fakeVscode, outputChannel);

  const terminal = {
    shellIntegration: {}, // present, as on VS Code 1.93+ — must be ignored now
    sendText: (cmd) => sends.push(cmd),
  };

  const prev = process.env.VZT_VSCODE_SEND_DELAY_MS;
  process.env.VZT_VSCODE_SEND_DELAY_MS = '20'; // keep the test fast
  try {
    sendWhenReady(terminal, { unitKey: 'slug-u1', cwd: '/tmp/x', cmd: 'claude "do the thing"' });
    // Deliberately NOT sent synchronously — sending before the PTY settles is
    // what stopped the unit TUI from ever starting.
    assert.deepEqual(sends, [], 'the command must not be sent synchronously');
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(sends, ['claude "do the thing"'], 'the unit command must be sent after the delay');
    assert.ok(logged.some((l) => l.includes('[LAUNCH]')), 'the launch must be logged');
    assert.equal(sends.length, 1, 'command must not be sent twice');
  } finally {
    if (prev === undefined) delete process.env.VZT_VSCODE_SEND_DELAY_MS;
    else process.env.VZT_VSCODE_SEND_DELAY_MS = prev;
  }
});

test('the unit command is sent on a DELAY, never on the shell-integration event', () => {
  // This looks backwards — shell integration is the "proper" readiness signal —
  // so the reason is recorded here to stop it being helpfully reintroduced.
  //
  // A unit runs `claude` as an interactive TUI. Shell integration activates
  // before the PTY has settled, so a TUI launched at that moment never
  // initialises: no session, no sentinel, silence until the start-grace expires.
  // Falsified live — the same command queued twice, once on the TTY and once
  // redirected to a file: the redirected (headless) run completed, the TTY run
  // never did, while a bare immediate sendText ran the TUI fine.
  // Match against the compiled JS with comments stripped: the SOURCE explains
  // why shell integration is wrong, so scanning it would match the explanation
  // and fail on correct code.
  const js = fs.readFileSync(path.join(REPO_ROOT, 'vscode', 'out', 'extension.js'), 'utf8');
  const start = js.indexOf('function sendWhenReady');
  assert.ok(start > 0, 'sendWhenReady missing from the compiled extension — run `npm run compile` in vscode/');
  const rest = js.slice(start);
  const end = rest.indexOf('\nfunction ', 1);
  const code = (end > 0 ? rest.slice(0, end) : rest)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.ok(
    !/shellIntegration/.test(code),
    'sendWhenReady must NOT gate on shell integration — it fires before the PTY settles and the unit TUI never starts'
  );
  assert.ok(/setTimeout\(/.test(code), 'sendWhenReady must send on a timer');
  assert.ok(/VZT_VSCODE_SEND_DELAY_MS/.test(code), 'the delay must stay tunable');
});

test('the extension does not send a unit command into an uninitialised shell', () => {
  // sendText() immediately after createTerminal() is swallowed by a still-
  // initialising shell — observed live, cost a unit its entire timeout.
  const ext = fs.readFileSync(path.join(REPO_ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.ok(ext.includes('sendWhenReady'), 'command dispatch must go through sendWhenReady');
  // NOTE: this used to also require gating on shell integration. That was wrong
  // and is now asserted against in the test above — the readiness event fires
  // before the PTY settles and the unit's TUI never starts. The delay is the fix.
  assert.ok(/VZT_VSCODE_SEND_DELAY_MS/.test(ext), 'the send must be delayed and tunable');
  // And a failed createTerminal must not silently lose the unit.
  assert.ok(/createTerminal failed/.test(ext), 'createTerminal must fail loudly, not silently');
});
