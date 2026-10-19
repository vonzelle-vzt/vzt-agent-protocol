/**
 * Pre-accept Claude Code's folder-trust dialog for a directory.
 *
 * Observed 2026-10-14 on Claude Code 2.1.299: a freshly launched claude sat
 * forever on "Is this a project you trust?" with the cursor on "No, exit" —
 * --dangerously-skip-permissions does NOT skip it, and trust on a PARENT folder
 * is not inherited (tested). It hit ship-watch unit worktrees AND the live bus
 * round trip in the repo itself. Orca's own launcher writes exactly this
 * one-key entry for worktrees it creates with --agent claude; callers that
 * launch claude themselves must write it too.
 *
 * Callers decide WHETHER a folder deserves trust (ship-watch: its own unit
 * worktrees; the VS Code pair: only when VS Code's workspace trust is granted).
 * This only records it. Reads back to verify, because a running claude
 * rewrites ~/.claude.json and can clobber the edit. Never throws.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function claudeConfigFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

export function trustClaudeWorkspace(dir, { log = (m) => console.error(m) } = {}) {
  const file = claudeConfigFile();
  let key;
  try { key = fs.realpathSync(dir); } catch { key = dir; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!fs.existsSync(file)) return false;
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg.projects?.[key]?.hasTrustDialogAccepted === true) return true;
      cfg.projects = cfg.projects || {};
      cfg.projects[key] = { ...(cfg.projects[key] || {}), hasTrustDialogAccepted: true };
      const tmp = `${file}.vzt-${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(tmp, file);
      const back = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (back.projects?.[key]?.hasTrustDialogAccepted === true) return true;
    } catch (e) {
      log(`  trust: attempt ${attempt} for ${key} failed — ${e.message}`);
    }
  }
  log(`  trust: could not pre-accept Claude's folder-trust dialog for ${key}; claude may stop on it`);
  return false;
}
