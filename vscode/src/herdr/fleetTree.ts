/**
 * The herdr fleet as a VS Code tree: workspaces -> tabs -> agents.
 *
 * This is the one thing VS Code fundamentally cannot show you today — which of
 * your agents is working, which is blocked on you, and where each one lives.
 *
 * Deliberately a pure READER of FleetModel. It holds no state of its own, so it
 * cannot disagree with the daemon about what is running. Same discipline as
 * shipTree.ts, and the icon vocabulary is shared with it on purpose: `blocked`
 * is amber in both trees because it means the same thing in both — a human is
 * the blocker.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { Agent, FleetModel } from "./model";
import type { ConnectionState } from "./client";
import type { AgentStatus, TabInfo, WorkspaceInfo } from "./types.gen";

const ICONS: Record<AgentStatus, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon("sync~spin"),
  // Amber, matching shipTree's `blocked`. This is the state the whole view exists
  // to surface: the agent is waiting on a human and will wait forever.
  blocked: new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow")),
  idle: new vscode.ThemeIcon("circle-outline"),
  done: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
  unknown: new vscode.ThemeIcon("question"),
};

export type FleetNode = WorkspaceNode | TabNode | AgentNode | MessageNode;

export class WorkspaceNode extends vscode.TreeItem {
  readonly nodeKind = "workspace" as const;
  constructor(readonly workspace: WorkspaceInfo, status: AgentStatus, agentCount: number) {
    super(workspace.label || `workspace ${workspace.number}`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `ws:${workspace.workspace_id}`;
    this.description = `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
    this.iconPath = ICONS[status];
    this.contextValue = "herdrWorkspace";
    const worktree = workspace.worktree;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${workspace.label}** — \`${status}\``,
        "",
        `- id: \`${workspace.workspace_id}\``,
        `- tabs: ${workspace.tab_count} · panes: ${workspace.pane_count}`,
        worktree ? `- repo: \`${worktree.repo_name}\`` : "",
        worktree ? `- checkout: \`${worktree.checkout_path}\`` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

export class TabNode extends vscode.TreeItem {
  readonly nodeKind = "tab" as const;
  constructor(readonly tab: TabInfo, status: AgentStatus) {
    super(tab.label || `tab ${tab.number}`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `tab:${tab.tab_id}`;
    this.iconPath = ICONS[status];
    this.contextValue = "herdrTab";
    this.tooltip = new vscode.MarkdownString(`**${tab.label}** — \`${status}\`\n\n- id: \`${tab.tab_id}\``);
  }
}

export class AgentNode extends vscode.TreeItem {
  readonly nodeKind = "agent" as const;
  constructor(readonly agent: Agent) {
    // `title` and `label` come back null in practice — the readable name is the
    // agent plus where it is working, so that is what we build the row from.
    super(agent.agent, vscode.TreeItemCollapsibleState.None);
    const where = agent.cwd ? path.basename(agent.cwd) : agent.terminal_title_stripped || agent.pane_id;
    this.id = `agent:${agent.pane_id}`;
    this.description = `${where} · ${agent.agent_status}`;
    this.iconPath = ICONS[agent.agent_status];
    this.contextValue = "herdrAgent";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${agent.agent}** — \`${agent.agent_status}\``,
        "",
        `- pane: \`${agent.pane_id}\``,
        agent.cwd ? `- cwd: \`${agent.cwd}\`` : "",
        agent.terminal_title_stripped ? `- terminal: ${agent.terminal_title_stripped}` : "",
        agent.focused ? "- focused in herdr" : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    this.command = {
      command: "vzt-mux.herdr.focusAgent",
      title: "Focus agent in herdr",
      arguments: [this],
    };
  }
}

/** A non-actionable row explaining why the tree is empty. */
export class MessageNode extends vscode.TreeItem {
  readonly nodeKind = "message" as const;
  constructor(label: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `msg:${label}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "herdrMessage";
    if (tooltip) this.tooltip = tooltip;
  }
}

export class FleetTreeProvider implements vscode.TreeDataProvider<FleetNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FleetNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: ConnectionState = { kind: "idle" };

  constructor(private readonly model: FleetModel) {}

  setConnectionState(state: ConnectionState): void {
    this.state = state;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: FleetNode): vscode.TreeItem {
    return node;
  }

  /**
   * Required for `reveal()` — VS Code walks parents to expand down to a node,
   * and without this the status bar's "jump to the blocked agent" silently does
   * nothing.
   */
  getParent(node: FleetNode): FleetNode | undefined {
    if (node.nodeKind === "agent") {
      const tab = this.model.getTabs(node.agent.workspace_id).find((t) => t.tab_id === node.agent.tab_id);
      return tab ? new TabNode(tab, this.model.rollUp(this.model.getAgents(tab.tab_id))) : undefined;
    }
    if (node.nodeKind === "tab") {
      const ws = this.model.getWorkspaces().find((w) => w.workspace_id === node.tab.workspace_id);
      if (!ws) return undefined;
      const agents = this.model.getAgents().filter((a) => a.workspace_id === ws.workspace_id);
      return new WorkspaceNode(ws, this.model.rollUp(agents), agents.length);
    }
    return undefined;
  }

  getChildren(node?: FleetNode): FleetNode[] {
    if (!node) {
      return this.roots();
    }
    if (node.nodeKind === "workspace") {
      return this.model.getTabs(node.workspace.workspace_id).map((tab) => {
        const agents = this.model.getAgents(tab.tab_id);
        return new TabNode(tab, this.model.rollUp(agents));
      });
    }
    if (node.nodeKind === "tab") {
      return this.model.getAgents(node.tab.tab_id).map((agent) => new AgentNode(agent));
    }
    return [];
  }

  private roots(): FleetNode[] {
    // Say WHY it is empty. "No agents" when the daemon is simply not running
    // sends you looking for a bug in the wrong place.
    switch (this.state.kind) {
      case "protocolMismatch":
        return [
          new MessageNode(
            `Protocol mismatch: daemon ${this.state.daemon}, extension ${this.state.expected}`,
            "error",
            "Run `npm run compile` in the extension to regenerate types against this herdr."
          ),
        ];
      case "offline":
        return [new MessageNode(this.state.detail, "debug-disconnect", "Reconnecting automatically.")];
      case "connecting":
        return [new MessageNode("Connecting to herdr…", "sync~spin")];
      case "idle":
        return [];
      case "connected": {
        const workspaces = this.model.getWorkspaces();
        if (workspaces.length === 0) {
          return [new MessageNode("No agents running", "circle-outline", "herdr is up but no pane has an agent on it.")];
        }
        return workspaces.map((ws) => {
          const agents = this.model.getAgents().filter((a) => a.workspace_id === ws.workspace_id);
          return new WorkspaceNode(ws, this.model.rollUp(agents), agents.length);
        });
      }
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
