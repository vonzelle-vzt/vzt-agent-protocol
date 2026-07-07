import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-router-state-'));
const HOOK_ENV = { ...process.env, VZT_ROUTER_STATE_DIR: STATE_DIR };

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

test('install → doctor → uninstall round-trip in a temp target', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-agent-test-'));
  try {
    const out = run(['install', '--target', target]);
    assert.match(out, /agents:\s+7 installed/);
    assert.match(out, /hooks:\s+2 installed/);

    const dotClaude = path.join(target, '.claude');
    assert.ok(fs.existsSync(path.join(dotClaude, 'agents', 'vzt-planner.md')));
    assert.ok(fs.existsSync(path.join(dotClaude, 'skills', 'vzt-route', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dotClaude, 'skills', 'vzt-fable-mode', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dotClaude, 'hooks', 'vzt-router', 'vzt-route-classifier.mjs')));

    const settings = JSON.parse(fs.readFileSync(path.join(dotClaude, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit.length >= 1);
    assert.ok(settings.hooks.SessionStart.length >= 1);

    // idempotent: second install must not duplicate hook entries
    run(['install', '--target', target]);
    const settings2 = JSON.parse(fs.readFileSync(path.join(dotClaude, 'settings.json'), 'utf8'));
    assert.equal(settings2.hooks.UserPromptSubmit.length, settings.hooks.UserPromptSubmit.length);

    const doctorOut = run(['doctor', '--target', target]);
    assert.match(doctorOut, /All checks passed/);

    run(['uninstall', '--target', target]);
    assert.ok(!fs.existsSync(path.join(dotClaude, 'agents', 'vzt-planner.md')));
    const settings3 = JSON.parse(fs.readFileSync(path.join(dotClaude, 'settings.json'), 'utf8'));
    assert.ok(!settings3.hooks?.UserPromptSubmit);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('install preserves pre-existing settings and foreign hooks', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-agent-test-'));
  try {
    const dotClaude = path.join(target, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo other-tool' }] }] },
      })
    );
    run(['install', '--target', target]);
    const settings = JSON.parse(fs.readFileSync(path.join(dotClaude, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.equal(settings.hooks.UserPromptSubmit.length, 2);

    run(['uninstall', '--target', target]);
    const after = JSON.parse(fs.readFileSync(path.join(dotClaude, 'settings.json'), 'utf8'));
    assert.equal(after.hooks.UserPromptSubmit.length, 1);
    assert.match(after.hooks.UserPromptSubmit[0].hooks[0].command, /other-tool/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('classifier hook emits a directive for a plan prompt', () => {
  const input = JSON.stringify({
    prompt: 'Design the architecture for the new multi-tenant reporting system',
    session_id: 'test-session',
  });
  const out = execFileSync('node', [path.join(__dirname, '..', 'hooks', 'vzt-route-classifier.mjs')], {
    encoding: 'utf8',
    env: HOOK_ENV,
    input,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Fable 5/);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /@ effort (low|medium|high)/);
});

test('classifier hook stays silent on slash commands and tiny prompts', () => {
  for (const prompt of ['/model sonnet', 'ok thanks', '~ just do it directly please']) {
    const out = execFileSync('node', [path.join(__dirname, '..', 'hooks', 'vzt-route-classifier.mjs')], {
      encoding: 'utf8',
      input: JSON.stringify({ prompt, session_id: 't' }),
    });
    assert.equal(out.trim(), '');
  }
});

test('session-start hook emits chair profile', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'hooks', 'vzt-session-start.mjs')], {
    encoding: 'utf8',
    env: HOOK_ENV,
    input: JSON.stringify({ model: 'claude-sonnet-5', session_id: 'test-chair' }),
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Chair = Sonnet 5/);
});
