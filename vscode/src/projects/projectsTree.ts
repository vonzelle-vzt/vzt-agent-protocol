/**
 * Projects view (`vztProjects`) — registered projects → git worktrees → bus agents,
 * each with Orca's status glyphs.
 *
 * A pure reader of `projects list --json` and `bus agents --all --json`; the
 * join and the glyph rules live in the vscode-free model/status modules. One
 * VS Code window per project: openWindow reveals this window when it already
 * holds the project, else asks VS Code to open (or focus) the project's own.
 * Terminals belong to one window, so focusing another window's agent goes
 * through a focus request file that the owning window claims (focus.ts).
 */

import * as vscode from "vscode";
import { BusAgentRow, GLYPH_ICON, Glyph } from "./status";
import { AgentNode, buildProjectTree, ProjectEntry, ProjectNode, TreeNode } from "./model";
import { claimFocus, requestFocus } from "./focus";

type Run = <T>(args: string[], cwd?: string) => Promise<T>;

export interface ProjectsDeps {
  run: Run;
  windowId: string;
  baseDir: string;
  focusLocal(agentId: string): boolean;
}

export interface ProjectsApi {
  refresh(): void;
  setBadge(n: number): void;
  focusAgent(agent: BusAgentRow): Promise<void>;
}

const POLL_MS = 3_000;
const CLAIM_MS = 1_000;

type Node = TreeNode | { kind: "error"; text: string };

function glyphIcon(g: Glyph | null): vscode.ThemeIcon | undefined {
  if (!g) return undefined;
  const { codicon, color } = GLYPH_ICON[g];
  return new vscode.ThemeIcon(codicon, color ? new vscode.ThemeColor(color) : undefined);
}

/** Accept both a bare array and `{ <key>: [...] }`, whichever the CLI prints. */
function rows<T>(out: unknown, key: string): T[] {
  if (Array.isArray(out)) return out as T[];
  const inner = out && (out as Record<string, unknown>)[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

class ProjectsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  projects: ProjectEntry[] = [];
  agents: BusAgentRow[] = [];
  private roots: Node[] = [];
  private loaded = false;

  constructor(private readonly run: Run) {}

  private inFlight = false;

  /** Re-read projects and agents, then redraw. Never throws: a failure is one error node. */
  async reload(): Promise<void> {
    if (this.inFlight) return; // a slow CLI must not stack polls
    this.inFlight = true;
    try {
      const [p, a] = await Promise.all([
        this.run<unknown>(["projects", "list", "--json"]),
        this.run<unknown>(["bus", "agents", "--all", "--json"]),
      ]);
      this.projects = rows<ProjectEntry>(p, "projects");
      this.agents = rows<BusAgentRow>(a, "agents");
      this.roots = buildProjectTree(this.projects, this.agents, Date.now());
    } catch (err) {
      this.roots = [{ kind: "error", text: err instanceof Error ? err.message : String(err) }];
    } finally {
      this.inFlight = false;
    }
    this.loaded = true;
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.loaded ? this.roots : [];
    switch (node.kind) {
      case "unregistered":
        return node.projects;
      case "project":
        return node.worktrees;
      case "worktree":
        return node.agents;
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { Expanded, Collapsed } = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case "error": {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        item.tooltip = node.text;
        return item;
      }
      case "unregistered": {
        const item = new vscode.TreeItem(node.label, Collapsed);
        item.iconPath = glyphIcon(node.rollup) ?? new vscode.ThemeIcon("question");
        item.tooltip = "Agents whose project is not in ~/.vzt/projects.json — add it with VZT: Add Project.";
        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(node.name, node.worktrees.length ? Expanded : vscode.TreeItemCollapsibleState.None);
        item.description = node.exists ? node.root : `${node.root} · missing`;
        item.iconPath = glyphIcon(node.rollup) ?? new vscode.ThemeIcon(node.exists ? "repo" : "warning");
        item.tooltip = node.registered ? `${node.root}\nbase: ${node.baseRef}` : node.root;
        item.contextValue = node.registered ? "vztProject" : "vztProjectUnregistered";
        if (node.registered) {
          item.command = { command: "vzt-mux.projects.openWindow", title: "Open Project Window", arguments: [node] };
        }
        return item;
      }
      case "worktree": {
        const label = node.branch ?? (node.known ? `(detached ${node.head.slice(0, 7)})` : node.path);
        const item = new vscode.TreeItem(label, node.agents.length ? Expanded : vscode.TreeItemCollapsibleState.None);
        const parts = [node.main ? "main" : "", node.agents.length ? `${node.agents.length} agent(s)` : ""];
        item.description = parts.filter(Boolean).join(" · ");
        item.iconPath = glyphIcon(node.rollup) ?? new vscode.ThemeIcon("git-branch");
        item.tooltip = node.path;
        item.contextValue = "vztWorktree";
        return item;
      }
      case "agent":
        return agentItem(node);
    }
  }
}

function agentItem(node: AgentNode): vscode.TreeItem {
  const a = node.agent;
  const item = new vscode.TreeItem(a.alias);
  const parts: string[] = [a.kind, node.glyph];
  if (a.unread) parts.push(`${a.unread} unread`);
  if (a.wake_unconfirmed) parts.push("wake unconfirmed");
  item.description = parts.join(" · ");
  item.iconPath = glyphIcon(node.glyph);
  item.tooltip = new vscode.MarkdownString(
    [`**${a.alias}** (${a.kind})`, "", `- status: ${node.glyph}`, `- state: ${a.state}`, `- liveness: ${a.liveness}`, `- worktree: ${a.workspace}`].join("\n")
  );
  item.contextValue = "vztProjectAgent";
  item.command = { command: "vzt-mux.projects.focusAgent", title: "Focus Agent", arguments: [node] };
  return item;
}

function asAgent(arg: unknown): BusAgentRow | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const n = arg as Partial<AgentNode> & Partial<BusAgentRow>;
  if (n.kind === "agent" && n.agent) return n.agent;
  return typeof n.agent_id === "string" ? (n as BusAgentRow) : undefined;
}

function thisWindowHolds(root: string): boolean {
  return (vscode.workspace.workspaceFolders || []).some((f) => f.uri.fsPath === root);
}

export function registerProjects(context: vscode.ExtensionContext, deps: ProjectsDeps): ProjectsApi {
  const provider = new ProjectsTreeProvider(deps.run);
  const view = vscode.window.createTreeView("vztProjects", { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(view);

  const refresh = () => void provider.reload();

  async function pickProject(arg: unknown): Promise<ProjectNode | ProjectEntry | undefined> {
    const n = arg as Partial<ProjectNode> | undefined;
    if (n && typeof n.root === "string" && typeof n.name === "string") return n as ProjectNode;
    const pick = await vscode.window.showQuickPick(
      provider.projects.map((p) => ({ label: p.name, description: p.root, project: p })),
      { placeHolder: "Project" }
    );
    return pick?.project;
  }

  async function openWindow(project: { root: string } | undefined): Promise<void> {
    if (!project) return;
    if (thisWindowHolds(project.root)) {
      await vscode.commands.executeCommand("workbench.view.explorer");
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(project.root), { forceNewWindow: true });
  }

  async function focusAgent(agent: BusAgentRow): Promise<void> {
    if (agent.window_id === deps.windowId && deps.focusLocal(agent.agent_id)) return;
    try {
      requestFocus(deps.baseDir, agent.agent_id, agent.window_id ?? "", Date.now());
    } catch (err) {
      vscode.window.showErrorMessage(`VZT: could not request focus: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const project = provider.projects.find((p) => p.root === agent.project);
    if (project) await openWindow(project);
  }

  const showError = (err: unknown) =>
    vscode.window.showErrorMessage(`VZT: ${err instanceof Error ? err.message : String(err)}`);

  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.projects.refresh", refresh),
    vscode.commands.registerCommand("vzt-mux.projects.add", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Add Project",
      });
      if (!picked?.length) return;
      try {
        await deps.run(["projects", "add", picked[0].fsPath, "--json"]);
      } catch (err) {
        showError(err);
      }
      refresh();
    }),
    vscode.commands.registerCommand("vzt-mux.projects.remove", async (arg?: unknown) => {
      const project = await pickProject(arg);
      if (!project) return;
      try {
        await deps.run(["projects", "remove", project.name, "--json"]);
      } catch (err) {
        showError(err);
      }
      refresh();
    }),
    vscode.commands.registerCommand("vzt-mux.projects.openWindow", async (arg?: unknown) =>
      openWindow(await pickProject(arg))
    ),
    vscode.commands.registerCommand("vzt-mux.projects.focusAgent", async (arg?: unknown) => {
      const agent = asAgent(arg);
      if (agent) await focusAgent(agent);
    })
  );

  // Poll only while the view is visible — each poll is two short CLI processes.
  let poll: ReturnType<typeof setInterval> | undefined;
  const syncPolling = () => {
    if (view.visible && !poll) {
      refresh();
      poll = setInterval(refresh, POLL_MS);
    } else if (!view.visible && poll) {
      clearInterval(poll);
      poll = undefined;
    }
  };
  context.subscriptions.push(view.onDidChangeVisibility(syncPolling));
  syncPolling();

  // Claim focus requests other windows wrote for agents this window owns.
  const claim = setInterval(() => {
    for (const id of claimFocus(deps.baseDir, deps.windowId, Date.now())) deps.focusLocal(id);
  }, CLAIM_MS);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(claim);
      if (poll) clearInterval(poll);
    },
  });

  return {
    refresh,
    setBadge(n: number) {
      view.badge = n > 0 ? { value: n, tooltip: "agents need you" } : undefined;
    },
    focusAgent,
  };
}
