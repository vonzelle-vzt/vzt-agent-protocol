/**
 * The Orca mux must lay a ship run out as PANES, not a tab per unit.
 *
 * What went wrong in the field: a 9-unit run on blackops-trading left Orca with
 * 18 tabs — `worktree create` (no --agent) drops a fallback shell tab, and
 * `terminal create` then opened a second tab for the agent. Nothing was ever
 * split, so two agents could never be watched at once.
 *
 * These drive the REAL `ship-watch` against a FAKE `orca` binary (the backend
 * already honours `--orca <path>`) that records every argv it is handed. The
 * assertions read that log: what Orca was actually ASKED to do is the only
 * observable that matters here, and it needs no Orca runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A stand-in for the `orca` CLI: logs argv as JSON lines, answers each verb with
 *  a minimal `{id,ok,result}` envelope, and makes REAL git worktrees so the scope
 *  audit and the oracle have something to run against. Handles are returned under
 *  a per-verb node (`result.create.handle`, `result.split.handle`) — the shape
 *  Orca actually uses, and the one a naive `result.handle` read would miss. */
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const argv = process.argv.slice(2);
const log = process.env.FAKE_ORCA_LOG;
const state = process.env.FAKE_ORCA_STATE;
fs.appendFileSync(log, JSON.stringify(argv) + '\\n');
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const read = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')); } catch { return { n: 0, worktrees: [] }; } };
const write = (s) => fs.writeFileSync(state, JSON.stringify(s));
const out = (result) => { process.stdout.write(JSON.stringify({ id: 'x', ok: true, result })); process.exit(0); };
const verb = argv.slice(0, 2).join(' ');

if (verb === 'worktree create') {
  const s = read();
  const name = flag('--name');
  const repo = String(flag('--repo') || '').replace(/^path:/, '');
  const wt = path.join(path.dirname(state), 'wt', name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', name, wt], { stdio: ['ignore', 'ignore', 'ignore'] });
  s.worktrees.push({ name, path: wt });
  write(s);
  out({ worktree: { id: 'repo::' + wt, path: wt }, startupTerminal: { handle: 'term_startup_' + name } });
}
if (verb === 'terminal split' && process.env.FAKE_ORCA_FAIL_SPLIT) {
  process.stderr.write('terminal_handle_stale');
  process.exit(1);
}
if (verb === 'terminal create' || verb === 'terminal split') {
  const s = read(); s.n += 1; write(s);
  const node = verb.endsWith('create') ? 'create' : 'split';
  out({ [node]: { handle: 'term_' + s.n } });
}
if (verb === 'terminal read') out({ latestCursor: 1 });          // proof of life for waitIdle
if (verb === 'worktree list') out({ worktrees: read().worktrees });
out({ ok: true });                                                // wait / close / set
`;

function scaffold(units) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-orca-panes-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'user.email', 't@t.local');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const orca = path.join(tmp, 'orca');
  fs.writeFileSync(orca, FAKE_ORCA);
  fs.chmodSync(orca, 0o755);

  const spec = {
    specVersion: 1, slug: 'panes', title: 'Panes', root: repo, contract: 'c',
    manifest: units.map((id) => ({ path: `${id}.txt`, op: 'new' })),
    units: units.map((id) => ({
      id, title: id, agentType: 'vzt-builder',
      filesInScope: [`${id}.txt`], brief: 'b',
      machineCheck: 'true', expect: 'exit 0',
    })),
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'panes');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Panes\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, repo, orca, specPath, specDir };
}

/** Run ship-watch against the fake orca and return {out, calls}. */
function watch({ tmp, orca, specPath }, env = {}) {
  const log = path.join(tmp, 'orca.log');
  const state = path.join(tmp, 'orca-state.json');
  fs.writeFileSync(log, '');
  // spawnSync, not execFileSync: the dispatch diagnostics this asserts on go to
  // STDERR, which execFileSync throws away on a zero exit.
  const r = spawnSync(process.execPath, [CLI, 'ship-watch', specPath, '--mux', 'orca', '--orca', orca], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_ORCA_LOG: log, FAKE_ORCA_STATE: state, VZT_START_GRACE_MS: '30', ...env },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { out, calls };
}

const verbOf = (a) => a.slice(0, 2).join(' ');
const arg = (a, n) => { const i = a.indexOf(n); return i === -1 ? null : a[i + 1]; };

test('units after the first share a tab as split panes, up to the cap', () => {
  const s = scaffold(['u1', 'u2', 'u3', 'u4']);
  try {
    const { out, calls } = watch(s, { VZT_PANES_PER_TAB: '3' });
    const creates = calls.filter((a) => verbOf(a) === 'terminal create');
    const splits = calls.filter((a) => verbOf(a) === 'terminal split');

    // 4 units, cap 3 → tab(u1) + split(u2) + split(u3) | tab(u4).
    assert.equal(creates.length, 2, `expected 2 tabs, got ${creates.length}:\n${out}`);
    assert.equal(splits.length, 2, `expected 2 splits, got ${splits.length}:\n${out}`);

    // Every split hangs off the FIRST pane of its tab — not off the previous
    // split. Chaining would stack panes into ever-thinner slivers.
    const firstPane = 'term_1';
    for (const sp of splits) assert.equal(arg(sp, '--terminal'), firstPane);

    // `terminal split` has no --worktree, so the pane inherits the anchor's
    // checkout: without this cd the agent runs in the WRONG worktree.
    for (const sp of splits) {
      const cmd = arg(sp, '--command');
      assert.match(cmd, /^cd '.*\/wt\/panes-u[234]' && claude /, `split command lost its cd:\n${cmd}`);
    }
    // The house standard survives on BOTH paths.
    for (const a of [...creates, ...splits]) {
      assert.match(arg(a, '--command'), /claude --dangerously-skip-permissions /);
    }
    // Panes are attributed on stdout, since split cannot carry a --title.
    assert.match(out, /u2 → pane 2\/3/);
    assert.match(out, /u4 → tab ship\/panes/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

// The control. If the cap did nothing, the test above would be describing the
// scaffold rather than measuring the layout: with a cap of 1 every unit must go
// back to its own tab, and no split may be issued at all.
test('VZT_PANES_PER_TAB=1 restores a tab per unit (the cap is load-bearing)', () => {
  const s = scaffold(['u1', 'u2', 'u3', 'u4']);
  try {
    const { calls } = watch(s, { VZT_PANES_PER_TAB: '1' });
    assert.equal(calls.filter((a) => verbOf(a) === 'terminal create').length, 4);
    assert.equal(calls.filter((a) => verbOf(a) === 'terminal split').length, 0);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

// Layout must never cost a unit its agent. The anchor can be gone by the time a
// later unit dispatches — the operator closed that pane, or Orca reaped it when
// its agent exited — and a failed split with no fallback means a unit runs
// NOTHING while the ledger still grades its worktree.
test('a dead anchor falls back to a tab instead of losing the unit', () => {
  const s = scaffold(['u1', 'u2', 'u3']);
  try {
    const { out, calls } = watch(s, { VZT_PANES_PER_TAB: '3', FAKE_ORCA_FAIL_SPLIT: '1' });
    assert.equal(calls.filter((a) => verbOf(a) === 'terminal create').length, 3, out);
    assert.match(out, /u2: anchor pane unusable — opening a tab instead/);
    // Every unit still got a handle, so nothing was graded without an agent.
    assert.doesNotMatch(out, /no orca agent terminal handle/);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('the fallback shell tab is closed once its unit has been graded', () => {
  const s = scaffold(['u1', 'u2']);
  try {
    const { calls } = watch(s, { VZT_PANES_PER_TAB: '3' });
    const closes = calls.filter((a) => verbOf(a) === 'terminal close');
    assert.equal(closes.length, 2, 'every unit leaves exactly one fallback shell to close');
    for (const c of closes) {
      // The STARTUP shell, never the agent pane, and the whole tab with it.
      assert.match(arg(c, '--terminal'), /^term_startup_panes-u[12]$/);
      assert.ok(c.includes('--tab'), 'a pane close would leave the empty tab behind');
    }
    // Ordering is the safety property: the setup hook runs in that shell and has
    // no completion signal, so it may only be closed after the oracle has run.
    const firstClose = calls.findIndex((a) => verbOf(a) === 'terminal close');
    const lastWait = calls.map(verbOf).lastIndexOf('terminal wait');
    assert.ok(firstClose > lastWait || lastWait === -1 || firstClose > calls.findIndex((a) => verbOf(a) === 'terminal wait'),
      'the shell was closed before the agent was waited on');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});
