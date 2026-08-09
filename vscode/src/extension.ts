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
import { registerHerdrFleet } from "./herdr/fleet";

// Shape of a queue file written by the CLI.
interface QueueRecord {
  unitKey: string;
  cwd: string;
  /** The ship spec's `root` — the project this run belongs to. Scopes the record
   *  to the window that has that project open. Absent on records written by a
   *  CLI older than 1.13.0. */
  workspaceRoot?: string;
  env: Record<string, string>;
  cmd: string;
}

/**
 * Does THIS window own the record?
 *
 * The queue directory is global; extension hosts are per window. Every open
 * window polls the same directory, so without this check they race and the unit
 * terminal opens wherever the race landed — observed 2026-07-29 with 2 windows
 * and 3 hosts, and the likely reason identical runs behaved differently.
 *
 * A record belongs to the window that has its project open. Matching is
 * containment in either direction so that a window opened on a subfolder of the
 * repo (or on a parent of it) still counts.
 *
 * Back-compat: a record with no `workspaceRoot` came from an older CLI, which
 * had no concept of scoping. Claim it rather than stranding it forever — a
 * version mismatch must degrade to the old behaviour, not to a dead queue.
 */
function ownsWorkspace(record: QueueRecord): boolean {
  if (!record.workspaceRoot) {
    return true;
  }
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    return false; // an empty window owns nothing
  }
  const root = path.resolve(record.workspaceRoot);
  return folders.some((f) => {
    const dir = path.resolve(f.uri.fsPath);
    return dir === root || root.startsWith(dir + path.sep) || dir.startsWith(root + path.sep);
  });
}

const POLL_INTERVAL_MS = 1000;
const SETUP_PROMPT_KEY = "vzt.setupPromptedRoots";

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
  const configured = vscode.workspace.getConfiguration("vztMux").get<string>("baseDir") || "";
  return process.env.VZT_VSCODE_DIR || expandHome(configured) || path.join(os.homedir(), ".vzt", "vscode-mux");
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
function unitsDir(): string {
  return path.join(baseDir(), "units");
}

function expandHome(p: string): string {
  if (!p) return "";
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function ensureDirs(): void {
  for (const dir of [baseDir(), queueDir(), stateDir(), promptsDir(), unitsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function countFiles(dir: string, suffix?: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => !suffix || f.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

function hasProtocolHook(settingsPath: string): boolean {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return raw.includes("vzt-route-classifier.mjs") && raw.includes("vzt-session-start.mjs");
  } catch {
    return false;
  }
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function projectProtocolRoots(): string[] {
  return workspaceRoots().filter((root) => hasProtocolHook(path.join(root, ".claude", "settings.json")));
}

function globalProtocolInstalled(): boolean {
  return hasProtocolHook(path.join(os.homedir(), ".claude", "settings.json"));
}

interface Readiness {
  kind: "setup" | "ready" | "running" | "blocked";
  projectRoots: string[];
  globalInstalled: boolean;
  queueCount: number;
  statusCount: number;
  unitCount: number;
  startedCount: number;
  blockedCount: number;
}

function readReadiness(): Readiness {
  const blockedCount = countFiles(stateDir(), ".blocked");
  const startedCount = countFiles(stateDir(), ".started");
  const queueCount = countFiles(queueDir(), ".json");
  const projectRoots = projectProtocolRoots();
  const globalInstalled = globalProtocolInstalled();
  let kind: Readiness["kind"] = projectRoots.length || globalInstalled ? "ready" : "setup";
  if (queueCount > 0 || startedCount > 0 || terminals.size > 0) kind = "running";
  if (blockedCount > 0) kind = "blocked";
  return {
    kind,
    projectRoots,
    globalInstalled,
    queueCount,
    statusCount: countFiles(stateDir(), ".status"),
    unitCount: countFiles(unitsDir(), ".json"),
    startedCount,
    blockedCount,
  };
}

function updateStatusBar(): void {
  const readiness = readReadiness();
  const label = readiness.kind === "setup"
    ? "setup needed"
    : readiness.kind === "blocked"
      ? `blocked ${readiness.blockedCount}`
      : readiness.kind === "running"
        ? "running"
        : "ready";
  statusBarItem.text = `VZT: ${label}  ${passCount} ✓ ${failCount} ✗`;
  statusBarItem.command = "vzt-mux.doctor";
  statusBarItem.tooltip = new vscode.MarkdownString(
    [
      `**VZT Agent Protocol** — ${label}`,
      "",
      `- mux dir: \`${baseDir()}\``,
      `- queue: ${readiness.queueCount}`,
      `- units: ${readiness.unitCount}`,
      `- status: ${readiness.statusCount}`,
      `- started: ${readiness.startedCount}`,
      `- blocked: ${readiness.blockedCount}`,
      readiness.projectRoots.length ? `- project install: ${readiness.projectRoots.map((r) => `\`${r}\``).join(", ")}` : "",
      readiness.globalInstalled ? "- global install: yes" : "- global install: no",
    ].filter(Boolean).join("\n")
  );
  statusBarItem.backgroundColor = readiness.kind === "blocked"
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : readiness.kind === "setup"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
  statusBarItem.show();
}

function cliPath(context: vscode.ExtensionContext): string | null {
  const candidate = path.resolve(context.extensionPath, "..", "cli", "vzt-agent.js");
  return fs.existsSync(candidate) ? candidate : null;
}

function cliCommand(context: vscode.ExtensionContext): string {
  const cli = cliPath(context);
  return cli ? `node ${shellQuote(cli)}` : "npx github:vonzelle-vzt/vzt-agent-protocol";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runInstallTerminal(context: vscode.ExtensionContext, scope: "project" | "global"): void {
  const args = scope === "global"
    ? "--global"
    : `--target ${shellQuote(workspaceRoots()[0] || process.cwd())}`;
  const t = vscode.window.createTerminal({ name: `VZT install:${scope}` });
  t.show(false);
  t.sendText(`${cliCommand(context)} install ${args}`, true);
}

function appendDoctor(context: vscode.ExtensionContext): Readiness {
  const r = readReadiness();
  const version = (context.extension?.packageJSON?.version as string) || "unknown";
  outputChannel.appendLine("");
  outputChannel.appendLine(`[doctor] VZT Ship Mux ${version}`);
  outputChannel.appendLine(`[doctor] mux dir: ${baseDir()}`);
  outputChannel.appendLine(`[doctor] project protocol roots: ${r.projectRoots.length ? r.projectRoots.join(", ") : "none"}`);
  outputChannel.appendLine(`[doctor] global protocol: ${r.globalInstalled ? "installed" : "missing"}`);
  outputChannel.appendLine(`[doctor] queue=${r.queueCount} units=${r.unitCount} status=${r.statusCount} started=${r.startedCount} blocked=${r.blockedCount}`);
  outputChannel.appendLine(`[doctor] loaded host: ${path.join(baseDir(), "host.json")}`);
  return r;
}

async function maybePromptSetup(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("vztMux");
  if (cfg.get<boolean>("showSetupPrompts") === false) return;
  const r = readReadiness();
  if (r.kind !== "setup") return;
  const root = workspaceRoots()[0];
  if (!root) return;
  const prompted = context.globalState.get<string[]>(SETUP_PROMPT_KEY, []);
  if (prompted.includes(root)) return;
  await context.globalState.update(SETUP_PROMPT_KEY, [...prompted, root]);
  const picked = await vscode.window.showInformationMessage(
    "VZT is active, but this project is not wired to the protocol yet.",
    "Install in Project",
    "Install Globally",
    "Later"
  );
  if (picked === "Install in Project") runInstallTerminal(context, "project");
  if (picked === "Install Globally") runInstallTerminal(context, "global");
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

    // Is this record OURS? The queue directory is global but extension hosts are
    // per window, so without this every open window competes for every record
    // and the terminal opens in whichever host won the poll — possibly a window
    // you are not looking at, possibly one running an older build.
    if (!ownsWorkspace(record)) {
      continue; // leave it on disk for the window that does own it
    }

    // CLAIM ATOMICALLY. Reading then unlinking is two steps, so two hosts could
    // both read a record before either deleted it and both open a terminal for
    // the same unit. `rename` is atomic: exactly one host wins and the loser's
    // call throws ENOENT.
    const claimed = `${filePath}.claimed-${process.pid}`;
    try {
      fs.renameSync(filePath, claimed);
    } catch {
      continue; // another host claimed it first — not an error
    }
    // The claim file is the unit's tombstone until the terminal exists; drop it
    // once we are past the point where a re-scan could double-process.
    try {
      fs.unlinkSync(claimed);
    } catch {
      // ignore
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
 * Fix: send after a plain delay. Shell integration looks like the right signal,
 * but it fires before the PTY is settled for Claude's interactive TUI.
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
    } else if (contents === "FAIL" || contents === "SCOPE_BREACH") {
      // A breach is a failure and must be counted as one. Leaving it out of the
      // tally would show "3 ✓ 0 ✗" for a run where a unit wrote outside its
      // declared scope — the one result that invalidates every other unit's.
      failCount++;
    }
    outputChannel.appendLine(`[${contents}] ${unitKey}`);
    if (contents === "SCOPE_BREACH") {
      outputChannel.appendLine(
        `[SCOPE_BREACH] ${unitKey} wrote outside FILES_IN_SCOPE — the integration gate's disjointness assumption no longer holds for this run.`
      );
    }
    updateStatusBar();
  }
}

/**
 * Record which extension VERSION is actually loaded in this host.
 *
 * VS Code caches extension code in the running host. Neither copying a fresh
 * `out/extension.js` into the extension folder nor
 * `code --install-extension …vsix --force` hot-swaps it — only a window reload
 * does. So the version ON DISK can differ from the version RUNNING, with no
 * outward sign: a fix appears to have no effect, and you debug the code instead
 * of the reload. That cost about an hour on 2026-07-28.
 *
 * Writing it here — inside activate(), which only runs on load — makes the
 * running version observable from outside VS Code. `vzt-agent doctor` compares
 * it against vscode/package.json and says "reload the window" instead of
 * reporting green.
 */
function writeHostHeartbeat(context: vscode.ExtensionContext): void {
  try {
    const version = (context.extension?.packageJSON?.version as string) || 'unknown';
    fs.writeFileSync(
      path.join(baseDir(), "host.json"),
      JSON.stringify({ version, pid: process.pid, activatedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* diagnostics must never block activation */
  }
}

export function activate(context: vscode.ExtensionContext): void {
  ensureDirs();
  writeHostHeartbeat(context);

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

    vscode.commands.registerCommand("vzt-mux.doctor", () => {
      const r = appendDoctor(context);
      outputChannel.show(true);
      updateStatusBar();
      if (r.kind === "setup") {
        vscode.window.showWarningMessage("VZT: protocol setup is missing for this workspace and globally.");
      } else {
        vscode.window.showInformationMessage(`VZT: ${r.kind}`);
      }
    }),

    vscode.commands.registerCommand("vzt-mux.installProject", () => runInstallTerminal(context, "project")),

    vscode.commands.registerCommand("vzt-mux.installGlobal", () => runInstallTerminal(context, "global")),

    vscode.commands.registerCommand("vzt-mux.openShipRun", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.vztShip");
      await vscode.commands.executeCommand("vztShipRun.focus");
    }),

    vscode.commands.registerCommand("vzt-mux.startShipWatchFromSpec", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "VZT ship specs": ["md"], "All files": ["*"] },
        openLabel: "Start Ship Watch",
      });
      const spec = picked?.[0]?.fsPath;
      if (!spec) return;
      const command = `${cliCommand(context)} ship-watch ${shellQuote(spec)} --mux vscode`;
      const t = vscode.window.createTerminal({ name: "VZT ship-watch", cwd: path.dirname(spec) });
      t.show(false);
      t.sendText(command, true);
    }),

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
    updateStatusBar();
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
      updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateStatusBar();
      void maybePromptSetup(context);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vztMux")) {
        ensureDirs();
        writeHostHeartbeat(context);
        updateStatusBar();
      }
    })
  );

  // --- Herdr Fleet ---------------------------------------------------------
  // A second, independent view: the agents herdr is running, live. Registered
  // here but deliberately NOT connected — see registerHerdrFleet, which waits
  // for the view to actually become visible before opening a socket.
  //
  // It shares nothing with the ship-run machinery above: different daemon,
  // different transport, different lifecycle. A herdr outage must not touch the
  // ship queue, and vice versa.
  registerHerdrFleet(context, outputChannel);

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

  if (vscode.workspace.getConfiguration("vztMux").get<boolean>("autoDoctorOnStartup") !== false) {
    appendDoctor(context);
  }
  void maybePromptSetup(context);
}

export function deactivate(): void {
  // Interval cleanup is handled by the Disposable pushed onto
  // context.subscriptions in activate().
}
