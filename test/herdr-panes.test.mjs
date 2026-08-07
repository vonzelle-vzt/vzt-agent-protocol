/**
 * The herdr mux against the herdr 0.7.5 CLI contract.
 *
 * What went wrong in the field: herdr changed `agent start` from
 * `<name> --workspace <ws> --cwd <path> -- claude …` to
 * `<name> --kind <kind> --pane <pane> -- <agent flags>`, and `agent wait` from
 * `--status` to `--until`. This backend still sent the old shapes, herdr answered
 * `unknown option: --workspace`, and BOTH failures were swallowed by a catch — so
 * every unit created its worktree, started no agent, waited zero milliseconds and
 * was graded on an empty tree. Nothing in the suite noticed, because nothing
 * asserted the argv.
 *
 * So these assert the ARGV, not just the outcome: a fake `herdr` records what it
 * was handed. Shapes verified live against herdr 0.7.5 before being frozen here.
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

/** A stand-in for `herdr`, answering the 0.7.5 response shapes recorded live:
 *  worktree create → result.workspace.workspace_id + result.root_pane.{pane_id,cwd};
 *  pane split → result.pane.pane_id; agent start → result.agent.pane_id. */
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(argv) + '\\n');
const state = process.env.FAKE_HERDR_STATE;
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const read = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')); } catch { return { n: 0, worktrees: [] }; } };
const write = (s) => fs.writeFileSync(state, JSON.stringify(s));
const out = (result) => { process.stdout.write(JSON.stringify({ id: 'x', result })); process.exit(0); };
const verb = argv.slice(0, 2).join(' ');

if (verb === 'worktree create') {
  const s = read(); s.n += 1;
  const branch = flag('--branch');
  const wt = path.join(path.dirname(state), 'wt', branch);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', flag('--cwd'), 'worktree', 'add', '-q', '-b', branch, wt], { stdio: ['ignore', 'ignore', 'ignore'] });
  s.worktrees.push({ branch, path: wt, open_workspace_id: 'w' + s.n });
  write(s);
  out({ workspace: { workspace_id: 'w' + s.n }, worktree: { path: wt },
        root_pane: { pane_id: 'w' + s.n + ':p1', cwd: wt } });
}
if (verb === 'pane split') {
  const s = read(); s.n += 1; write(s);
  out({ pane: { pane_id: 'split:p' + s.n } });
}
if (verb === 'agent start') out({ agent: { pane_id: flag('--pane') } });
if (verb === 'worktree list') out({ worktrees: read().worktrees });
out({ ok: true });
`;

function scaffold(units) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-herdr-panes-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'user.email', 't@t.local');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const herdr = path.join(tmp, 'herdr');
  fs.writeFileSync(herdr, FAKE_HERDR);
  fs.chmodSync(herdr, 0o755);

  const spec = {
    specVersion: 1, slug: 'hp', title: 'Herdr panes', root: repo, contract: 'c',
    manifest: units.map((id) => ({ path: `${id}.txt`, op: 'new' })),
    units: units.map((id) => ({
      id, title: id, agentType: 'vzt-builder',
      filesInScope: [`${id}.txt`], brief: 'b', machineCheck: 'true', expect: 'exit 0',
    })),
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'hp');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# HP\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, repo, herdr, specPath, specDir };
}

function watch({ tmp, herdr, specPath }, env = {}) {
  const log = path.join(tmp, 'herdr.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [CLI, 'ship-watch', specPath, '--mux', 'herdr', '--herdr', herdr], {
    encoding: 'utf8',
    env: {
      ...process.env, FAKE_HERDR_LOG: log, FAKE_HERDR_STATE: path.join(tmp, 'herdr-state.json'),
      VZT_START_GRACE_MS: '30', ...env,
    },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { out: `${r.stdout || ''}${r.stderr || ''}`, calls };
}

const verbOf = (a) => a.slice(0, 2).join(' ');
const arg = (a, n) => { const i = a.indexOf(n); return i === -1 ? null : a[i + 1]; };

test('agent start uses the 0.7.5 shape — --kind + --pane, never --workspace', () => {
  const s = scaffold(['u1', 'u2']);
  try {
    const { out, calls } = watch(s);
    const starts = calls.filter((a) => verbOf(a) === 'agent start');
    assert.equal(starts.length, 2, `every unit must start an agent:\n${out}`);
    for (const st of starts) {
      assert.equal(arg(st, '--kind'), 'claude');
      assert.match(arg(st, '--pane') || '', /:p\d+$/);
      // The exact flags herdr 0.7.5 rejects. Sending either starts NOTHING.
      assert.ok(!st.includes('--workspace'), 'the removed --workspace flag came back');
      assert.ok(!st.includes('--cwd'), 'agent start no longer takes --cwd');
      // --kind supplies the executable: repeating it runs `claude claude <prompt>`.
      const after = st.slice(st.indexOf('--') + 1);
      assert.equal(after[0], '--dangerously-skip-permissions', `agent args are flags only, got ${after[0]}`);
    }
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('waitIdle waits with --until, not the rejected --status', () => {
  const s = scaffold(['u1', 'u2']);   // ship-check refuses a single-unit spec
  try {
    const { calls } = watch(s);
    const waits = calls.filter((a) => verbOf(a) === 'agent wait');
    assert.ok(waits.length > 0, 'the run never waited for its agent at all');
    for (const w of waits) {
      assert.ok(w.includes('--until'), `wait used ${w.join(' ')}`);
      assert.ok(!w.includes('--status'), 'the rejected --status flag came back');
    }
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('units after the first share one workspace as split panes, up to the cap', () => {
  const s = scaffold(['u1', 'u2', 'u3', 'u4']);
  try {
    const { out, calls } = watch(s, { VZT_PANES_PER_TAB: '3' });
    const splits = calls.filter((a) => verbOf(a) === 'pane split');
    // u1 takes its worktree's root pane; u2+u3 split into it; u4 starts a new one.
    assert.equal(splits.length, 2, `expected 2 splits, got ${splits.length}:\n${out}`);
    for (const sp of splits) {
      assert.equal(arg(sp, '--pane'), 'w1:p1', 'splits must hang off the first agent pane');
      // --cwd is what puts the pane in the right checkout; herdr has no cd step.
      assert.match(arg(sp, '--cwd') || '', /\/wt\/hp-u[23]$/);
      // The herdr server's PATH is the bare system default; without this the
      // agent binary in ~/.local/bin never resolves.
      assert.match(arg(sp, '--env') || '', /^PATH=/);
    }
    // The per-unit workspace a split unit no longer needs is closed, not left empty.
    assert.equal(calls.filter((a) => verbOf(a) === 'workspace close').length, 2);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

// The control: with a cap of 1 nothing may be split, and every unit keeps its own
// workspace. If this and the test above agreed, the cap would be decoration.
test('VZT_PANES_PER_TAB=1 gives every unit its own workspace again', () => {
  const s = scaffold(['u1', 'u2', 'u3']);
  try {
    const { calls } = watch(s, { VZT_PANES_PER_TAB: '1' });
    assert.equal(calls.filter((a) => verbOf(a) === 'pane split').length, 0);
    assert.equal(calls.filter((a) => verbOf(a) === 'workspace close').length, 0);
    assert.equal(calls.filter((a) => verbOf(a) === 'agent start').length, 3);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test('a shared-workspace unit is stamped on its PANE, never on the workspace', () => {
  const s = scaffold(['u1', 'u2']);
  try {
    const { calls } = watch(s, { VZT_PANES_PER_TAB: '3' });
    const renames = calls.filter((a) => verbOf(a) === 'pane rename');
    // u2 shares u1's workspace: renaming that workspace would relabel u1 too.
    assert.ok(renames.some((r) => r.includes('hp-u2 oracle:PASS')),
      `u2's verdict never landed on its pane: ${JSON.stringify(renames)}`);
    const wsRenames = calls.filter((a) => verbOf(a) === 'workspace rename');
    assert.ok(!wsRenames.some((r) => r.join(' ').includes('hp-u2')),
      'u2 relabelled the shared workspace, clobbering its siblings');
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});
