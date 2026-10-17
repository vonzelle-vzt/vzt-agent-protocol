/**
 * Attention (Orca's bell) — a `$(bell) N need you` status-bar item counting
 * every agent that needs you across all projects, plus a notification when an
 * agent this window owns goes from working to needs-you or done.
 *
 * The transition rules live in the vscode-free watcher; this file only polls
 * `bus agents --all --json` and renders.
 */

import * as vscode from "vscode";
import { BusAgentRow } from "../projects/status";
import { AttentionWatcher, needsYou, Transition } from "./watcher";

type Run = <T>(args: string[], cwd?: string) => Promise<T>;

export interface AttentionDeps {
  run: Run;
  windowId: string;
  focusLocal(agentId: string): boolean;
  openDashboard(): void;
  setBadge(n: number): void;
}

const POLL_MS = 2_000;
const OPEN_COMMAND = "vzt-mux.attention.openDashboard";

/** Accept both a bare array and `{ agents: [...] }`, whichever the CLI prints. */
function agentRows(out: unknown): BusAgentRow[] {
  if (Array.isArray(out)) return out as BusAgentRow[];
  const inner = out && (out as Record<string, unknown>).agents;
  return Array.isArray(inner) ? (inner as BusAgentRow[]) : [];
}

export function registerAttention(context: vscode.ExtensionContext, deps: AttentionDeps): void {
  const watcher = new AttentionWatcher(deps.windowId);

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = OPEN_COMMAND;
  item.tooltip = "VZT: agents that need you — open the Agent Dashboard";
  context.subscriptions.push(item, vscode.commands.registerCommand(OPEN_COMMAND, () => deps.openDashboard()));

  const notify = async (t: Transition) => {
    const text = t.to === "needs-you" ? `${t.alias} needs you` : `${t.alias} is done`;
    if ((await vscode.window.showInformationMessage(text, "Show")) === "Show") deps.focusLocal(t.agent_id);
  };

  const tick = async () => {
    let agents: BusAgentRow[];
    try {
      agents = agentRows(await deps.run<unknown>(["bus", "agents", "--all", "--json"]));
    } catch {
      return; // the Projects view already surfaces a broken CLI; keep the last count
    }
    const now = Date.now();
    const transitions = watcher.update(agents, now);
    const n = needsYou(agents, now);
    deps.setBadge(n);
    if (n > 0) {
      item.text = `$(bell) ${n} need you`;
      item.show();
    } else {
      item.hide();
    }
    if (vscode.workspace.getConfiguration("vztMux.attention").get<boolean>("notify", true)) {
      for (const t of transitions) void notify(t); // never block the poll on a toast
    }
  };

  // never more than one tick in flight (setTimeout chain, not setInterval)
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    await tick();
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  void loop();
  context.subscriptions.push({
    dispose: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
}
