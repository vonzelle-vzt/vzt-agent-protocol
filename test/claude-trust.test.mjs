// Pins the 2026-10-14 dispatch failure: Claude Code 2.1.299 stopped every Orca
// ship unit on its folder-trust dialog, because our two-step dispatch bypasses
// the Orca launcher that normally pre-trusts the worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');
const src = fs.readFileSync(CLI, 'utf8');

async function loadTrust() {
  const { trustClaudeWorkspace } = await import('../cli/claude-trust.mjs');
  return (dir) => trustClaudeWorkspace(dir, { log: () => {} });
}

function withConfig(initial, fn) {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-trust-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-trust-wt-'));
  const file = path.join(cfgDir, '.claude.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    return fn({ file, wt: fs.realpathSync(wt) });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

test('trust: writes the one-key entry Orca writes, and keeps every other key', async () => {
  const trust = await loadTrust();
  withConfig({ numStartups: 7, projects: { '/other': { allowedTools: ['x'] } } }, ({ file, wt }) => {
    assert.equal(trust(wt), true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cfg.projects[wt], { hasTrustDialogAccepted: true });
    assert.equal(cfg.numStartups, 7);
    assert.deepEqual(cfg.projects['/other'], { allowedTools: ['x'] });
  });
});

test('trust: merges into an existing project entry instead of replacing it', async () => {
  const trust = await loadTrust();
  withConfig({ projects: {} }, ({ file, wt }) => {
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
    seeded.projects[wt] = { lastSessionId: 'abc' };
    fs.writeFileSync(file, JSON.stringify(seeded));
    assert.equal(trust(wt), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects[wt], { lastSessionId: 'abc', hasTrustDialogAccepted: true });
  });
});

test('trust: never creates a config that does not exist, and never throws', async () => {
  const trust = await loadTrust();
  withConfig(null, ({ file, wt }) => {
    assert.equal(trust(wt), false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('trust: the orca backend trusts the worktree BEFORE it opens the agent pane', () => {
  const body = src.slice(src.indexOf('function orcaBackend'));
  const trustAt = body.indexOf('trustClaudeWorkspace(wpath)');
  const paneAt = body.indexOf('paneArgv(spec, u, wtId, wpath');
  assert.ok(trustAt > 0 && paneAt > 0 && trustAt < paneAt);
});

test('trust: `bus trust-claude` trusts the start folder and its git workspace', async () => {
  const { execFileSync } = await import('node:child_process');
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-trust-cli-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-trust-repo-')));
  try {
    fs.writeFileSync(path.join(cfgDir, '.claude.json'), '{"projects":{}}');
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, 'sub'));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir };
    delete env.ORCA_TERMINAL_HANDLE; // the bus refuses inside an Orca pane by design
    const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'cli', 'bus', 'cli.mjs'), 'trust-claude', '--workspace', path.join(repo, 'sub'), '--json'], { env, encoding: 'utf8' }));
    assert.equal(out.trusted, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8'));
    for (const d of [repo, path.join(repo, 'sub')]) assert.deepEqual(cfg.projects[d], { hasTrustDialogAccepted: true });
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('trust: VS Code pair gates on workspace trust, then pre-trusts, before registering agents', () => {
  // Pair and every other launch go through spawnAgent, which owns the order.
  const pair = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'src', 'bus', 'pair.ts'), 'utf8');
  assert.match(pair, /isTrusted: \(\) => vscode\.workspace\.isTrusted/);
  const spawn = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'src', 'bus', 'spawn.ts'), 'utf8');
  const gate = spawn.indexOf('deps.isTrusted()');
  const trust = spawn.indexOf('"trust-claude"');
  const register = spawn.indexOf('"register"');
  assert.ok(gate > 0 && trust > gate && register > trust, 'order must be: isTrusted gate → trust-claude → register');
});
