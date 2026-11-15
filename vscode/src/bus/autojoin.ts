/**
 * Self-joined agents: claude/codex the user started by hand in one of this
 * window's terminals. The window exports VZT_BUS_AGENT=auto to every terminal
 * (and to the tmux shells it starts), so the agent's own hooks register it on
 * the bus with its process id (cli/bus/cli.mjs autoJoin) — the way an agent in
 * an Orca pane belongs to Orca without being launched by it.
 *
 * The extension then has to own it like one it spawned: lease it and type its
 * wakes. This module only decides WHERE an agent runs; it is kept free of the
 * `vscode` module so test/autojoin-vscode.test.mjs drives it with plain data.
 *
 * Never type blind: an agent is hosted only when its live process descends from
 * one of this window's terminal shells or tmux panes, and the poller re-checks
 * that the process is alive before every lease and wake.
 */

import type { PsRow } from "./restore";

/** A bus agent row as `bus agents --all --json` prints it (the fields used here). */
export interface BusAgentRow {
  agent_id: string;
  alias: string;
  kind: string;
  window_id: string | null;
  agent_pid: number | null;
}

/** Where a self-joined agent runs: one of the window's terminals, or a session on the private tmux server. */
export type Host = { terminal: number; pid: number } | { session: string; pid: number };

/** `pid` and its ancestors (nearest first); a cycle or unknown parent ends the walk. */
export function ancestors(pid: number, ps: PsRow[]): number[] {
  const parent = new Map(ps.map((r) => [r.pid, r.ppid]));
  const out: number[] = [];
  for (let p: number | undefined = pid, n = 0; p !== undefined && p > 1 && n < 64; n++) {
    out.push(p);
    p = parent.get(p);
  }
  return out;
}

/**
 * The host of the agent process `agentPid`: the nearest terminal shell or tmux
 * pane above it. `terminalPids[i]` is terminal i's shell pid (undefined while
 * unknown); `panes` maps a tmux session to its pane pid.
 */
export function hostOf(
  agentPid: number,
  terminalPids: (number | undefined)[],
  panes: Map<string, number> | undefined,
  ps: PsRow[]
): Host | undefined {
  for (const pid of ancestors(agentPid, ps)) {
    const terminal = terminalPids.indexOf(pid);
    if (terminal >= 0) return { terminal, pid };
    if (panes) {
      for (const [session, panePid] of panes) if (panePid === pid) return { session, pid };
    }
  }
  return undefined;
}

/**
 * Rows the window should look at: self-joined (agent_pid set), not already
 * an agent this extension started, and with a live process.
 */
export function candidates(rows: BusAgentRow[], owned: (id: string) => boolean, alive: (pid: number) => boolean): BusAgentRow[] {
  return rows.filter((r) => typeof r.agent_pid === "number" && r.agent_pid > 1 && !owned(r.agent_id) && alive(r.agent_pid));
}

/** True while `pid` exists (signal 0 checks without sending anything). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
