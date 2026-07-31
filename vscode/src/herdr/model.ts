/**
 * The fleet, as this extension understands it.
 *
 * Seeded once from `session.snapshot`, then kept live purely by events. There is
 * no timer in here and there must never be one: polling `session.snapshot` in a
 * loop works, and is the thing you regret — it burns a connection per tick and
 * still shows stale state between ticks.
 *
 * THE LIVE-STATUS MECHANISM, and why it is `pane.updated`:
 *
 *   The obvious subscription is `pane.agent_status_changed`. It is unusable for a
 *   fleet view — its params REQUIRE a `pane_id`, so there is no global form. You
 *   would have to subscribe per pane and re-subscribe on every `pane.created`,
 *   racing new panes.
 *
 *   `pane.updated` takes no `pane_id` and carries the complete `PaneInfo` on
 *   every change, `agent_status` included. Verified against herdr 0.7.5 by
 *   watching a live idle -> working transition arrive with the full payload
 *   (agent='claude', workspace_id, tab_id, cwd, the lot). So one global
 *   subscription is the entire mechanism.
 *
 * AGENTS ARE DERIVED, NOT STORED. `session.snapshot` returns both `panes` and
 * `agents`, where `agents` is just the subset of panes with a detected agent
 * (6 panes / 5 agents on the fleet this was built against). Keeping both would
 * mean two sources of truth that can disagree the moment an event updates one.
 * We keep panes and filter.
 */

import * as vscode from "vscode";
import type {
  AgentStatus,
  HerdrEventEnvelope,
  PaneInfo,
  SessionSnapshot,
  Subscription,
  TabInfo,
  WorkspaceInfo,
} from "./types.gen";

/**
 * Exactly what we subscribe to — all in global form (none of these takes a
 * `pane_id`). Deliberately narrow: `pane.output_matched` and
 * `pane.scroll_changed` would fire constantly and tell a fleet view nothing.
 */
export const FLEET_SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.updated" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.agent_detected" },
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.closed" },
];

/** A pane that has an agent on it. */
export interface Agent extends PaneInfo {
  agent: string;
}

export interface FleetCounts {
  working: number;
  blocked: number;
  idle: number;
  done: number;
  total: number;
}

/** Coalescing window for redraws. */
const COALESCE_MS = 50;

export class FleetModel implements vscode.Disposable {
  private workspaces = new Map<string, WorkspaceInfo>();
  private tabs = new Map<string, TabInfo>();
  private panes = new Map<string, PaneInfo>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private coalesceTimer: NodeJS.Timeout | undefined;

  /**
   * Replace all state from a snapshot. Used at connect and after every reconnect.
   *
   * KNOWN herdr 0.7.5 DIVERGENCE, measured not guessed: the event stream and
   * `session.snapshot` can disagree about a pane's `agent_status` and stay
   * disagreeing. Observed: seed said `idle`, the stream then pushed `working`
   * twice, and `session.snapshot` reported `idle` continuously for 12s
   * afterwards with no corrective event ever arriving.
   *
   * This model follows the STREAM, which is the right call for a live view — but
   * it means a badge can sit `working` after the daemon considers the pane idle.
   * The correction is a re-seed, and there are two without adding a poll loop:
   * hiding and re-showing the view (which disconnects and reconnects, and
   * reconnect always re-seeds), and the explicit "Herdr: Refresh Fleet" command.
   * Do NOT "fix" this with a setInterval snapshot — that is the polling the whole
   * design exists to avoid.
   */
  seed(snapshot: SessionSnapshot): void {
    this.workspaces = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w]));
    this.tabs = new Map(snapshot.tabs.map((t) => [t.tab_id, t]));
    this.panes = new Map(snapshot.panes.map((p) => [p.pane_id, p]));
    this.scheduleChange();
  }

  /** Empty the model — used when the daemon goes away, so the tree stops lying. */
  clear(): void {
    this.workspaces.clear();
    this.tabs.clear();
    this.panes.clear();
    this.scheduleChange();
  }

  apply(envelope: HerdrEventEnvelope): void {
    // The generated EventData union is discriminated on `type`, which duplicates
    // the envelope's `event`. Narrowing through the union for eleven cases buys
    // nothing over reading the fields we actually use, so this stays deliberately
    // structural — the shapes are pinned by the schema either way.
    const data = envelope.data as Record<string, unknown>;

    switch (envelope.event) {
      // A pane's agent_status arrives here. This is the whole point.
      //
      // Authoritative: a pane_updated is the daemon's current view of the pane,
      // including an agent having gone away, so it replaces wholesale.
      case "pane_updated": {
        const pane = data.pane as PaneInfo | undefined;
        if (pane?.pane_id) {
          this.panes.set(pane.pane_id, pane);
        }
        break;
      }

      // NOT authoritative about agents, and treating it as if it were is a bug
      // I shipped and then caught: herdr emits pane_created for a pane that
      // already exists, carrying `agent: null, agent_status: "unknown"` — agent
      // DETECTION runs afterwards and arrives via pane_agent_detected /
      // pane_updated. Replacing wholesale here silently dropped a live agent out
      // of the tree until its next status change. Observed repeatedly on
      // w65:p1, always the same pane, which is what gave it away as ordering
      // rather than a race.
      //
      // So: upsert, but never let a creation event downgrade an agent we have
      // already seen. Anything the payload does know still wins.
      case "pane_created": {
        const pane = data.pane as PaneInfo | undefined;
        if (!pane?.pane_id) {
          break;
        }
        const known = this.panes.get(pane.pane_id);
        this.panes.set(
          pane.pane_id,
          known?.agent && !pane.agent
            ? { ...pane, agent: known.agent, agent_status: known.agent_status }
            : pane
        );
        break;
      }
      case "pane_closed": {
        const paneId = data.pane_id as string | undefined;
        if (paneId) {
          this.panes.delete(paneId);
        }
        break;
      }
      case "pane_agent_detected": {
        // Carries the agent identity but NOT a full PaneInfo, so patch in place
        // rather than replacing — dropping the rest of the pane here would blank
        // the row until the next pane_updated.
        const paneId = data.pane_id as string | undefined;
        const existing = paneId ? this.panes.get(paneId) : undefined;
        if (existing) {
          const released = data.released === true;
          this.panes.set(existing.pane_id, {
            ...existing,
            agent: released ? null : ((data.agent as string | null | undefined) ?? existing.agent),
            agent_status: (data.final_status as AgentStatus | null | undefined) ?? existing.agent_status,
          });
        }
        break;
      }

      case "workspace_created":
      case "workspace_updated": {
        const ws = data.workspace as WorkspaceInfo | undefined;
        if (ws?.workspace_id) {
          this.workspaces.set(ws.workspace_id, ws);
        }
        break;
      }
      case "workspace_renamed": {
        const id = data.workspace_id as string | undefined;
        const existing = id ? this.workspaces.get(id) : undefined;
        if (existing) {
          this.workspaces.set(existing.workspace_id, { ...existing, label: data.label as string });
        }
        break;
      }
      case "workspace_closed": {
        const id = data.workspace_id as string | undefined;
        if (id) {
          this.workspaces.delete(id);
          // Children do not always emit their own closes, and orphans would
          // otherwise sit in the tree forever under a workspace that is gone.
          for (const [tabId, tab] of this.tabs) {
            if (tab.workspace_id === id) this.tabs.delete(tabId);
          }
          for (const [paneId, pane] of this.panes) {
            if (pane.workspace_id === id) this.panes.delete(paneId);
          }
        }
        break;
      }

      case "tab_created": {
        const tab = data.tab as TabInfo | undefined;
        if (tab?.tab_id) {
          this.tabs.set(tab.tab_id, tab);
        }
        break;
      }
      case "tab_renamed": {
        const id = data.tab_id as string | undefined;
        const existing = id ? this.tabs.get(id) : undefined;
        if (existing) {
          this.tabs.set(existing.tab_id, { ...existing, label: data.label as string });
        }
        break;
      }
      case "tab_closed": {
        const id = data.tab_id as string | undefined;
        if (id) {
          this.tabs.delete(id);
          for (const [paneId, pane] of this.panes) {
            if (pane.tab_id === id) this.panes.delete(paneId);
          }
        }
        break;
      }

      default:
        return; // subscribed to something we do not model — ignore, do not redraw
    }

    this.scheduleChange();
  }

  /**
   * Coalesce redraws. A single status flip arrives as a burst (pane_updated,
   * layout_updated, focus events), and firing per event makes a spinner icon
   * stutter and the tree lose expansion state.
   */
  private scheduleChange(): void {
    if (this.coalesceTimer) {
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      this._onDidChange.fire();
    }, COALESCE_MS);
  }

  // --- reads ---------------------------------------------------------------

  /** Workspaces that contain at least one agent, in herdr's own display order. */
  getWorkspaces(): WorkspaceInfo[] {
    const withAgents = new Set(this.getAgents().map((a) => a.workspace_id));
    return [...this.workspaces.values()]
      .filter((w) => withAgents.has(w.workspace_id))
      .sort((a, b) => a.number - b.number);
  }

  getTabs(workspaceId: string): TabInfo[] {
    const withAgents = new Set(this.getAgents().map((a) => a.tab_id));
    return [...this.tabs.values()]
      .filter((t) => t.workspace_id === workspaceId && withAgents.has(t.tab_id))
      .sort((a, b) => a.number - b.number);
  }

  getAgents(tabId?: string): Agent[] {
    const agents: Agent[] = [];
    for (const pane of this.panes.values()) {
      if (!pane.agent) continue;
      if (tabId && pane.tab_id !== tabId) continue;
      agents.push(pane as Agent);
    }
    return agents.sort((a, b) => a.pane_id.localeCompare(b.pane_id));
  }

  /**
   * Roll a container's status up from its agents, most-urgent first.
   *
   * `blocked` outranks everything because it is the only state that means a
   * human is the bottleneck — the entire reason to glance at a fleet.
   */
  rollUp(agents: Agent[]): AgentStatus {
    if (agents.some((a) => a.agent_status === "blocked")) return "blocked";
    if (agents.some((a) => a.agent_status === "working")) return "working";
    if (agents.some((a) => a.agent_status === "idle")) return "idle";
    if (agents.some((a) => a.agent_status === "done")) return "done";
    return "unknown";
  }

  counts(): FleetCounts {
    const agents = this.getAgents();
    const tally = (s: AgentStatus) => agents.filter((a) => a.agent_status === s).length;
    return {
      working: tally("working"),
      blocked: tally("blocked"),
      idle: tally("idle"),
      done: tally("done"),
      total: agents.length,
    };
  }

  dispose(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
    }
    this._onDidChange.dispose();
  }
}
