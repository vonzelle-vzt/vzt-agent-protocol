import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'vzt-dispatch-log.mjs');

function run(input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-dispatch-'));
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'vzt-builder.md'), '---\nname: vzt-builder\nmodel: sonnet\n---\nbody\n');
  const env = { ...process.env, HOME: home };
  delete env.VZT_ROUTER_STATE_DIR;
  const r = spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8' });
  const log = path.join(home, '.claude', 'vzt-router', 'decisions.jsonl');
  const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, rows };
}

test('dispatch-log: appends one row with model from agent frontmatter', () => {
  const { r, rows } = run(JSON.stringify({ session_id: 's1', agent_type: 'vzt-builder' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'dispatch');
  assert.equal(rows[0].session, 's1');
  assert.equal(rows[0].subagent_type, 'vzt-builder');
  assert.equal(rows[0].model, 'sonnet');
  assert.equal(rows[0].modelSource, 'agent-frontmatter');
});

test('dispatch-log: unknown agent type gives model null', () => {
  const { r, rows } = run(JSON.stringify({ session_id: 's2', agent_type: 'no-such-agent' }));
  assert.equal(r.status, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].modelSource, 'unknown');
});

test('dispatch-log: malformed payload exits 0 silently', () => {
  const { r, rows } = run('{not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(rows.length <= 1);
});
