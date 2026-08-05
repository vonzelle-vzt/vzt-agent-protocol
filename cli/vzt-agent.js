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
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateSpec, planWaves, depsOf, pathInScope, reduceLedger, nextAction, unitLine } from './ship-lib.mjs';

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
    else if (a === '--max-concurrent') args.maxConcurrent = argv[++i];
    // This list is a WHITELIST: anything not named here lands in `_` as a
    // positional and is silently ignored. A flag added to the help text but not
    // to this switch reads as "supported" and does nothing at all.
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
  // Derived, never restated. This line hardcoded its ten skill names, so adding
  // an eleventh (herdr-extensions) would have installed it while reporting it
  // did not — the same drift that let AGENT_TYPES omit two agents and the README
  // claim "Seven agents" while listing eight. Parse the source of truth.
  const skillNames = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR).sort() : [];
  console.log(`  skills:   ${skills.length} files installed (${skillNames.map((s) => `/${s}`).join(' ')})`);
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
  // Things worth SAYING that are not things worth FAILING on: transient state a
  // reinstall cannot fix. Kept separate so the exit code stays a statement about
  // the installation itself.
  const warnings = [];
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

  // INSTALLED ≠ CURRENT, and every check above only proves the file EXISTS.
  //
  // 🔴 The failure this catches, from the 1.17.0 release itself. `dependsOn` was
  // added to templates/spec.md in the repo — but the chair writes specs from the
  // INSTALLED copy at .claude/templates/spec.md. Anyone who had installed an
  // earlier version kept a template with no `dependsOn` in it, so no spec would
  // ever declare a dependency, and the entire task DAG would sit there as code
  // nothing could reach. Doctor reported all-green throughout, because the file
  // was present — just old.
  //
  // Same shape as the v1.4.0 bug one level down: doctrine pointing at an
  // artifact that exists but no longer says what the doctrine assumes.
  const stale = [];
  for (const [srcDir, destSub, filter] of [
    [TEMPLATES_DIR, 'templates', (f) => f.endsWith('.md')],
    [AGENT_FILES_DIR, 'agents', (f) => f.endsWith('.md')],
    [WORKFLOWS_DIR, 'workflows', (f) => f.endsWith('.js')],
    [DOCS_DIR, 'docs', (f) => f.endsWith('.md')],
  ]) {
    if (!fs.existsSync(srcDir)) continue;
    for (const f of fs.readdirSync(srcDir).filter(filter)) {
      const dest = path.join(dotClaude, destSub, f);
      if (!fs.existsSync(dest)) continue; // absence is the "installed" check's job
      try {
        if (fs.readFileSync(path.join(srcDir, f), 'utf8') !== fs.readFileSync(dest, 'utf8')) stale.push(`${destSub}/${f}`);
      } catch { /* unreadable — not worth failing a doctor run over */ }
    }
  }
  checks.push([
    stale.length ? `installed copies are STALE (${stale.slice(0, 4).join(', ')}${stale.length > 4 ? `, +${stale.length - 4} more` : ''}) — re-run: vzt-agent install` : 'installed copies match this version',
    stale.length === 0,
  ]);

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
      if (running === want) {
        checks.push([`vscode extension host running ${running}`, true]);
      } else {
        // ADVISORY, not a failed check. Everything else doctor grades is fixed by
        // `vzt-agent install`; this one is fixed only by reloading an editor
        // window, and it clears itself the moment you do. Failing the run on it
        // made `doctor` report the developer's live editor state — so a bumped
        // extension version turned the test suite red on a machine where nothing
        // was actually wrong, and "Some checks failed — run: vzt-agent install"
        // pointed at a command that cannot fix it.
        warnings.push(`vscode extension host is running ${running}, but ${want} is installed — RELOAD THE WINDOW (Cmd+Shift+P → Developer: Reload Window) before trusting a --mux vscode run.`);
      }
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
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
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
  else console.log(`${file} not found — run \`vzt-agent install\``);
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

function unitPrompt(spec, u, extras = {}) {
  const files = (u.filesInScope || []).map((f) => `    - ${f}`).join('\n');
  const seeded = extras.seeded && extras.seeded.length
    ? [
        `ALREADY IN THIS WORKTREE — the finished work of: ${extras.seeded.join(', ')}.`,
        'Those files are your dependencies\' output, not yours. READ them, build against',
        'them, and do NOT rewrite or "improve" them — they are outside FILES_IN_SCOPE and',
        'editing them is a scope breach that fails this unit.',
        '',
      ]
    : [];
  return [
    `[VZT ship unit ${u.id}] ${u.title || ''}`.trim(),
    '',
    `STEP 0 (run this FIRST, before anything else): \`sh ${BOOTSTRAP}\``,
    'It symlinks node_modules and .env* from the primary checkout into this worktree so',
    'your build and MACHINE_CHECK work. A fresh worktree has neither. Skip nothing.',
    '',
    u.brief,
    '',
    ...seeded,
    'FILES_IN_SCOPE — touch ONLY these; they are your collision boundary:',
    files,
    '',
    `This unit is DONE only when this command passes:  ${u.machineCheck}`,
    `Expected:  ${u.expect}`,
    '',
    'Work under VZT fable-mode discipline (scope → evidence → attack → verify → report).',
    'Do not edit, create, or delete any file outside FILES_IN_SCOPE. When finished, run the',
    'MACHINE_CHECK yourself and report its exact output.',
    ...(extras.drift ? ['', extras.drift] : []),
  ].join('\n');
}

/**
 * A unit's dependencies in TOPOLOGICAL order, expanded transitively, barrier first.
 *
 * Transitivity is not optional, and the reason is captureWorktreePatch(): it
 * diffs a worktree against its OWN HEAD. Once a dependent's worktree has its
 * seed committed, that worktree's patch contains only ITS work — the grandparent's
 * contribution has moved into HEAD and vanished from the patch. So seeding u3
 * from its direct dep u2 alone would silently hand u3 a tree with u2's work and
 * NONE of u1's. Expand the whole ancestry and apply each unit's own delta in
 * order, and the layers compose exactly once.
 */
function transitiveDeps(spec, u) {
  const byId = new Map((spec.units || []).map((x) => [x.id, x]));
  const ordered = [];
  const seen = new Set();
  const visit = (unit, trail) => {
    for (const id of depsOf(unit)) {
      if (trail.has(id)) continue; // cycle — validateSpec already refused this spec
      const dep = byId.get(id);
      if (!dep || seen.has(id)) continue;
      visit(dep, new Set([...trail, id]));
      if (!seen.has(id)) { seen.add(id); ordered.push(dep); }
    }
  };
  visit(u, new Set([u.id]));
  // The barrier is every unit's implicit first dependency: it holds the shared
  // contract, so it must be underneath everything else.
  return [spec.barrier, ...ordered].filter(Boolean);
}

/** Which dependency wave this unit runs in (1-based). 0 = the barrier / unknown. */
function waveOf(spec, u) {
  const waves = planWaves(spec);
  for (let i = 0; i < waves.length; i++) if (waves[i].some((x) => x.id === u.id)) return i + 1;
  return 0;
}

/**
 * Seed a unit's worktree with its dependencies' finished work, then commit it.
 *
 * 🔴 THE BUG THIS FIXES. Every worktree in this file is created from the primary
 * checkout's HEAD — barrier and units alike, on all three backends. Nothing ever
 * merged, rebased, or cherry-picked. So a unit briefed to "implement X against
 * the interface in types.ts" opened a tree where types.ts DID NOT EXIST, because
 * the barrier wrote it on a different branch in a different worktree. The unit
 * then either failed its own oracle or breached scope creating the missing file
 * itself. Only the integration gate ever saw the pieces together, at the very end.
 *
 * Seeding is a `git apply` of each dependency's patch, not a merge, because
 * agents routinely leave work UNCOMMITTED and a branch merge would miss it —
 * captureWorktreePatch() is the same primitive the integration gate already uses.
 *
 * The seed is COMMITTED for two reasons: it becomes the audit baseline (so
 * seeded files are not mistaken for this unit's own writes), and it keeps this
 * unit's own captured patch free of its dependencies' content, so the integration
 * gate applies each layer exactly once.
 *
 * Scopes are pairwise disjoint, so these applies cannot conflict — which makes a
 * conflict here a REAL finding (a dependency wrote outside its declared scope),
 * surfaced at dispatch instead of after the whole run has been paid for.
 *
 * @returns {{baseSha: string|null, seeded: string[]}}
 */
function seedFromDeps(be, spec, u, wtPath) {
  const seeded = [];
  for (const dep of transitiveDeps(spec, u)) {
    let ref = null;
    try { ref = be.resolve(spec, dep); } catch { /* not dispatched yet */ }
    if (!ref || !ref.path || !fs.existsSync(ref.path) || path.resolve(ref.path) === path.resolve(wtPath)) continue;
    let patch = '';
    try { patch = captureWorktreePatch(ref.path); } catch { /* unreadable worktree */ }
    if (!patch.trim()) continue;
    // Seeding must be IDEMPOTENT. ensureWorktree deliberately reuses a worktree
    // across re-dispatches, so a unit corrected and re-run would meet its own
    // seed commit and `git apply` would die with "already exists" — turning an
    // ordinary retry into a permanent dispatch failure. `--check --reverse`
    // succeeds exactly when the patch is already present.
    try {
      execFileSync('git', ['-C', wtPath, 'apply', '--check', '--reverse'], { input: patch, stdio: ['pipe', 'ignore', 'ignore'] });
      seeded.push(dep.id);
      continue; // already seeded by an earlier dispatch of this unit
    } catch { /* not applied yet — fall through and apply it */ }
    try {
      execFileSync('git', ['-C', wtPath, 'apply', '--index', '--whitespace=nowarn'], {
        input: patch, stdio: ['pipe', 'ignore', 'pipe'],
      });
      seeded.push(dep.id);
    } catch (e) {
      const detail = `${e.stderr || ''}`.trim().split('\n').slice(0, 4).join(' / ');
      const err = new Error(
        `seed conflict: ${dep.id}'s work does not apply into ${u.id}'s worktree — ` +
        `scopes are disjoint, so ${dep.id} wrote OUTSIDE its declared FILES_IN_SCOPE. ${detail}`
      );
      err.vztSeedConflict = true;
      throw err; // a corrupt base is worse than a missing one — never launch on it
    }
  }
  if (seeded.length) {
    try {
      execFileSync('git', ['-C', wtPath, 'commit', '--no-verify', '-qm', `vzt: seed ${u.id} from ${seeded.join(', ')}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'vzt-agent', GIT_AUTHOR_EMAIL: 'vzt@local', GIT_COMMITTER_NAME: 'vzt-agent', GIT_COMMITTER_EMAIL: 'vzt@local' },
      });
    } catch { /* nothing staged after all — the baseline below still resolves */ }
  }
  let baseSha = null;
  try { baseSha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a repo */ }
  return { baseSha, seeded };
}

/**
 * How far a REUSED worktree has fallen behind the primary checkout, as a prompt block.
 *
 * ensureWorktree deliberately reuses an existing worktree across re-dispatches,
 * which means a re-run silently works on whatever HEAD was current the first
 * time. The worker discovers that the hard way — stale line numbers, a helper
 * that "should exist" and doesn't. Orca surfaces the same thing to its workers
 * as a BASE DRIFT block; the point is that the drift is visible on line 1 rather
 * than inferred from confusing evidence an hour in.
 *
 * Returns null when there is no drift, so a fresh worktree emits nothing at all —
 * a section that fires every time is a section workers learn to skip.
 */
function baseDriftBlock(root, branch) {
  try {
    const behind = Number(
      execFileSync('git', ['-C', root, 'rev-list', '--count', `${branch}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    );
    if (!behind) return null;
    const subjects = execFileSync('git', ['-C', root, 'log', '--format=%s', '-5', `${branch}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').filter(Boolean).map((s) => `  - ${s}`).join('\n');
    return [
      '--- BASE DRIFT ---',
      `This worktree is ${behind} commit(s) behind the primary checkout's HEAD. The most`,
      'recent subjects on HEAD that are NOT in your worktree:',
      subjects,
      '',
      'If any look relevant to your task, pull them in (`git rebase HEAD@{upstream}` or',
      'equivalent) or say so in your report BEFORE starting. Do not silently build on a',
      'stale base.',
      '---',
    ].join('\n');
  } catch {
    return null; // no such branch / not a repo — drift is unknowable, not zero
  }
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

/** Terminal handle out of an `orca terminal create|split --json` result.
 *  Orca wraps the payload in a per-verb node (`result.split.handle`,
 *  `result.create.handle`), so SCAN rather than guessing one key: guessing wrong
 *  returns null, and a null handle makes waitIdle return instantly and grade a
 *  worktree the agent never touched. */
function paneHandle(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.handle) return res.handle;
  for (const k of ['split', 'create', 'terminal', 'startupTerminal', 'session']) {
    if (res[k] && res[k].handle) return res[k].handle;
  }
  for (const v of Object.values(res)) if (v && typeof v === 'object' && v.handle) return v.handle;
  return null;
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
  const claudeCmd = (spec, u, extras) =>
    `claude ${skipPerms ? '--dangerously-skip-permissions ' : ''}${shq(unitPrompt(spec, u, extras))}`;

  // PANES, NOT A TAB PER UNIT. `terminal create` opens a whole TAB, so a 9-unit
  // run buried the operator in 9 agent tabs (plus 9 fallback shells) with no way
  // to watch two agents at once — the entire point of running them in parallel.
  // Units after the first in a tab are SPLIT off that tab's first pane instead.
  //
  // The cap exists because agent TUIs degrade badly when squeezed: past
  // VZT_PANES_PER_TAB the next unit opens a fresh tab and becomes its anchor.
  const PANES_PER_TAB = Math.max(1, Number(process.env.VZT_PANES_PER_TAB || 3));
  let anchor = null;      // first pane of the current ship tab; every split hangs off it
  let panesInTab = 0;
  let plannedPanes = 0;   // dry-run only (plan()), never touched by a real dispatch
  const tabArgv = (spec, u, wtId, extras) => ['terminal', 'create',
    ...(wtId ? ['--worktree', wtId] : []),
    '--title', `ship/${spec.slug}`, '--command', claudeCmd(spec, u, extras), '--json'];
  // `terminal split` has NO --worktree flag: the new pane inherits the ANCHOR's
  // worktree, so the command must cd into this unit's checkout itself. Cost of
  // that, stated plainly: `orca terminal list` reports split panes under the
  // anchor's worktreePath. Nothing here reads it — resolve() goes through
  // `worktree list`, stamp() through `name:<ws>`, waitIdle() through the handle
  // — so grading is unaffected; only Orca's own label for the pane is.
  //
  // Direction alternates so a capped tab forms a grid rather than three slivers.
  // `--title` is not available on split, and `terminal rename` renames the whole
  // TAB, which would clobber every sibling — so units are attributed on stdout.
  const splitArgv = (spec, u, wpath, extras) => ['terminal', 'split',
    '--terminal', anchor,
    '--direction', panesInTab % 2 === 1 ? 'vertical' : 'horizontal',
    '--command', `cd ${shq(wpath)} && ${claudeCmd(spec, u, extras)}`, '--json'];
  const paneArgv = (spec, u, wtId, wpath, extras) =>
    (anchor && panesInTab < PANES_PER_TAB && wpath
      ? splitArgv(spec, u, wpath, extras)
      : tabArgv(spec, u, wtId, extras));
  const be = {
    name: 'orca', bin,
    // Dry-run. No pane exists yet, so the layout is SIMULATED with the same rule
    // dispatch uses — otherwise ship-dispatch would print a tab per unit and
    // misrepresent what the real run does.
    plan(spec, u) {
      const slot = plannedPanes % PANES_PER_TAB;   // 0 = first pane of a new tab
      plannedPanes += 1;
      const planned = slot === 0
        ? tabArgv(spec, u, '<WORKTREE_ID>')
        : ['terminal', 'split', '--terminal', '<FIRST_PANE_HANDLE>',
          '--direction', slot % 2 === 1 ? 'vertical' : 'horizontal',
          '--command', `cd '<WORKTREE_PATH>' && ${claudeCmd(spec, u)}`, '--json'];
      return [
        `${shq(bin)} ${createArgv(spec, u).map(shq).join(' ')}`,
        `${shq(bin)} ${planned.map(shq).join(' ')}`,
      ];
    },
    dispatch(spec, u) {
      const res = envJson(bin, createArgv(spec, u));
      const wt = res.worktree || res;
      const wpath = wt.path || (wt.id && String(wt.id).split('::')[1]) || null;
      // The worktree id is a two-part `<repo-id>::<path>` address; a bare repo id
      // is not a worktree id, so prefer the returned id verbatim.
      const wtId = wt.id || (wpath ? `path:${wpath}` : null);

      // Seed the worktree with this unit's dependencies BEFORE the agent starts.
      // Orca creates every worktree from the repo's base branch, so without this
      // a dependent opens a tree that does not contain what it was told to build
      // against. Throws on a seed conflict rather than launching on a bad base.
      const { baseSha, seeded } = wpath ? seedFromDeps(be, spec, u, wpath) : { baseSha: null, seeded: [] };

      // The agent handle comes from the pane we open, NEVER from the worktree.
      // A bare `worktree create` (no --agent) leaves a fallback SHELL as the
      // first terminal; waiting on that reports tui-idle immediately and grades
      // the unit before the agent has done anything. That shell is closed once
      // this unit has been graded — see shipWatch; closing it earlier would kill
      // the repo setup hook that runs in it, and `terminal wait --for` offers
      // only exit|tui-idle, neither of which a plain shell ever reports.
      const startupHandle = res.startupTerminal?.handle || null;
      const argv = paneArgv(spec, u, wtId, wpath, { seeded });
      let mode = argv[1]; // 'create' (new tab) | 'split' (pane in the current tab)
      let handle = null;
      try {
        const term = envJson(bin, argv);
        handle = paneHandle(term);
      } catch (e) {
        console.error(`  ${u.id}: orca terminal ${mode} failed — ${(e.message || '').trim().split('\n')[0]}`);
      }
      // A split is anchored on a pane that may be GONE — the operator closed it,
      // or its agent exited and Orca reaped it. Layout must never cost a unit its
      // agent, so fall back to the tab this replaced. Worst case is the old
      // behaviour, not a unit that silently launched nothing.
      if (!handle && mode === 'split') {
        console.error(`  ${u.id}: anchor pane unusable — opening a tab instead`);
        anchor = null; panesInTab = 0; mode = 'create';
        try {
          handle = paneHandle(envJson(bin, tabArgv(spec, u, wtId, { seeded })));
        } catch (e) {
          console.error(`  ${u.id}: orca terminal create failed — ${(e.message || '').trim().split('\n')[0]}`);
        }
      }
      if (handle) {
        if (mode === 'split') {
          panesInTab += 1;
        } else {
          anchor = handle;   // splits hang off the tab's FIRST pane, not a chain
          panesInTab = 1;
        }
        // split takes no --title and rename retitles the whole tab, so stdout is
        // the only place a pane can be attributed back to its unit.
        console.log(`  ${u.id} → ${mode === 'split' ? `pane ${panesInTab}/${PANES_PER_TAB}` : `tab ship/${spec.slug}`}  ${handle}`);
      }
      // A null handle means waitIdle has nothing to wait ON: it returns instantly
      // and the oracle grades a worktree the agent may not have touched yet.
      // herdr logs when `agent start` throws; orca said nothing at all.
      if (!handle) {
        console.error(`  ${u.id}: no orca agent terminal handle — cannot wait for idle, so the oracle may grade an unfinished worktree.`);
      }
      return { path: wpath, ws: key(spec, u), baseSha, seeded, handle, startupHandle };
    },
    // Best-effort tidy of the fallback shell `worktree create` left behind. Only
    // safe once the unit has been GRADED: the repo setup hook runs in that shell,
    // and there is no CLI signal for "setup finished". Never throws — a stray tab
    // costs one command, a failed run costs the work.
    closeStartup(startupHandle) {
      if (!startupHandle) return;
      try {
        execFileSync(bin, ['terminal', 'close', '--terminal', startupHandle, '--tab', '--json'],
          { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch { /* already gone, or Orca not live */ }
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
  return be;
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
  // herdr 0.7.5: `agent start <NAME> --kind <KIND> --pane <ID> [-- AGENT_ARG...]`.
  // The KIND supplies the executable, so the args after `--` are claude's FLAGS
  // only — passing `claude` again would run `claude claude <prompt>`.
  //
  // 🔴 This shape is a BREAKING CHANGE from the one this backend used to send
  // (`--workspace <ws> --cwd <path> --no-focus --env … -- claude …`), and herdr
  // rejects the old one with a bare `unknown option: --workspace`. Every unit
  // therefore created its worktree, started NOTHING, and was graded on an empty
  // tree — silently, because the throw was swallowed into a one-line warning.
  // `agent wait` drifted the same way: `--status` became `--until`.
  const agentArgs = (prompt) => [...(skipPerms ? ['--dangerously-skip-permissions'] : []), prompt];
  // PANES, NOT A WORKSPACE PER UNIT. `worktree create` opens a workspace holding
  // one pane, so a 9-unit run produced 9 separate surfaces and the operator could
  // never watch two units at once. Units after the first are SPLIT into the first
  // unit's workspace instead — `pane split --cwd` puts the new pane in the right
  // checkout with no cd, and the now-empty per-unit workspace is closed.
  // Shares VZT_PANES_PER_TAB with the orca backend: one knob for "how many agents
  // share a surface", because agent TUIs degrade badly when squeezed.
  const PANES_PER_WS = Math.max(1, Number(process.env.VZT_PANES_PER_TAB || 3));
  // A freshly split pane is NOT yet at its shell prompt, and herdr answers
  // `agent_pane_busy` — which reads as "pane in use" rather than "not ready yet".
  // Retry against a deadline: shell startup time depends on the user's rc files,
  // so a slept constant is a guess that fails on someone else's machine.
  const PANE_READY_MS = Number(process.env.VZT_HERDR_PANE_READY_MS || 30_000);
  let anchor = null;      // first agent pane; every split hangs off it
  let panesInWs = 0;
  const paneId = (r) => r?.pane?.pane_id || r?.agent?.pane_id || r?.root_pane?.pane_id || null;
  const quietly = (argv) => {
    try { execFileSync(bin, argv, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
  };
  // herdr enforces GLOBALLY-UNIQUE agent instance names. The `<name>` positional
  // of `agent start <name>` is the instance name, NOT the agent type. So naming
  // every unit's agent "claude" made the first unit claim the name and every later
  // start die with `agent_name_taken`, launching nothing and grading empty
  // worktrees. Name each agent by its unit key, and salt a RE-RUN of the same unit
  // (whose previous agent may still hold the name) rather than launching nothing.
  const startAgent = (name, pane, prompt) => {
    const deadline = Date.now() + PANE_READY_MS;
    for (let attempt = 0; ; attempt += 1) {
      const instance = attempt === 0 ? name : `${name}-${attempt}`;
      try {
        return paneId(envJson(bin, ['agent', 'start', instance, '--kind', 'claude', '--pane', pane,
          '--timeout', String(PANE_READY_MS), '--', ...agentArgs(prompt)]));
      } catch (e) {
        const msg = (e.message || '').trim();
        if (/agent_name_taken/.test(msg) && attempt < 3) continue;      // stale name from a re-run
        if (/busy|not ready|agent_pane_busy/i.test(msg) && Date.now() < deadline) { sleepSync(1000); continue; }
        throw e;
      }
    }
  };
  const be = {
    name: 'herdr', bin,
    plan(spec, u) {
      const b = branch(spec, u);
      const aargv = agentArgs(unitPrompt(spec, u)).map(shq).join(' ');
      return [
        `${shq(bin)} worktree create --cwd ${shq(spec.root)} --branch ${shq(b)} --label ${shq(b)} --no-focus --json`,
        `${shq(bin)} pane split --pane <ANCHOR_PANE> --direction down --cwd <WT_PATH> --env PATH="$PATH" --no-focus`,
        `${shq(bin)} agent start ${shq(b)} --kind claude --pane <PANE> -- ${aargv}`,
      ];
    },
    dispatch(spec, u) {
      const b = branch(spec, u);
      const wt = envJson(bin, ['worktree', 'create', '--cwd', spec.root, '--branch', b, '--label', b, '--no-focus', '--json']);
      const ws = wt.workspace?.workspace_id || wt.worktree?.open_workspace_id || null;
      const wpath = wt.worktree?.path || wt.root_pane?.cwd || wt.workspace?.worktree?.checkout_path || null;
      // Seed dependencies into the worktree BEFORE the agent boots. herdr creates
      // the branch from the repo's current HEAD, so a dependent would otherwise
      // open a tree missing everything it was told to build against.
      const { baseSha, seeded } = wpath ? seedFromDeps(be, spec, u, wpath) : { baseSha: null, seeded: [] };

      // Where the agent will live: a split of the shared ship workspace when one
      // is open, otherwise this unit's own root pane (which then becomes the
      // anchor every later unit splits off).
      let pane = null;
      let paneWs = ws;
      if (anchor && panesInWs < PANES_PER_WS && wpath) {
        try {
          pane = paneId(envJson(bin, ['pane', 'split', '--pane', anchor, '--direction',
            panesInWs % 2 === 1 ? 'down' : 'right', '--cwd', wpath, ...envPath, '--no-focus']));
        } catch (e) { console.error(`  ${u.id}: herdr pane split failed — ${(e.message || '').trim().split('\n')[0]}`); }
        if (pane) {
          panesInWs += 1;
          paneWs = null;              // the agent lives in the SHARED workspace now
          if (ws) quietly(['workspace', 'close', ws]);   // this unit's own surface is empty
        }
      }
      if (!pane) {
        pane = wt.root_pane?.pane_id || null;
        if (pane) { anchor = pane; panesInWs = 1; }
      }

      let handle = null;
      if (pane) {
        try {
          handle = startAgent(b, pane, unitPrompt(spec, u, { seeded }));
        } catch (e) { console.error(`  ${u.id}: herdr agent start failed — ${(e.message || '').trim().split('\n')[0]}`); }
      } else {
        console.error(`  ${u.id}: herdr gave no pane to start in — the unit will be graded on an untouched worktree.`);
      }
      if (handle) {
        // `pane rename` labels THIS unit's pane. Renaming the workspace would
        // clobber every sibling sharing it — the same trap as retitling a tab.
        quietly(['pane', 'rename', handle, b]);
        console.log(`  ${u.id} → ${paneWs ? 'workspace' : `pane ${panesInWs}/${PANES_PER_WS}`}  ${handle}`);
      }
      return { path: wpath, ws, baseSha, seeded, handle, paneWs };
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
      //
      // The flag is `--until`, NOT `--status`: herdr rejects the latter outright,
      // and because every wait here is wrapped in a catch, the rejection made
      // waitIdle return in milliseconds — so the oracle graded each worktree the
      // instant it was created. A silent no-op wait is worse than no wait at all.
      const started = ['working', 'blocked'].some((st) =>
        quietly(['agent', 'wait', handle, '--until', st, '--timeout', String(Math.min(t, START_GRACE_MS))]));
      if (!started) {
        // Never observed running. Either it died on launch, or it finished
        // faster than we looked. Don't grade yet — the oracle is the authority,
        // but give the filesystem a beat so a fast unit isn't failed on a race.
        quietly(['agent', 'wait', handle, '--until', 'idle', '--timeout', String(Math.min(t, START_GRACE_MS))]);
        return;
      }
      quietly(['agent', 'wait', handle, '--until', 'idle', '--timeout', String(t)]);
    },
    resolve(spec, u) {
      try {
        const r = envJson(bin, ['worktree', 'list', '--cwd', spec.root, '--json']);
        const b = branch(spec, u);
        const hit = (r.worktrees || []).find((w) => w.branch === b);
        return hit ? { path: hit.path, ws: hit.open_workspace_id } : null;
      } catch { return null; }
    },
    // The verdict goes on whatever surface this unit actually OWNS. A unit that
    // shares the ship workspace owns only its pane; renaming the workspace there
    // would overwrite the label of every sibling in it.
    stamp(spec, u, info, status /* , pass */) {
      const label = `${branch(spec, u)} oracle:${status}`;
      if (info.handle && !info.paneWs) { quietly(['pane', 'rename', info.handle, label]); return; }
      const ws = info.paneWs || info.ws;
      if (ws) quietly(['workspace', 'rename', ws, label]);
    },
  };
  return be;
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
    // `fresh` decides whether a BASE DRIFT block is worth emitting: a worktree
    // created just now is by definition at HEAD, and a drift section that fires
    // on every unit is one workers stop reading.
    if (fs.existsSync(path.join(wtPath, '.git'))) return { path: wtPath, fresh: false }; // reuse from a prior run
    try {
      execFileSync('git', ['-C', spec.root, 'worktree', 'add', '-b', k, wtPath, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      // Branch already exists (re-dispatch) — attach it instead of recreating.
      execFileSync('git', ['-C', spec.root, 'worktree', 'add', wtPath, k], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return { path: wtPath, fresh: true };
  };

  const be = {
    name: 'vscode', bin: 'code',
    plan(spec, u) {
      const k = key(spec, u);
      const wtPath = path.join(wtRoot, k);
      const promptFile = path.join(promptDir, `${k}.txt`);
      const deps = transitiveDeps(spec, u).map((d) => d.id);
      return [
        ...(deps.length ? [`# seeded from: ${deps.join(', ')} (their patches applied + committed first)`] : []),
        `git -C ${shq(spec.root)} worktree add -b ${shq(k)} ${shq(wtPath)} HEAD`,
        `# then in a VS Code integrated terminal at ${shq(wtPath)}:  ${claudeCmd(promptFile)}`,
        `# (--mux vscode does both automatically via the companion extension)`,
      ];
    },
    dispatch(spec, u) {
      const k = key(spec, u);
      const { path: wtPath, fresh } = ensureWorktree(spec, u);
      // Seed BEFORE the agent launches. A dependent that opens a tree missing its
      // dependencies' output has already lost — it will either fail its oracle or
      // breach scope rebuilding what it cannot see. Throws on a seed conflict,
      // which shipWatch records as a dispatch failure with the reason.
      const { baseSha, seeded } = seedFromDeps(be, spec, u, wtPath);
      // Clear EVERY sentinel from a prior run of this unit key, not just idle —
      // a stale `.started` would satisfy the start phase instantly and put us
      // right back to grading an empty worktree.
      for (const f of [`${k}.idle`, `${k}.status`, `${k}.started`, `${k}.blocked`]) {
        try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* none */ }
      }
      const promptFile = path.join(promptDir, `${k}.txt`);
      fs.writeFileSync(promptFile, unitPrompt(spec, u, { seeded, drift: fresh ? null : baseDriftBlock(spec.root, k) }));
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
          {
            unitKey: k, slug: spec.slug, id: u.id, title: u.title || u.id, cwd: wtPath,
            machineCheck: u.machineCheck || '', expect: u.expect || '',
            // The DAG, as the tree view needs it: what this unit waited for, which
            // wave it ran in, and the commit its own work is measured against.
            // `baseSha` is the seed commit, so the scope audit does not mistake a
            // dependency's files for something this unit wrote.
            dependsOn: depsOf(u), seeded, wave: waveOf(spec, u), baseSha,
            filesInScope: Array.isArray(u.filesInScope) ? u.filesInScope : [],
            dispatchedAt: new Date().toISOString(),
          },
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
      return { path: wtPath, ws: k, baseSha, seeded, handle: { idleFile, startedFile, blockedFile, unitKey: k, launched } };
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
    // Wait on SEVERAL in-flight units at once and return the first to finish.
    //
    // waitIdle is the 5-method interface's blocking primitive, and blocking on
    // ONE handle is exactly wrong for a concurrency cap: a slot only frees when
    // its own unit finishes, so a wave runs at the speed of whichever unit the
    // loop happened to name first. Polling every sentinel in one loop frees the
    // slot that actually finished. Only the vscode backend can do this cheaply
    // (its liveness signal is a file); orca and herdr fall back to chunking.
    waitAny(handles, t) {
      const live = (handles || []).filter((h) => h && h.idleFile);
      if (!live.length) return null;
      const deadline = Date.now() + t;
      while (Date.now() < deadline) {
        for (const h of live) if (fs.existsSync(h.idleFile)) return h;
        // Nothing can ever finish if nothing was ever launched — don't burn the
        // whole timeout to discover the extension is not running.
        if (live.every((h) => h.launched === false)) return live[0];
        sleepSync(500);
      }
      return live[0]; // timed out: surrender the oldest slot so the wave can advance
    },
  };
  return be;
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

/**
 * What a unit's worktree was actually seeded with — including when the answer is
 * "nothing", which is the case that matters.
 *
 * A dependency whose agent has not written anything yields an EMPTY patch, and an
 * empty patch applies cleanly by doing nothing at all. So the difference between
 * "seeded from u1" and "u1 had nothing to give" is invisible unless it is said
 * out loud, and a unit silently building against an absent dependency is the
 * exact failure the seeding was added to prevent.
 */
function seedLine(spec, u, info) {
  const want = transitiveDeps(spec, u).map((d) => d.id);
  if (!want.length) return 'seeded from: (nothing to wait on — base is HEAD)';
  const got = (info && info.seeded) || [];
  const missing = want.filter((d) => !got.includes(d));
  if (!missing.length) return `seeded from: ${got.join(', ')}`;
  return `⚠️  seeded from: ${got.join(', ') || 'NOTHING'} — ${missing.join(', ')} produced no work yet`;
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
  // One phase per dependency wave. A spec with no `dependsOn` has exactly one,
  // which is the flat parallel fan-out this replaced.
  const waves = planWaves(spec);
  const base = spec.barrier ? 2 : 1;
  waves.forEach((wave, i) => {
    phases.push({
      label: `PHASE ${base + i} — wave ${i + 1}/${waves.length} (parallel; pairwise-disjoint scopes)`
        + (i > 0 ? ` — waits on wave ${i}` : ''),
      units: wave,
    });
  });

  console.log(`# ship-dispatch: ${spec.slug} — ${spec.title}`);
  console.log(`# root: ${spec.root}`);
  console.log(`# ${args.execute ? 'EXECUTING via' : 'DRY RUN (add --execute to run) via'} ${be.name} (${be.bin})`);
  if (spec.barrier) console.log('# NOTE: wait for the barrier oracle to pass before dispatching the units.');
  // ship-dispatch fires everything at once — it has no wait, by design; it is the
  // manual escape hatch. That was harmless when units were independent. With
  // `dependsOn` it is a trap: a later wave's worktree gets seeded from a
  // dependency whose agent has not written anything yet, so the seed is empty and
  // the unit builds against nothing — silently, because an empty patch is not an
  // error. Say so before spending anything, and name the units affected.
  if (args.execute && waves.length > 1) {
    const later = waves.slice(1).flat().map((u) => u.id);
    console.log(`#`);
    console.log(`# ⚠️  This spec has ${waves.length} dependency waves and ship-dispatch does NOT wait.`);
    console.log(`#    ${later.join(', ')} will be dispatched against dependencies that have not run yet,`);
    console.log(`#    so their worktrees will be seeded with nothing. Use ship-watch for a staged run:`);
    console.log(`#      vzt-agent ship-watch ${specPath} --mux ${be.name}`);
    console.log(`#    Continuing anyway — re-dispatch a later wave once its dependencies pass.`);
  }

  for (const phase of phases) {
    console.log(`\n## ${phase.label}`);
    for (const u of phase.units) {
      if (args.execute) {
        console.log(`\n→ dispatching ${u.id} …`);
        try {
          const info = be.dispatch(spec, u);
          console.log(`  ${u.id} → ${info.path || '(worktree)'}${info.handle ? '' : '  (no agent handle — will resolve on verify)'}`);
          console.log(`     ${seedLine(spec, u, info)}`);
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

/**
 * The commit a unit's own work is measured against.
 *
 * NOT simply HEAD: a dependent's worktree is seeded with its dependencies and
 * that seed is committed, so diffing against the worktree's creation point would
 * report every seeded file as something this unit wrote — a false breach on
 * exactly the units that need the audit most.
 *
 * Order of preference: the baseSha dispatch recorded; else the seed commit found
 * by message (ship-supervise runs without a dispatch result in hand); else the
 * fork point from the primary checkout; else HEAD.
 */
function auditBase(wt, spec, ref) {
  if (ref && ref.baseSha) return ref.baseSha;
  const tryGit = (argv) => {
    try {
      const out = execFileSync('git', ['-C', wt, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || null;
    } catch { return null; }
  };
  const seed = tryGit(['log', '-1', '--format=%H', '--grep', '^vzt: seed ']);
  if (seed) return seed;
  const rootHead = (() => {
    try { return execFileSync('git', ['-C', spec.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  })();
  return (rootHead && tryGit(['merge-base', 'HEAD', rootHead])) || 'HEAD';
}

/**
 * Every path this unit touched that it never declared. Empty means clean.
 *
 * Two sources, because either alone misses half the cases: `diff --name-only`
 * sees work the agent COMMITTED, and `ls-files --others` sees files it created
 * and left untracked — which the smoke runs showed is the common case.
 *
 * `--exclude-standard` is what keeps this honest. The unit bootstrap symlinks
 * node_modules and .env* into every worktree, and a naive scan reports all of
 * them as writes. A verifier that manufactures failures is worse than no
 * verifier — this repo has already had a correct barrier BLOCKED through two
 * correction rounds by exactly that.
 */
function auditScope(wt, base, filesInScope) {
  const lines = (argv) => {
    try {
      return execFileSync('git', ['-C', wt, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { return []; }
  };
  const touched = new Set([
    ...lines(['diff', '--name-only', base]),
    ...lines(['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...touched].filter((p) => !pathInScope(p, filesInScope)).sort();
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

  // SCOPE AUDIT, before the oracle.
  //
  // FILES_IN_SCOPE was enforced in exactly two places, and neither ran on this
  // path: a plan-time disjointness check (which cannot see what an agent
  // actually did) and a SCOPE_BREACH verdict that lives only in the headless
  // Workflow driver. On the supervised path the FIRST sign a unit had written
  // outside its scope was a failed `git apply` in the integration gate — at the
  // very end, after every unit's budget was already spent, reported against
  // whichever unit happened to be applied second.
  //
  // Orca's equivalent is `worker_done --files-modified`, which is the agent's
  // own account of what it touched. The worktree is better evidence: it needs no
  // cooperation from the model and cannot be wrong.
  const breach = wt ? auditScope(wt, auditBase(wt, spec, ref), u.filesInScope || []) : [];
  if (breach.length) {
    console.log(`  ${u.id} … SCOPE_BREACH  (${breach.length} file(s) outside FILES_IN_SCOPE)`);
    for (const f of breach.slice(0, 8)) console.log(`      ✗ ${f}`);
    if (breach.length > 8) console.log(`      … and ${breach.length - 8} more`);
    console.log(`      declared scope: ${(u.filesInScope || []).join(', ') || '(none)'}`);
    console.log(`      worktree: ${wt}`);
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'ship-note', specPath,
        JSON.stringify({ kind: 'unit_result', unit: u.id, status: 'SCOPE_BREACH', via, mux: be.name, code: -1, output: breach.slice(0, 20).join(', ') })],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { /* best-effort */ }
    if (ref) { try { be.stamp(spec, u, ref, 'SCOPE_BREACH', false); } catch { /* not live */ } }
    // Do not run the oracle. A unit that wrote outside its declared scope has
    // already broken the assumption the whole parallel fan-out rests on, and a
    // green oracle on top of that reads as "fine" when it is not.
    return false;
  }

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

/**
 * Block until ONE of the in-flight workers finishes, remove it, and return it.
 *
 * The 5-method backend interface only ever offered `waitIdle(handle)` — blocking
 * on one named worker. That is the wrong primitive for a concurrency cap: a slot
 * should free when whichever unit finishes first does, not when the one the loop
 * happened to name first does. A backend that can watch several at once says so
 * with `waitAny`; the others fall back to the old single-handle wait, which is
 * still correct, just less efficient (the wave proceeds in dispatch order).
 *
 * Always removes exactly one worker, so the caller's loop cannot spin.
 */
function takeFinished(be, inflight, timeoutMs) {
  if (typeof be.waitAny === 'function' && inflight.length > 1) {
    const handle = be.waitAny(inflight.map((w) => w.info.handle), timeoutMs);
    const i = inflight.findIndex((w) => w.info.handle === handle);
    return inflight.splice(i >= 0 ? i : 0, 1)[0];
  }
  be.waitIdle(inflight[0].info.handle, timeoutMs);
  return inflight.splice(0, 1)[0];
}

/**
 * Hold an idle-sleep assertion for the length of the run, on macOS.
 *
 * "Kick once and walk away" is the whole promise of ship-watch, and walking away
 * is exactly what puts the machine to sleep — a 40-minute unit on a laptop that
 * idles out at 20 gets suspended mid-turn, and the API connection it was holding
 * does not survive the wake. `caffeinate -w <pid>` dies with us, so a crashed or
 * killed run never leaves the machine permanently awake.
 *
 * What this does NOT do, and must not be described as doing: keep agents alive
 * past the thing that actually kills them. Ship units are VS Code integrated
 * terminals — child processes of the extension host — so closing or reloading
 * the window ends them regardless. Nor does any userland assertion override a
 * lid-close on a Mac without an external display. For a run that genuinely
 * outlives the editor, the answer is `--mux herdr`: its panes belong to a
 * separate daemon, not to a window.
 *
 * @returns {() => void} release
 */
function keepAwake() {
  if (process.platform !== 'darwin' || process.env.VZT_NO_CAFFEINATE === '1') return () => {};
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
    child.unref();
    return () => { try { child.kill(); } catch { /* already gone */ } };
  } catch {
    return () => {}; // no caffeinate — not worth failing a run over
  }
}

function shipWatch(args) {
  const specPath = args._[1];
  const spec = loadSpec(specPath);
  const errs = validateSpec(spec);
  if (errs.length) {
    console.error('❌ refusing to watch: SPEC does not pass ship-check. Run `vzt-agent ship-check` first.');
    process.exit(1);
  }
  const be = getBackend(args);
  // Held for the whole run; released on every exit path below, including the
  // barrier abort. A `caffeinate -w <our pid>` also dies with us if we crash.
  const release = keepAwake();
  process.on('exit', release);
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 30 * 60 * 1000;
  // How many units may be in flight at once. The old behaviour was "all of
  // them", which on a wide spec means N claude processes and N terminals
  // competing for the same machine. 0 restores it explicitly.
  const maxConcurrent = Number(args.maxConcurrent ?? process.env.VZT_MAX_CONCURRENT ?? 4);
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
      // Only worth a line when this unit actually depends on something; the
      // barrier-only case is every unit in every spec and would be pure noise.
      if (depsOf(u).length) console.log(`     ${seedLine(spec, u, info)}`);
      return { u, info };
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).trim().split('\n')[0];
      console.error(`  ${u.id}: DISPATCH FAILED — ${msg}`);
      note({ kind: 'unit_result', unit: u.id, status: 'FAIL', via: 'ship-watch', mux: be.name, code: -1, output: `dispatch failed: ${msg}` });
      return { u, info: null, dispatchFailed: true };
    }
  };

  // Grade a finished unit, then let the backend tidy anything it opened purely to
  // get the agent running — for orca, the fallback shell tab `worktree create`
  // leaves behind. Deliberately AFTER the oracle: that shell runs the repo setup
  // hook and there is no CLI signal for "setup finished", so a unit that has been
  // graded is the first moment closing it is provably safe.
  const grade = (u, info) => {
    const pass = verifyAndRecord(be, spec, u, specPath, info, 'ship-watch');
    if (be.closeStartup) be.closeStartup(info && info.startupHandle);
    return pass;
  };

  // Phase 1 — barrier gates everything.
  if (spec.barrier) {
    console.log('\n## barrier (runs first; its oracle grades every unit)');
    const b = dispatch(spec.barrier);
    let barrierOk = false;
    if (!b.dispatchFailed) {
      be.waitIdle(b.info.handle, timeoutMs);
      barrierOk = grade(spec.barrier, b.info);
    }
    if (!barrierOk) {
      console.error('\n❌ barrier FAILED — aborting before dispatching units. Fix the barrier worktree, then re-run.');
      note({ kind: 'aborted', reason: b.dispatchFailed ? 'barrier dispatch failed' : 'barrier oracle failed' });
      process.exit(1);
    }
  }

  // Phase 2 — units in dependency WAVES, at most `cap` at a time.
  //
  // This used to be `spec.units.map(dispatch)`: every unit launched at once,
  // then waited on in spec order. Two things were wrong with that. A 12-unit
  // spec started 12 claude processes and 12 terminals simultaneously, and there
  // was no way to say "u2 needs what u1 produces" short of making it the single
  // barrier. Waves fix the ordering; the cap fixes the stampede.
  const waves = planWaves(spec);
  const cap = maxConcurrent > 0 ? maxConcurrent : Infinity;
  console.log(`\n## units — ${waves.length} wave(s), ${maxConcurrent > 0 ? `max ${maxConcurrent} at a time` : 'no concurrency cap'}`);

  let passed = 0;
  const passedUnits = [];
  const verdict = new Map(); // unit id -> 'PASS' | 'FAIL' | 'BLOCKED'

  for (const [i, wave] of waves.entries()) {
    console.log(`\n### wave ${i + 1}/${waves.length}: ${wave.map((u) => u.id).join(', ')}`);

    // A unit whose dependency did not PASS must never be dispatched. Its
    // worktree would be seeded from a broken or absent base, so it would fail
    // for a reason that has nothing to do with its own brief — and the operator
    // would then debug the wrong unit. BLOCKED is the honest verdict.
    const queue = [];
    for (const u of wave) {
      const unmet = depsOf(u).filter((d) => verdict.get(d) !== 'PASS');
      if (unmet.length) {
        console.log(`  ${u.id} … BLOCKED (dependency ${unmet.join(', ')} did not pass)`);
        verdict.set(u.id, 'BLOCKED');
        note({ kind: 'unit_result', unit: u.id, status: 'BLOCKED', via: 'ship-watch', mux: be.name, code: -1, output: `not dispatched: dependency ${unmet.join(', ')} did not pass` });
      } else {
        queue.push(u);
      }
    }

    // Slot scheduler. A slot frees when the unit HOLDING it finishes, which is
    // why this waits on all in-flight handles at once rather than on whichever
    // one the loop named first — otherwise a wave runs at the speed of its
    // slowest member no matter how many slots are free.
    const inflight = [];
    while (queue.length || inflight.length) {
      while (inflight.length < cap && queue.length) {
        const w = dispatch(queue.shift());
        if (w.dispatchFailed) { verdict.set(w.u.id, 'FAIL'); continue; }
        inflight.push(w);
      }
      if (!inflight.length) break;
      const w = takeFinished(be, inflight, timeoutMs);
      if (grade(w.u, w.info)) {
        verdict.set(w.u.id, 'PASS');
        passed++;
        passedUnits.push(w.u);
      } else {
        verdict.set(w.u.id, 'FAIL');
      }
    }
  }

  console.log(`\n${passed}/${spec.units.length} unit oracle(s) PASS.`);

  let integration = { ok: false, status: 'SKIPPED' };
  if (passed === spec.units.length) {
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
    units: spec.units.length + (spec.barrier ? 1 : 0),
    passed: passed + (spec.barrier ? 1 : 0),
    blocked: spec.units.length - passed,
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
                                 [--max-concurrent <n>]
                                          KICK ONCE, WALK AWAY: dispatch every unit → wait
                                          for each to finish → auto-verify + stamp + ledger →
                                          integration gate. Stops at "ready to review + merge".
                                          Units run in dependency waves (see dependsOn in the
                                          SPEC); at most --max-concurrent at a time (default 4,
                                          0 = unlimited, or set VZT_MAX_CONCURRENT).
  vzt-agent ship-dispatch <SPEC.md> [--mux orca|herdr|vscode] [--execute]
                                          one worktree+claude per unit (dry-run prints commands)
  vzt-agent ship-supervise <SPEC.md> [--mux orca|herdr|vscode]
                                          run each unit's MACHINE_CHECK in its worktree,
                                          record PASS/FAIL to the shared ledger + mux card
  (default mux is orca; --mux herdr uses the herdr multiplexer; --mux vscode opens each
   unit as a native VS Code integrated terminal — needs the companion extension in vscode/)
`);
}
