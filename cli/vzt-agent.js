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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const AGENT_FILES_DIR = path.join(PKG_ROOT, 'agents');
const SKILLS_DIR = path.join(PKG_ROOT, 'skills');
const HOOKS_DIR = path.join(PKG_ROOT, 'hooks');
// The doctrine tells every session to delegate using templates/worker-brief.md.
// If we don't install it, that instruction points at nothing — the brief gets
// improvised, and MACHINE_CHECK drifts to being chosen AFTER the diff exists.
const TEMPLATES_DIR = path.join(PKG_ROOT, 'templates');

const HOOKS = [
  { event: 'UserPromptSubmit', basename: 'vzt-route-classifier.mjs', timeout: 10 },
  { event: 'SessionStart', basename: 'vzt-session-start.mjs', timeout: 10 },
];
const MANAGED_MARKER = 'vzt-agent-protocol';
const STATE_DIR = path.join(os.homedir(), '.claude', 'vzt-router');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global' || a === '-g') args.global = true;
    else if (a === '--target') args.target = argv[++i];
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

function install(args) {
  const dotClaude = claudeDir(args);
  console.log(`Installing VZT Agent Protocol → ${dotClaude}`);

  const agents = copyDirContents(AGENT_FILES_DIR, path.join(dotClaude, 'agents'), { ext: '.md' });
  const skills = copyDirContents(SKILLS_DIR, path.join(dotClaude, 'skills'));
  const hooks = copyDirContents(HOOKS_DIR, path.join(dotClaude, 'hooks', 'vzt-router'));
  const templates = copyDirContents(TEMPLATES_DIR, path.join(dotClaude, 'templates'), { ext: '.md' });
  // Project installs (--target / cwd) get portable $CLAUDE_PROJECT_DIR paths so
  // a committed settings.json works for anyone who clones the repo; a global
  // install (~/.claude) uses the absolute path.
  const settingsPath = wireSettings(dotClaude, { portable: !args.global });

  console.log(`  agents:   ${agents.length} installed (fable×2, opus×2, sonnet×1, haiku×2)`);
  console.log(`  skills:   ${skills.length} files installed (/vzt-route /vzt-plan /vzt-fix /vzt-build /vzt-quick /vzt-fable-mode)`);
  console.log(`  hooks:    ${hooks.length} installed (SessionStart chair-profile + UserPromptSubmit classifier)`);
  console.log(`  templates: ${templates.length} installed (worker-brief delegation contract)`);
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
  // Remove only the template files we ship — never the templates/ dir itself,
  // which the user may share with other tooling.
  if (fs.existsSync(TEMPLATES_DIR)) {
    for (const f of fs.readdirSync(TEMPLATES_DIR)) {
      const target = path.join(dotClaude, 'templates', f);
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
  let overrides = 0;
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      byTier[d.tier] = (byTier[d.tier] || 0) + 1;
      if (d.override) overrides++;
    } catch {
      /* skip bad lines */
    }
  }
  const total = lines.length;
  console.log(`Routing decisions: ${total} (manual overrides: ${overrides})\n`);
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    const n = byTier[tier] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${tier.padEnd(6)} ${String(pct).padStart(3)}%  ${bar} (${n})`);
  }
  const fablePct = total ? ((byTier.fable || 0) / total) * 100 : 0;
  console.log(`\nTarget: Fable ≤15% — ${fablePct <= 15 ? '✅ on target' : `❌ over (${Math.round(fablePct)}%) — tighten routing or use /vzt-build for execution`}`);
}

function matrix() {
  const file = path.join(PKG_ROOT, 'docs', 'ROUTING-MATRIX.md');
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
  else console.log('docs/ROUTING-MATRIX.md not found');
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
  default:
    console.log(`vzt-agent — VZT Agent Protocol CLI

Usage:
  vzt-agent install [--global] [--target <dir>]
  vzt-agent uninstall [--global] [--target <dir>]
  vzt-agent doctor [--global] [--target <dir>]
  vzt-agent stats
  vzt-agent matrix
`);
}
