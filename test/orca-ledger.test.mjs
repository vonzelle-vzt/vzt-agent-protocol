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

// The --mux backend abstraction: ship-dispatch dry-run must emit the right CLI shape
// for each multiplexer without either tool being installed/running (dry-run is pure).
test('ship-dispatch --mux selects the backend and emits its command shape (dry-run)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-mux-'));
  try {
    const specDir = path.join(root, '.vzt', 'ship', 'demo');
    fs.mkdirSync(specDir, { recursive: true });
    const spec = path.join(specDir, 'SPEC.md');
    fs.writeFileSync(spec, `# Demo
<!-- vzt-spec -->
\`\`\`json
{
  "slug": "demo", "title": "t", "root": "${root}",
  "contract": "c", "integration": { "machineCheck": "true", "expect": "0" },
  "units": [
    { "id": "u1", "title": "A", "agentType": "vzt-builder", "filesInScope": ["a.txt"], "brief": "b", "machineCheck": "true", "expect": "0" },
    { "id": "u2", "title": "B", "agentType": "vzt-builder", "filesInScope": ["b.txt"], "brief": "b", "machineCheck": "true", "expect": "0" }
  ]
}
\`\`\`
`);
    // Isolate VZT_MUX from the caller's shell — this asserts the CODE default (orca).
    // A machine-wide `export VZT_MUX=herdr` is a legit user override but must never
    // flip a test of the built-in default, or the suite goes red on herdr-default machines.
    const codeDefaultEnv = { ...process.env };
    delete codeDefaultEnv.VZT_MUX;
    const orca = execFileSync(process.execPath, [CLI, 'ship-dispatch', spec], { encoding: 'utf8', env: codeDefaultEnv });
    assert.match(orca, /worktree' 'create'.*'--agent' 'claude'/s, 'orca (default) uses one worktree-create --agent call');

    // And with VZT_MUX=herdr exported, the same no-flag call must resolve to herdr.
    const herdrDefaultEnv = { ...process.env, VZT_MUX: 'herdr' };
    const herdrByEnv = execFileSync(process.execPath, [CLI, 'ship-dispatch', spec], { encoding: 'utf8', env: herdrDefaultEnv });
    assert.match(herdrByEnv, /herdr' agent start 'demo-u1'/, 'VZT_MUX=herdr makes herdr the default without --mux');

    const herdr = execFileSync(process.execPath, [CLI, 'ship-dispatch', spec, '--mux', 'herdr'], { encoding: 'utf8' });
    assert.match(herdr, /herdr' worktree create --cwd/, 'herdr uses worktree create');
    assert.match(herdr, /herdr' agent start 'demo-u1'/, 'herdr launches the agent in a second step');

    // vscode: no external binary — plan() emits a plain `git worktree add` per unit
    // and a `claude` launch line the companion extension runs in a native terminal.
    // Isolate VZT_VSCODE_DIR so backend construction can't touch the real ~/.vzt.
    const vscodeEnv = { ...process.env, VZT_VSCODE_DIR: path.join(root, 'vscode-mux') };
    const vscode = execFileSync(process.execPath, [CLI, 'ship-dispatch', spec, '--mux', 'vscode'], { encoding: 'utf8', env: vscodeEnv });
    assert.match(vscode, /worktree add -b 'demo-u1'/, 'vscode creates one git worktree per unit');
    assert.match(vscode, /claude --dangerously-skip-permissions/, 'vscode launches claude in the unit terminal');

    assert.throws(
      () => execFileSync(process.execPath, [CLI, 'ship-dispatch', spec, '--mux', 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] }),
      'an unknown --mux exits non-zero',
    );
  } finally {
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
