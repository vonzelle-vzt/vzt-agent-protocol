import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'cli', 'vzt-agent.js');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
const vzt = (cwd, ...a) => execFileSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });

// Workflow D: `.vzt/ship/` is git-tracked, so a linked worktree gets its OWN forked
// LEDGER. If ship-note wrote there, the chair (in the primary checkout) would never
// see it and branches would conflict. The ledger MUST resolve to the primary checkout.
test('ship-note from a linked worktree lands in the PRIMARY checkout, not the worktree fork', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-orca-ledger-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  try {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    const specDir = path.join(repo, '.vzt', 'ship', 'demo');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'SPEC.md'),
      '# Demo\n<!-- vzt-spec -->\n```json\n{"slug":"demo","units":[{"id":"u1"}]}\n```\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    // A linked worktree = one Orca unit pane. It has its OWN copy of .vzt/ship/demo/.
    git(repo, 'worktree', 'add', '-q', '--detach', wt);
    const wtSpec = path.join(wt, '.vzt', 'ship', 'demo', 'SPEC.md');
    assert.ok(fs.existsSync(wtSpec), 'worktree has its own forked spec (tracked file)');

    // ship-note run FROM the worktree, pointing at the worktree's own spec path.
    vzt(wt, 'ship-note', wtSpec, JSON.stringify({ kind: 'unit_result', unit: 'u1', status: 'PASS' }));

    const primaryLedger = path.join(repo, '.vzt', 'ship', 'demo', 'LEDGER.jsonl');
    const worktreeLedger = path.join(wt, '.vzt', 'ship', 'demo', 'LEDGER.jsonl');
    assert.ok(fs.existsSync(primaryLedger), 'note landed in the PRIMARY checkout ledger');
    assert.ok(!fs.existsSync(worktreeLedger), 'worktree fork ledger was NOT created');
    assert.match(fs.readFileSync(primaryLedger, 'utf8'), /"unit":"u1","status":"PASS"/);
  } finally {
    // Detach the worktree metadata before removing, then nuke the tree.
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Backward compatibility: in a PLAIN checkout the primary root IS the repo root, so
// the ledger sits next to the spec exactly as before Workflow D.
test('ship-note in a plain checkout writes next to the spec (unchanged behaviour)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-orca-plain-'));
  const repo = path.join(root, 'repo');
  try {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    const specDir = path.join(repo, '.vzt', 'ship', 'demo');
    fs.mkdirSync(specDir, { recursive: true });
    const spec = path.join(specDir, 'SPEC.md');
    fs.writeFileSync(spec, '# Demo\n<!-- vzt-spec -->\n```json\n{"slug":"demo","units":[{"id":"u1"}]}\n```\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    vzt(repo, 'ship-note', spec, JSON.stringify({ kind: 'note', msg: 'hi' }));
    assert.ok(fs.existsSync(path.join(specDir, 'LEDGER.jsonl')), 'ledger sits next to the spec');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
