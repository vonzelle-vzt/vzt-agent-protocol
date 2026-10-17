/**
 * Attention transitions for bus agents — pure, no `vscode` at runtime.
 *
 * Orca's bell rings when an agent this window owns stops working and either
 * needs you or is done. The watcher diffs glyphs between polls; the first
 * sighting of an agent only seeds its glyph, so opening a window never floods
 * it with notifications for work that finished before it was looking.
 */

import { BusAgentRow, Glyph, glyphFor } from "../projects/status";

export interface Transition {
  agent_id: string;
  alias: string;
  project: string;
  to: "needs-you" | "done";
}

const BUSY: ReadonlySet<Glyph> = new Set<Glyph>(["working", "launching"]);

export class AttentionWatcher {
  private last = new Map<string, Glyph>();

  constructor(private readonly windowId: string) {}

  update(agents: BusAgentRow[], nowMs: number): Transition[] {
    const next = new Map<string, Glyph>();
    const out: Transition[] = [];
    for (const a of agents) {
      const glyph = glyphFor(a, nowMs);
      const prev = this.last.get(a.agent_id);
      next.set(a.agent_id, glyph);
      if (a.window_id !== this.windowId || prev === undefined || !BUSY.has(prev)) continue;
      if (glyph === "needs-you" || glyph === "done") {
        out.push({ agent_id: a.agent_id, alias: a.alias, project: a.project, to: glyph });
      }
    }
    this.last = next; // agents missing from this poll are forgotten
    return out;
  }
}

/** Every agent needing you, across all projects — not just this window's. */
export function needsYou(agents: BusAgentRow[], nowMs: number): number {
  return agents.filter((a) => glyphFor(a, nowMs) === "needs-you").length;
}
