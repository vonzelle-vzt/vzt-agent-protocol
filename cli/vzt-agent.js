#!/usr/bin/env node
/**
 * vzt-agent — installer/CLI for the VZT Agent Protocol.
 *
 * Installs automatic model routing (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5)
 * into a Claude Code project (.claude/) or globally (~/.claude/).
 *
 * Commands:
 *   vzt-agent install [--global] [--target <dir>]   copy agents/skills/hooks + wire settings
 *   vzt-agent uninstall [--global] [--target <dir>] remove installed files + unwire hooks
 *   vzt-agent doctor [--global] [--target <dir>]    verify installation health
 *   vzt-agent matrix                                 print the routing matrix
 *   vzt-agent stats                                  routing-decision distribution vs targets
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateSpec, reduceLedger, nextAction, unitLine } from './ship-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const AGENT_FILES_DIR = path.join(PKG_ROOT, 'agents');
const SKILLS_DIR = path.join(PKG_ROOT, 'skills');
const HOOKS_DIR = path.join(PKG_ROOT, 'hooks');
// The doctrine tells every session to delegate using templates/worker-brief.md.
// If we don't install it, that instruction points at nothing — the brief gets
// improvised, and MACHINE_CHECK drifts to being chosen AFTER the diff exists.
const TEMPLATES_DIR = path.join(PKG_ROOT, 'templates');
// Same lesson, second time: /vzt-ship tells the session to launch
// workflows/vzt-ship.js. If install() doesn't copy it, Workflow gets a
// scriptPath that does not exist — and it fails AFTER the spec has been paid
// for. The script and its install wiring ship together or not at all.
const WORKFLOWS_DIR = path.join(PKG_ROOT, 'workflows');
const ORCA_SRC_DIR = path.join(PKG_ROOT, 'orca');

const HOOKS = [
  { event: 'UserPromptSubmit', basename: 'vzt-route-classifier.mjs', timeout: 10 },
  { event: 'SessionStart', basename: 'vzt-session-start.mjs', timeout: 10 },
];
const MANAGED_MARKER = 'vzt-agent-protocol';
// The hooks honour VZT_ROUTER_STATE_DIR; the CLI used to hardcode ~/.claude,
// so `vzt-agent stats` read a different file than the hooks wrote.
const STATE_DIR = process.env.VZT_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'vzt-router');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global' || a === '-g') args.global = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--execute') args.execute = true;
    else if (a === '--orca') args.orca = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = argv[++i];
    else args._.push(a);
  }
  return args;
}

function claudeDir(args) {
  if (args.target) return path.resolve(args.target, '.claude');
  if (args.global) return path.join(os.homedir(), '.claude');
  return path.resolve(process.cwd(), '.claude');
}

function copyDirContents(srcDir, destDir, { ext } = {}) {
  if (!fs.existsSync(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDirContents(src, dest));
    } else {
      if (ext && !entry.name.endsWith(ext)) continue;
      fs.copyFileSync(src, dest);
      copied.push(dest);
    }
  }
  return copied;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Non-destructive merge of our hooks into settings.json. */
function wireSettings(dotClaude, { portable = false } = {}) {
  const settingsPath = path.join(dotClaude, 'settings.json');
  const settings = readJson(settingsPath, {});
  settings.hooks = settings.hooks || {};
  for (const h of HOOKS) {
    const bucket = (settings.hooks[h.event] = settings.hooks[h.event] || []);
    // Project installs use $CLAUDE_PROJECT_DIR so the committed settings.json
    // works on any clone; global installs use the absolute ~/.claude path.
    const cmd = portable
      ? `node "$CLAUDE_PROJECT_DIR/.claude/hooks/vzt-router/${h.basename}"`
      : `node "${path.join(dotClaude, 'hooks', 'vzt-router', h.basename)}"`;
    const already = bucket.some((m) =>
      (m.hooks || []).some((x) => typeof x.command === 'string' && x.command.includes(h.basename))
    );
    if (!already) {
      bucket.push({ hooks: [{ type: 'command', command: cmd, timeout: h.timeout, _managedBy: MANAGED_MARKER }] });
    }
  }
  fs.mkdirSync(dotClaude, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settingsPath;
}

function unwireSettings(dotClaude) {
  const settingsPath = path.join(dotClaude, 'settings.json');
  const settings = readJson(settingsPath, null);
  if (!settings || !settings.hooks) return false;
  let changed = false;
  for (const h of HOOKS) {
    const bucket = settings.hooks[h.event];
    if (!bucket) continue;
    const next = bucket
      .map((m) => ({
        ...m,
        hooks: (m.hooks || []).filter(
          (x) => !(typeof x.command === 'string' && x.command.includes(h.basename))
        ),
      }))
      .filter((m) => (m.hooks || []).length > 0);
    if (next.length !== bucket.length || JSON.stringify(next) !== JSON.stringify(bucket)) changed = true;
    if (next.length === 0) delete settings.hooks[h.event];
    else settings.hooks[h.event] = next;
  }
  if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

/** Copy orca/ helper scripts to the fixed ~/.orca/vzt/ home, making .sh executable. */
function installOrcaHelpers() {
  if (!fs.existsSync(ORCA_SRC_DIR)) return [];
  fs.mkdirSync(ORCA_VZT_DIR, { recursive: true });
  const out = [];
  for (const name of fs.readdirSync(ORCA_SRC_DIR)) {
    const src = path.join(ORCA_SRC_DIR, name);
    if (!fs.statSync(src).isFile()) continue;
    const dest = path.join(ORCA_VZT_DIR, name);
    fs.copyFileSync(src, dest);
    if (name.endsWith('.sh')) fs.chmodSync(dest, 0o755);
    out.push(name);
  }
  return out;
}

function install(args) {
  const dotClaude = claudeDir(args);
  console.log(`Installing VZT Agent Protocol → ${dotClaude}`);

  const agents = copyDirContents(AGENT_FILES_DIR, path.join(dotClaude, 'agents'), { ext: '.md' });
  const skills = copyDirContents(SKILLS_DIR, path.join(dotClaude, 'skills'));
  const hooks = copyDirContents(HOOKS_DIR, path.join(dotClaude, 'hooks', 'vzt-router'));
  const templates = copyDirContents(TEMPLATES_DIR, path.join(dotClaude, 'templates'), { ext: '.md' });
  const workflows = copyDirContents(WORKFLOWS_DIR, path.join(dotClaude, 'workflows'), { ext: '.js' });
  // Orca supervision helpers go to a FIXED home (~/.orca/vzt/), not .claude —
  // ship-dispatch/ship-watch point each unit's prompt at this absolute path, and
  // Orca worktree panes need it regardless of which project's .claude they inherit.
  const orca = installOrcaHelpers();
  // Project installs (--target / cwd) get portable $CLAUDE_PROJECT_DIR paths so
  // a committed settings.json works for anyone who clones the repo; a global
  // install (~/.claude) uses the absolute path.
  const settingsPath = wireSettings(dotClaude, { portable: !args.global });

  console.log(`  agents:   ${agents.length} installed (fable×2, opus×2, sonnet×1, haiku×2)`);
  console.log(`  skills:   ${skills.length} files installed (/vzt-route /vzt-plan /vzt-fix /vzt-build /vzt-quick /vzt-fable-mode /vzt-diagnose /vzt-ship)`);
  console.log(`  hooks:    ${hooks.length} installed (SessionStart chair-profile + UserPromptSubmit classifier)`);
  console.log(`  templates: ${templates.length} installed (worker-brief delegation contract, ship spec)`);
  console.log(`  workflows: ${workflows.length} installed (vzt-ship long-horizon orchestration)`);
  console.log(`  orca:     ${orca.length} helper(s) → ${ORCA_VZT_DIR} (worktree-bootstrap for ship-dispatch/ship-watch)`);
  console.log(`  settings: wired ${settingsPath}`);
  console.log('\nDone. Restart Claude Code to activate.');
  console.log('Chair is up to you — the protocol adapts either way:');
  console.log('  /model opus   → build inline, delegate routine work DOWN to Sonnet/Haiku, Fable for the hard stuff');
  console.log('  /model sonnet → stay on the Sonnet bucket, escalate UP only when a task earns it');
}

function uninstall(args) {
  const dotClaude = claudeDir(args);
  console.log(`Uninstalling VZT Agent Protocol from ${dotClaude}`);
  let removed = 0;
  if (fs.existsSync(AGENT_FILES_DIR)) {
    for (const f of fs.readdirSync(AGENT_FILES_DIR)) {
      const target = path.join(dotClaude, 'agents', f);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removed++;
      }
    }
  }
  // Remove only the files we ship — never the templates/ or workflows/ dirs
  // themselves, which the user may share with other tooling.
  for (const [srcDir, destName] of [
    [TEMPLATES_DIR, 'templates'],
    [WORKFLOWS_DIR, 'workflows'],
  ]) {
    if (!fs.existsSync(srcDir)) continue;
    for (const f of fs.readdirSync(srcDir)) {
      const target = path.join(dotClaude, destName, f);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removed++;
      }
    }
  }
  const skillDirs = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : [];
  for (const dir of [...skillDirs.map((d) => path.join(dotClaude, 'skills', d)), path.join(dotClaude, 'hooks', 'vzt-router')]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
      removed++;
    }
  }
  const unwired = unwireSettings(dotClaude);
  console.log(`  removed ${removed} paths; hooks ${unwired ? 'unwired' : 'were not wired'}`);
}

function doctor(args) {
  const dotClaude = claudeDir(args);
  const checks = [];
  const agentCount = fs.existsSync(AGENT_FILES_DIR)
    ? fs.readdirSync(AGENT_FILES_DIR).filter((f) => f.endsWith('.md')).length
    : 0;
  const installedAgents = fs.existsSync(path.join(dotClaude, 'agents'))
    ? fs.readdirSync(path.join(dotClaude, 'agents')).filter((f) => f.startsWith('vzt-')).length
    : 0;
  checks.push([`agents installed (${installedAgents}/${agentCount})`, installedAgents >= agentCount && agentCount > 0]);
  const skillDirs = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : [];
  const skillsOk = skillDirs.every((d) => fs.existsSync(path.join(dotClaude, 'skills', d, 'SKILL.md')));
  checks.push([`skills installed (${skillDirs.join(', ')})`, skillsOk && skillDirs.length > 0]);
  // The v1.4.0 bug was a doctrine reference to a file install() never copied.
  // Doctor now checks the artifacts the doctrine points at, not just the agents.
  const templateFiles = fs.existsSync(TEMPLATES_DIR) ? fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md')) : [];
  const templatesOk = templateFiles.length > 0 && templateFiles.every((f) => fs.existsSync(path.join(dotClaude, 'templates', f)));
  checks.push([`templates installed (${templateFiles.join(', ')})`, templatesOk]);
  const workflowFiles = fs.existsSync(WORKFLOWS_DIR) ? fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.js')) : [];
  const workflowsOk = workflowFiles.length > 0 && workflowFiles.every((f) => fs.existsSync(path.join(dotClaude, 'workflows', f)));
  checks.push([`workflows installed (${workflowFiles.join(', ')})`, workflowsOk]);

  const settings = readJson(path.join(dotClaude, 'settings.json'), {});
  for (const h of HOOKS) {
    checks.push([`${h.basename} installed`, fs.existsSync(path.join(dotClaude, 'hooks', 'vzt-router', h.basename))]);
    const wired = (settings.hooks?.[h.event] || []).some((m) =>
      (m.hooks || []).some((x) => typeof x.command === 'string' && x.command.includes(h.basename))
    );
    checks.push([`${h.event} hook wired in settings.json`, wired]);
  }
  const major = Number(process.versions.node.split('.')[0]);
  checks.push([`node >= 18 (found ${process.versions.node})`, major >= 18]);

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — run: vzt-agent install');
  process.exitCode = ok ? 0 : 1;
}

function stats() {
  const file = path.join(STATE_DIR, 'decisions.jsonl');
  if (!fs.existsSync(file)) {
    console.log('No routing decisions logged yet (~/.claude/vzt-router/decisions.jsonl).');
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const byTier = {};
  const ships = [];
  let overrides = 0;
  let routed = 0;
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.kind === 'ship') {
        ships.push(d);
        continue;
      }
      if (!d.tier) continue;
      byTier[d.tier] = (byTier[d.tier] || 0) + 1;
      if (d.override) overrides++;
      routed++;
    } catch {
      /* skip bad lines */
    }
  }
  const total = routed;
  console.log(`Routing decisions: ${total} (manual overrides: ${overrides})\n`);
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    const n = byTier[tier] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${tier.padEnd(6)} ${String(pct).padStart(3)}%  ${bar} (${n})`);
  }
  const fablePct = total ? ((byTier.fable || 0) / total) * 100 : 0;
  console.log(`\nTarget: Fable ≤15% — ${fablePct <= 15 ? '✅ on target' : `❌ over (${Math.round(fablePct)}%) — tighten routing or use /vzt-build for execution`}`);

  // /vzt-ship ships with the test that can delete it. If the spec is not buying
  // coherence, it is buying a document, and a document is a tax.
  if (ships.length) {
    const units = ships.reduce((n, s) => n + (s.units || 0), 0);
    const blocked = ships.reduce((n, s) => n + (s.blocked || 0), 0);
    const corrections = ships.reduce((n, s) => n + (s.corrections || 0), 0);
    const ratio = units ? corrections / units : 0;
    console.log(`\n/vzt-ship: ${ships.length} runs, ${units} units, ${blocked} blocked, ${corrections} corrections (${ratio.toFixed(2)}/unit)`);
    if (ships.length >= 5) {
      const bad = blocked > 0 && ratio >= 1;
      console.log(
        bad
          ? '  ❌ falsified: corrections ≥ 1/unit AND units still blocking — the spec is buying a document, not coherence. Delete the skill.'
          : '  ✅ holding: the spec is paying for itself.'
      );
    }
  }
}

// ——— /vzt-ship: spec gate + run ledger ———————————————————————————————————
//
// The ledger lives next to the spec, in-repo, so it shows up in git and cannot
// be orphaned from the code it describes.
//
// WORKTREE COHERENCE (Orca supervision layer): when ship units run in isolated
// git worktrees (one Orca pane per unit), `.vzt/ship/` is git-tracked, so every
// worktree gets its OWN forked LEDGER on its own branch. A worker writing there is
// invisible to the chair and branches merge-conflict on LEDGER.jsonl. So the ledger
// ALWAYS resolves to the PRIMARY checkout — the single shared writer target — no
// matter which worktree ship-note runs from. In a plain (non-worktree) checkout the
// primary root IS the repo root, so this is byte-identical to the old behaviour.

/** First entry of `git worktree list` is always the main checkout. null if not a repo. */
function primaryCheckoutRoot(fromDir) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: fromDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n').find((l) => l.startsWith('worktree '));
    return first ? first.slice('worktree '.length).trim() : null;
  } catch {
    return null; // git missing or not a repo — caller falls back to spec-local
  }
}

function ledgerPathFor(specPath) {
  const specDir = path.dirname(path.resolve(specPath));
  // If the spec sits under <root>/.vzt/ship/<slug>/, redirect the ledger to the
  // PRIMARY checkout's copy of that same relative path. Otherwise (unusual layout,
  // or no git) keep it next to the spec — backward compatible.
  const m = /(^|[/\\])\.vzt[/\\]ship[/\\][^/\\]+$/.exec(specDir);
  const primary = primaryCheckoutRoot(specDir);
  if (m && primary) {
    const slug = path.basename(specDir);
    return path.join(primary, '.vzt', 'ship', slug, 'LEDGER.jsonl');
  }
  return path.join(specDir, 'LEDGER.jsonl');
}

function loadSpec(specPath) {
  if (!specPath) {
    console.error('usage: vzt-agent ship-check <path/to/SPEC.md>');
    process.exit(2);
  }
  if (!fs.existsSync(specPath)) {
    console.error(`❌ no such spec: ${specPath}`);
    process.exit(2);
  }
  const { spec, error } = parseSpec(fs.readFileSync(specPath, 'utf8'));
  if (error) {
    console.error(`❌ ${error}`);
    process.exit(1);
  }
  return spec;
}

/**
 * The gate. This is what turns "FILES_IN_SCOPE must be pairwise disjoint" from
 * doctrine a model might honour into a command that exits non-zero.
 */
function shipCheck(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error(`❌ SPEC invalid — ${errs.length} violation${errs.length === 1 ? '' : 's'}:\n`);
    for (const e of errs) console.error(`  • ${e}`);
    console.error('\nFix the spec. Do not proceed on a red gate.');
    process.exit(1);
  }
  const units = spec.units.length + (spec.barrier ? 1 : 0);
  const files = [spec.barrier, ...spec.units].filter(Boolean).reduce((n, u) => n + (u.filesInScope || []).length, 0);
  console.log(`✅ SPEC valid — ${units} units, ${files} files, scopes pairwise disjoint, every unit has an oracle.`);
  console.log(`   slug: ${spec.slug}`);
  console.log(`   next: vzt-agent ship-start ${specPath}`);
}

function shipStart(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to start: SPEC does not pass ship-check.');
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const runId = `ship_${stamp}_${spec.slug}`;
  const ledger = ledgerPathFor(specPath);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const lines = [
    { ts: new Date().toISOString(), kind: 'run_started', runId, slug: spec.slug, specPath: path.resolve(specPath) },
    { ts: new Date().toISOString(), kind: 'gate_passed', runId, gate: 'ship-check', detail: `${spec.units.length} units, disjoint, oracles present` },
  ];
  fs.appendFileSync(ledger, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`✅ run started: ${runId}`);
  console.log(`   ledger: ${ledger}`);
}

/** Append one line to the ledger. The chair is the single writer. */
function shipNote(args) {
  const specPath = args._[1];
  const json = args._[2];
  if (!specPath || !json) {
    console.error('usage: vzt-agent ship-note <path/to/SPEC.md> \'{"kind":"unit_result",...}\'');
    process.exit(2);
  }
  let entry;
  try {
    entry = JSON.parse(json);
  } catch (e) {
    console.error(`❌ not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const ledger = ledgerPathFor(specPath);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  console.log(`✅ appended ${entry.kind || 'entry'} → ${ledger}`);
}

/** Find the newest ledger under <cwd>/.vzt/ship/ * /LEDGER.jsonl.
 *  Resolves to the PRIMARY checkout first, so `ship-status` from inside an Orca
 *  worktree pane sees the one shared run, not that worktree's forked copy. */
function findLedgers(cwd) {
  const root = primaryCheckoutRoot(cwd) || cwd;
  const base = path.join(root, '.vzt', 'ship');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const slug of fs.readdirSync(base)) {
    const l = path.join(base, slug, 'LEDGER.jsonl');
    if (fs.existsSync(l)) out.push({ slug, ledger: l, mtime: fs.statSync(l).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * The rehydration block. After a compaction eats the plan, this reconstructs
 * the run from disk — the whole point of the release.
 */
function shipStatus(args) {
  const cwd = args.target ? path.resolve(args.target) : process.cwd();
  const found = findLedgers(cwd);
  if (!found.length) {
    console.log(`No ship runs in ${cwd}/.vzt/ship/`);
    return;
  }
  for (const { slug, ledger } of found) {
    const state = reduceLedger(fs.readFileSync(ledger, 'utf8'));
    const status = state.active ? 'ACTIVE' : 'complete';
    console.log(`\nSHIP RUN ${state.runId || slug} — ${status}`);
    if (state.specPath) console.log(`  spec:     ${state.specPath}   (read this — it IS the plan)`);
    if (state.wfRunId) console.log(`  workflow: ${state.wfRunId}  → resume: Workflow({scriptPath, resumeFromRunId:"${state.wfRunId}"})`);
    console.log(`  units:    ${unitLine(state)}`);
    if (state.integration) console.log(`  integration: ${state.integration.status}`);
    console.log(`  next:     ${nextAction(state)}`);
  }
}

function matrix() {
  const file = path.join(PKG_ROOT, 'docs', 'ROUTING-MATRIX.md');
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
  else console.log('docs/ROUTING-MATRIX.md not found');
}

// ——— /vzt-ship: Orca supervision — dispatch units as worktree panes ————————
//
// Turns a gated SPEC into one `orca worktree create --agent claude` per unit, each
// carrying the unit's worker brief, its FILES_IN_SCOPE collision boundary, and its
// MACHINE_CHECK. --setup run fires the repo's worktree-bootstrap so node_modules/.env
// are linked before the agent starts. This is the SUPERVISED path (Orca panes you
// watch); the headless path stays the vzt-ship.js Workflow. Never run BOTH on one SPEC.
//
// Default prints the commands (review before spending). --execute runs them via the
// orca CLI. The barrier runs FIRST and alone — its oracle grades every unit — so we
// separate it into phase 1 and gate phase 2 behind it.

const DEFAULT_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
// Where `vzt-agent install` places the Orca helper scripts (see install()).
const ORCA_VZT_DIR = path.join(os.homedir(), '.orca', 'vzt');
const BOOTSTRAP = path.join(ORCA_VZT_DIR, 'worktree-bootstrap.sh');

function unitPrompt(spec, u) {
  const files = (u.filesInScope || []).map((f) => `    - ${f}`).join('\n');
  return [
    `[VZT ship unit ${u.id}] ${u.title || ''}`.trim(),
    '',
    `STEP 0 (run this FIRST, before anything else): \`sh ${BOOTSTRAP}\``,
    'It symlinks node_modules and .env* from the primary checkout into this worktree so',
    'your build and MACHINE_CHECK work. A fresh worktree has neither. Skip nothing.',
    '',
    u.brief,
    '',
    'FILES_IN_SCOPE — touch ONLY these; they are your collision boundary:',
    files,
    '',
    `This unit is DONE only when this command passes:  ${u.machineCheck}`,
    `Expected:  ${u.expect}`,
    '',
    'Work under VZT fable-mode discipline (scope → evidence → attack → verify → report).',
    'Do not edit, create, or delete any file outside FILES_IN_SCOPE. When finished, run the',
    'MACHINE_CHECK yourself and report its exact output.',
  ].join('\n');
}

function orcaArgvFor(spec, u) {
  return [
    'worktree', 'create',
    '--repo', `path:${spec.root}`,
    '--name', `${spec.slug}-${u.id}`,
    '--no-parent',
    '--agent', 'claude',
    '--setup', 'run',
    '--prompt', unitPrompt(spec, u),
    '--json',
  ];
}

/** POSIX single-quote an argument for safe copy-paste of the printed command. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function shipDispatch(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to dispatch: SPEC does not pass ship-check. Run `vzt-agent ship-check` first.');
    process.exit(1);
  }
  const ORCA = args.orca || process.env.ORCA_CLI || DEFAULT_ORCA;
  const phases = [];
  if (spec.barrier) phases.push({ label: 'PHASE 1 — barrier (run FIRST, alone; its oracle grades every unit)', units: [spec.barrier] });
  phases.push({ label: `PHASE ${spec.barrier ? 2 : 1} — units (parallel; pairwise-disjoint scopes)`, units: spec.units });

  console.log(`# ship-dispatch: ${spec.slug} — ${spec.title}`);
  console.log(`# root: ${spec.root}`);
  console.log(`# ${args.execute ? 'EXECUTING via' : 'DRY RUN (add --execute to run) via'} ${ORCA}`);
  if (spec.barrier) console.log('# NOTE: wait for the barrier oracle to pass before dispatching the units.');

  for (const phase of phases) {
    console.log(`\n## ${phase.label}`);
    for (const u of phase.units) {
      const argv = orcaArgvFor(spec, u);
      if (args.execute) {
        console.log(`\n→ creating worktree for ${u.id} …`);
        try {
          const out = execFileSync(ORCA, argv, { encoding: 'utf8' });
          console.log(out.trim());
        } catch (e) {
          console.error(`❌ ${u.id}: orca worktree create failed — ${e.message}`);
        }
      } else {
        console.log(`\n# ${u.id}: verified by  ${u.machineCheck}`);
        console.log(`${shq(ORCA)} ${argv.map(shq).join(' ')}`);
      }
    }
  }
  console.log(`\n## after workers finish — verify each unit's oracle (Workflow C):`);
  console.log(`#   vzt-agent ship-supervise ${specPath}   (or run each unit's MACHINE_CHECK in its worktree)`);
  console.log(`# integration gate: ${spec.integration && spec.integration.machineCheck ? spec.integration.machineCheck : '(none declared)'}`);
}

// ——— /vzt-ship: Orca supervision — verify each unit's oracle on finish ————————
//
// The automated "verify worker artifacts before accepting the report" reaction. For
// each unit it resolves the unit's Orca worktree (by name), runs that unit's
// MACHINE_CHECK inside it, records PASS/FAIL to the SHARED ledger (ship-note, which
// resolves to the primary checkout), and — when Orca is live — stamps the worktree
// card. Oracles are self-contained (`cd <root> && …`), so this also works without a
// live Orca: it falls back to running the check as written and recording the verdict.

/** Resolve an Orca-managed worktree path by its --name. null when Orca is not live. */
function resolveWorktreePath(ORCA, name) {
  try {
    const out = execFileSync(ORCA, ['worktree', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const data = JSON.parse(out);
    // The orca CLI wraps every response in a {id, ok, result} envelope.
    const root = data && data.result ? data.result : data;
    const list = Array.isArray(root) ? root : root.worktrees || [];
    const hit = list.find((w) => w.name === name || w.displayName === name);
    return hit ? hit.path || (hit.id && hit.id.split('::')[1]) || null : null;
  } catch {
    return null; // Orca not running / older CLI — fall back to the primary checkout
  }
}

/** Run a self-contained oracle command; return {pass, code, output}. */
function runOracle(machineCheck, cwd) {
  try {
    const output = execFileSync('sh', ['-c', machineCheck], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { pass: true, code: 0, output: output.trim().slice(-500) };
  } catch (e) {
    return { pass: false, code: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}`.trim().slice(-500) };
  }
}

/**
 * Verify ONE unit and record everywhere: run its oracle in its worktree, append the
 * verdict to the SHARED ledger, and stamp the Orca card. Shared by ship-supervise
 * (batch) and ship-watch (as each worker finishes). `wtPath` may be pre-resolved by
 * the caller; otherwise it's looked up. Returns true on PASS.
 */
function verifyAndRecord(ORCA, spec, u, specPath, wtPath, via) {
  const wt = wtPath || resolveWorktreePath(ORCA, `${spec.slug}-${u.id}`);
  const r = runOracle(u.machineCheck, wt || spec.root);
  const status = r.pass ? 'PASS' : 'FAIL';
  console.log(`  ${u.id} … ${status}${wt ? '' : '  (no live worktree — ran against primary)'}`);
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-note', specPath,
      JSON.stringify({ kind: 'unit_result', unit: u.id, status, via, code: r.code })],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* best-effort */ }
  if (wt) {
    try {
      execFileSync(ORCA, ['worktree', 'set', '--worktree', `name:${spec.slug}-${u.id}`,
        '--comment', `oracle: ${status}`, '--workspace-status', r.pass ? 'in-review' : 'in-progress', '--json'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { /* Orca not live / older CLI */ }
  }
  return r.pass;
}

function runIntegrationGate(spec) {
  const check = spec.integration && spec.integration.machineCheck;
  if (!check) { console.log('\nintegration gate: (none declared)'); return true; }
  process.stdout.write('\nintegration gate … ');
  const r = runOracle(check, spec.root);
  console.log(r.pass ? 'PASS ✅ — units verified and integrated; ready for your review + merge.' : 'FAIL ❌');
  if (!r.pass && r.output) console.log(r.output.split('\n').map((l) => `    ${l}`).join('\n'));
  return r.pass;
}

function shipSupervise(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to supervise: SPEC does not pass ship-check.');
    process.exit(1);
  }
  const ORCA = args.orca || process.env.ORCA_CLI || DEFAULT_ORCA;
  const units = [spec.barrier, ...spec.units].filter(Boolean);
  let passed = 0;
  for (const u of units) if (verifyAndRecord(ORCA, spec, u, specPath, null, 'ship-supervise')) passed++;
  console.log(`\n${passed}/${units.length} unit oracle(s) PASS. Verdicts appended to the shared LEDGER.`);
  console.log(`next: run the integration gate → ${spec.integration && spec.integration.machineCheck ? spec.integration.machineCheck : '(none declared)'}`);
  if (passed < units.length) process.exitCode = 1;
}

// ——— /vzt-ship: Orca ship-watch — ONE command, kick once and walk away ————————
//
// The full automatic loop: dispatch every unit as an Orca claude pane, wait for each
// to finish (tui-idle), auto-run its oracle + stamp its card + record the ledger the
// instant it's done, then run the integration gate. The barrier (if any) runs FIRST
// and gates the units. Stops at the green gate with a "ready to review + merge"
// verdict — it never auto-merges (verify-before-accept stays a human call).

/** Run an orca command with --json and return the unwrapped `result`. Throws on failure. */
function orcaJson(ORCA, argv) {
  const out = execFileSync(ORCA, [...argv, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const d = JSON.parse(out);
  return d && d.result ? d.result : d;
}

function dispatchOne(ORCA, spec, u) {
  const res = orcaJson(ORCA, ['worktree', 'create', '--repo', `path:${spec.root}`,
    '--name', `${spec.slug}-${u.id}`, '--no-parent', '--agent', 'claude', '--setup', 'run',
    '--prompt', unitPrompt(spec, u)]);
  const wt = res.worktree || res;
  const handle = res.agentTerminalHandle || (res.startupTerminal && res.startupTerminal.handle)
    || (wt.startupTerminal && wt.startupTerminal.handle) || null;
  const wtPath = wt.path || (wt.id && String(wt.id).split('::')[1]) || null;
  console.log(`  dispatched ${u.id} → ${wtPath || '(worktree)'}${handle ? '' : '  (no agent handle — will resolve on verify)'}`);
  return { u, wtPath, handle };
}

function waitIdle(ORCA, handle, timeoutMs) {
  if (!handle) return;
  try {
    execFileSync(ORCA, ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle',
      '--timeout-ms', String(timeoutMs), '--json'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* timed out or handle stale — verify anyway */ }
}

function shipWatch(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to watch: SPEC does not pass ship-check. Run `vzt-agent ship-check` first.');
    process.exit(1);
  }
  const ORCA = args.orca || process.env.ORCA_CLI || DEFAULT_ORCA;
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 30 * 60 * 1000;
  console.log(`ship-watch: ${spec.slug} — dispatch → wait → verify → integration gate (timeout ${Math.round(timeoutMs / 60000)}m/unit)`);

  // Open the ledger.
  try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-start', specPath], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}

  // Phase 1 — barrier gates everything.
  if (spec.barrier) {
    console.log('\n## barrier (runs first; its oracle grades every unit)');
    const b = dispatchOne(ORCA, spec, spec.barrier);
    waitIdle(ORCA, b.handle, timeoutMs);
    if (!verifyAndRecord(ORCA, spec, spec.barrier, specPath, b.wtPath, 'ship-watch')) {
      console.error('\n❌ barrier oracle FAILED — aborting before dispatching units. Fix the barrier worktree, then re-run.');
      process.exit(1);
    }
  }

  // Phase 2 — units in parallel; verify each as it idles.
  console.log('\n## units (parallel)');
  const workers = spec.units.map((u) => dispatchOne(ORCA, spec, u));
  console.log('\n## verifying as each finishes …');
  let passed = 0;
  for (const w of workers) {
    waitIdle(ORCA, w.handle, timeoutMs); // by the time earlier ones idle, later ones often already have
    if (verifyAndRecord(ORCA, spec, w.u, specPath, w.wtPath, 'ship-watch')) passed++;
  }

  console.log(`\n${passed}/${workers.length} unit oracle(s) PASS.`);
  const gateOk = passed === workers.length ? runIntegrationGate(spec) : (console.log('\nintegration gate skipped — not all units passed.'), false);
  if (!gateOk) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
switch (cmd) {
  case 'install':
    install(args);
    break;
  case 'uninstall':
    uninstall(args);
    break;
  case 'doctor':
    doctor(args);
    break;
  case 'stats':
    stats();
    break;
  case 'matrix':
    matrix();
    break;
  case 'ship-check':
    shipCheck(args);
    break;
  case 'ship-start':
    shipStart(args);
    break;
  case 'ship-note':
    shipNote(args);
    break;
  case 'ship-status':
    shipStatus(args);
    break;
  case 'ship-dispatch':
    shipDispatch(args);
    break;
  case 'ship-supervise':
    shipSupervise(args);
    break;
  case 'ship-watch':
    shipWatch(args);
    break;
  default:
    console.log(`vzt-agent — VZT Agent Protocol CLI

Usage:
  vzt-agent install [--global] [--target <dir>]
  vzt-agent uninstall [--global] [--target <dir>]
  vzt-agent doctor [--global] [--target <dir>]
  vzt-agent stats
  vzt-agent matrix

Long-horizon runs (/vzt-ship):
  vzt-agent ship-check <SPEC.md>          gate the spec — disjoint scopes, an oracle per unit
  vzt-agent ship-start <SPEC.md>          open the run ledger
  vzt-agent ship-note  <SPEC.md> '<json>' append one ledger line
  vzt-agent ship-status [--target <dir>]  reconstruct run state from disk (use after a compaction)

Orca supervision layer (parallel /vzt-ship runs in Orca worktree panes):
  vzt-agent ship-dispatch <SPEC.md> [--execute] [--orca <path>]
                                          one \`orca worktree create --agent claude\` per unit
                                          (dry-run prints the commands; --execute runs them)
  vzt-agent ship-supervise <SPEC.md> [--orca <path>]
                                          run each unit's MACHINE_CHECK in its worktree,
                                          record PASS/FAIL to the shared ledger + Orca card
  vzt-agent ship-watch <SPEC.md> [--orca <path>] [--timeout-ms <n>]
                                          KICK ONCE, WALK AWAY: dispatch every unit → wait
                                          for each to finish → auto-verify + stamp + ledger →
                                          integration gate. Stops at "ready to review + merge".
`);
}
