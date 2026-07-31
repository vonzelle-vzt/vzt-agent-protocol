/**
 * Assembles the Herdr Fleet surface and — the load-bearing part — keeps it LAZY.
 *
 * The host extension activates on `onStartupFinished` because it has to: it
 * polls the ship queue for work the CLI drops in. The fleet layer has no such
 * excuse. If it connected at activation, every VS Code window would open a unix
 * socket and hold a subscription for a panel most of them never show.
 *
 * So: the tree provider is registered at activation (cheap — VS Code needs it to
 * draw the view container), but nothing touches the socket until the view first
 * becomes visible, and the held connection is dropped again when it is hidden.
 * A fleet panel nobody opened costs nothing.
 */

import * as vscode from "vscode";
import { HerdrClient } from "./client";
import { FLEET_SUBSCRIPTIONS, FleetModel } from "./model";
import { AgentNode, FleetTreeProvider, type FleetNode } from "./fleetTree";
import { FleetStatusBar } from "./status";

export const VIEW_ID = "herdrFleet.agents";

export function registerHerdrFleet(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  if (vscode.workspace.getConfiguration("vztMux").get<boolean>("herdr.enabled") === false) {
    log.appendLine("[herdr] fleet view disabled by vztMux.herdr.enabled");
    return;
  }

  const model = new FleetModel();
  const client = new HerdrClient(log);
  const tree = new FleetTreeProvider(model);
  const status = new FleetStatusBar(model);

  const view = vscode.window.createTreeView<FleetNode>(VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(view, tree, model, client, status);

  // --- wiring: daemon -> model -> view ------------------------------------

  context.subscriptions.push(
    client.onDidSeed((snapshot) => {
      model.seed(snapshot);
      log.appendLine(
        `[herdr] seeded: ${snapshot.workspaces.length} workspaces, ${snapshot.agents.length} agents ` +
          `(herdr ${snapshot.version}, protocol ${snapshot.protocol})`
      );
    }),

    client.onDidReceiveEvent((event) => model.apply(event)),

    client.onDidChangeState((state) => {
      // Losing the daemon must empty the model. Leaving the last-known fleet on
      // screen after herdr dies is worse than showing nothing — it looks live.
      if (state.kind === "offline" || state.kind === "protocolMismatch") {
        model.clear();
      }
      tree.setConnectionState(state);
      status.update(state);
    }),

    model.onDidChange(() => {
      tree.refresh();
      status.update(client.getState());
    })
  );

  // --- laziness ------------------------------------------------------------

  const syncVisibility = () => {
    if (view.visible) {
      client.start(FLEET_SUBSCRIPTIONS);
    } else {
      client.stop();
    }
  };
  context.subscriptions.push(view.onDidChangeVisibility(syncVisibility));
  // A view can already be visible at activation when the user reloads with the
  // container open — VS Code will not fire onDidChangeVisibility for that.
  syncVisibility();

  // --- commands ------------------------------------------------------------

  context.subscriptions.push(
    // The only write this extension makes to herdr.
    vscode.commands.registerCommand("vzt-mux.herdr.focusAgent", async (node?: AgentNode) => {
      if (!node?.agent) {
        return;
      }
      try {
        await client.focusPane(node.agent.pane_id);
      } catch (err) {
        vscode.window.showWarningMessage(`Herdr: could not focus ${node.agent.pane_id} — ${err}`);
      }
    }),

    vscode.commands.registerCommand("vzt-mux.herdr.refresh", async () => {
      // A manual re-seed, for when you want to be sure rather than trust the
      // stream. Not a substitute for events — nothing calls this on a timer.
      try {
        model.seed(await client.snapshot());
      } catch (err) {
        vscode.window.showWarningMessage(`Herdr: refresh failed — ${err}`);
      }
    }),

    vscode.commands.registerCommand("vzt-mux.herdr.revealBlocked", async () => {
      const blocked = model.getAgents().find((a) => a.agent_status === "blocked");
      if (!blocked) {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        return;
      }
      await view.reveal(new AgentNode(blocked), { select: true, focus: true, expand: true });
    })
  );
}
