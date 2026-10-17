import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// u7 wiring: the vzt-agent dispatch, the extension's registration order and the
// vscode/package.json contributions. Contract: .vzt/ship/vscode-orca-workspaces/SPEC.md.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'vzt-agent.js');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8'));
const EXTENSION = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');

const BASE_ENV = { ...process.env };
for (const k of ['ORCA_TERMINAL_HANDLE', 'VZT_PROJECTS_FILE', 'VZT_BUS_DIR']) delete BASE_ENV[k];

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function vztAgent(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...BASE_ENV,
      VZT_PROJECTS_FILE: path.join(tmp('vzt-wire-reg-'), 'projects.json'),
      VZT_BUS_DIR: tmp('vzt-wire-bus-'),
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const WORKSPACE_COMMANDS = [
  'vzt-mux.projects.refresh',
  'vzt-mux.projects.add',
  'vzt-mux.projects.remove',
  'vzt-mux.projects.openWindow',
  'vzt-mux.projects.focusAgent',
  'vzt-mux.agents.newWorkspace',
  'vzt-mux.agents.addHere',
  'vzt-mux.dashboard.open',
];

test('package contributes projects view first', () => {
  const views = PKG.contributes.views.vztShip;
  assert.equal(views[0].id, 'vztProjects');
  assert.equal(views[0].name, 'Projects');
  // Existing views are kept, after it.
  assert.deepEqual(views.slice(1).map((v) => v.id), ['vztShipRun', 'vztBus']);
});

test('package contributes workspace commands', () => {
  const byId = new Map(PKG.contributes.commands.map((c) => [c.command, c]));
  for (const id of WORKSPACE_COMMANDS) {
    assert.ok(byId.has(id), `missing command ${id}`);
    assert.match(byId.get(id).title, /^VZT: /, `${id} title`);
  }
  // Every pre-existing contribution survives.
  for (const id of ['vzt-mux.watchShipRun', 'vzt-mux.doctor', 'vzt-mux.bus.pair', 'vzt-mux.herdr.refresh']) {
    assert.ok(byId.has(id), `lost command ${id}`);
  }
  const titleMenu = PKG.contributes.menus['view/title'].filter((m) => m.when === 'view == vztProjects' && m.group.startsWith('navigation'));
  assert.deepEqual(
    titleMenu.map((m) => m.command).sort(),
    ['vzt-mux.agents.newWorkspace', 'vzt-mux.dashboard.open', 'vzt-mux.projects.add', 'vzt-mux.projects.importOrca', 'vzt-mux.projects.refresh']
  );
});

test('package version', () => {
  assert.equal(PKG.version, '0.10.0'); // 0.10.0: tmux-backed project swap, project + picker
});

test('project and worktree rows carry their own + buttons; a worktree row is clickable', () => {
  const inline = PKG.contributes.menus['view/item/context'].filter((m) => m.group?.startsWith('inline') && /view == vztProjects/.test(m.when));
  const on = (item) => inline.filter((m) => m.when.includes(`viewItem == ${item}`)).map((m) => m.command).sort();
  assert.deepEqual(on('vztProject'), ['vzt-mux.agents.startInProject']); // Open Project Window moved to the context menu
  assert.deepEqual(on('vztWorktree'), ['vzt-mux.agents.addHere']);
  const tree = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'projects', 'projectsTree.ts'), 'utf8');
  assert.match(tree, /command: "vzt-mux\.projects\.openWorktree", title: "Open Worktree", arguments: \[node\]/);
  const hidden = PKG.contributes.menus.commandPalette.find((m) => m.command === 'vzt-mux.projects.openWorktree');
  assert.equal(hidden?.when, 'false', 'a row-only command stays out of the palette');
});

test('workspace picker: create anywhere, choose projects only in a saved workspace', () => {
  const title = PKG.contributes.menus['view/title'];
  assert.ok(title.some((m) => m.command === 'vzt-mux.workspace.create' && m.when === 'view == vztProjects'));
  const edit = title.find((m) => m.command === 'vzt-mux.workspace.editProjects');
  assert.match(edit.when, /workbenchState == workspace/, 'never offered in a single-folder window');
  const ext = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(ext, /registerWorkspaceCommands\(context, \{ run: bus\.runTop, baseDir: path\.join\(os\.homedir\(\), \"\.vzt\"\) \}\)/);
  const cmds = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'projects', 'workspaceCommands.ts'), 'utf8');
  assert.equal((cmds.match(/updateWorkspaceFolders\(/g) || []).length, 1, 'exactly one folder update per edit');
});

test('Explorer root folders offer New Agent Workspace on right-click', () => {
  const item = (PKG.contributes.menus['explorer/context'] || []).find((m) => m.command === 'vzt-mux.agents.newWorkspace');
  assert.equal(item?.when, 'explorerResourceIsRoot');
});

test('Restricted Mode: the sidebar stays, nothing starts until trust is granted', () => {
  assert.equal(PKG.capabilities?.untrustedWorkspaces?.supported, 'limited');
  const welcome = PKG.contributes.viewsWelcome;
  for (const view of ['vztProjects', 'vztShipRun', 'vztBus', 'herdrFleet.agents']) {
    const restricted = welcome.find((w) => w.view === view && w.when === '!isWorkspaceTrusted');
    assert.match(restricted?.contents || '', /\(command:workbench\.trust\.manage\)/, `${view} offers trust`);
    assert.ok(welcome.filter((w) => w.view === view && w.when !== '!isWorkspaceTrusted').every((w) => w.when === 'isWorkspaceTrusted'),
      `${view}: the trusted welcome never shows in Restricted Mode`);
  }
  const ext = fs.readFileSync(path.join(ROOT, 'vscode', 'src', 'extension.ts'), 'utf8');
  const activate = ext.slice(ext.indexOf('export function activate('), ext.indexOf('function activateTrusted('));
  assert.match(activate, /if \(vscode\.workspace\.isTrusted\) \{\n\s+activateTrusted\(context\);\n\s+return;/);
  assert.match(activate, /onDidGrantWorkspaceTrust\(\(\) => activateTrusted\(context\)\)/);
  assert.doesNotMatch(activate, /createTerminal|ensureDirs|registerAgentBus/, 'nothing else runs before trust');
});

test('agent restore setting defaults true', () => {
  const prop = PKG.contributes.configuration.properties['vztMux.agents.restore'];
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, true);
});

test('attention setting defaults true', () => {
  const prop = PKG.contributes.configuration.properties['vztMux.attention.notify'];
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, true);
  assert.ok(PKG.contributes.configuration.properties['vztMux.baseDir'], 'existing setting kept');
});

test('vzt-agent projects list dispatches', () => {
  const r = vztAgent(['projects', 'list', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), []);

  const text = vztAgent(['projects', 'list']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /no projects registered/);
});

test('vzt-agent worktree usage exits 2', () => {
  const r = vztAgent(['worktree', 'create']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--project is required/);
  assert.match(r.err, /vzt-agent worktree create/);

  // Help lists both groups.
  const help = vztAgent(['help']);
  assert.match(help.out, /vzt-agent projects /);
  assert.match(help.out, /vzt-agent worktree /);
});

test('extension wires all four features', () => {
  const at = (needle) => {
    const i = EXTENSION.indexOf(needle);
    assert.ok(i >= 0, `extension.ts lacks ${needle}`);
    return i;
  };
  const bus = at('const bus = registerAgentBus(');
  const projects = at('registerProjects(context, {');
  const attention = at('registerAttention(context, {');
  const dashboard = at('registerCommand("vzt-mux.dashboard.open"');
  assert.ok(bus < projects && projects < attention && attention < dashboard, 'order: bus → projects → attention → dashboard');

  const projectsCall = EXTENSION.slice(projects, attention);
  assert.match(projectsCall, /run: bus\.runTop/);
  assert.match(projectsCall, /windowId: vscode\.env\.sessionId/);
  assert.match(projectsCall, /baseDir: baseDir\(\)/, 'baseDir is the ship-queue resolution');
  assert.match(EXTENSION, /bus\.registry\.focus\(id\)/);

  const attentionCall = EXTENSION.slice(attention, dashboard);
  assert.match(attentionCall, /executeCommand\("vzt-mux\.dashboard\.open"\)/);
  assert.match(attentionCall, /projects\.setBadge\(n\)/);
  assert.match(EXTENSION.slice(dashboard), /openDashboard\(context, \{ run: bus\.runTop, focusAgent: [^}]*projects\.focusAgent/);

  // Every contributed workspace command is registered by some module.
  const src = execFileSync('grep', ['-rhoE', 'registerCommand\\("[^"]+"', path.join(ROOT, 'vscode', 'src')], { encoding: 'utf8' });
  for (const id of WORKSPACE_COMMANDS) assert.ok(src.includes(`"${id}"`), `${id} is never registered`);
});
