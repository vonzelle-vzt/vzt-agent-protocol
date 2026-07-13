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

test('classifier returns confidence and signals', () => {
  const r = classify('Design the architecture for the new system from scratch');
  assert.ok(['low', 'medium', 'high'].includes(r.confidence));
  assert.ok(Array.isArray(r.matched));
});

test('classify() effort is always low/medium/high, never max', () => {
  for (const [prompt] of cases) {
    const r = classify(prompt);
    assert.ok(['low', 'medium', 'high'].includes(r.effort), `unexpected effort "${r.effort}" for "${prompt}"`);
  }
});

test('suggestEffort: opus downgrades to medium on low confidence', () => {
  assert.equal(suggestEffort('opus', 'low'), 'medium');
  assert.equal(suggestEffort('opus', 'high'), 'high');
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
    for (const m of contents.matchAll(/templates\/[A-Za-z0-9._-]+\.md/g)) referenced.add(m[0]);
  }
  // Anything the doctrine tells an agent to open must be shipped by install().
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'vzt-agent.js'), 'utf8');
  assert.ok(referenced.size > 0, 'expected the doctrine to reference at least one template');
  assert.ok(
    /TEMPLATES_DIR/.test(cli) && /copyDirContents\(TEMPLATES_DIR/.test(cli),
    `doctrine references ${[...referenced].join(', ')} but cli/vzt-agent.js never installs templates/`
  );
  for (const ref of referenced) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ref)), `doctrine references ${ref}, which does not exist in the repo`);
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
