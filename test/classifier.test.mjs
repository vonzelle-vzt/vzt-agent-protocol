import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../hooks/vzt-route-classifier.mjs';

const cases = [
  // fable — planning/architecture
  ['Design the system architecture for a multi-tenant SaaS billing platform', 'fable'],
  ['Help me plan out the migration strategy from Postgres to a sharded setup, weighing trade-offs', 'fable'],
  // fable — impossible bugs
  ['There is a race condition somewhere, the job intermittently fails and I have no idea why it breaks', 'fable'],
  ['Find the root cause of this memory leak, it is still failing after three fixes', 'fable'],
  // opus — heavy build
  ['Refactor the entire payment module and migrate all the handlers to the new event bus', 'opus'],
  ['Optimize the concurrency of the ingest pipeline, the parallelism is wrong under load', 'opus'],
  // sonnet — standard build
  ['Add a settings page with a form to update the user profile', 'sonnet'],
  ['Fix the bug where the modal does not close after submit and write a test for it', 'sonnet'],
  // haiku — mechanical
  ['Fix the typo in the header and bump the version to 2.1.0', 'haiku'],
  ['Rename getUserData to fetchUserProfile everywhere', 'haiku'],
  // haiku — scout
  ['Where is the stripe webhook handler defined and which files import it?', 'haiku'],
  ['Summarize the status of the auth module for me', 'haiku'],
  // default
  ['Thanks, that looks good, please continue with the next one', 'sonnet'],
];

for (const [prompt, expected] of cases) {
  test(`"${prompt.slice(0, 60)}..." → ${expected}`, () => {
    const r = classify(prompt);
    assert.equal(r.tier, expected, `got ${r.tier} (scores: ${JSON.stringify(r.scores)})`);
  });
}

test('classifier returns confidence and signals', () => {
  const r = classify('Design the architecture for the new system from scratch');
  assert.ok(['low', 'medium', 'high'].includes(r.confidence));
  assert.ok(Array.isArray(r.matched));
});
