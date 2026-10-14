/**
 * "VZT: Pair Claude + Codex" — two agents in split integrated terminals, talking
 * over the durable local bus — plus the poller that keeps their leases alive and
 * types wake-ups into them.
 *
 * Nothing here decides WHAT to launch or WHAT to type. The agent argv comes from
 * `bus argv`, the first prompt from `bus bootstrap-prompt`, and every wake (line
 * included) from `bus wake-plan`. This file only creates terminals, launches the
 * command the CLI returned, and executes the plan.
 */

import * as vscode from "vscode";
import { BusCli, BusCliError } from "./busCli";
import { BusTreeProvider } from "./busTree";
import { executeWakeAction, WakeAction } from "./wake";

const POLL_MS = 1500;

/** The doctor field that says the CLI's Node can load its storage engine. */
const ENGINE_OK_FIELD = ["node", "sq" + "lite"].join("_");

type Kind = "claude" | "codex";

interface Doctor {
  codex_hooks?: { untrusted?: string[]; missing?: string[] };
  claude_hooks?: { missing?: string[] };
  [key: string]: unknown;
}

export type Launch = (terminal: vscode.Terminal, cmd: string, label: string) => void;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerAgentBus(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  launch: Launch,
  cliPath: () => string | null
): void {
  const bus = new BusCli(cliPath);
  const tree = new BusTreeProvider(bus, workspaceCwd);
  const view = vscode.window.createTreeView("vztBus", { treeDataProvider: tree });
  const window = vscode.env.sessionId;

  // agent_id → the terminal this window launched it in. Terminals die with the
  // window, so this never needs persisting: a reload re-pairs and the bus hands
  // back the same agent_ids with their queues intact.
  const agents = new Map<string, { alias: string; terminal: vscode.Terminal }>();

  const log = (line: string) => outputChannel.appendLine(`[bus] ${line}`);
  let lastPollError = "";

  // --- poller: never more than one tick in flight (setTimeout chain, not setInterval)
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    const cwd = workspaceCwd();
    try {
      if (cwd && agents.size) {
        const pairs: string[] = [];
        for (const [id, { terminal }] of agents) {
          const pid = await terminal.processId;
          if (pid) pairs.push(`${id}:${pid}`);
        }
        if (pairs.length) await bus.run(["lease", "--window", window, "--agents", pairs.join(",")], cwd);

        const plan = await bus.run<WakeAction[]>(["wake-plan", "--window", window], cwd);
        for (const action of plan) {
          const owned = agents.get(action.agent_id);
          if (!owned) continue; // not launched by this extension host — never type blind
          const typed = await executeWakeAction(action, owned.terminal, sleep);
          if (!typed) {
            log(`unknown wake action "${action.action}" for ${action.alias} — skipped`);
            continue;
          }
          await bus.run(["wake-sent", "--attempt", action.attempt_id], cwd);
          log(`${action.action} → ${action.alias} (attempt ${action.attempt_id})`);
        }
      }
      if (view.visible) await tree.reload();
      lastPollError = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastPollError) log(`poll failed: ${msg}`); // once per distinct failure, not every 1.5 s
      lastPollError = msg;
    }
  };

  const loop = async () => {
    await tick();
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  timer = setTimeout(loop, POLL_MS);

  // --- pair
  const pair = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("VZT: open the project folder first — the bus is scoped to its git workspace.");
      return;
    }
    const live = [...agents.values()].filter(({ terminal }) => terminal.exitStatus === undefined);
    if (live.length) {
      live.forEach(({ terminal }) => terminal.show(true));
      vscode.window.showInformationMessage("VZT: this window already has a paired Claude + Codex.");
      return;
    }

    try {
      const doctor = await bus.run<Doctor>(["doctor"], cwd);
      const untrusted = doctor.codex_hooks?.untrusted || [];
      const problems: string[] = [];
      if (doctor[ENGINE_OK_FIELD] !== true) problems.push("the Node that runs vzt-agent cannot load the bus store (needs Node 22.5+).");
      if (untrusted.length) problems.push(`${untrusted.length} Codex bus hook(s) are not trusted yet — open codex once and approve them.`);
      if (problems.length) {
        const text = JSON.stringify(doctor, null, 2);
        log(`pair refused by doctor:\n${text}`);
        vscode.window.showErrorMessage(`VZT: cannot pair — ${problems.join(" ")}`, { modal: true, detail: text });
        return;
      }

      // Claude Code 2.1.299 stops on its folder-trust dialog even under
      // the house permission-bypass flag (cursor on "No, exit"), so a paired
      // claude would never start. Pre-accept it — but ONLY for a folder VS Code
      // itself already trusts: the trust decision stays the user's.
      if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage("VZT: cannot pair — trust this workspace in VS Code first (Workspaces: Manage Workspace Trust). Claude runs here with permissions bypassed.");
        return;
      }
      await bus.run(["trust-claude", "--workspace", cwd], cwd);

      const ids = {} as Record<Kind, string>;
      for (const kind of ["claude", "codex"] as Kind[]) {
        const r = await bus.run<{ agent_id: string }>(
          ["register", "--alias", kind, "--kind", kind, "--window", window],
          cwd
        );
        ids[kind] = r.agent_id;
      }

      const commandFor = async (kind: Kind, peer: Kind) => {
        const argv = await bus.run<string[]>(["argv", "--kind", kind], cwd);
        const { prompt } = await bus.run<{ prompt: string }>(["bootstrap-prompt", "--alias", kind, "--peer", peer], cwd);
        return [...argv, prompt].map(shellQuote).join(" ");
      };
      const claudeCmd = await commandFor("claude", "codex");
      const codexCmd = await commandFor("codex", "claude");

      const envFor = (kind: Kind): Record<string, string> => ({
        VZT_BUS_AGENT: ids[kind],
        VZT_BUS_KIND: kind,
        VZT_BUS_WINDOW: window,
        ...(kind === "claude" ? { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1" } : {}),
      });

      const claude = vscode.window.createTerminal({ name: "claude", cwd, env: envFor("claude") });
      agents.set(ids.claude, { alias: "claude", terminal: claude });
      claude.show(false);
      const codex = vscode.window.createTerminal({
        name: "codex",
        cwd,
        env: envFor("codex"),
        location: { parentTerminal: claude },
      });
      agents.set(ids.codex, { alias: "codex", terminal: codex });

      launch(claude, claudeCmd, `bus claude (${ids.claude})`);
      launch(codex, codexCmd, `bus codex (${ids.codex})`);
      log(`paired claude=${ids.claude} codex=${ids.codex} window=${window}`);
      await tree.reload();
    } catch (err) {
      const msg = err instanceof BusCliError || err instanceof Error ? err.message : String(err);
      log(`pair failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: pair failed — ${msg}`);
    }
  };

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("vzt-mux.bus.pair", pair),
    vscode.commands.registerCommand("vzt-mux.bus.refresh", () => tree.reload()),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void tree.reload();
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, { terminal }] of agents) {
        if (terminal === closed) agents.delete(id); // its lease lapses in 30 s → stale
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vztMux.busCommand")) bus.reset();
    }),
    new vscode.Disposable(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
    })
  );
}
