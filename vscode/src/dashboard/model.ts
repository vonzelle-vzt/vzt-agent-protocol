/**
 * Agent Dashboard model — kanban buckets and the webview document, pure, no
 * `vscode` at runtime.
 *
 * Every agent-controlled string that reaches the HTML goes through escapeHtml,
 * and only the named card fields are rendered: a row that carries anything
 * else (a message body, say) never leaks it into the page.
 */

import type { BusAgentRow } from "../projects/status";
import { glyphFor } from "../projects/status";

export interface Board {
  needsYou: BusAgentRow[];
  working: BusAgentRow[];
  done: BusAgentRow[];
  idle: BusAgentRow[];
}

const byAlias = (a: BusAgentRow, b: BusAgentRow) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);

/** Launching counts as working; stale counts as idle; idle stays empty unless shown. */
export function bucket(agents: BusAgentRow[], nowMs: number, showIdle: boolean): Board {
  const board: Board = { needsYou: [], working: [], done: [], idle: [] };
  for (const a of agents) {
    switch (glyphFor(a, nowMs)) {
      case "needs-you":
        board.needsYou.push(a);
        break;
      case "working":
      case "launching":
        board.working.push(a);
        break;
      case "done":
        board.done.push(a);
        break;
      default:
        if (showIdle) board.idle.push(a);
    }
  }
  for (const col of Object.values(board)) col.sort(byAlias);
  return board;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function basename(p: string): string {
  const parts = String(p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? "");
}

function card(a: BusAgentRow): string {
  const unread = Number(a.unread) || 0;
  return (
    `<li class="card" data-agent-id="${escapeHtml(a.agent_id)}" tabindex="0">` +
    `<div class="alias">${escapeHtml(a.alias)} <span class="kind">${escapeHtml(a.kind)}</span>` +
    (unread > 0 ? ` <span class="unread">${escapeHtml(String(unread))}</span>` : "") +
    `</div>` +
    `<div class="where">${escapeHtml(basename(a.project))} / ${escapeHtml(basename(a.workspace))}</div>` +
    `</li>`
  );
}

function column(title: string, agents: BusAgentRow[]): string {
  return (
    `<section class="col"><h2>${escapeHtml(title)} <span class="count">${agents.length}</span></h2>` +
    `<ul>${agents.map(card).join("")}</ul></section>`
  );
}

export function renderHtml(board: Board, opts: { nonce: string; cspSource: string; showIdle: boolean }): string {
  const nonce = escapeHtml(opts.nonce);
  const csp =
    `default-src 'none'; style-src ${escapeHtml(opts.cspSource)} 'unsafe-inline'; ` + `script-src 'nonce-${nonce}'`;
  const cols = [
    column("Needs You", board.needsYou),
    column("Working", board.working),
    column("Done", board.done),
    ...(opts.showIdle ? [column("Idle", board.idle)] : []),
  ].join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Dashboard</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; }
  .bar { margin-bottom: 8px; }
  .board { display: flex; gap: 8px; align-items: flex-start; }
  .col { flex: 1; min-width: 0; background: var(--vscode-sideBar-background); border-radius: 4px; padding: 6px; }
  h2 { font-size: 12px; text-transform: uppercase; margin: 0 0 6px; }
  .count { opacity: 0.6; }
  ul { list-style: none; margin: 0; padding: 0; }
  .card { padding: 6px; margin-bottom: 6px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .card:hover, .card:focus { outline: 1px solid var(--vscode-focusBorder); }
  .kind { opacity: 0.7; font-size: 11px; }
  .unread { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .where { opacity: 0.7; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<div class="bar"><button id="toggleIdle">${opts.showIdle ? "Hide idle" : "Show idle"}</button></div>
<div class="board">${cols}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById("toggleIdle").addEventListener("click", () => vscode.postMessage({ type: "toggleIdle" }));
  const focus = (el) => { if (el) vscode.postMessage({ type: "focus", agent_id: el.dataset.agentId }); };
  document.addEventListener("click", (e) => focus(e.target.closest(".card")));
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") focus(e.target.closest && e.target.closest(".card")); });
</script>
</body>
</html>`;
}
