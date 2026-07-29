/**
 * VZT Ship Run tree — the orchestration view Herdr structurally cannot provide.
 *
 * Herdr is excellent at what it does (persistent named panes, remote attach, a
 * cross-project workspace), but its panes live OUTSIDE the editor process. That
 * makes three things impossible from inside VS Code:
 *   - seeing a unit's git worktree diff WHILE the unit is still writing it
 *   - jumping from a unit to its terminal without leaving the window
 *   - re-running a unit's oracle without retyping it
 *
 * This tree does those. It is a pure READER of the same filesystem contract the
 * CLI backend already writes (~/.vzt/vscode-mux), so it holds no state of its
 * own and cannot disagree with ship-watch about what happened:
 *
 *   units/<key>.json    persistent unit record (title, cwd, machineCheck)
 *   state/<key>.started agent's claude process booted
 *   state/<key>.blocked sitting on a permission prompt
 *   state/<key>.idle    turn finished
 *   state/<key>.status  "PASS" | "FAIL" — ship-watch's verdict
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type UnitState = "queued" | "working" | "blocked" | "finished" | "PASS" | "FAIL";

export interface UnitRecord {
  unitKey: string;
  slug: string;
  id: string;
  title: string;
  cwd: string;
  machineCheck: string;
  expect: string;
  dispatchedAt: string;
}

export function baseDir(): string {
  return process.env.VZT_VSCODE_DIR || path.join(os.homedir(), ".vzt", "vscode-mux");
}

/**
 * Derive a unit's state from the sentinels, most-decided first.
 *
 * Order matters: a verdict beats liveness. A unit can hold BOTH `.idle` and
 * `.status`, and the status is the one that means something to a human.
 */
export function deriveState(stateDir: string, key: string): UnitState {
  const has = (ext: string) => fs.existsSync(path.join(stateDir, `${key}.${ext}`));
  if (has("status")) {
    try {
      const v = fs.readFileSync(path.join(stateDir, `${key}.status`), "utf8").trim();
      if (v === "PASS" || v === "FAIL") return v;
    } catch {
      /* fall through */
    }
  }
  if (has("idle")) return "finished";
  if (has("blocked")) return "blocked";
  if (has("started")) return "working";
  return "queued";
}

const ICONS: Record<UnitState, vscode.ThemeIcon> = {
  queued: new vscode.ThemeIcon("circle-outline"),
  working: new vscode.ThemeIcon("sync~spin"),
  // Amber: a human is the blocker. This is the state that is completely
  // invisible today — a blocked unit emits nothing and simply hangs until the
  // unit timeout expires.
  blocked: new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow")),
  finished: new vscode.ThemeIcon("circle-filled"),
  PASS: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
  FAIL: new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red")),
};

export class UnitItem extends vscode.TreeItem {
  constructor(
    public readonly record: UnitRecord,
    public readonly state: UnitState
  ) {
    super(record.title || record.id, vscode.TreeItemCollapsibleState.None);
    this.id = record.unitKey;
    this.description = `${record.id} · ${state}`;
    this.iconPath = ICONS[state];
    this.contextValue = "vztUnit";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.title || record.id}** — \`${state}\``,
        "",
        `- run: \`${record.slug}\``,
        `- worktree: \`${record.cwd}\``,
        record.machineCheck ? `- oracle: \`${record.machineCheck}\`` : "",
        record.expect ? `- expect: ${record.expect}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

export class ShipTreeProvider implements vscode.TreeDataProvider<UnitItem> {
  private readonly _onDidChange = new vscode.EventEmitter<UnitItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: UnitItem): vscode.TreeItem {
    return el;
  }

  getChildren(): UnitItem[] {
    const unitDir = path.join(baseDir(), "units");
    const stateDir = path.join(baseDir(), "state");
    let files: string[];
    try {
      files = fs.readdirSync(unitDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const items: UnitItem[] = [];
    for (const f of files) {
      let rec: UnitRecord;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(unitDir, f), "utf8")) as UnitRecord;
      } catch {
        continue; // a half-written record on the next poll is not an error
      }
      items.push(new UnitItem(rec, deriveState(stateDir, rec.unitKey)));
    }
    // Newest run first, then unit id — so the run you just kicked is on top.
    items.sort((a, b) => {
      const t = (b.record.dispatchedAt || "").localeCompare(a.record.dispatchedAt || "");
      return t !== 0 ? t : a.record.id.localeCompare(b.record.id);
    });
    return items;
  }
}
