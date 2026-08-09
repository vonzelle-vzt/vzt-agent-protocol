// Coverage for the Ship Run tree (vscode/src/shipTree.ts) after waves landed.
//
// These run the REAL compiled provider out of vscode/out/shipTree.js against a
// stub `vscode` module and REAL fixture directories on disk, then read the
// RENDERED tree items — labels, descriptions, icons, nesting.
//
// That distinction is the point. A test that called deriveState and compared it
// to its own copy of the precedence rules would restate the function's own
// arithmetic and pass on a tree that renders nothing. The bug this view exists
// to surface is a unit sitting in a state nobody can see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TREE_JS = path.join(REPO_ROOT, 'vscode', 'out', 'shipTree.js');

/** Minimal stand-in for `vscode`. shipTree touches TreeItem, ThemeIcon,
 *  ThemeColor, MarkdownString, EventEmitter and the collapsible enum. If this
 *  stub has to grow, the view has picked up a host dependency it should not have. */
function makeVscodeStub() {
  return {
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(id, color) { this.id = id; this.color = color; }
    },
    ThemeColor: class {
      constructor(id) { this.id = id; }
    },
    MarkdownString: class {
      constructor(value) { this.value = value; }
    },
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose: () => {} }); }
      fire() {}
      dispose() {}
    },
    workspace: {
      getConfiguration: () => ({ get: () => '' }),
    },
  };
}

function loadTree() {
  if (!fs.existsSync(TREE_JS)) {
    assert.fail('vscode/out/shipTree.js missing — run `npm run compile` in vscode/ before testing');
  }
  const req = createRequire(import.meta.url);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return makeVscodeStub();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete req.cache[req.resolve(TREE_JS)];
    return req(TREE_JS);
  } finally {
    Module._load = originalLoad;
  }
}

/** Build a real ~/.vzt/vscode-mux fixture and point the provider at it. */
function fixture(units, sentinels = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-tree-'));
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  for (const u of units) {
    const rec = {
      unitKey: `${u.slug || 'run'}-${u.id}`,
      slug: u.slug || 'run',
      id: u.id,
      title: u.title || u.id,
      cwd: `/tmp/wt/${u.id}`,
      machineCheck: 'true',
      expect: 'exit 0',
      dispatchedAt: u.dispatchedAt || '2026-08-01T00:00:00.000Z',
      ...u,
    };
    fs.writeFileSync(path.join(dir, 'units', `${rec.unitKey}.json`), JSON.stringify(rec));
  }
  for (const [key, exts] of Object.entries(sentinels)) {
    for (const [ext, body] of Object.entries(exts)) {
      fs.writeFileSync(path.join(dir, 'state', `${key}.${ext}`), body === true ? '' : body);
    }
  }
  return dir;
}

/** Run the provider against a fixture dir; returns the top-level nodes. */
function render(dir) {
  const prev = process.env.VZT_VSCODE_DIR;
  process.env.VZT_VSCODE_DIR = dir;
  try {
    const { ShipTreeProvider } = loadTree();
    const p = new ShipTreeProvider();
    const roots = p.getChildren();
    return { provider: p, roots };
  } finally {
    if (prev === undefined) delete process.env.VZT_VSCODE_DIR;
    else process.env.VZT_VSCODE_DIR = prev;
  }
}

test('units are grouped under their dependency wave, in order', () => {
  const dir = fixture([
    { id: 'u1', wave: 1 },
    { id: 'u2', wave: 2, dependsOn: ['u1'] },
    { id: 'u3', wave: 2, dependsOn: ['u1'] },
  ]);
  try {
    const { provider, roots } = render(dir);
    assert.equal(roots.length, 2, 'expected exactly two wave nodes');
    assert.deepEqual(roots.map((r) => r.label), ['Wave 1', 'Wave 2']);
    assert.match(roots[0].description, /1 unit/);
    assert.match(roots[1].description, /2 units/);
    // The children have to actually come back from getChildren(wave) — a wave
    // node that renders with the right label but no children shows an empty run.
    const w2 = provider.getChildren(roots[1]);
    assert.deepEqual(w2.map((c) => c.record.id).sort(), ['u2', 'u3']);
    assert.deepEqual(provider.getChildren(w2[0]), [], 'a unit must have no children');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a unit whose dependency has not passed renders as waiting, not queued', () => {
  const dir = fixture([
    { id: 'u1', wave: 1 },
    { id: 'u2', wave: 2, dependsOn: ['u1'] },
  ]);
  try {
    const { provider, roots } = render(dir);
    const u2 = provider.getChildren(roots[1])[0];
    // Both are undispatched. Without dependency awareness they look identical,
    // and the operator cannot tell which one is about to start.
    assert.equal(u2.state, 'waiting');
    assert.match(u2.description, /waiting/);
    assert.equal(u2.iconPath.id, 'circle-slash');
    const u1 = provider.getChildren(roots[0])[0];
    assert.equal(u1.state, 'queued', 'a unit with no unmet deps must stay queued');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('once the dependency PASSes the dependent stops waiting', () => {
  const dir = fixture(
    [
      { id: 'u1', wave: 1 },
      { id: 'u2', wave: 2, dependsOn: ['u1'] },
    ],
    { 'run-u1': { status: 'PASS' } }
  );
  try {
    const { provider, roots } = render(dir);
    assert.equal(provider.getChildren(roots[0])[0].state, 'PASS');
    assert.equal(provider.getChildren(roots[1])[0].state, 'queued');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCOPE_BREACH renders as its own red state, distinct from FAIL', () => {
  const dir = fixture(
    [{ id: 'u1', wave: 1 }, { id: 'u2', wave: 1 }],
    { 'run-u1': { status: 'SCOPE_BREACH' }, 'run-u2': { status: 'FAIL' } }
  );
  try {
    const { provider, roots } = render(dir);
    const kids = provider.getChildren(roots[0]);
    const breach = kids.find((k) => k.record.id === 'u1');
    const fail = kids.find((k) => k.record.id === 'u2');
    assert.equal(breach.state, 'SCOPE_BREACH');
    assert.match(breach.description, /SCOPE_BREACH/);
    assert.equal(breach.iconPath.id, 'warning');
    assert.equal(breach.iconPath.color.id, 'charts.red');
    // Same colour, different icon — a breach is not "the oracle failed".
    assert.equal(fail.iconPath.id, 'error');
    assert.notEqual(breach.iconPath.id, fail.iconPath.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a wave rolls up to its WORST unit — one green sibling cannot hide a breach', () => {
  const { rollUp } = loadTree();
  assert.equal(rollUp(['PASS', 'PASS', 'SCOPE_BREACH']), 'SCOPE_BREACH');
  assert.equal(rollUp(['PASS', 'FAIL']), 'FAIL');
  assert.equal(rollUp(['PASS', 'working']), 'working');
  assert.equal(rollUp(['PASS', 'PASS']), 'PASS');
  assert.equal(rollUp(['SCOPE_BREACH', 'FAIL']), 'SCOPE_BREACH', 'a breach outranks an ordinary failure');

  // And it must actually reach the rendered wave node.
  const dir = fixture(
    [{ id: 'u1', wave: 1 }, { id: 'u2', wave: 1 }],
    { 'run-u1': { status: 'PASS' }, 'run-u2': { status: 'SCOPE_BREACH' } }
  );
  try {
    const { roots } = render(dir);
    assert.match(roots[0].description, /SCOPE_BREACH/);
    assert.equal(roots[0].iconPath.id, 'warning');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Back-compat: a run dispatched by a pre-0.6.0 CLI has no `wave` on any record.
// Inventing a "Wave 0" heading for it would advertise a concept that run never
// had; it must render exactly as it did before.
test('records with no wave render as a flat list, as they did before', () => {
  const dir = fixture([{ id: 'u1' }, { id: 'u2' }]);
  try {
    const { roots } = render(dir);
    assert.equal(roots.length, 2);
    assert.deepEqual(roots.map((r) => r.record.id).sort(), ['u1', 'u2']);
    assert.ok(!roots.some((r) => String(r.label).startsWith('Wave ')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent runs do not resolve each other\'s dependencies', () => {
  // Unit ids repeat across runs (u1, u2 …) but sentinels are keyed by unitKey.
  // Matching a dependency by bare id would let run B's passing u1 satisfy run
  // A's blocked u2 — and a wave would look ready when it is not.
  const dir = fixture(
    [
      { slug: 'a', id: 'u1', wave: 1 },
      { slug: 'a', id: 'u2', wave: 2, dependsOn: ['u1'] },
      { slug: 'b', id: 'u1', wave: 1 },
    ],
    { 'b-u1': { status: 'PASS' } } // run B's u1 passed; run A's did NOT
  );
  try {
    const { provider, roots } = render(dir);
    const waveA2 = roots.find((r) => r.label === 'Wave 2' && r.slug === 'a');
    assert.ok(waveA2, 'run a wave 2 missing');
    assert.equal(provider.getChildren(waveA2)[0].state, 'waiting', "run b's PASS must not unblock run a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tooltip names the dependencies and what was seeded into the worktree', () => {
  const dir = fixture([
    { id: 'u1', wave: 1 },
    { id: 'u2', wave: 2, dependsOn: ['u1'], seeded: ['u0', 'u1'], baseSha: 'a'.repeat(40) },
  ]);
  try {
    const { provider, roots } = render(dir);
    const t = provider.getChildren(roots[1])[0].tooltip.value;
    assert.match(t, /depends on: `u1`/);
    // Seeded files are present, relevant, and OUTSIDE this unit's scope — the
    // one thing an operator reviewing a diff needs told.
    assert.match(t, /seeded with: `u0`, `u1`/);
    assert.match(t, /base: `aaaaaaaa`/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// "If I close my lid, do my agents keep running?"
//
// A ship unit is a VS Code INTEGRATED TERMINAL — a child of the extension host.
// Closing the window, reloading it, or crashing the host kills every in-flight
// agent. But the sentinels are FILES: `.started` stays on disk, `.idle` never
// arrives, and the tree showed a cheerful spinner on an agent that died
// yesterday. "Still working" and "killed when you closed the window" rendered
// identically, and only one of them is worth waiting for.
function withHost(dir, activatedAt) {
  fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ version: '0.6.0', pid: 1, activatedAt }));
  return dir;
}

test('a unit dispatched by a DEAD host renders interrupted, not a forever-spinner', () => {
  const dir = fixture(
    [{ id: 'u1', wave: 1, dispatchedAt: '2026-08-01T10:00:00.000Z' }],
    { 'run-u1': { started: true } } // started, never idled — the window was closed
  );
  try {
    withHost(dir, '2026-08-01T12:00:00.000Z'); // this host booted two hours LATER
    const { provider, roots } = render(dir);
    const u1 = provider.getChildren(roots[0])[0];
    assert.equal(u1.state, 'interrupted');
    assert.equal(u1.iconPath.id, 'debug-disconnect');
    assert.match(u1.tooltip.value, /closing or reloading the window kills them/);
    assert.match(u1.tooltip.value, /--mux herdr/, 'the tooltip must name the mux that DOES survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE CONTROL. Same sentinels, same shape — but dispatched by the host that is
// currently running. If this also reported interrupted, the check would just be
// "any working unit is dead" and would make the tree useless during a real run.
test('a unit dispatched by the LIVE host keeps working — no false interrupt', () => {
  const dir = fixture(
    [{ id: 'u1', wave: 1, dispatchedAt: '2026-08-01T12:30:00.000Z' }],
    { 'run-u1': { started: true } }
  );
  try {
    withHost(dir, '2026-08-01T12:00:00.000Z'); // host booted BEFORE the dispatch
    const { provider, roots } = render(dir);
    assert.equal(provider.getChildren(roots[0])[0].state, 'working');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished verdict survives a host restart — only liveness is interrupted', () => {
  const dir = fixture(
    [{ id: 'u1', wave: 1, dispatchedAt: '2026-08-01T10:00:00.000Z' },
     { id: 'u2', wave: 1, dispatchedAt: '2026-08-01T10:00:00.000Z' }],
    { 'run-u1': { status: 'PASS' }, 'run-u2': { status: 'SCOPE_BREACH' } }
  );
  try {
    withHost(dir, '2026-08-01T12:00:00.000Z');
    const { provider, roots } = render(dir);
    const byId = Object.fromEntries(provider.getChildren(roots[0]).map((k) => [k.record.id, k.state]));
    // A verdict is durable — it outlived the host that produced it. Overwriting
    // it with "interrupted" would erase the only result the run actually earned.
    assert.equal(byId.u1, 'PASS');
    assert.equal(byId.u2, 'SCOPE_BREACH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no host heartbeat at all, nothing is marked interrupted', () => {
  // A missing host.json means we do not KNOW when this host started. Guessing
  // would paint a healthy run entirely orange on first install.
  const dir = fixture(
    [{ id: 'u1', wave: 1, dispatchedAt: '2020-01-01T00:00:00.000Z' }],
    { 'run-u1': { started: true } }
  );
  try {
    const { provider, roots } = render(dir);
    assert.equal(provider.getChildren(roots[0])[0].state, 'working');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
