import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, suggestEffort, TIERS } from '../hooks/vzt-route-classifier.mjs';

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
