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

// Status files we've already processed once, so re-reads on later polls are no-ops.
const seenStatusFiles = new Set<string>();

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

    const terminal = vscode.window.createTerminal({
      name: record.unitKey,
      cwd: record.cwd,
      env: record.env,
    });
    terminals.set(record.unitKey, terminal);

    terminal.show(true); // preserveFocus: true — don't steal focus aggressively
    terminal.sendText(record.cmd, true); // true = execute (send newline)

    outputChannel.appendLine(`[LAUNCH] ${record.unitKey} (${record.cwd})`);
  }
}

/**
 * Scan state/ for *.status files. Each is processed exactly once (tracked via
 * seenStatusFiles) and reflected into the output channel + status bar tally.
 * We never rename terminal tabs — VS Code does not support that after creation.
 */
function processStatus(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".status")) {
      continue;
    }
    if (seenStatusFiles.has(entry)) {
      continue;
    }
    seenStatusFiles.add(entry);

    const filePath = path.join(stateDir(), entry);
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

  const timer = setInterval(() => {
    processQueue();
    processStatus();
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
