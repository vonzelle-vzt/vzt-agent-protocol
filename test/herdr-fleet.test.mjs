// Coverage for the Herdr Fleet model (vscode/src/herdr/model.ts).
//
// The commit that shipped the fleet view claimed two defects were "pinned by
// tests carrying the old behaviour as the control". They were not — no test in
// this repo referenced FleetModel, pane_created or pane_updated, so both fixes
// shipped unguarded. This file is that missing guard.
//
// These run the REAL compiled model out of vscode/out/herdr/model.js against a
// stub `vscode` module, rather than grepping the source. A grep would match the
// long comment in model.ts that EXPLAINS each defect and pass on broken code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HERDR_SRC = path.join(REPO_ROOT, 'vscode', 'src', 'herdr');
const MODEL_JS = path.join(REPO_ROOT, 'vscode', 'out', 'herdr', 'model.js');

/**
 * Minimal stand-in for the `vscode` module. FleetModel touches exactly two
 * things on it: EventEmitter (for onDidChange) and nothing else. Keep it that
 * way — if this stub has to grow, the model has picked up a host dependency it
 * should not have.
 */
function makeVscodeStub() {
  return {
    EventEmitter: class {
      constructor() {
        this.listeners = [];
        this.event = (fn) => {
          this.listeners.push(fn);
          return { dispose: () => {} };
        };
      }
      fire(v) {
        for (const fn of this.listeners) fn(v);
      }
      dispose() {
        this.listeners = [];
      }
    },
  };
}

/** Load the compiled FleetModel with `require('vscode')` intercepted. */
function loadModel() {
  if (!fs.existsSync(MODEL_JS)) {
    assert.fail('vscode/out/herdr/model.js missing — run `npm run compile` in vscode/ before testing');
  }
  const req = createRequire(import.meta.url);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return makeVscodeStub();
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete req.cache[req.resolve(MODEL_JS)];
    return req(MODEL_JS);
  } finally {
    Module._load = originalLoad;
  }
}

const pane = (over = {}) => ({
  pane_id: 'w65:p1',
  tab_id: 'w65:t1',
  workspace_id: 'w65',
  agent: 'claude',
  agent_status: 'working',
  cwd: '/Users/x',
  ...over,
});

const snapshot = (panes) => ({
  workspaces: [{ workspace_id: 'w65', number: 1, label: 'fleet' }],
  tabs: [{ tab_id: 'w65:t1', workspace_id: 'w65', number: 1, label: 'main' }],
  panes,
  agents: panes.filter((p) => p.agent),
});

test('pane_created must NOT downgrade an agent already seen', () => {
  // The defect, observed live on w65:p1: herdr emits pane_created for a pane
  // that ALREADY EXISTS, carrying `agent: null, agent_status: "unknown"` —
  // detection runs afterwards and arrives via pane_agent_detected/pane_updated.
  // The first implementation replaced wholesale, which dropped a live agent out
  // of the tree until its next status change.
  //
  // CONTROL: with the old `this.panes.set(pane.pane_id, pane)` the assertions
  // below read agents.length === 0 and status 'unknown'. Verified by mutation,
  // not assumed.
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane()]));
  assert.equal(m.getAgents().length, 1, 'precondition: the agent is in the model');

  m.apply({
    event: 'pane_created',
    data: { pane: pane({ agent: null, agent_status: 'unknown' }) },
  });

  const agents = m.getAgents();
  assert.equal(agents.length, 1, 'pane_created for an existing pane must not drop its agent');
  assert.equal(agents[0].agent, 'claude', 'the known agent identity must survive');
  assert.equal(agents[0].agent_status, 'working', 'the known status must survive');
  m.dispose();
});

test('pane_created still applies everything the payload DOES know', () => {
  // The rule is "never downgrade", not "ignore". A pane_created that moved the
  // pane to another tab must still be applied, or the tree parents it wrongly.
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane()]));

  m.apply({
    event: 'pane_created',
    data: { pane: pane({ agent: null, agent_status: 'unknown', tab_id: 'w65:t2' }) },
  });

  assert.equal(m.getAgents()[0].tab_id, 'w65:t2', 'non-agent fields from pane_created must be applied');
  m.dispose();
});

test('pane_created DOES carry a NEW agent onto a pane that had none', () => {
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane({ agent: null, agent_status: 'unknown' })]));
  assert.equal(m.getAgents().length, 0, 'precondition: no agent yet');

  m.apply({ event: 'pane_created', data: { pane: pane() } });

  assert.equal(m.getAgents().length, 1, 'a pane_created that knows an agent must add it');
  m.dispose();
});

test('pane_updated MAY downgrade — a finished agent must not linger', () => {
  // The counterpart to the test above, and the reason the two events are handled
  // differently. Making pane_updated non-downgrading too "fixes" the first
  // defect and leaves dead agents in the tree forever.
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane()]));

  m.apply({
    event: 'pane_updated',
    data: { pane: pane({ agent: null, agent_status: 'unknown' }) },
  });

  assert.equal(m.getAgents().length, 0, 'pane_updated is authoritative — a released agent must leave the tree');
  m.dispose();
});

test('the model follows the STREAM, and nothing re-seeds it on a timer', () => {
  // herdr 0.7.5 diverges persistently: the stream pushed `working` twice while
  // session.snapshot reported `idle` for 12s with no corrective event. A live
  // view must follow the stream. The tempting "fix" is a setInterval snapshot,
  // which is the polling the whole design exists to avoid — so pin its absence.
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane({ agent_status: 'idle' })]));

  m.apply({ event: 'pane_updated', data: { pane: pane({ agent_status: 'working' }) } });
  assert.equal(m.counts().working, 1, 'a stream update must win over the seeded status');

  // ...and an explicit re-seed is still allowed to correct it. That is the
  // sanctioned correction (Refresh / view re-visibility), not a poll.
  m.seed(snapshot([pane({ agent_status: 'idle' })]));
  assert.equal(m.counts().working, 0, 'an explicit re-seed must still be able to correct the model');
  m.dispose();

  for (const file of fs.readdirSync(HERDR_SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.gen.ts'))) {
    const src = fs.readFileSync(path.join(HERDR_SRC, file), 'utf8');
    assert.ok(
      !/setInterval\s*\(/.test(src),
      `${file} must not use setInterval — the fleet is event-driven and must never poll session.snapshot`
    );
  }
});

test('blocked outranks everything in the roll-up — it is the whole product', () => {
  // "N working · N blocked" exists to answer "who needs me right now". A parent
  // row that reports `working` while a child is blocked hides the only state
  // that requires a human.
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  const agents = [
    pane({ pane_id: 'a', agent_status: 'working' }),
    pane({ pane_id: 'b', agent_status: 'blocked' }),
    pane({ pane_id: 'c', agent_status: 'idle' }),
  ];
  m.seed(snapshot(agents));

  assert.equal(m.rollUp(m.getAgents()), 'blocked', 'blocked must win the roll-up');
  assert.equal(m.counts().blocked, 1);
  assert.equal(m.counts().total, 3);
  m.dispose();
});

test('losing the daemon empties the model rather than leaving a stale fleet on screen', () => {
  const { FleetModel } = loadModel();
  const m = new FleetModel();
  m.seed(snapshot([pane()]));
  m.clear();
  assert.equal(m.getAgents().length, 0);
  assert.equal(m.getWorkspaces().length, 0, 'containers must go too, not just their agents');
  m.dispose();
});
