// Projects view (u3): Orca status glyphs, the project → worktree → agent model,
// and cross-window focus requests.
//
// status.js, model.js and focus.js are imported from the COMPILED extension
// (vscode/out) — run `npm --prefix vscode run compile` first. They are
// deliberately vscode-free so plain node can load them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(REPO_ROOT, 'vscode');

async function load(name) {
  const file = path.join(VSCODE, 'out', 'projects', `${name}.js`);
  if (!fs.existsSync(file)) {
    assert.fail(`vscode/out/projects/${name}.js missing — run \`npm --prefix vscode run compile\` before testing`);
  }
  return import(pathToFileURL(file).href);
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function agent(over = {}) {
  return {
    agent_id: 'a1',
    workspace: '/r/app',
    project: '/r/app',
    alias: 'claude',
    kind: 'claude',
    state: 'idle',
    state_ts_ms: NOW,
    liveness: 'live',
    wake_unconfirmed: false,
    unread: 0,
    window_id: 'w1',
    ...over,
  };
}

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-focus-'));
}

test('glyph working', async () => {
  const { glyphFor } = await load('status');
  assert.equal(glyphFor(agent({ state: 'working' }), NOW), 'working');
  assert.equal(glyphFor(agent({ state: 'launching' }), NOW), 'launching');
});

test('glyph needs-you when blocked', async () => {
  const { glyphFor } = await load('status');
  assert.equal(glyphFor(agent({ state: 'blocked' }), NOW), 'needs-you');
});

test('glyph done within 30 minutes', async () => {
  const { glyphFor, DONE_WINDOW_MS } = await load('status');
  assert.equal(DONE_WINDOW_MS, 30 * MIN);
  assert.equal(glyphFor(agent({ state_ts_ms: NOW - 29 * MIN }), NOW), 'done');
  assert.equal(glyphFor(agent({ state_ts_ms: NOW - DONE_WINDOW_MS + 1 }), NOW), 'done');
});

test('glyph idle after 30 minutes', async () => {
  const { glyphFor, DONE_WINDOW_MS } = await load('status');
  assert.equal(glyphFor(agent({ state_ts_ms: NOW - DONE_WINDOW_MS }), NOW), 'idle');
  assert.equal(glyphFor(agent({ state_ts_ms: NOW - 3 * 60 * MIN }), NOW), 'idle');
});

test('glyph stale when lease lapsed', async () => {
  const { glyphFor } = await load('status');
  // Liveness beats every state the row still claims.
  assert.equal(glyphFor(agent({ liveness: 'stale', state: 'blocked' }), NOW), 'stale');
  assert.equal(glyphFor(agent({ liveness: 'stale', state: 'working' }), NOW), 'stale');
  assert.equal(glyphFor(agent({ liveness: 'never-started', state: 'launching' }), NOW), 'stale');
});

test('rollup precedence', async () => {
  const { rollup, GLYPH_ICON } = await load('status');
  assert.equal(rollup([]), null);
  assert.equal(rollup(['stale', 'idle', 'done', 'launching', 'working', 'needs-you']), 'needs-you');
  assert.equal(rollup(['stale', 'idle', 'done', 'launching', 'working']), 'working');
  assert.equal(rollup(['stale', 'idle', 'done', 'launching']), 'launching');
  assert.equal(rollup(['stale', 'idle', 'done']), 'done');
  assert.equal(rollup(['stale', 'idle']), 'idle');
  assert.equal(rollup(['stale']), 'stale');
  assert.deepEqual(GLYPH_ICON['needs-you'], { codicon: 'question', color: 'charts.yellow' });
  assert.deepEqual(GLYPH_ICON.working, { codicon: 'sync~spin' });
});

test('agents land in their worktree', async () => {
  const { buildProjectTree } = await load('model');
  const projects = [
    {
      name: 'zeta', root: '/r/zeta', baseRef: 'origin/main', exists: true,
      worktrees: [{ path: '/r/zeta', branch: 'main', head: 'z0', main: true }],
    },
    {
      name: 'app', root: '/r/app', baseRef: 'origin/main', exists: true,
      worktrees: [
        { path: '/r/app-worktrees/feat-b', branch: 'feat-b', head: 'b1', main: false },
        { path: '/r/app', branch: 'main', head: 'm1', main: true },
        { path: '/r/app-worktrees/feat-a', branch: 'feat-a', head: 'a1', main: false },
      ],
    },
  ];
  const agents = [
    agent({ agent_id: 'x', alias: 'codex', kind: 'codex', workspace: '/r/app-worktrees/feat-a', state: 'blocked' }),
    agent({ agent_id: 'y', alias: 'claude', workspace: '/r/app-worktrees/feat-a', state: 'working' }),
    agent({ agent_id: 'z', alias: 'main-bot', workspace: '/r/app' }),
  ];
  const tree = buildProjectTree(projects, agents, NOW);

  assert.deepEqual(tree.map((n) => n.name), ['app', 'zeta']);
  const app = tree[0];
  assert.deepEqual(app.worktrees.map((w) => w.branch), ['main', 'feat-a', 'feat-b']);
  const [main, featA, featB] = app.worktrees;
  assert.deepEqual(main.agents.map((n) => n.agent.agent_id), ['z']);
  assert.deepEqual(featA.agents.map((n) => n.agent.alias), ['claude', 'codex']);
  assert.deepEqual(featA.agents.map((n) => n.glyph), ['working', 'needs-you']);
  assert.equal(featB.agents.length, 0);
  assert.equal(featA.rollup, 'needs-you');
  assert.equal(main.rollup, 'done');
  assert.equal(featB.rollup, null);
  assert.equal(app.rollup, 'needs-you');
  assert.equal(tree[1].rollup, null);
  assert.ok(!tree.some((n) => n.kind === 'unregistered'));
});

test('unregistered project group', async () => {
  const { buildProjectTree } = await load('model');
  const projects = [{
    name: 'app', root: '/r/app', baseRef: 'origin/main', exists: true,
    worktrees: [{ path: '/r/app', branch: 'main', head: 'm1', main: true }],
  }];
  const agents = [
    agent({ agent_id: 'p1', alias: 'b', project: '/o/two', workspace: '/o/two' }),
    agent({ agent_id: 'p2', alias: 'a', project: '/o/one', workspace: '/o/one-wt', state: 'working' }),
    agent({ agent_id: 'p3', alias: 'c', project: '/o/two', workspace: '/o/two', liveness: 'stale' }),
  ];
  const tree = buildProjectTree(projects, agents, NOW);

  assert.equal(tree.length, 2);
  const group = tree[tree.length - 1];
  assert.equal(group.kind, 'unregistered');
  assert.equal(group.label, 'Unregistered projects');
  assert.deepEqual(group.projects.map((p) => p.root), ['/o/one', '/o/two']);
  assert.ok(group.projects.every((p) => p.registered === false));
  const two = group.projects[1];
  assert.deepEqual(two.worktrees[0].agents.map((n) => n.agent.agent_id), ['p1', 'p3']);
  assert.equal(two.rollup, 'done');
  assert.equal(group.rollup, 'working');
  assert.equal(tree[0].worktrees[0].agents.length, 0);
});

test('focus claimed only by owner window', async () => {
  const { requestFocus, claimFocus } = await load('focus');
  const base = tmpBase();
  requestFocus(base, 'agent-1', 'owner', NOW);

  const dir = path.join(base, 'focus');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'agent-1.json'), 'utf8')),
    { agent_id: 'agent-1', window_id: 'owner', requested_ms: NOW });

  assert.deepEqual(claimFocus(base, 'other', NOW + 1000), []);
  assert.ok(fs.existsSync(path.join(dir, 'agent-1.json')), 'a non-owner leaves a fresh record alone');
  assert.deepEqual(claimFocus(base, 'owner', NOW + 1000), ['agent-1']);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(claimFocus(base, 'owner', NOW + 2000), []);
});

test('focus claim race has one winner', async () => {
  const { requestFocus, claimFocus } = await load('focus');
  const base = tmpBase();
  requestFocus(base, 'agent-1', 'owner', NOW);
  requestFocus(base, 'agent-2', 'owner', NOW);

  // Simulate a concurrent claimer winning agent-1 between our readdir and rename.
  const dir = path.join(base, 'focus');
  const realRename = fs.renameSync;
  let stolen = false;
  fs.renameSync = (from, to) => {
    if (!stolen && path.basename(from) === 'agent-1.json') {
      stolen = true;
      realRename(from, path.join(dir, 'agent-1.json.claimed-rival'));
      fs.unlinkSync(path.join(dir, 'agent-1.json.claimed-rival'));
    }
    return realRename(from, to);
  };
  let mine;
  try {
    mine = claimFocus(base, 'owner', NOW + 500);
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(stolen, 'the race was exercised');
  assert.deepEqual(mine, ['agent-2'], 'the loser skips the record it lost');

  // Two claimers back to back: exactly one of them gets the record.
  requestFocus(base, 'agent-3', 'owner', NOW);
  const a = claimFocus(base, 'owner', NOW + 600);
  const b = claimFocus(base, 'owner', NOW + 600);
  assert.deepEqual([...a, ...b], ['agent-3']);
});

test('stale focus request expires', async () => {
  const { requestFocus, claimFocus, FOCUS_TTL_MS } = await load('focus');
  const base = tmpBase();
  const dir = path.join(base, 'focus');
  requestFocus(base, 'gone', 'closed-window', NOW);
  requestFocus(base, 'old-mine', 'me', NOW);
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');

  assert.equal(FOCUS_TTL_MS, 60_000);
  // Any window unlinks expired and malformed records — even ones it does not own,
  // and even its own expired ones (a 61-second-old focus is no longer wanted).
  assert.deepEqual(claimFocus(base, 'bystander', NOW + 61_000), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('pure modules do not import vscode', () => {
  for (const name of ['status', 'model', 'focus']) {
    const src = fs.readFileSync(path.join(VSCODE, 'src', 'projects', `${name}.ts`), 'utf8');
    const runtime = src
      .split('\n')
      .filter((line) => /\bfrom\s+["']vscode["']|require\(\s*["']vscode["']\s*\)|^\s*import\s+["']vscode["']/.test(line))
      .filter((line) => !/^\s*import\s+type\b/.test(line));
    assert.deepEqual(runtime, [], `${name}.ts must not import vscode at runtime`);
  }
});

test('format age', async () => {
  const { formatAge } = await load('model');
  assert.equal(formatAge(0), 'now');
  assert.equal(formatAge(59_999), 'now');
  assert.equal(formatAge(MIN), '1m');
  assert.equal(formatAge(59 * MIN), '59m');
  assert.equal(formatAge(60 * MIN), '1h');
  assert.equal(formatAge(23 * 60 * MIN), '23h');
  assert.equal(formatAge(24 * 60 * MIN), '1d');
  assert.equal(formatAge(3 * 24 * 60 * MIN), '3d');
});

test('worktree row shows primary and busiest agent', async () => {
  const { worktreeRow } = await load('model');
  const wt = { path: '/r/app', branch: 'main', main: true };
  const agents = [
    agent({ agent_id: 'a', alias: 'idler', state: 'idle', state_ts_ms: NOW - 2 * 60 * MIN }),
    agent({ agent_id: 'b', alias: 'old', state: 'working', state_ts_ms: NOW - 10 * MIN }),
    agent({ agent_id: 'c', alias: 'busy', state: 'working', state_ts_ms: NOW - 5 * MIN }),
  ];
  assert.deepEqual(worktreeRow(wt, agents, NOW), {
    label: 'main', primary: true, glyph: 'working', activity: 'busy working · 5m', lead: agents[2],
  });
});

test('worktree row without agents', async () => {
  const { worktreeRow } = await load('model');
  assert.deepEqual(worktreeRow({ path: '/r/app-wt/feat', branch: null, main: false }, [], NOW), {
    label: 'feat', primary: false, glyph: null, activity: null, lead: null,
  });
});

test('worktree row whose agents are all stale has no lead to focus', async () => {
  const { worktreeRow } = await load('model');
  const row = worktreeRow({ path: '/r/app', branch: 'main', main: true }, [agent({ agent_id: 'd', alias: 'dead', liveness: 'stale' })], NOW);
  assert.equal(row.glyph, 'stale');
  assert.equal(row.lead, null);
});

// --- 0.10.0: one window, one terminal set per project -------------------------
// projectsTree.js needs the `vscode` module, so it is loaded with a minimal fake
// one: the test drives the real tree items and commands.

async function loadProjectsTree() {
  const { createRequire } = await import('node:module');
  const Module = (await import('node:module')).default;
  const require = createRequire(import.meta.url);
  const file = path.join(VSCODE, 'out', 'projects', 'projectsTree.js');
  if (!fs.existsSync(file)) assert.fail('vscode/out/projects/projectsTree.js missing — run `npm --prefix vscode run compile` before testing');

  const commands = new Map();
  const executed = [];
  const views = [];
  class EventEmitter { constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() {} }; }; } fire(e) { for (const l of this.listeners) l(e); } }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  const fake = {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    Uri: { file: (p) => ({ fsPath: p }) },
    window: {
      createTreeView: (id, opts) => { const v = { id, provider: opts.treeDataProvider, visible: false, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} }; views.push(v); return v; },
      showErrorMessage: () => {},
      showInformationMessage: () => {},
      showQuickPick: async () => undefined,
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (...args) => { executed.push(args); },
    },
    workspace: { workspaceFolders: [] },
  };
  const real = Module._resolveFilename;
  const FAKE = path.join(VSCODE, 'out', '__fake_vscode__.js');
  Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? FAKE : real.call(this, request, ...rest); };
  require.cache[FAKE] = { id: FAKE, filename: FAKE, loaded: true, exports: fake };
  try {
    delete require.cache[file];
    return { mod: require(file), commands, executed, views };
  } finally {
    Module._resolveFilename = real;
  }
}

async function projectsHarness({ active = '/r/app', agents = [], focusLocal = () => false } = {}) {
  const t = await loadProjectsTree();
  const shown = [];
  const focused = [];
  const context = { subscriptions: [] };
  const base = tmpBase();
  const api = t.mod.registerProjects(context, {
    run: async (args) => {
      if (args[0] === 'projects') {
        return [
          { name: 'app', root: '/r/app', baseRef: 'origin/main', exists: true, worktrees: [
            { path: '/r/app', branch: 'main', head: 'm', main: true },
            { path: '/r/app-wt/feat', branch: 'feat', head: 'f', main: false },
          ] },
          { name: 'zeta', root: '/r/zeta', baseRef: 'origin/main', exists: true, worktrees: [{ path: '/r/zeta', branch: 'main', head: 'z', main: true }] },
        ];
      }
      return agents;
    },
    windowId: 'w1',
    baseDir: base,
    focusLocal: (id) => { focused.push(id); return focusLocal(id); },
    showProject: (root) => shown.push(root),
    activeProject: () => active,
  });
  const provider = t.views[0].provider;
  await provider.reload();
  const dispose = () => { for (const s of context.subscriptions) s.dispose(); fs.rmSync(base, { recursive: true, force: true }); };
  return { ...t, api, provider, shown, focused, base, dispose };
}

test('a project row click shows that project; the active one says so', async () => {
  const h = await projectsHarness({ agents: [agent({ agent_id: 'a1', workspace: '/r/app', project: '/r/app' })] });
  try {
    const [app, zeta] = h.provider.getChildren();
    const appItem = h.provider.getTreeItem(app);
    assert.equal(appItem.description, 'active · 1 agents');
    assert.deepEqual(appItem.command, { command: 'vzt-mux.projects.show', title: 'Show Project', arguments: [app] });
    assert.equal(h.provider.getTreeItem(zeta).description, undefined, 'only the active project is tagged');

    await h.commands.get('vzt-mux.projects.show')(zeta);
    assert.deepEqual(h.shown, ['/r/zeta']);
    assert.deepEqual(h.executed, [], 'no window is opened and no folder changed');
    assert.ok(h.commands.has('vzt-mux.projects.openWindow'), 'Open Project Window stays (context menu)');
  } finally {
    h.dispose();
  }
});

test("a worktree row click focuses its agent, else shows its project; this window's lost agent never opens a window", async () => {
  const lead = agent({ agent_id: 'a1', workspace: '/r/app-wt/feat', project: '/r/app', state: 'working' });
  const h = await projectsHarness({ active: '/r/zeta', agents: [lead] });
  try {
    const [app] = h.provider.getChildren();
    const [main, feat] = h.provider.getChildren(app);
    assert.equal(h.provider.getTreeItem(main).command.command, 'vzt-mux.projects.openWorktree', 'a row without agents is clickable too');

    await h.commands.get('vzt-mux.projects.openWorktree')(main);
    assert.deepEqual(h.shown, ['/r/app'], 'no agent: its project is shown');

    await h.commands.get('vzt-mux.projects.openWorktree')(feat);
    assert.deepEqual(h.focused, ['a1'], 'the lead agent is focused (the registry swaps projects first)');
    // focusLocal said no (stale / forgotten): show its project, never request a window.
    assert.deepEqual(h.shown, ['/r/app', '/r/app']);
    assert.deepEqual(h.executed, []);
    assert.ok(!fs.existsSync(path.join(h.base, 'focus')), 'no cross-window focus request for our own agent');
  } finally {
    h.dispose();
  }
});
