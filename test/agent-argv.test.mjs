import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ARGV, BOOTSTRAP_PROMPT, WAKE_LINE } from '../cli/agent-argv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CORE_REL = path.join('vzt-orca-flow', 'lib', 'vzt_orca_flow', 'core.py');

// ../vzt-orca-flow next to this checkout; from a git worktree, next to the
// primary checkout (the worktree's parent is a workspaces dir, not the sibling's).
function siblingCore() {
  const roots = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    roots.push(path.dirname(common));
  } catch { /* not a git checkout */ }
  for (const r of roots) {
    const p = path.join(r, '..', CORE_REL);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PY = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "AGENT_ARGV" for t in node.targets):
        print(json.dumps(ast.literal_eval(node.value)))
        break
else:
    sys.exit("AGENT_ARGV assignment not found")
`;

test('AGENT_ARGV equals vzt-orca-flow AGENT_ARGV', (t) => {
  const core = siblingCore();
  if (!core) {
    t.skip('sibling vzt-orca-flow checkout absent');
    return;
  }
  const r = spawnSync('python3', ['-I', '-c', PY, core], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(JSON.stringify(AGENT_ARGV)));
});

test('argv and constants match the pinned spec', () => {
  assert.deepEqual([...AGENT_ARGV.claude], ['claude', '--dangerously-skip-permissions']);
  assert.deepEqual([...AGENT_ARGV.codex], ['codex', '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
  assert.equal(WAKE_LINE, 'vzt: new bus message - run: vzt-agent bus check --json');
  assert.match(WAKE_LINE, /^[\x20-\x7e]+$/);
  const spec = fs.readFileSync(path.join(ROOT, '.vzt', 'ship', 'vscode-agent-bus', 'SPEC.md'), 'utf8');
  const pinned = spec.match(/^ {2}`(You are "<A>".*)`$/m);
  assert.ok(pinned, 'bootstrap prompt line present in SPEC.md');
  assert.equal(BOOTSTRAP_PROMPT('claude', 'codex'), pinned[1].replaceAll('<A>', 'claude').replaceAll('<P>', 'codex'));
});

test('bus argv verb prints the house argv', () => {
  const cli = path.join(ROOT, 'cli', 'bus', 'cli.mjs');
  const env = { ...process.env };
  delete env.ORCA_TERMINAL_HANDLE;
  for (const kind of ['claude', 'codex']) {
    const out = execFileSync('node', [cli, 'argv', '--kind', kind, '--json'], { encoding: 'utf8', env });
    assert.deepEqual(JSON.parse(out), [...AGENT_ARGV[kind]]);
  }
  const bad = spawnSync('node', [cli, 'argv', '--kind', 'gpt', '--json'], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  const prompt = execFileSync('node', [cli, 'bootstrap-prompt', '--alias', 'codex', '--peer', 'claude'], { encoding: 'utf8', env });
  assert.equal(prompt, BOOTSTRAP_PROMPT('codex', 'claude') + '\n');
});
