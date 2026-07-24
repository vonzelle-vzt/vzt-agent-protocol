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
    assert.match(out, /hooks:\s+3 installed/);

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

// ——— v1.5.0: /vzt-ship —————————————————————————————————————————————————————
//
// The v1.4.0 bug: the doctrine told every session to open templates/worker-brief.md,
// and install() never copied templates/. The instruction pointed at nothing.
// /vzt-ship now tells the session to launch workflows/vzt-ship.js. Same class of
// bug, one release later — so it gets its own test.

test('install ships the workflow script and the /vzt-ship skill', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-ship-install-'));
  try {
    const out = run(['install', '--target', target]);
    assert.match(out, /workflows:\s+1 installed/);
    const dotClaude = path.join(target, '.claude');
    assert.ok(fs.existsSync(path.join(dotClaude, 'workflows', 'vzt-ship.js')), 'workflows/vzt-ship.js was not installed — /vzt-ship would launch Workflow with a scriptPath that does not exist');
    assert.ok(fs.existsSync(path.join(dotClaude, 'skills', 'vzt-ship', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dotClaude, 'templates', 'spec.md')));
    assert.match(run(['doctor', '--target', target]), /All checks passed/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('uninstall removes our workflow but leaves a foreign one alone', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-ship-uninstall-'));
  try {
    run(['install', '--target', target]);
    const wfDir = path.join(target, '.claude', 'workflows');
    const foreign = path.join(wfDir, 'someone-elses.js');
    fs.writeFileSync(foreign, '// not ours\n');

    run(['uninstall', '--target', target]);
    assert.ok(!fs.existsSync(path.join(wfDir, 'vzt-ship.js')), 'uninstall left our workflow behind');
    assert.ok(fs.existsSync(foreign), 'uninstall destroyed a workflow we do not own');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('ship-check exits 0 on the shipped template', () => {
  const out = run(['ship-check', path.join(__dirname, '..', 'templates', 'spec.md')]);
  assert.match(out, /SPEC valid/);
  assert.match(out, /pairwise disjoint/);
});

test('ship-check EXITS NON-ZERO on overlapping FILES_IN_SCOPE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-badspec-'));
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'templates', 'spec.md'), 'utf8');
    // u2 now claims the file u1 already owns.
    const bad = src.replace('"filesInScope": ["src/example/invoice.ts"]', '"filesInScope": ["src/example/meter.ts"]');
    const spec = path.join(dir, 'SPEC.md');
    fs.writeFileSync(spec, bad);

    assert.throws(
      () => run(['ship-check', spec], { stdio: 'pipe' }),
      (e) => {
        assert.equal(e.status, 1, 'a colliding spec must exit 1');
        assert.match(String(e.stderr), /collision/i);
        return true;
      },
      'ship-check accepted a spec whose units would clobber each other'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ship-start → ship-note → ship-status reconstructs the run from disk alone', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-shiprun-'));
  try {
    const specDir = path.join(repo, '.vzt', 'ship', 'example-slug');
    fs.mkdirSync(specDir, { recursive: true });
    const spec = path.join(specDir, 'SPEC.md');
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'spec.md'), spec);

    run(['ship-start', spec]);
    run(['ship-note', spec, JSON.stringify({ kind: 'workflow_launched', wfRunId: 'wf_test123' })]);
    run(['ship-note', spec, JSON.stringify({ kind: 'unit_result', unit: 'u1-meter', status: 'PASS', round: 0 })]);
    run(['ship-note', spec, JSON.stringify({ kind: 'unit_result', unit: 'u2-invoice', status: 'BLOCKED', round: 2 })]);

    // This is the release's actual acceptance test: run state, with the
    // conversation gone. Nothing below comes from context — only from disk.
    const out = run(['ship-status', '--target', repo]);
    assert.match(out, /ACTIVE/);
    assert.match(out, /u1-meter PASS/);
    assert.match(out, /u2-invoice BLOCKED\(2\)/);
    assert.match(out, /wf_test123/);
    assert.match(out, /escalate exactly ONE tier/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
