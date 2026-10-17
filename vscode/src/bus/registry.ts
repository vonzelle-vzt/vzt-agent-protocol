/**
 * The agents THIS extension host launched: agent_id → its alias, the folder it
 * runs in, and its terminal.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs can drive it with fake terminals.
 *
 * `onChange` gets the saved form (no terminals) after every change, so the
 * window can persist it and restore its agents after a reload (restore.ts).
 */

import type * as vscode from "vscode";

export interface RegistryEntry {
  alias: string;
  kind: "claude" | "codex";
  cwd: string;
  terminal: vscode.Terminal;
}

export interface SavedAgent {
  agent_id: string;
  alias: string;
  kind: "claude" | "codex";
  cwd: string;
}

export class AgentRegistry {
  private readonly agents = new Map<string, RegistryEntry>();

  constructor(private readonly onChange: (saved: SavedAgent[]) => void = () => {}) {}

  private changed(): void {
    this.onChange([...this.agents].map(([agent_id, { alias, kind, cwd }]) => ({ agent_id, alias, kind, cwd })));
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

  /** Show the agent's terminal. False when the id is unknown or its terminal has exited. */
  focus(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry || entry.terminal.exitStatus !== undefined) return false;
    entry.terminal.show(false);
    return true;
  }
}
