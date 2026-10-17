/**
 * The agents THIS extension host launched: agent_id → its alias, the folder it
 * runs in, and its terminal.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs can drive it with fake terminals.
 *
 * Terminals die with the window, so this never needs persisting: a reload
 * re-spawns and the bus hands back the same agent_ids with their queues intact.
 */

import type * as vscode from "vscode";

export interface RegistryEntry {
  alias: string;
  cwd: string;
  terminal: vscode.Terminal;
}

export class AgentRegistry {
  private readonly agents = new Map<string, RegistryEntry>();

  set(id: string, entry: RegistryEntry): void {
    this.agents.set(id, entry);
  }

  get(id: string): RegistryEntry | undefined {
    return this.agents.get(id);
  }

  delete(id: string): boolean {
    return this.agents.delete(id);
  }

  entries(): IterableIterator<[string, RegistryEntry]> {
    return this.agents.entries();
  }

  get size(): number {
    return this.agents.size;
  }

  /** Forget every agent that ran in `terminal` (it closed; its lease lapses → stale). */
  removeTerminal(terminal: vscode.Terminal): void {
    for (const [id, entry] of this.agents) {
      if (entry.terminal === terminal) this.agents.delete(id);
    }
  }

  /** Show the agent's terminal. False when the id is unknown or its terminal has exited. */
  focus(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry || entry.terminal.exitStatus !== undefined) return false;
    entry.terminal.show(false);
    return true;
  }
}
