#!/usr/bin/env node
/**
 * vzt-agent — installer/CLI for the VZT Agent Protocol.
 *
 * Installs automatic model routing (Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5)
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
// The doctrine tells every session to delegate using .claude/templates/worker-brief.md.
// If we don't install it, that instruction points at nothing — the brief gets
// improvised, and MACHINE_CHECK drifts to being chosen AFTER the diff exists.
const TEMPLATES_DIR = path.join(PKG_ROOT, 'templates');
// Same lesson, second time: /vzt-ship tells the session to launch
// workflows/vzt-ship.js. If install() doesn't copy it, Workflow gets a
// scriptPath that does not exist — and it fails AFTER the spec has been paid
// for. The script and its install wiring ship together or not at all.
const WORKFLOWS_DIR = path.join(PKG_ROOT, 'workflows');
const ORCA_SRC_DIR = path.join(PKG_ROOT, 'orca');
// Doctrine surfaces the skills point at by relative path; see install().
const DOCS_DIR = path.join(PKG_ROOT, 'docs');

const HOOKS = [
  { event: 'UserPromptSubmit', basename: 'vzt-route-classifier.mjs', timeout: 10 },
  { event: 'SessionStart', basename: 'vzt-session-start.mjs', timeout: 10 },
  // Agent lifecycle sentinels for the native VS Code mux (--mux vscode). One
  // script, three events, distinguished by the action argument. All three no-op
  // unless VZT_VSCODE_MUX=1 is set in the env — i.e. only inside a unit terminal
  // the vscode backend launched. See hooks/vzt-vscode-agent-state.sh.
  //
  // `started` is what lets waitIdle tell "still working" from "never launched".
  // Without it a unit whose terminal swallowed its command burns the whole unit
  // budget and is then graded FAIL against an empty worktree — herdr fixed this
  // for its own backend long ago; observed live in vscode on 2026-07-28.
  { event: 'SessionStart', basename: 'vzt-vscode-agent-state.sh', timeout: 10, runner: 'bash', args: 'started' },
  { event: 'PermissionRequest', basename: 'vzt-vscode-agent-state.sh', timeout: 10, runner: 'bash', args: 'blocked' },
  { event: 'Stop', basename: 'vzt-vscode-agent-state.sh', timeout: 10, runner: 'bash', args: 'idle' },
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
    else if (a === '--herdr') args.herdr = argv[++i];
    else if (a === '--mux') args.mux = argv[++i];
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
    const runner = h.runner || 'node';
    // Trailing action argument, for scripts wired to several events (the vscode
    // lifecycle sentinel is one script serving started/blocked/idle).
    const suffix = h.args ? ` ${h.args}` : '';
    const cmd = portable
      ? `${runner} "$CLAUDE_PROJECT_DIR/.claude/hooks/vzt-router/${h.basename}"${suffix}`
      : `${runner} "${path.join(dotClaude, 'hooks', 'vzt-router', h.basename)}"${suffix}`;
    // Idempotent, but an UPGRADE must also rewrite a command that changed.
    // The old check only asked "is this basename present?", so when the vscode
    // sentinel gained its action argument, every already-installed machine kept
    // the stale argument-less command forever and `install` reported success.
    // A hook we manage is ours to keep current.
    let found = false;
    for (const m of bucket) {
      for (const x of m.hooks || []) {
        if (typeof x.command !== 'string' || !x.command.includes(h.basename)) continue;
        // Only touch entries wired for THIS event's action — one script can be
        // wired to several events with different arguments.
        if (found) continue;
        found = true;
        if (x.command !== cmd) {
          x.command = cmd;
          x.timeout = h.timeout;
          x._managedBy = MANAGED_MARKER;
        }
      }
    }
    if (!found) {
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
  // The skills tell a running session to "see docs/VSCODE.md" and
  // docs/ROUTING-MATRIX.md, but install() never copied docs/ — so from the
  // INSTALLED location those references resolved to nothing. Same class as the
  // v1.4.0 templates bug: doctrine pointing at a file the installer skipped.
  const docs = copyDirContents(DOCS_DIR, path.join(dotClaude, 'docs'), { ext: '.md' });
  // Orca supervision helpers go to a FIXED home (~/.orca/vzt/), not .claude —
  // ship-dispatch/ship-watch point each unit's prompt at this absolute path, and
  // Orca worktree panes need it regardless of which project's .claude they inherit.
  const orca = installOrcaHelpers();
  // Project installs (--target / cwd) get portable $CLAUDE_PROJECT_DIR paths so
  // a committed settings.json works for anyone who clones the repo; a global
  // install (~/.claude) uses the absolute path.
  const settingsPath = wireSettings(dotClaude, { portable: !args.global });

  console.log(`  agents:   ${agents.length} installed (fable×2, opus×4, sonnet×2, haiku×2)`);
  console.log(`  skills:   ${skills.length} files installed (/vzt-route /vzt-design /vzt-plan /vzt-fix /vzt-build /vzt-quick /vzt-fable-mode /vzt-diagnose /vzt-ship /vzt-ui)`);
  console.log(`  hooks:    ${hooks.length} installed (SessionStart chair-profile + UserPromptSubmit classifier + vscode-mux lifecycle sentinels on SessionStart/PermissionRequest/Stop)`);
  console.log(`  templates: ${templates.length} installed (worker-brief delegation contract, ship spec, DESIGN.md taste cache)`);
  console.log(`  workflows: ${workflows.length} installed (vzt-ship long-horizon orchestration)`);
  console.log(`  docs:     ${docs.length} installed (VSCODE, ROUTING-MATRIX, CHAIR-PROFILES — the skills reference these by path)`);
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
    [DOCS_DIR, 'docs'],
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
  // install() places these at a FIXED ~/.orca/vzt/ home rather than inside
  // .claude, and uninstall had no counterpart — so the helpers outlived every
  // uninstall. Only remove on a global uninstall: the path is shared, and a
  // project-level uninstall must not yank it out from under other checkouts.
  if (args.global) {
    for (const f of ['worktree-bootstrap.sh', 'README.md']) {
      const p = path.join(ORCA_VZT_DIR, f);
      if (fs.existsSync(p)) { fs.rmSync(p); removed++; }
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

  const docFiles = fs.existsSync(DOCS_DIR) ? fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')) : [];
  const docsOk = docFiles.length > 0 && docFiles.every((f) => fs.existsSync(path.join(dotClaude, 'docs', f)));
  checks.push([`docs installed (${docFiles.join(', ')})`, docsOk]);

  // EVERY unit prompt makes this file its hard-required STEP 0. If it is
  // missing, every unit's first action fails, the worktree never gets its deps
  // or env, and every MACHINE_CHECK then fails for reasons that have nothing to
  // do with the unit. Same class as the v1.4.0 templates bug — doctrine pointing
  // at an artifact the installer may not have placed — and it was the one such
  // artifact doctor still did not check.
  checks.push([`orca worktree-bootstrap.sh installed (${ORCA_VZT_DIR})`, fs.existsSync(path.join(ORCA_VZT_DIR, 'worktree-bootstrap.sh'))]);

  const settings = readJson(path.join(dotClaude, 'settings.json'), {});
  // Dedupe: one script serves several events, so keyed by basename alone this
  // printed the same "installed" line three times and buried the real signal.
  for (const basename of [...new Set(HOOKS.map((h) => h.basename))]) {
    checks.push([`${basename} installed`, fs.existsSync(path.join(dotClaude, 'hooks', 'vzt-router', basename))]);
  }
  for (const h of HOOKS) {
    const cmds = (settings.hooks?.[h.event] || [])
      .flatMap((m) => m.hooks || [])
      .map((x) => x.command)
      .filter((c) => typeof c === 'string' && c.includes(h.basename));
    // Wired is not enough — the ACTION ARGUMENT has to be there too. An install
    // predating the lifecycle sentinels leaves an argument-less command that
    // silently collapses started/blocked/idle into idle, reinstating the
    // empty-worktree grading while doctor reported all-green.
    const wired = cmds.length > 0 && (!h.args || cmds.some((c) => c.trimEnd().endsWith(` ${h.args}`)));
    checks.push([`${h.event} hook wired${h.args ? ` with "${h.args}"` : ''}`, wired]);
  }

  // The extension is half of the vscode backend; a stale one is a silent
  // mismatch against the CLI's filesystem contract.
  const extManifest = path.join(PKG_ROOT, 'vscode', 'package.json');
  if (fs.existsSync(extManifest)) {
    const want = readJson(extManifest, {}).version;
    const installedDir = path.join(os.homedir(), '.vscode', 'extensions');
    let found = null;
    try {
      found = fs.readdirSync(installedDir).filter((d) => d.startsWith('vzt.vzt-mux-'))
        .map((d) => readJson(path.join(installedDir, d, 'package.json'), {}).version)
        .filter(Boolean)
        .sort()
        .pop() || null;
    } catch { /* no vscode extensions dir */ }
    checks.push([`vscode extension ${want} installed${found ? ` (found ${found})` : ' (not found — --mux vscode degrades to manual)'}`, found === want]);

    // Installed-on-disk is NOT the same as loaded-in-the-host. VS Code caches
    // extension code; neither a file copy nor `code --install-extension --force`
    // hot-swaps a running window, only a reload does. Without this check a stale
    // host is invisible: the fix "doesn't work" and you debug the code instead
    // of the reload. The extension stamps its version on activate().
    const hostFile = path.join(VZT_VSCODE_DIR, 'host.json');
    if (fs.existsSync(hostFile)) {
      const running = readJson(hostFile, {}).version;
      checks.push([
        running === want
          ? `vscode extension host running ${running}`
          : `vscode extension host running ${running}, but ${want} is installed — RELOAD THE WINDOW (Cmd+Shift+P → Developer: Reload Window)`,
        running === want,
      ]);
    } else if (found) {
      checks.push(['vscode extension host has not reported a version yet (reload the window once to enable the staleness check)', true]);
    }
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
  let routed = 0;
  let deduped = 0;

  // DEDUP by (timestamp, session), keeping the LAST entry.
  //
  // A repo that registers the classifier at project level on top of the global
  // registration routes every prompt TWICE, and the two copies can disagree —
  // an older build logs the pre-demotion `fable` verdict while the current one
  // logs the demoted `opus`. Those phantom fable rows land in this histogram.
  //
  // It is not a rounding curiosity: measured on the live log, the raw figure was
  // 10.0147% against a ≤10% target — a ❌ — while the deduped truth was 9.88%,
  // a ✅. The protocol's one headline KPI was being flipped by its own logging
  // noise. Last-wins because the second writer is the up-to-date classifier.
  const seen = new Map();
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.kind === 'ship') { ships.push(d); continue; }
    if (!d.tier) continue;
    const key = `${d.ts || ''}|${d.session || ''}`;
    if (d.ts && seen.has(key)) deduped++;
    seen.set(key, d);
  }
  let uiTotal = 0;
  let uiHits = 0;
  for (const d of seen.values()) {
    byTier[d.tier] = (byTier[d.tier] || 0) + 1;
    routed++;
    if (d.kind === 'ui') {
      uiTotal++;
      if (d.designDoc) uiHits++;
    }
  }

  const total = routed;
  console.log(`Routing decisions: ${total}${deduped ? ` (${deduped} duplicate double-routed prompts collapsed)` : ''}\n`);
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    const n = byTier[tier] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${tier.padEnd(6)} ${String(pct).padStart(3)}%  ${bar} (${n})`);
  }
  // One decimal, not Math.round: at 10.0147% the rounded form printed
  // "❌ over (10%)" against a "≤10%" target — a message that contradicts itself
  // on its face and gives you no way to tell a real overshoot from a rounding
  // artefact.
  const fablePct = total ? ((byTier.fable || 0) / total) * 100 : 0;
  console.log(
    `\nTarget: Fable ≤10% — ${
      fablePct <= 10
        ? `✅ on target (${fablePct.toFixed(1)}%)`
        : `❌ over (${fablePct.toFixed(1)}%) — tighten routing: routine planning belongs on opus@max (/vzt-design), execution on /vzt-build`
    }`
  );

  // The ui lane ships with the test that can delete it, same as /vzt-ship below.
  // Its entire economic claim is that DESIGN.md moves taste onto disk so visual
  // work routes DOWN to Sonnet. If the cache is never written, the lane is buying
  // an Opus turn per visual prompt and nothing else — strictly worse than the
  // zero-signal default it replaced.
  if (uiTotal) {
    const hitPct = (uiHits / uiTotal) * 100;
    console.log(`\nvisual (ui): ${uiTotal} decisions, ${uiHits} taste-cache hits (${hitPct.toFixed(0)}%)`);
    if (uiTotal >= 20) {
      console.log(
        hitPct < 20
          ? '  ❌ falsified: almost nothing is reading a DESIGN.md — the lane is buying an Opus turn per prompt. Run /vzt-ui extract on the repos you actually work in, or delete the lane.'
          : '  ✅ holding: taste is on disk and visual work is routing DOWN as designed.'
      );
    }
  }

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
const DEFAULT_HERDR = 'herdr'; // on PATH via Homebrew (agent multiplexer, terminal-native)
// Where `vzt-agent install` places the helper scripts (see install()).
const ORCA_VZT_DIR = path.join(os.homedir(), '.orca', 'vzt');
const BOOTSTRAP = path.join(ORCA_VZT_DIR, 'worktree-bootstrap.sh');
// Native VS Code mux (--mux vscode) exchanges work with the companion extension
// purely through the filesystem — no socket, no compiled binary. The backend
// writes launch records to queue/ and PASS/FAIL to state/; the extension drains
// queue/ into native integrated terminals; the Stop hook writes state/*.idle.
const VZT_VSCODE_DIR = process.env.VZT_VSCODE_DIR || path.join(os.homedir(), '.vzt', 'vscode-mux');

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

/** POSIX single-quote an argument for safe copy-paste of the printed command. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ——— mux backends — Orca and Herdr behind ONE 5-method interface ————————————
//
// Both are agent multiplexers that manage git worktrees + panes. A backend exposes:
//   plan(spec,u)    → [shell lines]        for `ship-dispatch` dry-run (copy-paste)
//   dispatch(spec,u)→ {path, ws, handle}   create the worktree + launch claude w/ the brief
//   waitIdle(handle)                        block until that agent goes idle
//   resolve(spec,u) → {path, ws}|null      find an already-created unit worktree
//   stamp(spec,u,info,status,pass)          write the visible PASS/FAIL onto the card/workspace
// Every mux CLI wraps responses in an envelope; unwrap `.result` (a live bug taught us this).
// Unit → worktree key: Orca `--name <slug>-<id>`, Herdr `--branch <slug>-<id>`.

function envJson(bin, argv) {
  const out = execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const d = JSON.parse(out);
  return d && d.result ? d.result : d;
}

function orcaBackend(args) {
  const bin = args.orca || process.env.ORCA_CLI || DEFAULT_ORCA;
  const key = (spec, u) => `${spec.slug}-${u.id}`;
  // Ship panes run UNSUPERVISED, so a unit that stops on its first permission
  // prompt never goes idle and burns its whole budget before the oracle grades
  // an empty worktree. herdr and vscode both pass --dangerously-skip-permissions.
  // Opt out per-run with VZT_ORCA_SKIP_PERMISSIONS=0.
  const skipPerms = process.env.VZT_ORCA_SKIP_PERMISSIONS !== '0';

  // TWO-STEP dispatch, which is what Orca documents for a custom agent argv.
  //
  // `worktree create --agent claude` launches the built-in Claude launcher and
  // accepts no agent-specific flags — there is no way to add
  // --dangerously-skip-permissions to it. Orca's own orca-cli skill guide is
  // explicit: for a custom command, create the worktree WITHOUT --agent, then
  // `terminal create --command '<full argv>'` in it.
  //
  // 🔴 The trap Orca documents alongside it: a bare `worktree create` (no
  // --agent) opens a FALLBACK SHELL as the first terminal before our
  // `terminal create` adds the agent. So the agent handle is the one returned
  // by terminal create — never the worktree's startupTerminal — or waitIdle
  // would poll an idle shell and grade the unit the instant it launched.
  const createArgv = (spec, u) => ['worktree', 'create', '--repo', `path:${spec.root}`,
    '--name', key(spec, u), '--no-parent', '--setup', 'run', '--json'];
  const claudeCmd = (spec, u) =>
    `claude ${skipPerms ? '--dangerously-skip-permissions ' : ''}${shq(unitPrompt(spec, u))}`;
  const termArgv = (spec, u, wtId) => ['terminal', 'create',
    ...(wtId ? ['--worktree', wtId] : []),
    '--title', key(spec, u), '--command', claudeCmd(spec, u), '--json'];
  return {
    name: 'orca', bin,
    plan(spec, u) {
      return [
        `${shq(bin)} ${createArgv(spec, u).map(shq).join(' ')}`,
        `${shq(bin)} ${termArgv(spec, u, '<WORKTREE_ID>').map(shq).join(' ')}`,
      ];
    },
    dispatch(spec, u) {
      const res = envJson(bin, createArgv(spec, u));
      const wt = res.worktree || res;
      const wpath = wt.path || (wt.id && String(wt.id).split('::')[1]) || null;
      // The worktree id is a two-part `<repo-id>::<path>` address; a bare repo id
      // is not a worktree id, so prefer the returned id verbatim.
      const wtId = wt.id || (wpath ? `path:${wpath}` : null);

      // The agent handle comes from `terminal create`, NEVER from the worktree.
      // A bare `worktree create` (no --agent) leaves a fallback SHELL as the
      // first terminal; waiting on that reports tui-idle immediately and grades
      // the unit before the agent has done anything.
      let handle = null;
      try {
        const term = envJson(bin, termArgv(spec, u, wtId));
        handle = term.handle || term.terminal?.handle || term.startupTerminal?.handle || null;
      } catch (e) {
        console.error(`  ${u.id}: orca terminal create failed — ${(e.message || '').trim().split('\n')[0]}`);
      }
      // A null handle means waitIdle has nothing to wait ON: it returns instantly
      // and the oracle grades a worktree the agent may not have touched yet.
      // herdr logs when `agent start` throws; orca said nothing at all.
      if (!handle) {
        console.error(`  ${u.id}: no orca agent terminal handle — cannot wait for idle, so the oracle may grade an unfinished worktree.`);
      }
      return { path: wpath, ws: key(spec, u), handle };
    },
    // TWO-PHASE, matching herdr and vscode: prove the agent STARTED before
    // waiting for it to stop. Orca exposes no agent status states, but
    // `terminal read` returns a monotonic `latestCursor` — output is proof of
    // life, and no output within the start grace means it never ran.
    //
    // Written from Orca's documented CLI contract and NOT exercised end-to-end
    // (no Orca runtime on the machine this was written on), so it degrades on
    // purpose: if a cursor cannot be read the phase is skipped entirely and we
    // fall through to the single-phase wait that shipped before. Worst case is
    // today's behaviour, not a broken default backend.
    waitIdle(handle, t) {
      if (!handle) return;
      const startGrace = Number(process.env.VZT_START_GRACE_MS || 90_000);
      const cursor = () => {
        try {
          const r = envJson(bin, ['terminal', 'read', '--terminal', handle, '--limit', '1', '--json']);
          const c = r.latestCursor ?? r.nextCursor ?? null;
          return typeof c === 'number' ? c : null;
        } catch {
          return null;
        }
      };
      const base = cursor();
      if (base !== null) {
        const deadline = Date.now() + Math.min(t, startGrace);
        let started = base > 0;
        while (!started && Date.now() < deadline) {
          sleepSync(1000);
          const c = cursor();
          if (c === null) { started = true; break; } // lost the signal — don't stall on it
          if (c > base) started = true;
        }
        if (!started) {
          console.error(`  orca: no output within ${Math.round(Math.min(t, startGrace) / 1000)}s — the agent likely never started; verifying anyway`);
          return;
        }
      }
      try { execFileSync(bin, ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(t), '--json'], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* timed out/stale — verify anyway */ }
    },
    resolve(spec, u) {
      try {
        const r = envJson(bin, ['worktree', 'list', '--json']);
        const list = Array.isArray(r) ? r : r.worktrees || [];
        const n = key(spec, u);
        const hit = list.find((w) => w.name === n || w.displayName === n);
        return hit ? { path: hit.path || (hit.id && String(hit.id).split('::')[1]) || null, ws: n } : null;
      } catch { return null; }
    },
    stamp(spec, u, info, status, pass) {
      try { execFileSync(bin, ['worktree', 'set', '--worktree', `name:${info.ws}`, '--comment', `oracle: ${status}`, '--workspace-status', pass ? 'in-review' : 'in-progress', '--json'], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not live */ }
    },
  };
}

function herdrBackend(args) {
  const bin = args.herdr || process.env.HERDR_CLI || DEFAULT_HERDR;
  const branch = (spec, u) => `${spec.slug}-${u.id}`;
  // The herdr server runs as a brew LaunchAgent, whose PATH is the bare system
  // default (/usr/bin:/bin:/usr/sbin:/sbin) — it does NOT inherit the login
  // shell's. `agent start claude` therefore dies with "No viable candidates
  // found in PATH" because claude lives in ~/.local/bin (and node in nvm).
  // Hand the child our own PATH explicitly; the mux adapter is the right layer
  // to do it, since patching the brew-owned plist is undone by every upgrade.
  const envPath = ['--env', `PATH=${process.env.PATH || ''}`];
  // How long to wait for a just-spawned agent to show any sign of life before
  // concluding it never ran. Claude takes a few seconds to boot and start
  // emitting, so this must comfortably exceed that; it is NOT the unit budget.
  const START_GRACE_MS = Number(process.env.VZT_START_GRACE_MS || 90_000);
  // Ship panes run UNSUPERVISED — a human is not sitting on each worktree to
  // clear permission prompts. So the pane's claude must skip permission checks
  // and drive the unit autonomously; otherwise it boots and blocks forever on
  // the first tool prompt, the idle-wait returns, and the oracle grades an
  // empty worktree. Opt out per-run with VZT_HERDR_SKIP_PERMISSIONS=0.
  const skipPerms = process.env.VZT_HERDR_SKIP_PERMISSIONS !== '0';
  const claudeArgv = (prompt) => ['claude', ...(skipPerms ? ['--dangerously-skip-permissions'] : []), prompt];
  // herdr enforces GLOBALLY-UNIQUE agent instance names. The `<name>` positional
  // of `agent start <name>` is the instance name, NOT the agent type — the type
  // (claude/codex/…) is auto-detected from the running process. So naming every
  // unit's agent "claude" made the first unit claim the name and every later
  // `agent start claude` die with `agent_name_taken`, launching nothing and
  // grading empty worktrees. Name each agent by its unit key (already unique).
  return {
    name: 'herdr', bin,
    plan(spec, u) {
      const b = branch(spec, u);
      const cargv = claudeArgv(unitPrompt(spec, u)).map(shq).join(' ');
      return [
        `${shq(bin)} worktree create --cwd ${shq(spec.root)} --branch ${shq(b)} --label ${shq(b)} --no-focus --json`,
        `${shq(bin)} agent start ${shq(b)} --workspace <WS> --cwd <WT_PATH> --no-focus --env PATH="$PATH" -- ${cargv}`,
      ];
    },
    dispatch(spec, u) {
      const b = branch(spec, u);
      const wt = envJson(bin, ['worktree', 'create', '--cwd', spec.root, '--branch', b, '--label', b, '--no-focus', '--json']);
      const ws = wt.workspace?.workspace_id || wt.worktree?.open_workspace_id || null;
      const wpath = wt.worktree?.path || wt.workspace?.worktree?.checkout_path || null;
      let handle = null;
      if (ws && wpath) {
        try {
          const ag = envJson(bin, ['agent', 'start', b, '--workspace', ws, '--cwd', wpath, '--no-focus', ...envPath, '--', ...claudeArgv(unitPrompt(spec, u))]);
          handle = ag.agent?.pane_id || null;
        } catch (e) { console.error(`  ${u.id}: herdr agent start failed — ${e.message}`); }
      }
      return { path: wpath, ws, handle };
    },
    waitIdle(handle, t) {
      if (!handle) return;
      // A freshly-spawned pane reports `unknown`/`idle` BEFORE the agent has
      // produced anything, so waiting on `idle` alone returns almost instantly
      // and the oracle then grades an empty worktree. Observed: dispatch at
      // T+0.0s, unit_result FAIL at T+1.0s, with the unit's file never written.
      //
      // So wait for the agent to actually START before waiting for it to stop.
      // `blocked` counts as started too — an agent sitting on a permission
      // prompt has clearly begun, and we want the idle wait (not a 1s false
      // FAIL) to be what governs it.
      const started = ['working', 'blocked'].some((st) => {
        try {
          execFileSync(bin, ['agent', 'wait', handle, '--status', st, '--timeout', String(Math.min(t, START_GRACE_MS))],
            { stdio: ['ignore', 'ignore', 'ignore'] });
          return true;
        } catch { return false; }
      });
      if (!started) {
        // Never observed running. Either it died on launch, or it finished
        // faster than we looked. Don't grade yet — the oracle is the authority,
        // but give the filesystem a beat so a fast unit isn't failed on a race.
        try { execFileSync(bin, ['agent', 'wait', handle, '--status', 'idle', '--timeout', String(Math.min(t, START_GRACE_MS))], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* fall through */ }
        return;
      }
      try { execFileSync(bin, ['agent', 'wait', handle, '--status', 'idle', '--timeout', String(t)], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* timed out/stale — verify anyway */ }
    },
    resolve(spec, u) {
      try {
        const r = envJson(bin, ['worktree', 'list', '--cwd', spec.root, '--json']);
        const b = branch(spec, u);
        const hit = (r.worktrees || []).find((w) => w.branch === b);
        return hit ? { path: hit.path, ws: hit.open_workspace_id } : null;
      } catch { return null; }
    },
    stamp(spec, u, info, status /* , pass */) {
      if (!info.ws) return;
      try { execFileSync(bin, ['workspace', 'rename', info.ws, `${branch(spec, u)} oracle:${status}`], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not live */ }
    },
  };
}

// A tiny synchronous sleep so the vscode backend can poll a sentinel file
// without turning the whole 5-method interface async.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch { /* SAB unavailable */ }
}

// The native VS Code backend needs NO compiled binary — it talks to the
// companion extension (vscode/) purely over the filesystem contract in
// VZT_VSCODE_DIR. dispatch: git worktree + queue a launch record; the extension
// opens a native integrated terminal running claude with the unit brief. waitIdle:
// poll for the Stop-hook idle sentinel. Same 5 methods as orca/herdr, so it drops
// straight into shipWatch()/verifyAndRecord() unchanged.
function vscodeBackend(/* args */) {
  const key = (spec, u) => `${spec.slug}-${u.id}`;
  const queueDir = path.join(VZT_VSCODE_DIR, 'queue');
  const stateDir = path.join(VZT_VSCODE_DIR, 'state');
  const promptDir = path.join(VZT_VSCODE_DIR, 'prompts');
  const wtRoot = path.join(VZT_VSCODE_DIR, 'worktrees');
  // `units/` is the PERSISTENT record the tree view reads. queue/ is transient
  // by design (the extension deletes each record to guarantee exactly-once
  // launch), so it cannot also be the source of truth for what a unit IS —
  // reload the window and the whole run would vanish from the UI.
  const unitDir = path.join(VZT_VSCODE_DIR, 'units');
  for (const d of [queueDir, stateDir, promptDir, wtRoot, unitDir]) fs.mkdirSync(d, { recursive: true });
  // Unit terminals run UNSUPERVISED, so their claude must skip permission prompts
  // or it boots and blocks forever on the first tool call (same lesson as herdr).
  // Opt out per-run with VZT_VSCODE_SKIP_PERMISSIONS=0.
  // Warn ONCE per run if the host is running a different build than is installed.
  // A stale host silently ignores every extension fix, and the symptom — units
  // that never start — looks identical to a code bug. Cheap to check, and it is
  // the difference between "reload the window" and an hour of bisecting.
  try {
    const host = JSON.parse(fs.readFileSync(path.join(VZT_VSCODE_DIR, 'host.json'), 'utf8'));
    const installed = JSON.parse(
      fs.readFileSync(path.join(PKG_ROOT, 'vscode', 'package.json'), 'utf8')
    ).version;
    if (host.version && installed && host.version !== installed) {
      console.error(`⚠️  VS Code extension host is running ${host.version} but ${installed} is installed.`);
      console.error('    Reload the window (Cmd+Shift+P → Developer: Reload Window) before trusting this run.');
    }
  } catch { /* no heartbeat yet, or not readable — not worth failing a run over */ }

  const skipPerms = process.env.VZT_VSCODE_SKIP_PERMISSIONS !== '0';
  // How long dispatch waits for the extension to consume a queue file before
  // concluding it isn't running and printing the manual fallback command.
  const DRAIN_GRACE_MS = Number(process.env.VZT_VSCODE_DRAIN_GRACE_MS || 8000);
  // The prompt is multi-line, so pass it via a file the shell cats — a raw
  // multi-line argv string would be mangled by the terminal's sendText.
  const claudeCmd = (promptFile) =>
    `claude ${skipPerms ? '--dangerously-skip-permissions ' : ''}"$(cat ${shq(promptFile)})"`;

  const ensureWorktree = (spec, u) => {
    const k = key(spec, u);
    const wtPath = path.join(wtRoot, k);
    if (fs.existsSync(path.join(wtPath, '.git'))) return wtPath; // reuse from a prior run
    try {
      execFileSync('git', ['-C', spec.root, 'worktree', 'add', '-b', k, wtPath, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      // Branch already exists (re-dispatch) — attach it instead of recreating.
      execFileSync('git', ['-C', spec.root, 'worktree', 'add', wtPath, k], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return wtPath;
  };

  return {
    name: 'vscode', bin: 'code',
    plan(spec, u) {
      const k = key(spec, u);
      const wtPath = path.join(wtRoot, k);
      const promptFile = path.join(promptDir, `${k}.txt`);
      return [
        `git -C ${shq(spec.root)} worktree add -b ${shq(k)} ${shq(wtPath)} HEAD`,
        `# then in a VS Code integrated terminal at ${shq(wtPath)}:  ${claudeCmd(promptFile)}`,
        `# (--mux vscode does both automatically via the companion extension)`,
      ];
    },
    dispatch(spec, u) {
      const k = key(spec, u);
      const wtPath = ensureWorktree(spec, u);
      // Clear EVERY sentinel from a prior run of this unit key, not just idle —
      // a stale `.started` would satisfy the start phase instantly and put us
      // right back to grading an empty worktree.
      for (const f of [`${k}.idle`, `${k}.status`, `${k}.started`, `${k}.blocked`]) {
        try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* none */ }
      }
      const promptFile = path.join(promptDir, `${k}.txt`);
      fs.writeFileSync(promptFile, unitPrompt(spec, u));
      const idleFile = path.join(stateDir, `${k}.idle`);
      const startedFile = path.join(stateDir, `${k}.started`);
      const blockedFile = path.join(stateDir, `${k}.blocked`);
      const cmd = claudeCmd(promptFile);
      const queueFile = path.join(queueDir, `${k}.json`);
      // `workspaceRoot` is what SCOPES this record to a window.
      //
      // The queue directory is global, but every open VS Code window runs its
      // own extension host and every one of them polls it. Observed 2026-07-29:
      // 2 windows, 3 hosts, all watching the same directory. Without a scope the
      // hosts race — the terminal opens in whichever window won, which may not
      // be the one you are working in and may be running a different build of
      // the extension. It also explains identical runs behaving differently.
      //
      // The host only claims a record whose workspaceRoot is one of its open
      // folders, so the unit lands in the window that actually has the project
      // open. If no window does, nobody claims it and the drain check below
      // reports exactly that.
      fs.writeFileSync(queueFile, JSON.stringify({
        unitKey: k,
        cwd: wtPath,
        workspaceRoot: spec.root,
        env: { VZT_VSCODE_MUX: '1', VZT_VSCODE_UNIT: k },
        cmd,
      }, null, 2));
      // Persistent twin for the tree view: survives the queue record's deletion
      // and a window reload, and carries the oracle so the tree can re-run it.
      fs.writeFileSync(
        path.join(unitDir, `${k}.json`),
        JSON.stringify(
          { unitKey: k, slug: spec.slug, id: u.id, title: u.title || u.id, cwd: wtPath, machineCheck: u.machineCheck || '', expect: u.expect || '', dispatchedAt: new Date().toISOString() },
          null,
          2
        )
      );
      // Wait briefly for the extension to consume the record (it deletes the file).
      let launched = false;
      const deadline = Date.now() + DRAIN_GRACE_MS;
      while (Date.now() < deadline) {
        if (!fs.existsSync(queueFile)) { launched = true; break; }
        sleepSync(200);
      }
      if (!launched) {
        console.error(`  ${u.id}: no VS Code window claimed this unit.`);
        console.error(`    A record is claimed only by a window that has ${spec.root} open —`);
        console.error('    check that such a window exists, that the extension is installed, and that');
        console.error("    the host has actually reloaded (vzt-agent doctor reports a stale one).");
        console.error(`  Manual fallback — open a terminal and run:\n    cd ${shq(wtPath)} && ${cmd}`);
        // Don't leave an unclaimable record behind. Before scoping, every record
        // was drained by someone; now one addressed to a window that is not open
        // would sit in the queue forever and get picked up by a LATER, unrelated
        // window — launching a stale unit long after its run ended.
        try { fs.unlinkSync(queueFile); } catch { /* already claimed after all */ }
      }
      return { path: wtPath, ws: k, handle: { idleFile, startedFile, blockedFile, unitKey: k, launched } };
    },
    // TWO-PHASE, mirroring herdrBackend().waitIdle — see that function's comment
    // for the original incident. Waiting on `.idle` ALONE cannot distinguish:
    //   (a) the agent is still working            -> keep waiting
    //   (b) the agent never launched at all       -> stop early, don't waste the budget
    // Observed live 2026-07-28: two identical units dispatched together; one
    // terminal swallowed its command (shell still initialising), never ran
    // claude, produced no `.idle`, and was graded FAIL against an empty worktree
    // only after the ENTIRE unit timeout expired. Phase 1 catches exactly that.
    waitIdle(handle, t) {
      if (!handle || !handle.idleFile) return;
      if (!handle.launched) {
        // The extension never drained the queue record, so no sentinel is coming.
        // Bounded wait; verify still runs against the worktree.
        const d = Date.now() + Math.min(t, 5000);
        while (Date.now() < d) { if (fs.existsSync(handle.idleFile)) return; sleepSync(500); }
        return;
      }

      // Phase 1 — wait for evidence the agent actually STARTED. `blocked` counts
      // as started (it is sitting on a prompt, which is a live agent), and so
      // does `idle` itself for a unit that finished faster than we looked.
      const startGrace = Number(process.env.VZT_START_GRACE_MS || 90_000);
      const startDeadline = Date.now() + Math.min(t, startGrace);
      let started = false;
      while (Date.now() < startDeadline) {
        if (fs.existsSync(handle.startedFile) || fs.existsSync(handle.blockedFile)) { started = true; break; }
        if (fs.existsSync(handle.idleFile)) return; // finished already
        sleepSync(500);
      }
      if (!started) {
        // Never observed running inside the grace window. Don't spend the rest of
        // the unit budget waiting on a sentinel that is not coming — the oracle
        // is still the authority and will run against the worktree.
        console.error(`  ${handle.unitKey}: no start signal within ${Math.round(Math.min(t, startGrace) / 1000)}s — terminal likely never ran its command; verifying anyway`);
        return;
      }

      // Phase 2 — it is alive; now the full unit budget governs.
      const deadline = Date.now() + t;
      while (Date.now() < deadline) {
        if (fs.existsSync(handle.idleFile)) return;
        sleepSync(1000);
      }
    },
    resolve(spec, u) {
      const k = key(spec, u);
      try {
        const out = execFileSync('git', ['-C', spec.root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
        let curPath = null;
        for (const line of out.split('\n')) {
          if (line.startsWith('worktree ')) curPath = line.slice(9).trim();
          else if (line.startsWith('branch ')) {
            const b = line.slice(7).trim().replace(/^refs\/heads\//, '');
            if (b === k && curPath) return { path: curPath, ws: k };
          }
        }
      } catch { /* not a git repo / no worktrees */ }
      const wtPath = path.join(wtRoot, k);
      return fs.existsSync(path.join(wtPath, '.git')) ? { path: wtPath, ws: k } : null;
    },
    stamp(spec, u, info, status /*, pass */) {
      try { fs.writeFileSync(path.join(stateDir, `${key(spec, u)}.status`), status); } catch { /* best-effort */ }
    },
  };
}

function getBackend(args) {
  const explicit = args.mux || process.env.VZT_MUX;
  const name = (explicit || 'orca').toLowerCase();
  // Orca is the historical default AND the least hardened backend: alone among
  // the three it has no start-grace phase in waitIdle and cannot pass
  // skip-permissions to its agent (see orcaBackend). Falling into it silently,
  // because neither --mux nor VZT_MUX was set, is how someone ends up debugging
  // "the oracle graded an empty worktree" without knowing which substrate they
  // were on. Say it out loud; do not change the default under them.
  if (!explicit) {
    console.error('note: no --mux and no VZT_MUX — defaulting to orca, the least-hardened backend.');
    console.error('      prefer `--mux herdr` or `--mux vscode`, or export VZT_MUX, unless you mean orca.');
  }
  if (name === 'herdr') return herdrBackend(args);
  if (name === 'orca') return orcaBackend(args);
  if (name === 'vscode') return vscodeBackend(args);
  console.error(`unknown --mux "${name}" (use: orca | herdr | vscode)`);
  process.exit(2);
}

function shipDispatch(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to dispatch: SPEC does not pass ship-check. Run `vzt-agent ship-check` first.');
    process.exit(1);
  }
  const be = getBackend(args);
  const phases = [];
  if (spec.barrier) phases.push({ label: 'PHASE 1 — barrier (run FIRST, alone; its oracle grades every unit)', units: [spec.barrier] });
  phases.push({ label: `PHASE ${spec.barrier ? 2 : 1} — units (parallel; pairwise-disjoint scopes)`, units: spec.units });

  console.log(`# ship-dispatch: ${spec.slug} — ${spec.title}`);
  console.log(`# root: ${spec.root}`);
  console.log(`# ${args.execute ? 'EXECUTING via' : 'DRY RUN (add --execute to run) via'} ${be.name} (${be.bin})`);
  if (spec.barrier) console.log('# NOTE: wait for the barrier oracle to pass before dispatching the units.');

  for (const phase of phases) {
    console.log(`\n## ${phase.label}`);
    for (const u of phase.units) {
      if (args.execute) {
        console.log(`\n→ dispatching ${u.id} …`);
        try {
          const info = be.dispatch(spec, u);
          console.log(`  ${u.id} → ${info.path || '(worktree)'}${info.handle ? '' : '  (no agent handle — will resolve on verify)'}`);
        } catch (e) {
          console.error(`❌ ${u.id}: ${be.name} dispatch failed — ${e.message}`);
        }
      } else {
        console.log(`\n# ${u.id}: verified by  ${u.machineCheck}`);
        for (const line of be.plan(spec, u)) console.log(line);
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
 * verdict to the SHARED ledger, and stamp the mux card/workspace. Shared by
 * ship-supervise (batch) and ship-watch (as each worker finishes). `info` ({path,ws})
 * may be pre-resolved by the caller (dispatch result); otherwise it's looked up.
 * Returns true on PASS. Falls back to the primary checkout when the mux isn't live.
 */
/**
 * Where Claude Code keeps its transcript for work done in `dir`.
 *
 * This is the backend-agnostic answer to Orca's `terminal read`. Orca can stream
 * a running agent's output; herdr and vscode cannot, and the vscode extension
 * API gives no read access to terminal contents at all — which is why a failing
 * unit used to be a dead end (the whole diagnosis had to be reconstructed by
 * redirecting unit output to files by hand).
 *
 * The transcript is strictly better than scrollback anyway: it survives the
 * terminal closing, and its absence is itself the diagnosis — no directory means
 * the agent never started, which is the single most common unit failure.
 *
 * Naming rule derived from real directories on disk: `/` and `.` both become `-`.
 */
function agentTranscriptDir(dir) {
  if (!dir) return null;
  const slug = dir.replace(/[/.]/g, '-');
  const p = path.join(os.homedir(), '.claude', 'projects', slug);
  return fs.existsSync(p) ? p : null;
}

function verifyAndRecord(be, spec, u, specPath, info, via) {
  const ref = info && info.path ? info : be.resolve(spec, u);
  const wt = ref && ref.path;
  const r = runOracle(u.machineCheck, wt || spec.root);
  const status = r.pass ? 'PASS' : 'FAIL';
  console.log(`  ${u.id} … ${status}${wt ? '' : '  (no live worktree — ran against primary)'}`);

  // On failure, say WHY. A bare "FAIL" forces the operator to reconstruct the
  // run from scratch; everything below is already in hand at this point.
  if (!r.pass) {
    if (r.output) {
      console.log(`      oracle: ${u.machineCheck}`);
      for (const line of r.output.split('\n').slice(-6)) console.log(`      | ${line}`);
    }
    if (wt) console.log(`      worktree: ${wt}`);
    const transcript = agentTranscriptDir(wt);
    if (transcript) {
      console.log(`      agent transcript: ${transcript}`);
    } else if (wt) {
      // The loudest signal available: the agent produced no session at all.
      console.log('      agent transcript: none — the agent never started in this worktree');
    }
  }
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-note', specPath,
      JSON.stringify({ kind: 'unit_result', unit: u.id, status, via, mux: be.name, code: r.code })],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* best-effort */ }
  if (ref) { try { be.stamp(spec, u, ref, status, r.pass); } catch { /* not live */ } }
  return r.pass;
}

/**
 * Capture a unit worktree's ENTIRE divergence from HEAD as a patch — committed,
 * uncommitted, and untracked alike.
 *
 * `git diff HEAD` alone is not enough: a unit that creates a new file leaves it
 * UNTRACKED, and the smoke run proved that is the common case (agents write the
 * file, they do not necessarily commit it). Diffing by branch name is also out —
 * orca names worktrees rather than branches, so there is no branch to name.
 *
 * Uses a THROWAWAY index (GIT_INDEX_FILE) so staging everything here never
 * touches the unit's own index. Returns '' when the unit changed nothing.
 */
function captureWorktreePatch(wt) {
  const idx = path.join(os.tmpdir(), `vzt-idx-${process.pid}-${Math.abs(hashString(wt))}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    execFileSync('git', ['-C', wt, 'read-tree', 'HEAD'], { env, stdio: 'ignore' });
    execFileSync('git', ['-C', wt, 'add', '-A'], { env, stdio: 'ignore' });
    const tree = execFileSync('git', ['-C', wt, 'write-tree'], { env, encoding: 'utf8' }).trim();
    return execFileSync('git', ['-C', wt, 'diff', 'HEAD', tree, '--binary'], {
      env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    try { fs.unlinkSync(idx); } catch { /* never existed */ }
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Run the integration check against HEAD + every passed unit's work combined.
 *
 * It used to run against `spec.root` — the PRIMARY checkout, which by
 * construction contains NONE of the unit work (every unit lives in its own
 * worktree). So it printed "units verified and integrated" after testing a tree
 * with zero unit changes in it. That PASS was vacuous, and it was the last gate
 * before a human was told the run was ready to merge.
 *
 * Because ship-check enforces pairwise-disjoint FILES_IN_SCOPE, the unit patches
 * cannot conflict with each other unless a unit wrote outside its declared
 * scope — so a failed `git apply` is itself a real finding, not noise.
 *
 * @returns {{ok: boolean, status: string, output?: string}}
 */
function runIntegrationGate(spec, be, units) {
  const check = spec.integration && spec.integration.machineCheck;
  if (!check) { console.log('\nintegration gate: (none declared)'); return { ok: true, status: 'NONE' }; }
  process.stdout.write('\nintegration gate … ');

  const tmp = path.join(os.tmpdir(), `vzt-integration-${spec.slug}-${process.pid}`);
  const cleanup = () => {
    try { execFileSync('git', ['-C', spec.root, 'worktree', 'remove', '--force', tmp], { stdio: 'ignore' }); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ }
  };

  try {
    execFileSync('git', ['-C', spec.root, 'worktree', 'add', '--detach', tmp, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.log('SKIPPED ⚠️');
    console.log(`    could not create an integration worktree: ${e.message.trim().split('\n')[0]}`);
    console.log('    (the gate is only meaningful against merged unit work — not falling back to the primary checkout)');
    return { ok: false, status: 'NO_WORKTREE' };
  }

  try {
    const applied = [];
    for (const u of units) {
      const ref = be.resolve(spec, u);
      if (!ref || !ref.path || !fs.existsSync(ref.path)) continue;
      let patch = '';
      try { patch = captureWorktreePatch(ref.path); } catch { /* unreadable worktree */ }
      if (!patch.trim()) continue;
      try {
        execFileSync('git', ['-C', tmp, 'apply', '--index', '--whitespace=nowarn'], { input: patch, stdio: ['pipe', 'ignore', 'pipe'] });
        applied.push(u.id);
      } catch (e) {
        console.log('MERGE_CONFLICT ❌');
        console.log(`    ${u.id}'s changes do not apply on top of ${applied.join(' + ') || 'HEAD'}.`);
        console.log('    Units have disjoint file scopes, so this means a unit wrote OUTSIDE its declared scope.');
        const detail = `${e.stderr || ''}`.trim();
        if (detail) console.log(detail.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n'));
        return { ok: false, status: 'MERGE_CONFLICT', output: detail.slice(-500) };
      }
    }

    const r = runOracle(check, tmp);
    console.log(r.pass ? `PASS ✅ — ${applied.length} unit(s) merged and verified together; ready for your review + merge.` : 'FAIL ❌');
    if (!r.pass && r.output) console.log(r.output.split('\n').map((l) => `    ${l}`).join('\n'));
    return { ok: r.pass, status: r.pass ? 'PASS' : 'FAIL', output: r.output };
  } finally {
    cleanup();
  }
}

function shipSupervise(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to supervise: SPEC does not pass ship-check.');
    process.exit(1);
  }
  const be = getBackend(args);
  const units = [spec.barrier, ...spec.units].filter(Boolean);
  let passed = 0;
  for (const u of units) if (verifyAndRecord(be, spec, u, specPath, null, 'ship-supervise')) passed++;
  console.log(`\n${passed}/${units.length} unit oracle(s) PASS. Verdicts appended to the shared LEDGER.`);
  console.log(`next: run the integration gate → ${spec.integration && spec.integration.machineCheck ? spec.integration.machineCheck : '(none declared)'}`);
  if (passed < units.length) process.exitCode = 1;
}

// ——— /vzt-ship: ship-watch — ONE command, kick once and walk away ————————————
//
// The full automatic loop on either mux: dispatch every unit as a claude worktree
// pane, wait for each to finish (agent idle), auto-run its oracle + stamp its card +
// record the ledger the instant it's done, then run the integration gate. The barrier
// (if any) runs FIRST and gates the units. Stops at the green gate with a "ready to
// review + merge" verdict — it never auto-merges (verify-before-accept stays human).

function shipWatch(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to watch: SPEC does not pass ship-check. Run `vzt-agent ship-check` first.');
    process.exit(1);
  }
  const be = getBackend(args);
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 30 * 60 * 1000;
  console.log(`ship-watch [${be.name}]: ${spec.slug} — dispatch → wait → verify → integration gate (timeout ${Math.round(timeoutMs / 60000)}m/unit)`);

  // Open the ledger.
  try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-start', specPath], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}

  // Append one ledger line. Every terminal path below MUST go through this —
  // a run that never records `run_complete`/`aborted` stays `active` forever in
  // reduceLedger, and the router hook then re-injects a stale "[VZT-SHIP] ACTIVE
  // RUN" block into every prompt in that repo, with no TTL to ever clear it.
  const note = (obj) => {
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-note', specPath, JSON.stringify(obj)],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { /* best-effort: never let bookkeeping kill a run */ }
  };

  const dispatch = (u) => {
    // ship-dispatch guards this; ship-watch did not — so a worktree/branch
    // collision on a re-run threw straight out of the loop and killed the whole
    // run mid-flight, after the barrier had already been paid for, with nothing
    // recorded in the ledger at all.
    try {
      const info = be.dispatch(spec, u);
      console.log(`  dispatched ${u.id} → ${info.path || '(worktree)'}${info.handle ? '' : '  (no agent handle — will resolve on verify)'}`);
      return { u, info };
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).trim().split('\n')[0];
      console.error(`  ${u.id}: DISPATCH FAILED — ${msg}`);
      note({ kind: 'unit_result', unit: u.id, status: 'FAIL', via: 'ship-watch', mux: be.name, code: -1, output: `dispatch failed: ${msg}` });
      return { u, info: null, dispatchFailed: true };
    }
  };

  // Phase 1 — barrier gates everything.
  if (spec.barrier) {
    console.log('\n## barrier (runs first; its oracle grades every unit)');
    const b = dispatch(spec.barrier);
    let barrierOk = false;
    if (!b.dispatchFailed) {
      be.waitIdle(b.info.handle, timeoutMs);
      barrierOk = verifyAndRecord(be, spec, spec.barrier, specPath, b.info, 'ship-watch');
    }
    if (!barrierOk) {
      console.error('\n❌ barrier FAILED — aborting before dispatching units. Fix the barrier worktree, then re-run.');
      note({ kind: 'aborted', reason: b.dispatchFailed ? 'barrier dispatch failed' : 'barrier oracle failed' });
      process.exit(1);
    }
  }

  // Phase 2 — units in parallel; verify each as it idles.
  console.log('\n## units (parallel)');
  const workers = spec.units.map(dispatch);
  console.log('\n## verifying as each finishes …');
  let passed = 0;
  const passedUnits = [];
  for (const w of workers) {
    if (w.dispatchFailed) continue; // already recorded FAIL; nothing to wait on
    be.waitIdle(w.info.handle, timeoutMs); // by the time earlier ones idle, later ones often already have
    if (verifyAndRecord(be, spec, w.u, specPath, w.info, 'ship-watch')) {
      passed++;
      passedUnits.push(w.u);
    }
  }

  console.log(`\n${passed}/${workers.length} unit oracle(s) PASS.`);

  let integration = { ok: false, status: 'SKIPPED' };
  if (passed === workers.length) {
    integration = runIntegrationGate(spec, be, [spec.barrier, ...passedUnits].filter(Boolean));
  } else {
    console.log('\nintegration gate skipped — not all units passed.');
  }
  note({ kind: 'integration', status: integration.status, output: integration.output || null });

  // The falsification record for `vzt-agent stats`. This used to depend on the
  // chair hand-typing a printf from the skill doc, so in practice it was never
  // written and the /vzt-ship kill-switch had no data to fire on. `corrections`
  // is honestly 0 here: the supervised path dispatches once and verifies once —
  // it has no repair loop (that lives in the headless workflow path).
  note({
    kind: 'ship',
    units: workers.length + (spec.barrier ? 1 : 0),
    passed: passed + (spec.barrier ? 1 : 0),
    blocked: workers.length - passed,
    corrections: 0,
  });

  note({ kind: 'run_complete', integration: integration.status });
  if (!integration.ok) process.exitCode = 1;
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

Supervision layer — parallel /vzt-ship runs in an agent multiplexer [--mux orca|herdr|vscode]:
  vzt-agent ship-watch <SPEC.md> [--mux orca|herdr|vscode] [--timeout-ms <n>]
                                          KICK ONCE, WALK AWAY: dispatch every unit → wait
                                          for each to finish → auto-verify + stamp + ledger →
                                          integration gate. Stops at "ready to review + merge".
  vzt-agent ship-dispatch <SPEC.md> [--mux orca|herdr|vscode] [--execute]
                                          one worktree+claude per unit (dry-run prints commands)
  vzt-agent ship-supervise <SPEC.md> [--mux orca|herdr|vscode]
                                          run each unit's MACHINE_CHECK in its worktree,
                                          record PASS/FAIL to the shared ledger + mux card
  (default mux is orca; --mux herdr uses the herdr multiplexer; --mux vscode opens each
   unit as a native VS Code integrated terminal — needs the companion extension in vscode/)
`);
}
