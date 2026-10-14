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

export type UnitState =
  | "waiting"
  | "queued"
  | "working"
  | "blocked"
  | "interrupted"
  | "finished"
  | "PASS"
  | "FAIL"
  | "SCOPE_BREACH";

export interface UnitRecord {
  unitKey: string;
  slug: string;
  id: string;
  title: string;
  cwd: string;
  machineCheck: string;
  expect: string;
  dispatchedAt: string;
  /** Unit ids this one consumes. Written by the CLI from the SPEC's `dependsOn`. */
  dependsOn?: string[];
  /** Dependencies whose finished work was applied into this worktree before launch. */
  seeded?: string[];
  /** 1-based dependency wave. 0/absent for a record written by a pre-0.6.0 CLI. */
  wave?: number;
  /** The seed commit this unit's own work is measured against. */
  baseSha?: string;
  filesInScope?: string[];
}

export function baseDir(): string {
  const configured = vscode.workspace.getConfiguration("vztMux").get<string>("baseDir") || "";
  return process.env.VZT_VSCODE_DIR || expandHome(configured) || path.join(os.homedir(), ".vzt", "vscode-mux");
}

function expandHome(p: string): string {
  if (!p) return "";
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
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
      if (v === "PASS" || v === "FAIL" || v === "SCOPE_BREACH") return v;
    } catch {
      /* fall through */
    }
  }
  if (has("idle")) return "finished";
  if (has("blocked")) return "blocked";
  if (has("started")) return "working";
  return "queued";
}

/**
 * When this extension host started. A unit dispatched before that timestamp
 * cannot still be running, because the terminal that was running it belonged to
 * the previous host.
 *
 * 🔴 The gap this closes. A ship unit is a VS Code INTEGRATED TERMINAL — a child
 * of the extension host. Close the window, reload it, or let the host crash, and
 * every in-flight agent dies with it. (This is exactly what herdr does not do:
 * its panes are owned by a separate daemon, which is why they survive.) But the
 * sentinels are files: `.started` stays on disk forever, `.idle` never arrives,
 * and the tree therefore showed a cheerful spinner on an agent that had been
 * dead since yesterday. "Still working" and "killed when you closed the lid"
 * looked identical, and only one of them is worth waiting for.
 */
function hostStartedAt(): number {
  try {
    const raw = fs.readFileSync(path.join(baseDir(), "host.json"), "utf8");
    const t = Date.parse(JSON.parse(raw).activatedAt);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0; // no heartbeat yet — cannot orphan anything, so don't
  }
}

/**
 * A unit's state, with two corrections the raw sentinels cannot express:
 * "waiting" (a dependency has not passed) and "interrupted" (the host that was
 * running it is gone).
 *
 * Without the first, a wave-2 unit looks identical to a wave-1 unit about to
 * start: both "queued", both idle. One is seconds away and the other is
 * deliberately held back.
 */
export function stateWithDeps(
  stateDir: string,
  rec: UnitRecord,
  verdictOf: (unitId: string) => UnitState | undefined,
  hostAt: number = hostStartedAt()
): UnitState {
  const own = deriveState(stateDir, rec.unitKey);

  // A verdict is durable — it outlives any host. Liveness is not.
  if (own === "PASS" || own === "FAIL" || own === "SCOPE_BREACH" || own === "finished") {
    return own;
  }

  // Dispatched by a host that is no longer running ⇒ its terminal is gone.
  // Only claim this when we actually know when this host started; a missing
  // heartbeat must not turn a healthy run into a wall of red.
  const dispatchedAt = Date.parse(rec.dispatchedAt || "");
  if (hostAt && Number.isFinite(dispatchedAt) && dispatchedAt < hostAt) {
    return "interrupted";
  }

  if (own !== "queued") {
    return own; // already dispatched and alive; deps are no longer the story
  }
  const unmet = (rec.dependsOn || []).filter((d) => verdictOf(d) !== "PASS");
  return unmet.length ? "waiting" : "queued";
}

const ICONS: Record<UnitState, vscode.ThemeIcon> = {
  // Grey and inert: held back on purpose, not stuck. Distinguishing this from
  // "queued" is the whole point of showing waves at all.
  waiting: new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground")),
  queued: new vscode.ThemeIcon("circle-outline"),
  working: new vscode.ThemeIcon("sync~spin"),
  // Amber: a human is the blocker. This is the state that is completely
  // invisible today — a blocked unit emits nothing and simply hangs until the
  // unit timeout expires.
  blocked: new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow")),
  // The agent is DEAD, not slow: the extension host that owned its terminal is
  // gone. Distinct from FAIL — nothing was graded, the work simply stopped.
  interrupted: new vscode.ThemeIcon("debug-disconnect", new vscode.ThemeColor("charts.orange")),
  finished: new vscode.ThemeIcon("circle-filled"),
  PASS: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
  FAIL: new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red")),
  // A breach is not "the oracle failed" — it means a unit wrote outside its
  // declared scope, which invalidates the disjointness the whole parallel
  // fan-out rests on. Same red, different icon, so it reads as its own class.
  SCOPE_BREACH: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red")),
};

/** Worst-first, so a wave's roll-up reports its most decided bad news. */
const SEVERITY: UnitState[] = [
  "SCOPE_BREACH", "FAIL", "interrupted", "blocked", "working", "queued", "waiting", "finished", "PASS",
];

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
    const deps = record.dependsOn || [];
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.title || record.id}** — \`${state}\``,
        state === "interrupted"
          ? "\n> This unit's terminal died with a previous VS Code window. Ship units are integrated terminals, so closing or reloading the window kills them. Re-dispatch it, or use `--mux herdr` for a run that survives the editor.\n"
          : "",
        "",
        `- run: \`${record.slug}\``,
        `- worktree: \`${record.cwd}\``,
        deps.length ? `- depends on: ${deps.map((d) => `\`${d}\``).join(", ")}` : "",
        // What is already in the worktree matters more than what it depends on
        // in principle: those files are present, relevant, and out of scope.
        record.seeded && record.seeded.length
          ? `- seeded with: ${record.seeded.map((d) => `\`${d}\``).join(", ")}`
          : "",
        record.baseSha ? `- base: \`${record.baseSha.slice(0, 8)}\`` : "",
        record.machineCheck ? `- oracle: \`${record.machineCheck}\`` : "",
        record.expect ? `- expect: ${record.expect}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

/** A dependency wave — the group units actually run in. */
export class WaveItem extends vscode.TreeItem {
  constructor(
    public readonly slug: string,
    public readonly wave: number,
    public readonly units: UnitItem[],
    rollUp: UnitState
  ) {
    super(`Wave ${wave}`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${slug}::wave-${wave}`;
    this.description = `${slug} · ${units.length} unit${units.length === 1 ? "" : "s"} · ${rollUp}`;
    this.iconPath = ICONS[rollUp];
    this.contextValue = "vztWave";
  }
}

export type ShipNode = WaveItem | UnitItem;

export class ShipTreeProvider implements vscode.TreeDataProvider<ShipNode> {
  private readonly _onDidChange = new vscode.EventEmitter<ShipNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: ShipNode): vscode.TreeItem {
    return el;
  }

  getChildren(el?: ShipNode): ShipNode[] {
    if (el instanceof WaveItem) {
      return el.units;
    }
    if (el) {
      return []; // a unit has no children
    }
    return this.waves();
  }

  /** Every unit on disk, grouped into its run's dependency waves. */
  private waves(): ShipNode[] {
    const unitDir = path.join(baseDir(), "units");
    const stateDir = path.join(baseDir(), "state");
    let files: string[];
    try {
      files = fs.readdirSync(unitDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const records: UnitRecord[] = [];
    for (const f of files) {
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(unitDir, f), "utf8")) as UnitRecord);
      } catch {
        continue; // a half-written record on the next poll is not an error
      }
    }

    // Dependencies are named by unit id but sentinels are keyed by unitKey, and
    // ids repeat across runs — so resolve within the record's own run.
    const byRunId = new Map<string, UnitRecord>();
    for (const r of records) {
      byRunId.set(`${r.slug}::${r.id}`, r);
    }
    const verdictOf = (slug: string) => (unitId: string): UnitState | undefined => {
      const dep = byRunId.get(`${slug}::${unitId}`);
      return dep ? deriveState(stateDir, dep.unitKey) : undefined;
    };

    const hostAt = hostStartedAt();
    const items = records.map(
      (rec) => new UnitItem(rec, stateWithDeps(stateDir, rec, verdictOf(rec.slug), hostAt))
    );
    items.sort((a, b) => {
      const t = (b.record.dispatchedAt || "").localeCompare(a.record.dispatchedAt || "");
      return t !== 0 ? t : a.record.id.localeCompare(b.record.id);
    });

    // A run written by a pre-0.6.0 CLI has no `wave` on any record. Grouping
    // those under a "Wave 0" heading would be noise about a concept that run
    // never had, so they stay a flat list exactly as before.
    const grouped: ShipNode[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const { slug, wave } = item.record;
      const gkey = `${slug}::${wave}`;
      if (!wave) {
        grouped.push(item);
        continue;
      }
      if (seen.has(gkey)) {
        continue;
      }
      seen.add(gkey);
      const members = items.filter((x) => x.record.slug === slug && x.record.wave === wave);
      grouped.push(new WaveItem(slug, wave, members, rollUp(members.map((m) => m.state))));
    }
    return grouped;
  }
}

/** The worst state among a wave's units — bad news must not hide behind a green sibling. */
export function rollUp(states: UnitState[]): UnitState {
  for (const s of SEVERITY) {
    if (states.includes(s)) {
      return s;
    }
  }
  return "PASS";
}
