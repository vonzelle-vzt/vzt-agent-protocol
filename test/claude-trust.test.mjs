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

function loadTrust() {
  const start = src.indexOf('function trustClaudeWorkspace');
  assert.ok(start > 0, 'trustClaudeWorkspace missing from CLI');
  const rest = src.slice(start);
  const fnSrc = rest.slice(0, rest.indexOf('\nfunction ', 1));
  return new Function('fs', 'os', 'path', 'process', `${fnSrc}\nreturn trustClaudeWorkspace;`)(fs, os, path, process);
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

test('trust: writes the one-key entry Orca writes, and keeps every other key', () => {
  withConfig({ numStartups: 7, projects: { '/other': { allowedTools: ['x'] } } }, ({ file, wt }) => {
    assert.equal(loadTrust()(wt), true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cfg.projects[wt], { hasTrustDialogAccepted: true });
    assert.equal(cfg.numStartups, 7);
    assert.deepEqual(cfg.projects['/other'], { allowedTools: ['x'] });
  });
});

test('trust: merges into an existing project entry instead of replacing it', () => {
  withConfig({ projects: {} }, ({ file, wt }) => {
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
    seeded.projects[wt] = { lastSessionId: 'abc' };
    fs.writeFileSync(file, JSON.stringify(seeded));
    assert.equal(loadTrust()(wt), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects[wt], { lastSessionId: 'abc', hasTrustDialogAccepted: true });
  });
});

test('trust: never creates a config that does not exist, and never throws', () => {
  withConfig(null, ({ file, wt }) => {
    assert.equal(loadTrust()(wt), false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('trust: the orca backend trusts the worktree BEFORE it opens the agent pane', () => {
  const body = src.slice(src.indexOf('function orcaBackend'));
  const trustAt = body.indexOf('trustClaudeWorkspace(wpath)');
  const paneAt = body.indexOf('paneArgv(spec, u, wtId, wpath');
  assert.ok(trustAt > 0 && paneAt > 0 && trustAt < paneAt);
});
