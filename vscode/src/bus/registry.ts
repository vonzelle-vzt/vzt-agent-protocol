/**
 * The agents (and plain shells) THIS extension host started or adopted, and the
 * one-window project swap over their terminals.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs and test/tmux-vscode.test.mjs drive it with fake
 * terminals.
 *
 * An entry outlives its terminal. A tmux entry (`session`) runs in a session on
 * the private tmux server (tmux.ts) and its VS Code terminal is only an attach
 * client: created when its project is shown, disposed when another project is,
 * and the agent never notices. `terminal` undefined = detached. A legacy entry
 * (no tmux, or started before 0.10) has no session — its terminal IS the agent —
 * so a swap never disposes it.
 *
 * Closing: a terminal the user closed ends its session (Orca: closing a tab
 * ends it). One that exited by itself is forgotten once its session is gone; a
 * tmux detach leaves the session running, so the entry stays, detached.
 * Shutdown keeps everything. A swap remembers its own disposals, so their close
 * events change nothing.
 *
 * `onChange` gets the saved form (no terminals) after every change, so the
 * window can persist it and restore its agents after a reload (restore.ts).
 */

import type * as vscode from "vscode";
import { terminalName } from "./spawn";
import type { Tmux } from "./tmux";

export type AgentKind = "claude" | "codex";

export interface RegistryEntry {
  alias: string;
  kind: AgentKind | "shell";
  cwd: string;
  /** The terminal showing it. Undefined = detached: its tmux session runs on with no client. */
  terminal?: vscode.Terminal;
  /** Its session on the private tmux server. Undefined = a direct terminal (legacy). */
  session?: string;
  /** The main checkout of `cwd` (the bus's project rule), cached when it started. */
  project?: string;
}

export interface SavedAgent {
  agent_id: string;
  alias: string;
  kind: AgentKind;
  cwd: string;
  session?: string;
  project?: string;
}

export interface SavedShell {
  session: string;
  alias: string;
  cwd: string;
  project?: string;
}

/** Why a terminal closed, from vscode.TerminalExitReason: Shutdown, User, or anything else. */
export type CloseReason = "user" | "shutdown" | "other";

export interface ShowOptions {
  /** Reveal the project's folder in the Explorer. Default: only when the active project changes. */
  reveal?: boolean;
  /** Show the project's lead terminal (keeping focus where it is). Default true. */
  show?: boolean;
}

/** What the swap needs from VS Code and tmux; absent = a plain registry (tests, legacy). */
export interface TerminalView {
  createTerminal(opts: vscode.TerminalOptions): vscode.Terminal;
  /** The tmux that runs the sessions, whenever its binary exists (even with spawning in tmux off). */
  tmux(): Tmux | undefined;
  /** Reveal `root` in the Explorer — only called when it is a workspace folder. */
  reveal?(root: string): void;
  onActive?(root: string): void;
  log?(line: string): void;
}

/** Drop undefined-valued keys, so the saved form of a pre-0.10 entry stays byte-identical. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const isLive = (t: vscode.Terminal | undefined): t is vscode.Terminal => !!t && t.exitStatus === undefined;

export class AgentRegistry {
  private readonly agents = new Map<string, RegistryEntry>();
  /** Terminals a swap disposed: their close event must not end or forget anything. */
  private readonly swapClosed = new WeakSet<object>();
  /** The project whose terminals the panel holds (the bus `project` root). */
  active: string | undefined;

  constructor(
    private readonly onChange: (agents: SavedAgent[], shells: SavedShell[]) => void = () => {},
    private readonly view?: TerminalView
  ) {}

  /** The persisted form: no terminals; shells apart from bus agents. */
  saved(): { agents: SavedAgent[]; shells: SavedShell[] } {
    const agents: SavedAgent[] = [];
    const shells: SavedShell[] = [];
    for (const [id, e] of this.agents) {
      if (e.kind === "shell") {
        if (e.session) shells.push(compact({ session: e.session, alias: e.alias, cwd: e.cwd, project: e.project }));
      } else {
        agents.push(compact({ agent_id: id, alias: e.alias, kind: e.kind, cwd: e.cwd, session: e.session, project: e.project }));
      }
    }
    return { agents, shells };
  }

  private changed(): void {
    const { agents, shells } = this.saved();
    this.onChange(agents, shells);
  }

  set(id: string, entry: RegistryEntry): void {
    this.agents.set(id, entry);
    this.changed();
  }

  get(id: string): RegistryEntry | undefined {
    return this.agents.get(id);
  }

  delete(id: string): boolean {
    const had = this.agents.delete(id);
    if (had) this.changed();
    return had;
  }

  entries(): IterableIterator<[string, RegistryEntry]> {
    return this.agents.entries();
  }

  get size(): number {
    return this.agents.size;
  }

  /** Forget every agent that ran in `terminal` (it closed; its lease lapses → stale). */
  removeTerminal(terminal: vscode.Terminal): void {
    let had = false;
    for (const [id, entry] of this.agents) {
      if (entry.terminal === terminal) had = this.agents.delete(id) || had;
    }
    if (had) this.changed();
  }

  /**
   * Show the entry's terminal, taking keyboard focus — showing its project first
   * when that is not the active one, or when its session is detached. False when
   * the id is unknown or there is no live terminal to show.
   */
  focus(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry) return false;
    if (this.view && entry.project && (entry.project !== this.active || (entry.session && !entry.terminal))) {
      this.showProject(entry.project, { show: false });
    }
    if (!isLive(entry.terminal)) return false;
    entry.terminal.show(false);
    return true;
  }

  /**
   * Make `root` the active project: detach the terminals of every other
   * project's tmux entries (their sessions run on), attach every entry of `root`
   * without a terminal — one split group per worktree — and show the lead one.
   * Never touches a legacy terminal or one this registry does not own.
   */
  showProject(root: string, opts: ShowOptions = {}): vscode.Terminal | undefined {
    const changed = root !== this.active;
    const { reveal = changed, show = true } = opts;

    for (const entry of this.agents.values()) {
      if (!entry.session || !entry.terminal || entry.project === root) continue;
      const t = entry.terminal;
      entry.terminal = undefined;
      this.swapClosed.add(t);
      t.dispose();
    }

    // Main checkout first, then worktrees by path; within one, start order.
    const mine = [...this.agents.values()].filter((e) => e.project === root);
    const groups = new Map<string, RegistryEntry[]>();
    for (const e of mine.sort((a, b) => Number(b.cwd === root) - Number(a.cwd === root) || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0))) {
      groups.set(e.cwd, [...(groups.get(e.cwd) || []), e]);
    }

    const tmux = this.view?.tmux();
    let lead: vscode.Terminal | undefined;
    for (const entries of groups.values()) {
      let parent = entries.map((e) => e.terminal).find(isLive);
      for (const e of entries) {
        if (e.terminal || !e.session || !tmux || !this.view) continue;
        e.terminal = this.view.createTerminal({
          name: terminalName(e.cwd, e.alias),
          cwd: e.cwd,
          ...tmux.attachOptions(e.session),
          // The session is the persistence: VS Code must not revive a stale client after a reload.
          isTransient: true,
          ...(parent ? { location: { parentTerminal: parent } } : {}),
        });
        parent ??= e.terminal;
      }
      lead ??= parent;
    }

    this.active = root;
    if (changed) this.view?.onActive?.(root);
    if (reveal) this.view?.reveal?.(root);
    if (show && lead) lead.show(true);
    return lead;
  }

  /** onDidCloseTerminal: end, forget or keep the entry that `terminal` showed. */
  async closed(terminal: vscode.Terminal, reason: CloseReason): Promise<void> {
    if (this.swapClosed.delete(terminal)) return;
    let hit: [string, RegistryEntry] | undefined;
    for (const pair of this.agents) {
      if (pair[1].terminal === terminal) {
        hit = pair;
        break;
      }
    }
    if (!hit || reason === "shutdown") return; // shutdown: sessions live on in tmux, restored next start
    const [id, entry] = hit;
    if (!entry.session) {
      this.removeTerminal(terminal);
      return;
    }
    entry.terminal = undefined;
    const tmux = this.view?.tmux();
    if (reason === "user") {
      try {
        await tmux?.killSession(entry.session);
      } catch (err) {
        this.view?.log?.(`closing ${entry.alias}: kill-session ${entry.session} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.agents.get(id) === entry) this.delete(id);
      return;
    }
    // The attach client exited on its own: the session ended (its shell
    // exited), or the client was only detached and the session runs on.
    const alive = tmux ? await tmux.hasSession(entry.session) : false;
    if (!alive && this.agents.get(id) === entry) this.delete(id);
  }
}

/**
 * The poller's lease pairs: the tmux pane pid for a tmux entry (from one
 * `panes` listing), the terminal pid for a legacy one; shells hold no lease.
 * `ended`: detached tmux entries whose session is gone — attached ones are
 * forgotten by their client's close event instead. With `panes` unknown (the
 * listing failed) nothing ends and tmux entries skip this lease.
 */
export async function leasePlan(
  entries: [string, RegistryEntry][],
  panes: Map<string, number> | undefined
): Promise<{ pairs: string[]; ended: [string, RegistryEntry][] }> {
  const pairs: string[] = [];
  const ended: [string, RegistryEntry][] = [];
  for (const [id, e] of entries) {
    if (e.session) {
      const pid = panes?.get(e.session);
      if (pid === undefined) {
        if (panes && !e.terminal) ended.push([id, e]);
      } else if (e.kind !== "shell") {
        pairs.push(`${id}:${pid}`);
      }
      continue;
    }
    if (e.kind === "shell" || !e.terminal) continue;
    const pid = await e.terminal.processId;
    if (pid) pairs.push(`${id}:${pid}`);
  }
  return { pairs, ended };
}
