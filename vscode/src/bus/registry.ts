/**
 * The agents (and plain shells) THIS extension host started or adopted, and the
 * one-window project swap over their terminals.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs and test/tmux-vscode.test.mjs drive it with fake
 * terminals.
 *
 * An entry outlives its terminal. A tmux entry (`session`) runs in a session on
 * the private tmux server (tmux.ts). Each worktree has a layout session whose
 * panes are attach clients of its agents' sessions — split side by side, the
 * way Orca splits a worktree's tab — and ONE VS Code terminal attached to that
 * layout, shared by every entry of the worktree: created when its project is
 * shown, disposed when another project is, and no agent notices. A new entry
 * of the shown project gets its pane at once. `terminal` undefined = detached.
 * A legacy entry (no tmux, or started before 0.10) has no session — its
 * terminal IS the agent — so a swap never disposes it.
 *
 * Closing: a worktree terminal the user closed ends every session in it
 * (Orca: closing a tab ends its panes). One that exited by itself is
 * forgotten for each session that is gone; a detach leaves them running, so
 * those entries stay, detached. An agent that exits closes its own pane and is
 * forgotten by the poller (leasePlan). Shutdown keeps everything. A swap
 * remembers its own disposals, so their close events change nothing.
 *
 * `onChange` gets the saved form (no terminals) after every change, so the
 * window can persist it and restore its agents after a reload (restore.ts).
 */

import type * as vscode from "vscode";
import { terminalName } from "./spawn";
import { layoutSession, type Tmux } from "./tmux";

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
  /** The editor column the user put its terminal in; undefined = the panel. Saved, so a reload keeps it. */
  column?: number;
}

export interface SavedAgent {
  agent_id: string;
  alias: string;
  kind: AgentKind;
  cwd: string;
  session?: string;
  project?: string;
  column?: number;
}

export interface SavedShell {
  session: string;
  alias: string;
  cwd: string;
  project?: string;
  column?: number;
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
  /** The editor column holding `terminal`, undefined when it is in the panel. */
  editorColumn?(terminal: vscode.Terminal): number | undefined;
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
  /** Attaches and focuses run one at a time, so a pane is never added twice. */
  private chain: Promise<unknown> = Promise.resolve();

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
        if (e.session) shells.push(compact({ session: e.session, alias: e.alias, cwd: e.cwd, project: e.project, column: e.column }));
      } else {
        agents.push(compact({ agent_id: id, alias: e.alias, kind: e.kind, cwd: e.cwd, session: e.session, project: e.project, column: e.column }));
      }
    }
    return { agents, shells };
  }

  private changed(): void {
    const { agents, shells } = this.saved();
    this.onChange(agents, shells);
  }

  set(id: string, entry: RegistryEntry): void {
    // Re-registered (adopted again, restored): keep the terminal already showing it.
    const prev = this.agents.get(id);
    if (prev?.terminal && !entry.terminal && prev.session && prev.session === entry.session) {
      entry.terminal = prev.terminal;
      entry.column ??= prev.column;
    }
    this.agents.set(id, entry);
    this.changed();
    // A new agent of the shown project opens its pane now, as in Orca.
    if (this.view && entry.session && !entry.terminal && entry.project && entry.project === this.active) {
      void this.showProject(entry.project, { show: false, reveal: false });
    }
  }

  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Settles once every queued attach and focus has run. */
  async idle(): Promise<void> {
    await this.chain;
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

  /** The user moved `terminal` to editor `column` (undefined = the panel): remember it for the next attach. */
  placed(terminal: vscode.Terminal, column: number | undefined): void {
    let moved = false;
    for (const entry of this.agents.values()) {
      if (entry.terminal !== terminal || !entry.session || entry.column === column) continue;
      entry.column = column;
      moved = true;
    }
    if (moved) this.changed();
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
   * Show the entry's terminal, taking keyboard focus — showing its project
   * first, and for a tmux entry selecting its pane in the worktree's layout.
   * False when the id is unknown or there is no terminal to show (a legacy
   * entry's is gone, or tmux is); a tmux entry's attach runs queued (idle()
   * settles it).
   */
  focus(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry) return false;
    if (this.view && entry.session && entry.project && this.view.tmux()) {
      const session = entry.session;
      void this.showProject(entry.project, { show: false });
      void this.queue(async () => {
        const t = entry.terminal;
        if (!isLive(t)) return;
        try {
          await this.view?.tmux()?.selectPane(layoutSession(entry.cwd), session);
        } catch (err) {
          this.view?.log?.(`focus ${entry.alias}: ${err instanceof Error ? err.message : String(err)}`);
        }
        t.show(false);
      });
      return true;
    }
    if (this.view && entry.project && entry.project !== this.active) void this.showProject(entry.project, { show: false });
    if (!isLive(entry.terminal)) return false;
    entry.terminal.show(false);
    return true;
  }

  /**
   * Make `root` the active project: detach the worktree terminals of every
   * other project (their sessions run on), give each of `root`'s worktrees its
   * layout — a pane per session, added for any that lack one — and one
   * terminal attached to it, and show the lead one. A terminal the user moved
   * into an editor column comes back in that column. Never touches a legacy
   * terminal or one this registry does not own. Runs queued.
   */
  showProject(root: string, opts: ShowOptions = {}): Promise<vscode.Terminal | undefined> {
    return this.queue(() => this.attach(root, opts));
  }

  private async attach(root: string, opts: ShowOptions): Promise<vscode.Terminal | undefined> {
    const changed = root !== this.active;
    const { reveal = changed, show = true } = opts;

    let moved = false;
    const dropped = new Set<vscode.Terminal>();
    for (const entry of this.agents.values()) {
      if (!entry.session || !entry.terminal || entry.project === root) continue;
      const t = entry.terminal;
      if (this.view?.editorColumn) {
        const column = this.view.editorColumn(t);
        moved ||= column !== entry.column;
        entry.column = column;
      }
      entry.terminal = undefined;
      dropped.add(t);
    }
    for (const t of dropped) {
      this.swapClosed.add(t);
      t.dispose();
    }
    if (moved) this.changed();
    this.active = root;
    if (changed) this.view?.onActive?.(root);

    // Main checkout first, then worktrees by path; within one, start order.
    const mine = [...this.agents.values()].filter((e) => e.project === root);
    const groups = new Map<string, RegistryEntry[]>();
    for (const e of mine.sort((a, b) => Number(b.cwd === root) - Number(a.cwd === root) || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0))) {
      groups.set(e.cwd, [...(groups.get(e.cwd) || []), e]);
    }

    const tmux = this.view?.tmux();
    let lead: vscode.Terminal | undefined;
    for (const [cwd, entries] of groups) {
      const tmuxed = entries.filter((e) => e.session);
      lead ??= entries.filter((e) => !e.session).map((e) => e.terminal).find(isLive);
      if (!tmuxed.length || !tmux || !this.view) continue;
      const layout = layoutSession(cwd);
      const panes = await tmux.layoutPanes(layout);
      let started = !!panes;
      for (const e of tmuxed) {
        // A session that ended (the poller forgets it within 1.5 s) gets no pane:
        // its attach client would die at once.
        if (panes?.has(e.session!) || !(await tmux.hasSession(e.session!))) continue;
        try {
          if (started) await tmux.addPane(layout, cwd, e.session!, e.alias);
          else {
            try {
              await tmux.newLayout(layout, cwd, e.session!, e.alias);
            } catch (err) {
              // Another window started this worktree's layout first: split into it.
              if (!(await tmux.hasSession(layout))) throw err;
              await tmux.addPane(layout, cwd, e.session!, e.alias);
            }
          }
          started = true;
        } catch (err) {
          this.view.log?.(`pane for ${e.alias} in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!started) continue;
      let t = tmuxed.map((e) => e.terminal).find(isLive);
      if (!t) {
        const column = tmuxed.map((e) => e.column).find((c) => c !== undefined);
        t = this.view.createTerminal({
          name: terminalName(cwd, "agents"),
          cwd,
          ...tmux.attachOptions(layout),
          // The layout is the persistence: VS Code must not revive a stale client after a reload.
          isTransient: true,
          ...(column !== undefined ? { location: { viewColumn: column, preserveFocus: true } } : {}),
        });
      }
      for (const e of tmuxed) e.terminal = t;
      lead ??= t;
    }

    if (reveal) this.view?.reveal?.(root);
    if (show && lead) lead.show(true);
    return lead;
  }

  /**
   * onDidCloseTerminal: end, forget or keep the entries that `terminal` showed.
   * Runs queued, so an attach cannot re-add the panes of sessions it is ending.
   */
  async closed(terminal: vscode.Terminal, reason: CloseReason): Promise<void> {
    if (this.swapClosed.delete(terminal)) return;
    if (reason === "shutdown") return; // sessions live on in tmux, restored next start
    await this.queue(() => this.close(terminal, reason));
  }

  private async close(terminal: vscode.Terminal, reason: CloseReason): Promise<void> {
    const hits = [...this.agents].filter(([, e]) => e.terminal === terminal);
    if (!hits.length) return;
    const tmux = this.view?.tmux();
    const forget = (id: string, entry: RegistryEntry) => {
      if (this.agents.get(id) === entry) this.delete(id);
    };
    for (const [id, entry] of hits) {
      entry.terminal = undefined;
      if (!entry.session) forget(id, entry);
    }
    const tmuxed = hits.filter(([, e]) => e.session);
    if (reason === "user") {
      const mine = new Set(tmuxed.map(([, e]) => e.session!));
      const layouts = new Map<string, Map<string, string> | undefined>();
      for (const cwd of new Set(tmuxed.map(([, e]) => e.cwd))) layouts.set(cwd, await tmux?.layoutPanes(layoutSession(cwd)));
      for (const [id, entry] of tmuxed) {
        try {
          await tmux?.killSession(entry.session!);
        } catch (err) {
          this.view?.log?.(`closing ${entry.alias}: kill-session ${entry.session} failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        forget(id, entry);
      }
      // The layout goes too (panes split by hand live in it) — unless it shows
      // another window's agents, whose panes must stay.
      for (const [cwd, panes] of layouts) {
        if (panes && [...panes.keys()].some((s) => !mine.has(s))) continue;
        await tmux?.killSession(layoutSession(cwd)).catch(() => {});
      }
      return;
    }
    // The attach client exited on its own: the layout ended (every session in
    // it did), or the client was only detached and the sessions run on.
    for (const [id, entry] of tmuxed) {
      const alive = tmux ? await tmux.hasSession(entry.session!) : false;
      if (!alive) forget(id, entry);
    }
  }
}

/**
 * The poller's lease pairs: the tmux pane pid for a tmux entry (from one
 * `panes` listing), the terminal pid for a legacy one; shells hold no lease.
 * `ended`: tmux entries whose session is gone, attached or not — an agent
 * that exits only closes its pane, and the worktree terminal stays open for
 * the rest. With `panes` unknown (the listing failed) nothing ends and tmux
 * entries skip this lease.
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
        if (panes) ended.push([id, e]);
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
