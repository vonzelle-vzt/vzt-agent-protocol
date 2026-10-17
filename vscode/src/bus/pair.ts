/**
 * "VZT: Pair Claude + Codex" — two agents in split integrated terminals, talking
 * over the durable local bus — plus "New Agent Workspace" / "Add Agent Here",
 * and the poller that keeps every launched agent's lease alive and types
 * wake-ups into it.
 *
 * Nothing here decides WHAT to launch or WHAT to type. Every agent starts
 * through spawnAgent (argv from `bus argv`, prompt from `bus bootstrap-prompt`),
 * and every wake (line included) comes from `bus wake-plan`. This file only
 * collects the user's choices, opens worktrees through the CLI, and executes
 * the plan.
 */

import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { BusCli, BusCliError } from "./busCli";
import { BusTreeProvider } from "./busTree";
import { AgentRegistry, SavedAgent } from "./registry";
import { Adopted, adoptSaved, parsePs, PidTerminal, PsRow, restoreAgent, shellAlive } from "./restore";
import { Kind, Launch, pairAliases, preflightReport, spawnAgent, SpawnDeps } from "./spawn";
import { executeWakeAction, WakeAction } from "./wake";

export type { Launch } from "./spawn";

const POLL_MS = 1500;

/** workspaceState key: this window's agents, restored after a reload or restart. */
const SAVED_KEY = "vztMux.agents";
/** How long to wait for VS Code to reattach terminals that survived a reload. */
const REVIVE_WAIT_MS = 10_000;

interface SavedState {
  /** The window (vscode.env.sessionId) the agents ran under; adopt takes them over from it. */
  window: string;
  /** `from`: an agent restore could not adopt yet still belongs to that earlier window. */
  agents: (SavedAgent & { from?: string })[];
}

/** The CLI's `worktree create` slug rule, capped at 57 so the alias `<slug>-claude` fits the bus's 64. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,56}$/;

/** Args WITHOUT the leading "vzt-agent". */
export type Run = <T>(args: string[], cwd?: string) => Promise<T>;

interface ProjectEntry {
  name: string;
  root: string;
  baseRef: string;
  exists: boolean;
  worktrees: { path: string; branch: string | null; head: string; main: boolean }[];
}

function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function errorText(err: unknown): string {
  return err instanceof BusCliError || err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every terminal with its shell pid; a pid that does not resolve within 1 s is left undefined. */
async function pidTerminals(): Promise<PidTerminal[]> {
  return Promise.all(
    vscode.window.terminals.map(async (terminal) => ({
      terminal,
      pid: await Promise.race([terminal.processId, sleep(1000).then(() => undefined)]),
    }))
  );
}

function psRows(): Promise<PsRow[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? [] : parsePs(stdout))
    );
  });
}

/** A tree node's worktree path or project, when a sidebar button passed one. */
function argPath(arg: unknown): string | undefined {
  const n = arg as { kind?: string; path?: unknown } | undefined;
  return n?.kind === "worktree" && typeof n.path === "string" ? n.path : undefined;
}

function argProject(arg: unknown): { name: string; root: string } | undefined {
  const n = arg as { kind?: string; name?: unknown; root?: unknown; registered?: unknown } | undefined;
  return n?.kind === "project" && n.registered === true && typeof n.name === "string" && typeof n.root === "string"
    ? { name: n.name, root: n.root }
    : undefined;
}

export function registerAgentBus(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  launch: Launch,
  cliPath: () => string | null
): { registry: AgentRegistry; runTop: Run; refreshBus(): Promise<void> } {
  const bus = new BusCli(cliPath);
  const tree = new BusTreeProvider(bus, workspaceCwd);
  const view = vscode.window.createTreeView("vztBus", { treeDataProvider: tree });
  const window = vscode.env.sessionId;
  const runTop: Run = (args, cwd) => bus.runTop(args, cwd);

  // Persisted on every change, except while restore rebuilds the registry: a
  // half-restored list must never overwrite the saved one.
  let restoring = false;
  const save = (agents: SavedState["agents"]) =>
    void context.workspaceState.update(SAVED_KEY, { window: window, agents } satisfies SavedState);
  const registry = new AgentRegistry((agents) => {
    if (!restoring) save(agents);
  });
  // The agent_ids of the last pair, so a second pair focuses it instead of
  // registering duplicates.
  let paired: { claude: string; codex: string } | undefined;

  const spawnDeps: SpawnDeps = {
    run: (args, cwd) => bus.run(args, cwd),
    createTerminal: (opts) => vscode.window.createTerminal(opts),
    launch,
    windowId: window,
    registry,
    isTrusted: () => vscode.workspace.isTrusted,
  };

  const log = (line: string) => outputChannel.appendLine(`[bus] ${line}`);
  let lastPollError = "";

  // --- poller: never more than one tick in flight (setTimeout chain, not setInterval)
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    // lease and wake-plan are keyed by window, not workspace: any folder works
    // as the CLI's cwd, including a worktree the window opened after start.
    const cwd = workspaceCwd() ?? registry.entries().next().value?.[1].cwd;
    try {
      if (cwd && registry.size) {
        const pairs: string[] = [];
        for (const [id, { terminal }] of registry.entries()) {
          const pid = await terminal.processId;
          if (pid) pairs.push(`${id}:${pid}`);
        }
        if (pairs.length) await bus.run(["lease", "--window", window, "--agents", pairs.join(",")], cwd);

        const plan = await bus.run<WakeAction[]>(["wake-plan", "--window", window], cwd);
        for (const action of plan) {
          const owned = registry.get(action.agent_id);
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
      const msg = errorText(err);
      if (msg !== lastPollError) log(`poll failed: ${msg}`); // once per distinct failure, not every 1.5 s
      lastPollError = msg;
    }
  };

  const loop = async () => {
    await tick();
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  timer = setTimeout(loop, POLL_MS);

  /** Doctor gate shared by pair and spawn. True = go; false = refused and shown. */
  const preflightOk = async (cwd: string, what: string): Promise<boolean> => {
    const { problems, doctor } = await preflightReport(spawnDeps.run, cwd);
    if (!problems.length) return true;
    const text = JSON.stringify(doctor, null, 2);
    log(`${what} refused by doctor:\n${text}`);
    vscode.window.showErrorMessage(`VZT: cannot ${what} — ${problems.join(" ")}`, { modal: true, detail: text });
    return false;
  };

  const isLive = (id: string | undefined) => {
    const entry = id ? registry.get(id) : undefined;
    return !!entry && entry.terminal.exitStatus === undefined;
  };

  // --- pair
  const pair = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("VZT: open the project folder first — the bus is scoped to its git workspace.");
      return;
    }
    if (paired && isLive(paired.claude) && isLive(paired.codex)) {
      registry.focus(paired.claude);
      registry.focus(paired.codex);
      vscode.window.showInformationMessage("VZT: this window already has a paired Claude + Codex.");
      return;
    }

    try {
      if (!(await preflightOk(cwd, "pair"))) return;
      const alias = pairAliases(cwd);
      const claude = await spawnAgent(spawnDeps, { kind: "claude", alias: alias.claude, cwd, peer: alias.codex });
      claude.terminal.show(false);
      const codex = await spawnAgent(spawnDeps, {
        kind: "codex",
        alias: alias.codex,
        cwd,
        peer: alias.claude,
        parentTerminal: claude.terminal,
      });
      paired = { claude: claude.agent_id, codex: codex.agent_id };
      log(`paired claude=${claude.agent_id} codex=${codex.agent_id} window=${window}`);
      await tree.reload();
    } catch (err) {
      const msg = errorText(err);
      log(`pair failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: pair failed — ${msg}`);
    }
  };

  // --- spawn one agent (callers run the doctor gate first)
  const spawnOne = async (req: { kind: Kind; alias: string; cwd: string; task?: string }) => {
    const { agent_id, terminal } = await spawnAgent(spawnDeps, req);
    terminal.show(false);
    log(`spawned ${req.alias}=${agent_id} in ${req.cwd} window=${window}`);
    await tree.reload();
  };

  const pickKind = async (): Promise<Kind | undefined> => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "claude", description: "Claude Code" },
        { label: "codex", description: "Codex" },
      ],
      { placeHolder: "Which agent?" }
    );
    return pick?.label as Kind | undefined;
  };

  // --- New Agent Workspace: worktree for a task + an agent in it.
  // From a project row's + button the project comes with the click.
  const newWorkspace = async (arg?: unknown) => {
    try {
      let project = argProject(arg);
      if (!project) {
        const projects = await runTop<ProjectEntry[]>(["projects", "list", "--json"], workspaceCwd());
        const usable = projects.filter((p) => p.exists);
        if (!usable.length) {
          const add = "Add Project";
          const choice = await vscode.window.showInformationMessage("VZT: no projects registered yet.", add);
          if (choice === add) await vscode.commands.executeCommand("vzt-mux.projects.add");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          usable.map((p) => ({ label: p.name, description: p.root, project: p })),
          { placeHolder: "Project for the new agent workspace" }
        );
        if (!pick) return;
        project = pick.project;
      }

      const slug = await vscode.window.showInputBox({
        prompt: "Worktree / branch name",
        placeHolder: "fix-login",
        validateInput: (v) => (SLUG_RE.test(v) ? undefined : "lowercase letters, digits, . _ - (start with a letter or digit, max 57)"),
      });
      if (!slug) return;
      const kind = await pickKind();
      if (!kind) return;
      const task = await vscode.window.showInputBox({ prompt: "First task for the agent (optional)" });
      if (task === undefined) return;

      // Gate BEFORE creating anything, so a refusal leaves no orphan worktree.
      if (!(await preflightOk(project.root, "start an agent"))) return;
      const wt = await runTop<{ path: string; branch: string; base: string; head: string }>(
        ["worktree", "create", "--project", project.name, "--name", slug, "--json"],
        project.root
      );
      try {
        await spawnOne({ kind, alias: `${slug}-${kind}`, cwd: wt.path, task: task.trim() || undefined });
      } catch (err) {
        const remove = "Remove Worktree";
        const choice = await vscode.window.showErrorMessage(
          `VZT: the worktree ${slug} was created but its agent did not start — ${errorText(err)}`,
          remove
        );
        if (choice === remove) {
          await runTop(["worktree", "remove", "--project", project.name, "--name", slug, "--json"], project.root);
        }
        return;
      }
      // Adding a folder to a single-folder window turns it into an untitled
      // multi-root workspace and RESTARTS the extension host, dropping this
      // window's agent registry (no more leases or wakes). Only add it when the
      // window is already a saved workspace; otherwise the Projects view lists it.
      const folders = vscode.workspace.workspaceFolders || [];
      if (vscode.workspace.workspaceFile && !folders.some((f) => f.uri.fsPath === wt.path)) {
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(wt.path) });
      }
    } catch (err) {
      const msg = errorText(err);
      log(`new agent workspace failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: new agent workspace failed — ${msg}`);
    }
  };

  // --- Add Agent Here: another agent in a worktree row's folder (its + button)
  // or in a folder this window already has open
  const addHere = async (arg?: unknown) => {
    try {
      let cwd = argPath(arg);
      if (!cwd) {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
          vscode.window.showErrorMessage("VZT: open the project folder first — the bus is scoped to its git workspace.");
          return;
        }
        cwd = (
          await vscode.window.showQuickPick(
            folders.map((f) => ({ label: f.name, description: f.uri.fsPath, cwd: f.uri.fsPath })),
            { placeHolder: "Folder for the new agent" }
          )
        )?.cwd;
        if (!cwd) return;
      }
      const kind = await pickKind();
      if (!kind) return;
      const alias = await vscode.window.showInputBox({
        prompt: "Agent alias (unique within the project)",
        value: `${path.basename(cwd)}-${kind}`,
        validateInput: (v) => (v.trim() ? undefined : "an alias is required"),
      });
      if (!alias) return;
      if (!(await preflightOk(cwd, "start an agent"))) return;
      await spawnOne({ kind, alias: alias.trim(), cwd });
    } catch (err) {
      const msg = errorText(err);
      log(`add agent failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: add agent failed — ${msg}`);
    }
  };

  // --- restore this window's agents from before a reload or restart
  const restore = async () => {
    const saved = context.workspaceState.get<SavedState>(SAVED_KEY);
    if (!saved?.agents?.length || !vscode.workspace.getConfiguration("vztMux").get<boolean>("agents.restore", true)) return;
    if (!vscode.workspace.isTrusted) {
      log(`restore skipped: workspace not trusted (${saved.agents.length} agents saved)`);
      return;
    }
    restoring = true;
    const keep: SavedState["agents"] = []; // not restored now, but not gone: try again next start
    const counts: Record<string, number> = {};
    try {
      const adopted: { agent: SavedState["agents"][number]; a: Adopted }[] = [];
      for (const agent of saved.agents) {
        try {
          const a = await adoptSaved(spawnDeps, agent, agent.from ?? saved.window);
          if (typeof a === "string") log(`restore ${agent.alias} (${agent.agent_id}): ${a}`);
          else adopted.push({ agent, a });
        } catch (err) {
          keep.push({ ...agent, from: agent.from ?? saved.window }); // the bus still names the old window
          log(`restore ${agent.alias}: adopt failed, kept for next start — ${errorText(err)}`);
        }
      }

      // Terminals that survived a reload come back asynchronously: wait until
      // every live old shell has its terminal again, or the deadline.
      let ps = await psRows();
      let terminals = await pidTerminals();
      const expected = adopted.filter(({ a }) => shellAlive(a.terminal_pid, ps)).map(({ a }) => a.terminal_pid);
      for (let waited = 0; waited < REVIVE_WAIT_MS; waited += 250) {
        if (expected.every((pid) => terminals.some((t) => t.pid === pid))) break;
        await sleep(250);
        terminals = await pidTerminals();
      }
      ps = await psRows();

      for (const { agent, a } of adopted) {
        try {
          const outcome = await restoreAgent(spawnDeps, agent, a, terminals, ps);
          counts[outcome] = (counts[outcome] || 0) + 1;
          if (outcome === "waiting") keep.push({ ...agent, from: undefined }); // adopted: now this window's
          log(`restore ${agent.alias} (${agent.agent_id}): ${outcome}`);
        } catch (err) {
          keep.push({ ...agent, from: undefined });
          log(`restore ${agent.alias} failed, kept for next start: ${errorText(err)}`);
        }
      }
    } finally {
      restoring = false;
      const live = [...registry.entries()].map(([agent_id, e]) => ({ agent_id, alias: e.alias, kind: e.kind, cwd: e.cwd }));
      save([...live, ...keep.filter((k) => !registry.get(k.agent_id))]);
    }
    const back = registry.size;
    if (back) {
      const how = Object.entries(counts).filter(([k]) => k !== "waiting").map(([k, n]) => `${n} ${k}`).join(", ");
      vscode.window.showInformationMessage(`VZT: ${back} agent${back === 1 ? "" : "s"} back (${how}).`);
    }
    await tree.reload();
  };
  void restore();

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("vzt-mux.bus.pair", pair),
    vscode.commands.registerCommand("vzt-mux.bus.refresh", () => tree.reload()),
    vscode.commands.registerCommand("vzt-mux.agents.newWorkspace", newWorkspace),
    vscode.commands.registerCommand("vzt-mux.agents.addHere", addHere),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void tree.reload();
    }),
    // A terminal the user (or the agent) closed is forgotten; its lease lapses in
    // 30 s → stale. One closed by VS Code shutting down stays saved for restore.
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) registry.removeTerminal(closed);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vztMux.busCommand")) bus.reset();
    }),
    new vscode.Disposable(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
    })
  );

  return { registry, runTop, refreshBus: () => tree.reload() };
}
