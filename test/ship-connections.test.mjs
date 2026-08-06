/**
 * CONNECTIONS_IN_SCOPE — the external side-effect boundary.
 *
 * FILES_IN_SCOPE bounds what a unit writes inside the repo. Nothing bounded what
 * it could reach outside one, and the ship path makes that gap sharp: every unit
 * worktree gets the primary checkout's `.env*` symlinked in by
 * worktree-bootstrap.sh, so a parallel fan-out starts holding whatever
 * production credentials the repo holds.
 *
 * The gate must be DEFAULT-DENY. The case that matters most is the one that used
 * to pass silently: a spec naming a connection no registry declares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConnections, connectionsOf, validateSpec } from '../cli/ship-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli', 'vzt-agent.js');

const specWith = (connectionsInScope) => ({
  specVersion: 1,
  slug: 'demo',
  title: 'Demo',
  root: '/abs/repo',
  contract: 'Do the thing.',
  manifest: [{ path: 'a.ts', op: 'new' }, { path: 'b.ts', op: 'new' }],
  units: [
    { id: 'u1', title: 'A', agentType: 'vzt-builder', filesInScope: ['a.ts'], brief: 'build a', machineCheck: 'npm test a', expect: 'exit 0', ...(connectionsInScope ? { connectionsInScope } : {}) },
    { id: 'u2', title: 'B', agentType: 'vzt-builder', filesInScope: ['b.ts'], brief: 'build b', machineCheck: 'npm test b', expect: 'exit 0' },
  ],
  integration: { machineCheck: 'npm test', expect: 'exit 0' },
});

const registry = (extra = {}) => JSON.stringify({
  version: 1,
  connections: [{ id: 'stripe-test', service: 'stripe', mode: 'test', credentialEnv: 'STRIPE_TEST_SECRET_KEY', allow: ['read', 'write'], ...extra }],
});

// ——— the default-deny rule ————————————————————————————————————————————————

test('a unit declaring no connection is valid — repo-local work stays frictionless', () => {
  assert.deepEqual(validateSpec(specWith(null), { connections: ['stripe-test'] }), []);
  assert.deepEqual(validateSpec(specWith(null), { connections: null }), []);
  // and with no opts at all — every pre-existing caller and spec keeps working
  assert.deepEqual(validateSpec(specWith(null)), []);
});

test('a connection with no registry is REFUSED — absent registry means nothing is declared, not anything goes', () => {
  const errs = validateSpec(specWith(['stripe-test']), { connections: null });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /u1: declares connection "stripe-test".*no \.vzt\/connections\.json/);
});

test('a connection absent from the registry is REFUSED', () => {
  const errs = validateSpec(specWith(['stripe-live']), { connections: ['stripe-test'] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /connection "stripe-live" is not in \.vzt\/connections\.json/);
});

test('a registered connection passes', () => {
  assert.deepEqual(validateSpec(specWith(['stripe-test']), { connections: ['stripe-test'] }), []);
});

test('connectionsInScope must be an array', () => {
  const spec = specWith(null);
  spec.units[0].connectionsInScope = 'stripe-test';
  const errs = validateSpec(spec, { connections: ['stripe-test'] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /connectionsInScope must be an array/);
});

test('the barrier is bound by the same rule as any other unit', () => {
  const spec = specWith(null);
  spec.barrier = { id: 'u0', title: 'contract', agentType: 'vzt-builder', filesInScope: ['t.ts'], connectionsInScope: ['nope'], brief: 'b', machineCheck: 'x', expect: 'exit 0' };
  const errs = validateSpec(spec, { connections: ['stripe-test'] });
  assert.ok(errs.some((e) => /u0: connection "nope" is not in/.test(e)), errs.join('; '));
});

test('connectionsOf ignores junk entries rather than passing them to the gate', () => {
  assert.deepEqual(connectionsOf({ connectionsInScope: ['a', '', '  ', 7, null, 'b'] }), ['a', 'b']);
  assert.deepEqual(connectionsOf({}), []);
});

// ——— the registry file itself ——————————————————————————————————————————————

test('a well-formed registry parses', () => {
  const { connections, errors } = parseConnections(registry());
  assert.deepEqual(errors, []);
  assert.equal(connections[0].id, 'stripe-test');
});

test('an inline credential is REFUSED — this file is git-tracked', () => {
  for (const field of ['token', 'secret', 'apiKey', 'credential', 'password', 'key']) {
    const { errors } = parseConnections(registry({ [field]: 'sk_live_deadbeef' }));
    assert.ok(errors.some((e) => e.includes(`"${field}" is forbidden`)), `${field}: ${errors.join('; ')}`);
  }
});

test('a registry entry missing a required field is REFUSED', () => {
  const doc = JSON.parse(registry());
  delete doc.connections[0].credentialEnv;
  const { connections, errors } = parseConnections(JSON.stringify(doc));
  assert.equal(connections, null);
  assert.ok(errors.some((e) => /missing required field: credentialEnv/.test(e)), errors.join('; '));
});

test('an empty allow list is REFUSED — a connection permitting nothing is a spec bug', () => {
  const doc = JSON.parse(registry());
  doc.connections[0].allow = [];
  const { errors } = parseConnections(JSON.stringify(doc));
  assert.ok(errors.some((e) => /empty allow/.test(e)), errors.join('; '));
});

test('duplicate connection ids are REFUSED', () => {
  const doc = JSON.parse(registry());
  doc.connections.push({ ...doc.connections[0] });
  const { errors } = parseConnections(JSON.stringify(doc));
  assert.ok(errors.some((e) => /duplicate connection id: stripe-test/.test(e)), errors.join('; '));
});

test('malformed registry files are REFUSED, not ignored', () => {
  assert.match(parseConnections('{oops').errors[0], /not valid JSON/);
  assert.match(parseConnections('[]').errors[0], /top level must be an object/);
  assert.match(parseConnections('{"version":1}').errors[0], /missing "connections" array/);
});

test('the shipped template is a valid registry once its _readme is dropped', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'connections.json'), 'utf8'));
  delete doc._readme;
  assert.deepEqual(parseConnections(JSON.stringify(doc)).errors, []);
});

// ——— end to end: the gate is a command, not an opinion ——————————————————————

function fixture(spec, registryText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-conn-'));
  spec.root = root;
  if (registryText) {
    fs.mkdirSync(path.join(root, '.vzt'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vzt', 'connections.json'), registryText);
  }
  const specPath = path.join(root, 'SPEC.md');
  fs.writeFileSync(specPath, `# fixture\n<!-- vzt-spec -->\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`);
  return specPath;
}

function shipCheck(specPath) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, 'ship-check', specPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('ship-check EXITS NON-ZERO on a spec naming an unregistered connection', () => {
  const { code, out } = shipCheck(fixture(specWith(['stripe-test']), null));
  assert.equal(code, 1, `expected a red gate, got:\n${out}`);
  assert.match(out, /no \.vzt\/connections\.json/);
});

test('ship-check passes once the connection is registered, and names it in the summary', () => {
  const { code, out } = shipCheck(fixture(specWith(['stripe-test']), registry()));
  assert.equal(code, 0, out);
  assert.match(out, /external: 1 declared connection\(s\) — stripe-test/);
});

test('ship-check reports a repo-local run when nothing is declared', () => {
  const { code, out } = shipCheck(fixture(specWith(null), null));
  assert.equal(code, 0, out);
  assert.match(out, /external: none declared \(repo-local run\)/);
});

test('a broken registry fails the gate rather than silently degrading to default-deny', () => {
  const { code, out } = shipCheck(fixture(specWith(['stripe-test']), '{oops'));
  assert.equal(code, 1, out);
  assert.match(out, /\.vzt\/connections\.json: not valid JSON/);
});

// ——— the boundary must reach the WORKER, or it binds only the plan ——————————

test('ship-dispatch renders CONNECTIONS_IN_SCOPE into the unit prompt', () => {
  const specPath = fixture(specWith(['stripe-test']), registry());
  const out = execFileSync('node', [CLI, 'ship-dispatch', specPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /CONNECTIONS_IN_SCOPE — the ONLY external services you may reach/);
  assert.match(out, /stripe-test/);
});

test('a unit declaring nothing is told so explicitly — silence reads as permission', () => {
  const specPath = fixture(specWith(null), null);
  const out = execFileSync('node', [CLI, 'ship-dispatch', specPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /CONNECTIONS_IN_SCOPE — none\. This unit is repo-local/);
  assert.match(out, /holding a credential is not permission to use it/i);
});
