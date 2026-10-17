/**
 * Agent Dashboard webview — a singleton panel over `bus agents --all --json`,
 * refreshed every 2 s while visible. A card click focuses that agent, but only
 * when its id is one the panel itself last fetched.
 */

import * as crypto from "crypto";
import * as vscode from "vscode";
import type { BusAgentRow } from "../projects/status";
import { bucket, renderHtml } from "./model";

type Run = <T>(args: string[], cwd?: string) => Promise<T>;

export interface DashboardDeps {
  run: Run;
  focusAgent(agent: BusAgentRow): void;
}

const POLL_MS = 2_000;

let current: vscode.WebviewPanel | undefined;

function rows(out: unknown): BusAgentRow[] {
  if (Array.isArray(out)) return out as BusAgentRow[];
  const inner = out && (out as Record<string, unknown>).agents;
  return Array.isArray(inner) ? (inner as BusAgentRow[]) : [];
}

export function openDashboard(context: vscode.ExtensionContext, deps: DashboardDeps): vscode.WebviewPanel {
  if (current) {
    current.reveal();
    return current;
  }
  const panel = vscode.window.createWebviewPanel("vztAgentDashboard", "Agent Dashboard", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  current = panel;

  let agents: BusAgentRow[] = [];
  let showIdle = false;
  let lastBoard = "";

  // Reassigning html reloads the webview, so only do it when the board changed.
  const render = (force = false) => {
    const board = bucket(agents, Date.now(), showIdle);
    const key = JSON.stringify([board, showIdle]);
    if (!force && key === lastBoard) return;
    lastBoard = key;
    panel.webview.html = renderHtml(board, {
      nonce: crypto.randomBytes(16).toString("base64"),
      cspSource: panel.webview.cspSource,
      showIdle,
    });
  };

  // A slow CLI must not stack polls (or let an older result overwrite a newer one).
  let inFlight = false;
  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      agents = rows(await deps.run<unknown>(["bus", "agents", "--all", "--json"]));
    } catch {
      // Keep the last board; the next tick retries.
    } finally {
      inFlight = false;
    }
    if (current === panel) render();
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  const syncPoll = () => {
    if (panel.visible && !poll) {
      void refresh();
      poll = setInterval(refresh, POLL_MS);
    } else if (!panel.visible && poll) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  panel.webview.onDidReceiveMessage(
    (msg: { type?: unknown; agent_id?: unknown }) => {
      if (msg?.type === "toggleIdle") {
        showIdle = !showIdle;
        render();
      } else if (msg?.type === "focus" && typeof msg.agent_id === "string") {
        const agent = agents.find((a) => a.agent_id === msg.agent_id);
        if (agent) deps.focusAgent(agent);
      }
    },
    undefined,
    context.subscriptions
  );
  panel.onDidChangeViewState(syncPoll, undefined, context.subscriptions);
  panel.onDidDispose(
    () => {
      if (poll) clearInterval(poll);
      poll = undefined;
      if (current === panel) current = undefined;
    },
    undefined,
    context.subscriptions
  );

  render(true);
  syncPoll();
  return panel;
}
