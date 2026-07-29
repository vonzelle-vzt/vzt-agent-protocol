/**
 * VZT Ship Mux — thin VS Code companion for `vzt-agent ship-watch --mux vscode`.
 *
 * Contract (must match the CLI backend exactly):
 *   Base dir: ~/.vzt/vscode-mux
 *     queue/<unitKey>.json   — written by the CLI, one ship unit to launch
 *     state/<unitKey>.status — written by the CLI, contains "PASS" or "FAIL"
 *     prompts/               — referenced by queue records' cmd, not read directly here
 *     idle/*                 — written by a shell hook, NOT us; ignored entirely
 *
 * We poll both dirs on a 1s interval (plus an initial scan on activation).
 * We deliberately do NOT rely on fs.watch alone — it is unreliable cross-platform
 * (misses events on some network/volume setups, fires duplicates on others).
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ShipTreeProvider, UnitItem } from "./shipTree";

// Shape of a queue file written by the CLI.
interface QueueRecord {
  unitKey: string;
  cwd: string;
  env: Record<string, string>;
  cmd: string;
}

const POLL_INTERVAL_MS = 1000;

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

// Known terminals by unitKey, so status updates and the watch command can find them.
const terminals = new Map<string, vscode.Terminal>();

// Status files already reported, keyed filename -> mtimeMs.
//
// This was a plain Set<string> keyed on filename alone, held for the whole
// extension-host lifetime. But the CLI DELETES a stale `.status` at dispatch and
// a re-dispatched unit writes the SAME filename again — so the second run of a
// unit inside one VS Code session was silently skipped and never reached the
// output channel or the tally. Keying on mtime makes a rewrite a new event, and
// vanished files are pruned so the map cannot grow without bound.
const seenStatusFiles = new Map<string, number>();

// Running tally for the status bar.
let passCount = 0;
let failCount = 0;

function baseDir(): string {
  return path.join(os.homedir(), ".vzt", "vscode-mux");
}
function queueDir(): string {
  return path.join(baseDir(), "queue");
}
function stateDir(): string {
  return path.join(baseDir(), "state");
}
function promptsDir(): string {
  return path.join(baseDir(), "prompts");
}

function ensureDirs(): void {
  for (const dir of [baseDir(), queueDir(), stateDir(), promptsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function updateStatusBar(): void {
  statusBarItem.text = `VZT ship: ${passCount} ✓  ${failCount} ✗`;
  statusBarItem.show();
}

/**
 * Scan queue/ for new *.json files, launch a terminal for each, then delete
 * the file so it is processed exactly once. Deleting immediately (rather than
 * marking-as-seen) is the guard against double-processing across polls.
 */
function processQueue(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(queueDir());
  } catch {
    return; // dir may not exist yet on a fresh machine between polls
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir(), entry);
    let record: QueueRecord;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      record = JSON.parse(raw) as QueueRecord;
    } catch (err) {
      outputChannel.appendLine(`[ERROR] failed to read/parse queue file ${entry}: ${err}`);
      // Remove the bad file so it doesn't jam the queue forever.
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
      continue;
    }

    // Delete first so a slow terminal creation can't cause a re-scan to double-process.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone — fine
    }

    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({
        name: record.unitKey,
        cwd: record.cwd,
        env: record.env,
      });
    } catch (err) {
      // The queue record is already deleted at this point, so a throw here used
      // to lose the unit ENTIRELY and silently: no terminal, no sentinel, and
      // ship-watch waiting out the full timeout on a unit that was never
      // launched. Say so loudly instead.
      outputChannel.appendLine(`[ERROR] createTerminal failed for ${record.unitKey}: ${err}`);
      outputChannel.appendLine(`[ERROR] run it by hand:  cd ${record.cwd} && ${record.cmd}`);
      outputChannel.show(true);
      continue;
    }
    terminals.set(record.unitKey, terminal);

    terminal.show(true); // preserveFocus: true — don't steal focus aggressively

    // The queue record is already deleted by now, so ANY throw past this point
    // loses the unit permanently and silently — ship-watch then waits out its
    // whole start-grace on a sentinel that will never arrive. A TDZ bug in
    // sendWhenReady did exactly that. Never let a launch failure be quiet.
    try {
      sendWhenReady(terminal, record);
    } catch (err) {
      outputChannel.appendLine(`[ERROR] failed to send command for ${record.unitKey}: ${err}`);
      outputChannel.appendLine(`[ERROR] run it by hand:  cd ${record.cwd} && ${record.cmd}`);
      outputChannel.show(true);
    }
  }
}

/**
 * Send a unit's command once the terminal's shell is actually ready to receive it.
 *
 * 🔴 THIS IS A REAL, OBSERVED BUG, not defensive coding. `createTerminal()`
 * returns before the shell has finished initialising, and `sendText()` written
 * into a still-initialising shell is SWALLOWED — the command simply never runs.
 *
 * Reproduced 2026-07-28: two identical units dispatched together against the
 * same spec. u2's terminal ran claude and passed in 17s; u1's command was eaten,
 * claude never started, no `.idle` sentinel ever appeared, and ship-watch burned
 * its entire 180s budget before grading u1 FAIL against an empty worktree. A
 * clean re-run of the very same spec went 2/2 in 17s — i.e. it is a race, and a
 * race that silently costs you a unit is worse than one that errors.
 *
 * Fix: prefer VS Code's shell-integration signal (the shell telling us it is
 * ready), and fall back to a delay when integration is unavailable — it is
 * opt-in and not guaranteed for every shell.
 */
function sendWhenReady(terminal: vscode.Terminal, record: QueueRecord): void {
  const SEND_DELAY_MS = Number(process.env.VZT_VSCODE_SEND_DELAY_MS || 1200);
  let sent = false;

  // `timer` is declared with `let`, BEFORE send(), and null-guarded.
  //
  // An earlier version closed over a `const timer` declared BELOW send(). Any
  // path that called send() synchronously hit the temporal dead zone →
  // ReferenceError, thrown out of a processQueue loop whose queue record had
  // ALREADY been deleted. The unit vanished with no terminal, no sentinel and no
  // error — this function reintroducing, in a new form, the exact silent
  // unit-loss it exists to prevent. Keep the declaration order.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (via: string) => {
    if (sent) return;
    sent = true;
    if (timer) clearTimeout(timer);
    terminal.sendText(record.cmd, true); // true = execute (send newline)
    outputChannel.appendLine(`[LAUNCH] ${record.unitKey} (${record.cwd}) [${via}]`);
  };

  // A plain delay, deliberately — NOT VS Code's shell-integration signal.
  //
  // Sending on `onDidChangeTerminalShellIntegration` looks like the "correct"
  // readiness signal, and it is fine for a one-shot command. But a unit runs
  // `claude` as an INTERACTIVE TUI, and shell integration activates before the
  // PTY has settled: the TUI then fails to initialise and the unit does nothing
  // at all — no session, no sentinel, silence until the start-grace expires.
  //
  // Falsified directly: the same command queued twice through this extension,
  // once with stdout on the TTY and once redirected to a file. The redirected
  // run (claude in headless mode) completed; the TTY run never did. Meanwhile
  // the original code — a bare sendText immediately after createTerminal — ran
  // the TUI fine, which is what rules the TUI itself out as the culprit.
  //
  // So the delay exists to solve the ORIGINAL problem (text sent at 0ms into a
  // still-initialising shell is swallowed) without introducing a new one. Tune
  // with VZT_VSCODE_SEND_DELAY_MS on a slow machine.
  timer = setTimeout(() => send('delay'), SEND_DELAY_MS);
}

/**
 * Scan state/ for *.status files. Each is reported once per WRITE (tracked via
 * seenStatusFiles keyed on mtime, so a re-run of the same unit reports again)
 * and reflected into the output channel + status bar tally.
 * We never rename terminal tabs — VS Code does not support that after creation.
 */
function processStatus(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir());
  } catch {
    return;
  }

  // Prune entries whose files are gone (the CLI unlinks them at dispatch), so a
  // re-dispatched unit starts clean and the map stays bounded.
  const present = new Set(entries);
  for (const seen of seenStatusFiles.keys()) {
    if (!present.has(seen)) seenStatusFiles.delete(seen);
  }

  for (const entry of entries) {
    if (!entry.endsWith(".status")) {
      continue;
    }

    const filePath = path.join(stateDir(), entry);
    let mtime: number;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    // Report once per WRITE, not once per filename — a re-run rewrites the same
    // name and must be reported again.
    if (seenStatusFiles.get(entry) === mtime) {
      continue;
    }
    seenStatusFiles.set(entry, mtime);

    const unitKey = entry.slice(0, -".status".length);
    let contents: string;
    try {
      contents = fs.readFileSync(filePath, "utf8").trim();
    } catch (err) {
      outputChannel.appendLine(`[ERROR] failed to read status file ${entry}: ${err}`);
      continue;
    }

    if (contents === "PASS") {
      passCount++;
    } else if (contents === "FAIL") {
      failCount++;
    }
    outputChannel.appendLine(`[${contents}] ${unitKey}`);
    updateStatusBar();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  ensureDirs();

  outputChannel = vscode.window.createOutputChannel("VZT Ship");
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Initial scan on activation, in case the CLI already dropped files before
  // this extension host came up.
  processQueue();
  processStatus();

  // --- Ship Run tree -------------------------------------------------------
  const tree = new ShipTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("vztShipRun", tree));

  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.refresh", () => tree.refresh()),

    // Jump to the unit's terminal without leaving the window.
    vscode.commands.registerCommand("vzt-mux.focusTerminal", (item: UnitItem) => {
      const t = terminals.get(item.record.unitKey);
      if (t) t.show(false);
      else vscode.window.showInformationMessage(`VZT: no live terminal for ${item.record.unitKey} (it may have been closed).`);
    }),

    // THE point of the tree: read a unit's diff while it is still being written.
    // Herdr cannot do this — its panes are outside the editor process.
    vscode.commands.registerCommand("vzt-mux.openWorktree", async (item: UnitItem) => {
      const uri = vscode.Uri.file(item.record.cwd);
      if (!fs.existsSync(item.record.cwd)) {
        vscode.window.showWarningMessage(`VZT: worktree is gone: ${item.record.cwd}`);
        return;
      }
      // Add as a workspace folder rather than opening a new window, so the SCM
      // view shows the unit's uncommitted diff alongside your own work.
      const already = (vscode.workspace.workspaceFolders || []).some((f) => f.uri.fsPath === uri.fsPath);
      if (!already) {
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, null, {
          uri,
          name: item.record.unitKey,
        });
      }
      await vscode.commands.executeCommand("workbench.view.scm");
    }),

    // Re-run the unit's own oracle, in its own worktree. The oracle string comes
    // from the persistent unit record, so it is the SAME command ship-watch
    // graded with — never a retyped approximation.
    vscode.commands.registerCommand("vzt-mux.rerunOracle", (item: UnitItem) => {
      if (!item.record.machineCheck) {
        vscode.window.showWarningMessage(`VZT: ${item.record.unitKey} has no recorded oracle.`);
        return;
      }
      const t = vscode.window.createTerminal({ name: `oracle:${item.record.unitKey}`, cwd: item.record.cwd });
      t.show(true);
      t.sendText(item.record.machineCheck, true);
    })
  );

  const timer = setInterval(() => {
    processQueue();
    processStatus();
    tree.refresh();
  }, POLL_INTERVAL_MS);

  // Ensure the interval is cleared on deactivation via context.subscriptions.
  context.subscriptions.push(
    new vscode.Disposable(() => clearInterval(timer))
  );

  // Drop terminals from the map once the user closes them, so the watch
  // command and any future bookkeeping don't reference stale handles.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [unitKey, terminal] of terminals) {
        if (terminal === closed) {
          terminals.delete(unitKey);
          break;
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.watchShipRun", () => {
      if (terminals.size === 0) {
        vscode.window.showInformationMessage("VZT: no active ship-run terminals.");
        return;
      }
      for (const terminal of terminals.values()) {
        terminal.show(true);
      }
    })
  );
}

export function deactivate(): void {
  // Interval cleanup is handled by the Disposable pushed onto
  // context.subscriptions in activate().
}
