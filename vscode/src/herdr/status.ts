/**
 * `N working · N blocked` in the status bar.
 *
 * THE BLOCKED COUNT IS THE PRODUCT. Everything else here is context. A working
 * agent needs nothing from you; a blocked one is stopped dead waiting on a human
 * and will stay stopped until someone notices. This exists so that noticing
 * costs a glance instead of a context switch into another app.
 *
 * That is why it takes a warning background when blocked > 0 — the one state
 * worth interrupting you for is the one state the bar shouts about.
 */

import * as vscode from "vscode";
import type { ConnectionState } from "./client";
import type { FleetModel } from "./model";

/**
 * Left of the existing ship tally (priority 100) so the two read left-to-right
 * as one row rather than fighting for the same slot.
 */
const PRIORITY = 99;

export class FleetStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly model: FleetModel) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
    this.item.command = "vzt-mux.herdr.revealBlocked";
  }

  update(state: ConnectionState): void {
    if (state.kind === "protocolMismatch") {
      this.item.text = "$(error) herdr: protocol mismatch";
      this.item.tooltip = `Daemon speaks protocol ${state.daemon}; this extension was built for ${state.expected}.`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.show();
      return;
    }

    // A daemon that is not running is a normal state, not a warning. Hide rather
    // than sit there accusing the user of something.
    if (state.kind !== "connected") {
      this.item.hide();
      return;
    }

    const { working, blocked, total } = this.model.counts();
    this.item.text = `$(pulse) ${working} working · ${blocked} blocked`;
    this.item.backgroundColor = blocked > 0
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**herdr fleet** — ${total} agent${total === 1 ? "" : "s"}`,
        "",
        `- working: ${working}`,
        `- blocked: ${blocked}`,
        "",
        blocked > 0 ? "_Click to jump to the first blocked agent._" : "_Click to open the fleet._",
      ].join("\n")
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
