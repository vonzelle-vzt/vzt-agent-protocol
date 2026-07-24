import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, suggestEffort, directive, TIERS } from '../hooks/vzt-route-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const cases = [
  // fable — planning/architecture
  ['Design the system architecture for a multi-tenant SaaS billing platform', 'fable', 'high'],
  ['Help me plan out the migration strategy from Postgres to a sharded setup, weighing trade-offs', 'fable', 'high'],
  // fable — impossible bugs
  ['There is a race condition somewhere, the job intermittently fails and I have no idea why it breaks', 'fable', 'high'],
  ['Find the root cause of this memory leak, it is still failing after three fixes', 'fable', 'high'],
  // opus — heavy build
  ['Refactor the entire payment module and migrate all the handlers to the new event bus', 'opus', 'high'],
  ['Optimize the concurrency of the ingest pipeline, the parallelism is wrong under load', 'opus', 'high'],
  // sonnet — standard build
  ['Add a settings page with a form to update the user profile', 'sonnet', 'medium'],
  ['Fix the bug where the modal does not close after submit and write a test for it', 'sonnet', 'medium'],
  // haiku — mechanical
  ['Fix the typo in the header and bump the version to 2.1.0', 'haiku', 'low'],
  ['Rename getUserData to fetchUserProfile everywhere', 'haiku', 'low'],
  // haiku — scout
  ['Where is the stripe webhook handler defined and which files import it?', 'haiku', 'low'],
  ['Summarize the status of the auth module for me', 'haiku', 'low'],
  // default
  ['Thanks, that looks good, please continue with the next one', 'sonnet', 'medium'],
];

for (const [prompt, expectedTier, expectedEffort] of cases) {
  test(`"${prompt.slice(0, 60)}..." → ${expectedTier}/${expectedEffort}`, () => {
    const r = classify(prompt);
    assert.equal(r.tier, expectedTier, `got ${r.tier} (scores: ${JSON.stringify(r.scores)})`);
    assert.equal(r.effort, expectedEffort, `got effort ${r.effort} (confidence: ${r.confidence})`);
  });
}

// ——— HORIZON: long-horizon builds are spec-first Opus work, not Fable work ———

const horizonCases = [
  'Build the entire notification system from scratch, end-to-end',
  'Implement the whole admin dashboard greenfield across every route',
  'Ship a multi-tenant billing subsystem from the ground up',
];

for (const prompt of horizonCases) {
  test(`HORIZON: "${prompt.slice(0, 50)}..." → opus/horizon/high`, () => {
    const r = classify(prompt);
    assert.equal(r.tier, 'opus', `got ${r.tier} (scores: ${JSON.stringify(r.scores)})`);
    assert.equal(r.kind, 'horizon', `got kind ${r.kind}`);
    assert.equal(r.effort, 'high');
  });
}

// THE REGRESSION GUARD. Scope language used to route to Fable — i.e. to the
// SLOWER model — on exactly the prompts where a slower model buys nothing,
// because long-horizon work fails on lost coherence, not on model IQ.
test('no long-horizon BUILD ever routes to fable (the bug this release fixes)', () => {
  for (const prompt of horizonCases) {
    assert.notEqual(classify(prompt).tier, 'fable', `"${prompt}" escalated the MODEL instead of the PROCESS`);
  }
});

// The gate is two-factor on purpose: scope alone is a planning question.
test('two-factor gate: SCOPE without a BUILD verb is NOT horizon (stays planning)', () => {
  const r = classify('Design the architecture for the whole system from scratch');
  assert.equal(r.tier, 'fable', 'a pure design question must still reach the planning tier');
  assert.notEqual(r.kind, 'horizon');
});

test('two-factor gate: a BUILD verb without SCOPE is NOT horizon (stays routine)', () => {
  const r = classify('Build a settings page with a form');
  assert.equal(r.tier, 'sonnet');
  assert.notEqual(r.kind, 'horizon');
});

test('no legacy case is misclassified as horizon', () => {
  for (const [prompt] of cases) {
    assert.notEqual(classify(prompt).kind, 'horizon', `"${prompt}" wrongly became a horizon task`);
  }
});

test('the horizon directive forbids implementing and routes to /vzt-ship', () => {
  const r = classify(horizonCases[0]);
  const d = directive(r, 'opus');
  for (const phrase of ['/vzt-ship', 'do NOT start implementing', 'ship-check', 'Escalate the PROCESS, not the MODEL', 'ship-status']) {
    assert.ok(d.includes(phrase), `horizon directive missing "${phrase}"`);
  }
  // Never fan a subagent at a spec — the chair writes it, then supervises.
  assert.ok(!d.includes('Delegate to the "'), 'horizon directive must not delegate the spec to a subagent');
  // It is still the Opus tier, so the gates still apply.
  assert.ok(d.includes('fable-mode gates'), 'horizon is an Opus surface — it must carry the gates');
});

test('classifier returns confidence and signals', () => {
  const r = classify('Design the architecture for the new system from scratch');
  assert.ok(['low', 'medium', 'high'].includes(r.confidence));
  assert.ok(Array.isArray(r.matched));
});

test('classify() effort is always low/medium/high/xhigh, never max', () => {
  for (const [prompt] of cases) {
    const r = classify(prompt);
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(r.effort), `unexpected effort "${r.effort}" for "${prompt}"`);
  }
});

test('classify() lifts a HARD (multi-signal) opus build to xhigh (matches the heavy-builder it delegates to)', () => {
  // A single opus signal is medium-confidence and stays at high; only a clearly-hard
  // build (refactor + performance/concurrency + complexity) reaches high → xhigh.
  const r = classify('Refactor the ingest pipeline for performance — the concurrency is gnarly with tricky edge cases');
  assert.equal(r.tier, 'opus');
  assert.equal(r.kind, 'build');
  assert.equal(r.confidence, 'high');
  assert.equal(r.effort, 'xhigh');
});

test('classify() keeps a single-signal opus build at high (not every opus build is xhigh)', () => {
  const r = classify('Refactor the payment module handlers');
  assert.equal(r.tier, 'opus');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.effort, 'high');
});

test('suggestEffort: opus downgrades to medium on low confidence', () => {
  assert.equal(suggestEffort('opus', 'low'), 'medium');
  assert.equal(suggestEffort('opus', 'high'), 'high'); // no kind → tier default
});

test('suggestEffort: high-confidence opus BUILD earns xhigh; review/moderate stay high', () => {
  assert.equal(suggestEffort('opus', 'high', 'build'), 'xhigh');
  assert.equal(suggestEffort('opus', 'high', 'review'), 'high');
  assert.equal(suggestEffort('opus', 'medium', 'build'), 'high');
  assert.equal(suggestEffort('opus', 'low', 'build'), 'medium');
});

test('suggestEffort: haiku is always low regardless of confidence', () => {
  assert.equal(suggestEffort('haiku', 'low'), 'low');
  assert.equal(suggestEffort('haiku', 'medium'), 'low');
  assert.equal(suggestEffort('haiku', 'high'), 'low');
});

test('suggestEffort: fable never returns max', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    assert.notEqual(suggestEffort('fable', confidence), 'max');
  }
});

test('docs mirror TIERS cost values exactly (sync check)', () => {
  const matrix = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ROUTING-MATRIX.md'), 'utf8');
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  for (const tier of Object.keys(TIERS)) {
    const costString = `${TIERS[tier].cost}×`;
    assert.ok(matrix.includes(costString), `docs/ROUTING-MATRIX.md missing "${costString}" for ${tier}`);
    assert.ok(skill.includes(costString), `skills/vzt-route/SKILL.md missing "${costString}" for ${tier}`);
  }
});

test('worker-brief template exists and defines the collision-boundary contract', () => {
  const brief = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'worker-brief.md'), 'utf8');
  for (const phrase of ['FILES_IN_SCOPE', 'MACHINE_CHECK', 'EXPECT', 'Collision boundary is law', 'Reporting ≠ persistence']) {
    assert.ok(brief.includes(phrase), `templates/worker-brief.md missing "${phrase}"`);
  }
});

// The doctrine referenced templates/worker-brief.md in every session, but the
// installer never copied templates/ — so at runtime the brief pointed at
// nothing. The file existed; the install did not. Guard the reference, not just
// the file.
test('every file path the doctrine references is actually installed', () => {
  const referenced = new Set();
  const scan = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'hooks')).map((f) => path.join(REPO_ROOT, 'hooks', f)),
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'skills'))
      .map((d) => path.join(REPO_ROOT, 'skills', d, 'SKILL.md'))
      .filter((f) => fs.existsSync(f)),
  ];
  for (const file of scan) {
    const contents = fs.readFileSync(file, 'utf8');
    // Generalized past the v1.4.0 bug: ANY shipped directory the doctrine points
    // at must be copied by install(), not just templates/.
    for (const m of contents.matchAll(/(templates|workflows)\/[A-Za-z0-9._-]+\.(md|js)/g)) referenced.add(m[0]);
  }
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'vzt-agent.js'), 'utf8');
  assert.ok(referenced.size > 0, 'expected the doctrine to reference at least one shipped file');

  const DIR_VARS = { templates: 'TEMPLATES_DIR', workflows: 'WORKFLOWS_DIR' };
  for (const ref of referenced) {
    // (a) the file exists in the repo …
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ref)), `doctrine references ${ref}, which does not exist in the repo`);
    // (b) … and install() actually copies the directory it lives in, and
    //     uninstall() actually removes it. A doctrine pointing at a file the
    //     installer never copied is exactly the v1.4.0 bug.
    const dir = ref.split('/')[0];
    const v = DIR_VARS[dir];
    assert.ok(
      new RegExp(`copyDirContents\\(${v}`).test(cli),
      `doctrine references ${ref} but cli/vzt-agent.js never installs ${dir}/ (no copyDirContents(${v}...))`
    );
    assert.ok(new RegExp(`\\[${v},`).test(cli), `cli/vzt-agent.js install()s ${dir}/ but uninstall() never removes it`);
  }
});

test('the ship spec template encodes the machine-readable contract', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'spec.md'), 'utf8');
  for (const phrase of ['<!-- vzt-spec', 'FILES_IN_SCOPE', 'machineCheck', 'expect', 'barrier', 'pairwise disjoint']) {
    assert.ok(spec.includes(phrase), `templates/spec.md missing "${phrase}"`);
  }
});

test('worker-brief encodes the supervision + correction protocol', () => {
  const brief = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'worker-brief.md'), 'utf8');
  for (const phrase of ['CORRECTION', 'SCOPE_BREACH', 'SendMessage', 'Two rounds is the ceiling', 'Name every worker']) {
    assert.ok(brief.includes(phrase), `templates/worker-brief.md missing "${phrase}"`);
  }
});

test('/vzt-ship ships, authorizes Workflow, and carries its own kill-switch', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-ship', 'SKILL.md'), 'utf8');
  for (const phrase of ['Workflow', 'ship-check', 'pairwise disjoint', 'no filesystem access', 'Falsification rule', 'templates/worker-brief.md']) {
    assert.ok(skill.includes(phrase), `skills/vzt-ship/SKILL.md missing "${phrase}"`);
  }
});

test('vzt-diagnose ships and encodes the fan-out limits', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-diagnose', 'SKILL.md'), 'utf8');
  for (const phrase of ['CONFIRMED', 'REFUTED', 'INCONCLUSIVE', 'read-only', 'confirmed_idx']) {
    assert.ok(skill.includes(phrase), `skills/vzt-diagnose/SKILL.md missing "${phrase}"`);
  }
  const route = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  assert.ok(route.includes('never for CORRECTNESS'), 'vzt-route missing the fan-out purpose rule');
  assert.ok(route.includes('Rejected — do not re-propose'), 'vzt-route missing the recorded worktree/judge rejection');
});

test('worker agents enforce the collision boundary', () => {
  for (const agent of ['vzt-builder.md', 'vzt-mechanic.md', 'vzt-heavy-builder.md']) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, 'agents', agent), 'utf8');
    assert.ok(contents.includes('Collision boundary'), `agents/${agent} missing "Collision boundary"`);
  }
});

test('every Opus surface carries the fable-mode gates (always-on discipline)', () => {
  // Both Opus agents state the gates as a rule.
  for (const agent of ['vzt-heavy-builder.md', 'vzt-reviewer.md']) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, 'agents', agent), 'utf8');
    assert.ok(contents.includes('fable-mode gates — always on'), `agents/${agent} missing always-on fable-mode gates rule`);
  }
  // The Opus chair profile injects the gates at session start.
  const sessionStart = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'vzt-session-start.mjs'), 'utf8');
  assert.ok(/opus: `[^`]*five gates/.test(sessionStart), 'opus chair profile missing the five gates');
  // Opus-targeted directives restate the discipline; other tiers do not.
  const opusDirective = directive({ tier: 'opus', kind: 'build', confidence: 'high', effort: 'high', matched: [], scores: {}, words: 10 }, 'sonnet');
  assert.ok(opusDirective.includes('fable-mode gates'), 'opus [VZT-ROUTE] directive missing the gates line');
  const sonnetDirective = directive({ tier: 'sonnet', kind: 'build', confidence: 'high', effort: 'medium', matched: [], scores: {}, words: 10 }, 'sonnet');
  assert.ok(!sonnetDirective.includes('fable-mode gates'), 'sonnet directive should not carry the opus gates line');
});

test('vzt-route skill references the worker-brief template', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('worker-brief'), 'skills/vzt-route/SKILL.md missing reference to "worker-brief"');
});
