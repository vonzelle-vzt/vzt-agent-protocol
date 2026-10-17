/**
 * Orca status glyphs for bus agents — pure, no `vscode` at runtime.
 *
 * The bus only knows `idle`; Orca splits it into Done (finished recently) and
 * Idle (quiet for 30 min). That split, and the rollup a worktree or project
 * shows for its agents, live here so the tree, the attention watcher and the
 * dashboard cannot disagree about what an agent's state means.
 */

export interface BusAgentRow {
  agent_id: string;
  workspace: string;
  project: string;
  alias: string;
  kind: "claude" | "codex";
  state: "launching" | "working" | "idle" | "blocked";
  state_ts_ms: number;
  liveness: "live" | "stale" | "never-started";
  wake_unconfirmed: boolean;
  unread: number;
  window_id: string | null;
}

export type Glyph = "working" | "needs-you" | "done" | "idle" | "stale" | "launching";

export const DONE_WINDOW_MS = 30 * 60_000;

/** Most-decided first: a lapsed lease beats any state the row still claims. */
export function glyphFor(a: BusAgentRow, nowMs: number): Glyph {
  if (a.liveness !== "live") return "stale";
  if (a.state === "blocked") return "needs-you";
  if (a.state === "working") return "working";
  if (a.state === "launching") return "launching";
  return nowMs - a.state_ts_ms < DONE_WINDOW_MS ? "done" : "idle";
}

const PRECEDENCE: Glyph[] = ["needs-you", "working", "launching", "done", "idle", "stale"];

/** The glyph a parent shows: its most urgent child, or null when it has none. */
export function rollup(glyphs: Glyph[]): Glyph | null {
  for (const g of PRECEDENCE) if (glyphs.includes(g)) return g;
  return null;
}

export const GLYPH_ICON: Record<Glyph, { codicon: string; color?: string }> = {
  working: { codicon: "sync~spin" },
  "needs-you": { codicon: "question", color: "charts.yellow" },
  done: { codicon: "pass", color: "charts.green" },
  idle: { codicon: "circle-outline", color: "disabledForeground" },
  stale: { codicon: "error", color: "charts.red" },
  launching: { codicon: "loading~spin" },
};
