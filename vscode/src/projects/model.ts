/**
 * Projects tree model — project → worktree → agent, pure, no `vscode` at runtime.
 *
 * Joins `projects list --json` with `bus agents --all --json`. An agent lands in
 * the worktree whose path equals its bus workspace; both sides are realpath'd by
 * the CLI, so plain string equality is the whole join.
 */

import { BusAgentRow, Glyph, glyphFor, rollup } from "./status";

const PRECEDENCE: Glyph[] = ["needs-you", "working", "launching", "done", "idle", "stale"];

/** Orca-style age: now, 5m, 3h, 1d. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export interface WorktreeRow {
  label: string;
  primary: boolean;
  glyph: Glyph | null;
  activity: string | null;
}

/** What a worktree line shows: branch, primary tag, rollup glyph, busiest agent. */
export function worktreeRow(
  wt: { path: string; branch: string | null; main: boolean },
  agents: BusAgentRow[],
  nowMs: number
): WorktreeRow {
  const scored = agents.map((a) => ({ a, g: glyphFor(a, nowMs) }));
  let best: { a: BusAgentRow; g: Glyph } | undefined;
  for (const c of scored) {
    if (
      !best ||
      PRECEDENCE.indexOf(c.g) < PRECEDENCE.indexOf(best.g) ||
      (c.g === best.g && c.a.state_ts_ms > best.a.state_ts_ms)
    ) {
      best = c;
    }
  }
  return {
    label: wt.branch ?? (wt.path.split("/").filter(Boolean).pop() || wt.path),
    primary: wt.main,
    glyph: rollup(scored.map((c) => c.g)),
    activity: best ? `${best.a.alias} ${best.g} · ${formatAge(nowMs - best.a.state_ts_ms)}` : null,
  };
}

export interface ProjectEntry {
  name: string;
  root: string;
  baseRef: string;
  exists: boolean;
  worktrees: { path: string; branch: string | null; head: string; main: boolean }[];
}

export interface AgentNode {
  kind: "agent";
  agent: BusAgentRow;
  glyph: Glyph;
}

export interface WorktreeNode {
  kind: "worktree";
  path: string;
  branch: string | null;
  head: string;
  main: boolean;
  /** False when the bus knows the workspace but `git worktree list` does not. */
  known: boolean;
  agents: AgentNode[];
  rollup: Glyph | null;
  row: WorktreeRow;
}

export interface ProjectNode {
  kind: "project";
  name: string;
  root: string;
  baseRef: string;
  exists: boolean;
  registered: boolean;
  worktrees: WorktreeNode[];
  rollup: Glyph | null;
}

export interface UnregisteredNode {
  kind: "unregistered";
  label: "Unregistered projects";
  projects: ProjectNode[];
  rollup: Glyph | null;
}

export type TreeNode = ProjectNode | WorktreeNode | AgentNode | UnregisteredNode;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function worktreeOrder(a: WorktreeNode, b: WorktreeNode): number {
  if (a.main !== b.main) return a.main ? -1 : 1;
  return byText(a.branch ?? a.path, b.branch ?? b.path);
}

function agentNodes(agents: BusAgentRow[], nowMs: number): AgentNode[] {
  return agents
    .slice()
    .sort((a, b) => byText(a.alias, b.alias))
    .map((agent) => ({ kind: "agent" as const, agent, glyph: glyphFor(agent, nowMs) }));
}

function worktreeNode(
  wt: { path: string; branch: string | null; head: string; main: boolean },
  known: boolean,
  agents: BusAgentRow[],
  nowMs: number
): WorktreeNode {
  const nodes = agentNodes(agents, nowMs);
  return {
    kind: "worktree",
    ...wt,
    known,
    agents: nodes,
    rollup: rollup(nodes.map((n) => n.glyph)),
    row: worktreeRow(wt, agents, nowMs),
  };
}

/** Workspaces holding agents that no listed worktree claims, as synthetic worktree nodes. */
function strayWorktrees(agents: BusAgentRow[], claimed: Set<string>, root: string, nowMs: number): WorktreeNode[] {
  const byWorkspace = new Map<string, BusAgentRow[]>();
  for (const a of agents) {
    if (claimed.has(a.workspace)) continue;
    byWorkspace.set(a.workspace, [...(byWorkspace.get(a.workspace) || []), a]);
  }
  return [...byWorkspace].map(([ws, rows]) =>
    worktreeNode({ path: ws, branch: null, head: "", main: ws === root }, false, rows, nowMs)
  );
}

export function buildProjectTree(
  projects: ProjectEntry[],
  agents: BusAgentRow[],
  nowMs: number
): (ProjectNode | UnregisteredNode)[] {
  const roots = new Set(projects.map((p) => p.root));
  const nodes: (ProjectNode | UnregisteredNode)[] = projects
    .slice()
    .sort((a, b) => byText(a.name, b.name))
    .map((p) => {
      const mine = agents.filter((a) => a.project === p.root);
      const paths = new Set(p.worktrees.map((w) => w.path));
      const worktrees = [
        ...p.worktrees.map((w) => worktreeNode(w, true, mine.filter((a) => a.workspace === w.path), nowMs)),
        ...strayWorktrees(mine, paths, p.root, nowMs),
      ].sort(worktreeOrder);
      return {
        kind: "project" as const,
        name: p.name,
        root: p.root,
        baseRef: p.baseRef,
        exists: p.exists,
        registered: true,
        worktrees,
        rollup: rollup(worktrees.flatMap((w) => w.agents.map((n) => n.glyph))),
      };
    });

  const strays = new Map<string, BusAgentRow[]>();
  for (const a of agents) {
    if (roots.has(a.project)) continue;
    strays.set(a.project, [...(strays.get(a.project) || []), a]);
  }
  if (strays.size) {
    const unregistered: ProjectNode[] = [...strays]
      .sort(([a], [b]) => byText(a, b))
      .map(([project, rows]) => {
        const worktrees = strayWorktrees(rows, new Set(), project, nowMs).sort(worktreeOrder);
        return {
          kind: "project" as const,
          name: project,
          root: project,
          baseRef: "",
          exists: true,
          registered: false,
          worktrees,
          rollup: rollup(worktrees.flatMap((w) => w.agents.map((n) => n.glyph))),
        };
      });
    nodes.push({
      kind: "unregistered",
      label: "Unregistered projects",
      projects: unregistered,
      rollup: rollup(unregistered.map((p) => p.rollup).filter((g): g is Glyph => g !== null)),
    });
  }
  return nodes;
}
