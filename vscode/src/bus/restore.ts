/**
 * Bring a window's agents back after a reload or a restart, the way Orca
 * restores its sessions.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/restore-vscode.test.mjs can drive it with fake terminals and ps rows.
 *
 * Per saved agent: `bus adopt` moves it to this window (keeping its state and
 * session) and returns the shell pid it last leased. A reload keeps terminal
 * processes, so a terminal whose shell has that pid IS the agent's terminal:
 * if anything still runs under it, it is reattached and nothing is typed.
 * Otherwise the agent starts again in a new terminal, resumed from the session
 * id its SessionStart hook recorded, or fresh when it never started. While the
 * old shell is alive but its terminal has not shown up yet, nothing launches.
 *
 * A 0.10+ agent saved with a tmux `session` needs none of that: tmux outlives
 * the window, so a session that still exists IS the agent — adopted, left
 * detached (the window attaches it when its project is shown), nothing typed.
 * A session that is gone (a reboot) resumes like above, into a new session.
 * Pre-0.10 entries keep the terminal-pid path (restoreAgent) unchanged.
 */

import * as path from "path";
import type * as vscode from "vscode";
import type { AgentRegistry, SavedAgent, SavedShell } from "./registry";
import { gateTrust, SpawnDeps, startAgent, terminalName } from "./spawn";
import type { Tmux } from "./tmux";

export interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
}

/** A terminal with its shell pid already resolved. */
export interface PidTerminal {
  terminal: vscode.Terminal;
  pid: number | undefined;
}

export interface Adopted {
  agent_id: string;
  session_id: string | null;
  terminal_pid: number | null;
  /** The agent's project root (`bus adopt` prints it; absent from an older CLI). */
  project?: string;
}

export type RestoreOutcome = "adopted" | "resumed" | "relaunched" | "waiting";

const SHELL_RE = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|nu|pwsh)$/;

/** `ps -A -o pid=,ppid=,comm=` output → rows. Unparseable lines are skipped. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] });
  }
  return rows;
}

/** True when any process runs under `pid` (the agent, or whatever it left running). */
export function hasChildren(pid: number, rows: PsRow[]): boolean {
  return rows.some((r) => r.ppid === pid);
}

/** True when `pid` is still a shell with something running under it: a surviving agent terminal. */
export function shellAlive(pid: number | null, rows: PsRow[]): boolean {
  if (!pid) return false;
  const row = rows.find((r) => r.pid === pid);
  return !!row && SHELL_RE.test(path.basename(row.comm)) && hasChildren(pid, rows);
}

/**
 * `bus adopt` for one saved agent. "gone" = the bus no longer knows it,
 * "elsewhere" = another live window drives it; any other failure throws, so a
 * transient error never drops the agent.
 */
export async function adoptSaved(
  deps: SpawnDeps,
  saved: SavedAgent,
  fromWindow: string
): Promise<Adopted | "gone" | "elsewhere"> {
  try {
    return await deps.run<Adopted>(
      ["adopt", "--agent", saved.agent_id, "--window", deps.windowId, "--from-window", fromWindow],
      saved.cwd
    );
  } catch (err) {
    const code = (err as { exitCode?: number | null }).exitCode;
    if (code === 2) return "gone";
    if (code === 4) return "elsewhere";
    throw err;
  }
}

export async function restoreAgent(
  deps: SpawnDeps,
  saved: SavedAgent,
  adopted: Adopted,
  terminals: PidTerminal[],
  ps: PsRow[]
): Promise<RestoreOutcome> {
  const own = adopted.terminal_pid
    ? terminals.find((t) => t.pid === adopted.terminal_pid && t.terminal.exitStatus === undefined)
    : undefined;
  if (own && hasChildren(own.pid!, ps)) {
    const project = adopted.project ?? saved.project;
    deps.registry.set(saved.agent_id, { alias: saved.alias, kind: saved.kind, cwd: saved.cwd, terminal: own.terminal, ...(project ? { project } : {}) });
    return "adopted";
  }
  if (!own && shellAlive(adopted.terminal_pid, ps)) return "waiting";

  await gateTrust(deps, saved.kind, saved.cwd);
  await startAgent(deps, { ...saved, project: adopted.project ?? saved.project, resume: adopted.session_id });

  // Only now that the new terminal runs, close the old one: the agent's own
  // terminal at a bare prompt, or a same-named shell VS Code revived after a
  // restart (it lacks the agent's env). Never one with something running in it.
  const name = terminalName(saved.cwd, saved.alias);
  const stale = own ? [own] : terminals.filter((t) => t.terminal.name === name && t.pid && !hasChildren(t.pid, ps));
  for (const t of stale) t.terminal.dispose();
  return adopted.session_id ? "resumed" : "relaunched";
}

/**
 * Restore one agent saved with a tmux session. `tmux` is the binary's Tmux
 * whenever it exists — even with spawning in tmux switched off, a running
 * session is still the agent. The session check comes first and adopt second,
 * so a failed adopt (thrown: kept for next start) never launches anything.
 */
export async function restoreSession(
  deps: SpawnDeps,
  tmux: Tmux | undefined,
  saved: SavedAgent,
  fromWindow: string
): Promise<RestoreOutcome | "gone" | "elsewhere"> {
  const live = !!saved.session && !!tmux && (await tmux.hasSession(saved.session));
  const adopted = await adoptSaved(deps, saved, fromWindow);
  if (typeof adopted === "string") return adopted;
  const project = adopted.project ?? saved.project ?? saved.cwd;
  if (live) {
    deps.registry.set(saved.agent_id, { alias: saved.alias, kind: saved.kind, cwd: saved.cwd, session: saved.session, project, ...(saved.column !== undefined ? { column: saved.column } : {}) });
    return "adopted";
  }
  await gateTrust(deps, saved.kind, saved.cwd);
  await startAgent(deps, { ...saved, project, resume: adopted.session_id });
  return adopted.session_id ? "resumed" : "relaunched";
}

/** A saved plain shell comes back only while its session runs; there is nothing to resume. */
export async function restoreShell(registry: AgentRegistry, tmux: Tmux | undefined, saved: SavedShell): Promise<boolean> {
  if (!tmux || !(await tmux.hasSession(saved.session))) return false;
  registry.set(saved.session, { alias: saved.alias, kind: "shell", cwd: saved.cwd, session: saved.session, project: saved.project ?? saved.cwd, ...(saved.column !== undefined ? { column: saved.column } : {}) });
  return true;
}
