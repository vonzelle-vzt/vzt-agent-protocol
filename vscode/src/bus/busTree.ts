/**
 * Agent Bus view (`vztBus`) — the paired agents and their message threads.
 *
 * A pure reader of `bus agents --json` and `bus inbox --json`; it holds no state
 * of its own. Message bodies are never shown (the inbox does not carry them):
 * the tree is for "who is up, who is stuck, what is moving", not for reading mail.
 */

import * as vscode from "vscode";
import { BusCli } from "./busCli";

export interface BusAgent {
  agent_id: string;
  alias: string;
  kind: string;
  state: string;
  liveness: "live" | "stale" | "never-started";
  wake_unconfirmed: boolean;
  unread: number;
  window_id: string;
}

export interface BusThreadMessage {
  id: string;
  seq: number;
  type: string;
  from: string;
  to: string;
  subject: string;
  state: string;
}

export interface BusThread {
  thread_id: string;
  subject: string;
  participants: string[];
  count: number;
  messages: BusThreadMessage[];
}

type Node =
  | { kind: "group"; group: "agents" | "threads" }
  | { kind: "agent"; agent: BusAgent }
  | { kind: "thread"; thread: BusThread }
  | { kind: "message"; message: BusThreadMessage }
  | { kind: "error"; text: string };

export class BusTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private agents: BusAgent[] = [];
  private threads: BusThread[] = [];
  private error: string | null = null;
  private loaded = false;

  constructor(private readonly bus: BusCli, private readonly cwd: () => string | undefined) {}

  /** Re-read agents and threads from the bus, then redraw. */
  async reload(): Promise<void> {
    const cwd = this.cwd();
    if (!cwd) {
      this.error = "Open a folder to use the agent bus.";
    } else {
      try {
        const [a, i] = await Promise.all([
          this.bus.run<{ agents: BusAgent[] }>(["agents"], cwd),
          this.bus.run<{ threads: BusThread[] }>(["inbox"], cwd),
        ]);
        this.agents = a.agents || [];
        this.threads = i.threads || [];
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    }
    this.loaded = true;
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (!this.loaded) return [];
      const roots: Node[] = [];
      if (this.error) roots.push({ kind: "error", text: this.error });
      if (this.agents.length || this.threads.length) {
        roots.push({ kind: "group", group: "agents" }, { kind: "group", group: "threads" });
      }
      return roots;
    }
    if (node.kind === "group") {
      return node.group === "agents"
        ? this.agents.map((agent) => ({ kind: "agent" as const, agent }))
        : this.threads.map((thread) => ({ kind: "thread" as const, thread }));
    }
    if (node.kind === "thread") {
      return node.thread.messages.map((message) => ({ kind: "message" as const, message }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "error": {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        item.tooltip = node.text;
        return item;
      }
      case "group": {
        const label = node.group === "agents" ? `Agents (${this.agents.length})` : `Threads (${this.threads.length})`;
        return new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      }
      case "agent":
        return agentItem(node.agent);
      case "thread": {
        const t = node.thread;
        const item = new vscode.TreeItem(t.subject, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${t.participants.join(" ↔ ")} · ${t.count}`;
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.contextValue = "vztBusThread";
        return item;
      }
      case "message": {
        const m = node.message;
        const item = new vscode.TreeItem(`#${m.seq} ${m.type}: ${m.subject}`);
        item.description = `${m.from} → ${m.to} · ${m.state}`;
        item.iconPath = new vscode.ThemeIcon(m.type === "task" ? "tasklist" : m.type === "question" ? "question" : "mail");
        return item;
      }
    }
  }
}

function agentItem(a: BusAgent): vscode.TreeItem {
  const item = new vscode.TreeItem(a.alias);
  const parts = [a.kind, a.liveness, a.state];
  if (a.unread) parts.push(`${a.unread} unread`);
  if (a.wake_unconfirmed) parts.push("wake unconfirmed");
  item.description = parts.join(" · ");
  item.contextValue = "vztBusAgent";

  const tooltip = new vscode.MarkdownString(
    [`**${a.alias}** (${a.kind})`, "", `- liveness: ${a.liveness}`, `- state: ${a.state}`, `- unread: ${a.unread}`].join("\n")
  );
  if (a.wake_unconfirmed) {
    tooltip.appendMarkdown(
      "\n\n⚠️ A wake-up was typed but the agent never submitted it. No more wakes until its next turn ends — check the terminal."
    );
  }
  if (a.liveness === "never-started") {
    tooltip.appendMarkdown("\n\n❌ Registered but the agent session never started — dispatch failed.");
  }
  item.tooltip = tooltip;

  if (a.liveness === "never-started") {
    item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  } else if (a.wake_unconfirmed) {
    item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
  } else if (a.liveness === "stale") {
    item.iconPath = new vscode.ThemeIcon("circle-outline");
  } else if (a.state === "blocked") {
    item.iconPath = new vscode.ThemeIcon("lock", new vscode.ThemeColor("problemsWarningIcon.foreground"));
  } else if (a.state === "working" || a.state === "launching") {
    item.iconPath = new vscode.ThemeIcon("sync~spin");
  } else {
    item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
  }
  return item;
}
