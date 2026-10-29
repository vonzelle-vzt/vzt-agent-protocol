/**
 * `ship-watch --resume`: re-grade what a previous run built, dispatch the rest.
 *
 * Without it a partial failure had two exits, both bad: re-run everything
 * (re-dispatching units that had already passed) or dispatch the remaining units
 * by hand, re-deriving the unit prompt and the dependency seed (workspace-dx,
 * 2026-10-29: u4 and u6 failed only under load, and u7/u8 were then hand-run).
 *
 * Driven on the ship-waves harness — the vscode mux, no extension host, a real
 * git repo — with u1's oracle keyed to a marker file, so the SAME worktree fails
 * in run 1 and passes in run 2 without any agent touching it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function scaffold() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-resume-'));
  const repo = path.join(tmp, 'repo');
  const muxDir = path.join(tmp, 'mux');
  const marker = path.join(tmp, 'u1-done');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'user.email', 't@t.local');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');

  const unit = (id, machineCheck, extra = {}) => ({
    id, title: id, agentType: 'vzt-builder', filesInScope: [`${id}.txt`], brief: 'b',
    machineCheck, expect: 'exit 0', ...extra,
  });
  const spec = {
    specVersion: 1, slug: 'res', title: 'Resume', root: repo, contract: 'c',
    manifest: [{ path: 'u1.txt', op: 'new' }, { path: 'u2.txt', op: 'new' }],
    units: [
      unit('u1', `test -f '${marker}'`),
      // u2 passes only when it was SEEDED with u1's work, so a PASS proves the
      // resumed u1 still counted as a satisfied dependency.
      unit('u2', 'test -f u1.txt', { dependsOn: ['u1'] }),
    ],
    integration: { machineCheck: 'true', expect: 'exit 0' },
  };
  const specDir = path.join(repo, '.vzt', 'ship', 'res');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'SPEC.md');
  fs.writeFileSync(specPath, `# Resume\n\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return { tmp, muxDir, marker, specPath, specDir };
}

function watch(specPath, muxDir, extra = []) {
  try {
    return execFileSync(process.execPath, [CLI, 'ship-watch', specPath, '--mux', 'vscode', ...extra], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VZT_VSCODE_DIR: muxDir, VZT_VSCODE_DRAIN_GRACE_MS: '30', VZT_START_GRACE_MS: '30' },
    });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`; // a failed unit exits non-zero
  }
}

/** Ledger entries written since the LAST run_started — i.e. by the latest run. */
const lastRun = (specDir) => {
  const all = fs.readFileSync(path.join(specDir, 'LEDGER.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const start = all.map((e) => e.kind).lastIndexOf('run_started');
  return all.slice(start).filter((e) => e.kind === 'unit_result');
};
const unitRecord = (muxDir, id) => JSON.parse(fs.readFileSync(path.join(muxDir, 'units', `res-${id}.json`), 'utf8'));

test('--resume re-grades an existing worktree in place and dispatches only what did not pass', () => {
  const s = scaffold();
  try {
    // Run 1: u1's marker is absent, so u1 FAILS and u2 is BLOCKED behind it.
    const out1 = watch(s.specPath, s.muxDir);
    assert.match(out1, /u1 … FAIL/, out1);
    assert.match(out1, /u2 … BLOCKED/, out1);
    const u1Dispatch = unitRecord(s.muxDir, 'u1').dispatchedAt;

    // Stand in for the agent's work and for whatever made the oracle pass.
    fs.writeFileSync(path.join(s.muxDir, 'worktrees', 'res-u1', 'u1.txt'), 'u1\n');
    fs.writeFileSync(s.marker, '');

    // Run 2, --resume.
    const out2 = watch(s.specPath, s.muxDir, ['--resume']);
    assert.match(out2, /## resume/, out2);
    assert.match(out2, /u2 … no worktree \(was BLOCKED\) — will dispatch/, out2);
    assert.match(out2, /u1 … PASS \(resumed — not re-dispatched\)/, out2);
    assert.doesNotMatch(out2, /dispatched u1 /, `u1 must not be dispatched again:\n${out2}`);
    assert.equal(unitRecord(s.muxDir, 'u1').dispatchedAt, u1Dispatch, 'u1 got a new launch record');
    assert.match(out2, /dispatched u2 /, out2);
    assert.deepEqual(unitRecord(s.muxDir, 'u2').seeded, ['u1'], 'u2 was not seeded from the resumed u1');

    const run2 = lastRun(s.specDir);
    assert.deepEqual(run2.filter((e) => e.unit === 'u1').map((e) => [e.status, e.via]), [['PASS', 'ship-watch-resume']]);
    assert.deepEqual(run2.filter((e) => e.unit === 'u2').map((e) => [e.status, e.via]), [['PASS', 'ship-watch']]);
    assert.match(out2, /2\/2 unit oracle\(s\) PASS/, out2);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

// CONTROL: the same state, re-run WITHOUT --resume, must behave as before —
// every unit dispatched, nothing re-graded in place.
test('without --resume every unit is dispatched again (behaviour unchanged)', () => {
  const s = scaffold();
  try {
    watch(s.specPath, s.muxDir);
    fs.writeFileSync(path.join(s.muxDir, 'worktrees', 'res-u1', 'u1.txt'), 'u1\n');
    fs.writeFileSync(s.marker, '');
    watch(s.specPath, s.muxDir, ['--resume']);

    const out3 = watch(s.specPath, s.muxDir);
    assert.doesNotMatch(out3, /## resume|resumed —/, out3);
    assert.match(out3, /dispatched u1 /, out3);
    assert.match(out3, /dispatched u2 /, out3);
    const run3 = lastRun(s.specDir);
    assert.ok(run3.length >= 2 && run3.every((e) => e.via === 'ship-watch'), JSON.stringify(run3));
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});
