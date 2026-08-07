import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'vzt-session-start.mjs');

function runSessionStart(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-session-home-'));
  try {
    const env = { ...process.env, HOME: home, VZT_ROUTER_STATE_DIR: path.join(home, '.claude', 'vzt-router') };
    delete env.ORCA_TERMINAL_HANDLE;
    Object.assign(env, extraEnv);
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ model: 'claude-opus-5', session_id: 's1' }),
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    return parsed.hookSpecificOutput.additionalContext;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('session-start names the Orca handle when visible panes are available', () => {
  const context = runSessionStart({ ORCA_TERMINAL_HANDLE: 'term_smoke' });
  assert.ok(context.includes('Chair = Opus 5'), 'per-profile marker should survive');
  assert.ok(context.includes('you ARE inside an Orca terminal (handle term_smoke)'), 'missing factual Orca handle wording');
  assert.ok(context.includes('--detach'), 'visible pane doctrine should mention detach');
  assert.ok(!context.includes('VISIBLE PARALLELISM — not available'), 'Orca session should not emit unavailable fallback');
});

test('session-start emits one unavailable line when no Orca terminal is detected', () => {
  const context = runSessionStart();
  assert.ok(context.includes('Chair = Opus 5'), 'per-profile marker should survive');
  assert.ok(context.includes('VISIBLE PARALLELISM — not available: no Orca terminal detected (ORCA_TERMINAL_HANDLE unset). Use Agent-tool subagents and say so.'));
  assert.ok(!context.includes('you ARE inside an Orca terminal'), 'non-Orca session should not claim a handle');
  assert.ok(!context.includes('vzt-orca-flow pane run'), 'non-Orca fallback should be a single unavailable line');
});
