/**
 * "VZT: Pair Claude + Codex" — two agents in split integrated terminals, talking
 * over the durable local bus — plus "New Agent Workspace", "Add Agent Here" and
 * a project row's + ("Start in Project"), and the poller that keeps every
 * launched agent's lease alive and types wake-ups into it.
 *
 * Nothing here decides WHAT to launch or WHAT to type. Every agent starts
 * through spawnAgent (argv from `bus argv`, prompt from `bus bootstrap-prompt`),
 * and every wake (line included) comes from `bus wake-plan`. This file only
 * collects the user's choices, opens worktrees through the CLI, and executes
 * the plan.
 *
 * With tmux (vztMux.agents.tmux, on by default) agents and plain shells run in
 * sessions on a private tmux server and their terminals are attach clients
 * that the registry swaps per project (registry.ts). All tmux argv lives in
 * tmux.ts; this file only hands it an exec.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BusCli, BusCliError } from "./busCli";
import { BusTreeProvider } from "./busTree";
import { claudeIdePort } from "./ide";
import { AgentRegistry, CloseReason, leasePlan, SavedAgent, SavedShell } from "./registry";
import { Adopted, adoptSaved, parsePs, PidTerminal, PsRow, restoreAgent, restoreSession, restoreShell, shellAlive } from "./restore";
import {
  defaultAlias,
  Kind,
  Launch,
  pairAliases,
  preflightReport,
  projectOf,
  spawnAgent,
  SpawnDeps,
  startShell,
  terminalName,
  UNTRUSTED_MESSAGE,
} from "./spawn";
import { defaultConfPath, Exec, findTmux, FALLBACK_DIRS, Tmux, writeConf } from "./tmux";
import { executeWakeAction, WakeAction } from "./wake";

export type { Launch } from "./spawn";

const POLL_MS = 1500;

/** workspaceState key: this window's agents, restored after a reload or restart. */
const SAVED_KEY = "vztMux.agents";
/** workspaceState key: the project whose terminals the panel showed. */
const ACTIVE_KEY = "vztMux.activeProject";
/** How long to wait for VS Code to reattach terminals that survived a reload. */
const REVIVE_WAIT_MS = 10_000;

interface SavedState {
  /** The window (vscode.env.sessionId) the agents ran under; adopt takes them over from it. */
  window: string;
  /** `from`: an agent restore could not adopt yet still belongs to that earlier window. */
  agents: (SavedAgent & { from?: string })[];
  /** Plain tmux shells (0.10+). */
  shells?: SavedShell[];
}

/**
 * The tmux client's environment. The private server keeps the environment of
 * the command that started it for every shell it ever runs, so drop what only
 * the extension host means: Electron/VS Code internals (ELECTRON_RUN_AS_NODE
 * turns an Electron binary into node), a bus identity VS Code itself was
 * started with, and $TMUX (tmux refuses to nest).
 */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ELECTRON_|VSCODE_)/.test(k) || /^(VZT_BUS_AGENT|VZT_BUS_KIND|VZT_BUS_WINDOW|TMUX|TMUX_PANE)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** Runs tmux (and git, for projectOf) for tmux.ts/spawn.ts; a failure carries stderr. */
const execTool: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: tmuxEnv(), timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout) });
      const text = String(stderr || "").trim() || err.message;
      reject(Object.assign(new Error(`${path.basename(file)}: ${text}`), { stderr: String(stderr || "") }));
    });
  });

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

/** True when `root` is one of this window's workspace folders (raw or realpath'd). */
function isWorkspaceFolder(root: string): boolean {
  return (vscode.workspace.workspaceFolders || []).some((f) => {
    if (f.uri.fsPath === root) return true;
    try {
      return fs.realpathSync(f.uri.fsPath) === root;
    } catch {
      return false;
    }
  });
}

export function registerAgentBus(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  launch: Launch,
  cliPath: () => string | null
): { registry: AgentRegistry; runTop: Run; refreshBus(): Promise<void>; onActiveProject(listener: () => void): void } {
  const bus = new BusCli(cliPath);
  const tree = new BusTreeProvider(bus, workspaceCwd);
  const view = vscode.window.createTreeView("vztBus", { treeDataProvider: tree });
  const window = vscode.env.sessionId;
  const runTop: Run = (args, cwd) => bus.runTop(args, cwd);
  const log = (line: string) => outputChannel.appendLine(`[bus] ${line}`);

  // --- tmux: the private agent server. The binary is looked up once; the
  // setting only decides whether NEW agents start there — sessions that already
  // run are attached, leased and woken whatever it says.
  const tmuxBin = findTmux(process.env.PATH || "");
  const tmux = tmuxBin ? new Tmux({ bin: tmuxBin, exec: execTool, conf: defaultConfPath() }) : undefined;
  if (tmux) {
    try {
      writeConf(tmux.conf);
    } catch (err) {
      log(`could not write ${tmux.conf}: ${errorText(err)}`);
    }
    void tmux.sourceConf();
  }
  let warnedNoTmux = false;
  const spawnTmux = (): Tmux | undefined => {
    if (!vscode.workspace.getConfiguration("vztMux").get<boolean>("agents.tmux", true)) return undefined;
    if (!tmux && !warnedNoTmux) {
      warnedNoTmux = true;
      const where = ["PATH", ...FALLBACK_DIRS].join(", ");
      log(`tmux not found (${where}) — agents run in plain terminals`);
      vscode.window.showWarningMessage(
        `VZT: tmux was not found (${where}). Agents run in plain terminals, which close with the window and with every project switch. Install tmux (brew install tmux), or set vztMux.agents.tmux to false to silence this.`
      );
    }
    return tmux;
  };

  // Persisted on every change, except while restore rebuilds the registry: a
  // half-restored list must never overwrite the saved one.
  let restoring = false;
  const save = (agents: SavedState["agents"], shells: SavedShell[]) =>
    void context.workspaceState.update(SAVED_KEY, { window: window, agents, shells } satisfies SavedState);
  const activeListeners: (() => void)[] = [];
  // A terminal editor tab names no terminal; its label is the terminal's name.
  const editorColumn = (terminal: vscode.Terminal): number | undefined => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTerminal && tab.label === terminal.name) return group.viewColumn;
      }
    }
    return undefined;
  };
  const registry = new AgentRegistry(
    (agents, shells) => {
      if (!restoring) save(agents, shells);
    },
    {
      createTerminal: (opts) => vscode.window.createTerminal(opts),
      tmux: () => tmux,
      reveal: (root) => {
        if (isWorkspaceFolder(root)) void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(root));
      },
      onActive: (root) => {
        void context.workspaceState.update(ACTIVE_KEY, root);
        for (const l of activeListeners) l();
      },
      editorColumn,
      log,
    }
  );
  registry.active = context.workspaceState.get<string>(ACTIVE_KEY);
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
    get tmux() {
      return spawnTmux();
    },
    projectOf: (cwd) => projectOf(execTool, cwd),
    idePort: (cwd) =>
      claudeIdePort(
        path.join(os.homedir(), ".claude", "ide"),
        (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
        cwd
      ),
    log,
  };

  let lastPollError = "";
  let lastTmuxError = "";

  // --- poller: never more than one tick in flight (setTimeout chain, not setInterval)
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    // lease and wake-plan are keyed by window, not workspace: any folder works
    // as the CLI's cwd, including a worktree the window opened after start.
    const cwd = workspaceCwd() ?? registry.entries().next().value?.[1].cwd;
    try {
      if (cwd && registry.size) {
        // Snapshot BEFORE listing panes: an entry added after the listing must
        // not look like one whose session ended.
        const snapshot = [...registry.entries()];
        let panes: Map<string, number> | undefined;
        if (tmux && snapshot.some(([, e]) => e.session)) {
          try {
            panes = await tmux.panePids();
            lastTmuxError = "";
          } catch (err) {
            const msg = errorText(err);
            if (msg !== lastTmuxError) log(`tmux list-panes failed, tmux agents not leased: ${msg}`);
            lastTmuxError = msg;
          }
        }
        const { pairs, ended } = await leasePlan(snapshot, panes);
        for (const [id, entry] of ended) {
          if (registry.get(id) !== entry) continue;
          registry.delete(id);
          log(`${entry.alias}: its tmux session ${entry.session} ended — forgotten`);
        }
        if (pairs.length) await bus.run(["lease", "--window", window, "--agents", pairs.join(",")], cwd);

        const plan = await bus.run<WakeAction[]>(["wake-plan", "--window", window], cwd);
        for (const action of plan) {
          const owned = registry.get(action.agent_id);
          if (!owned || owned.kind === "shell") continue; // not launched by this extension host — never type blind
          // A detached agent is woken through its session; an attached one too
          // (the client is only a view). A legacy agent through its terminal.
          const sink = owned.session ? tmux?.sink(owned.session) : owned.terminal;
          if (!sink) continue;
          const typed = await executeWakeAction(action, sink, sleep);
          if (!typed) {
            log(`unknown wake action "${action.action}" for ${action.alias} — skipped`);
            continue;
          }
          if ("done" in sink) await sink.done(); // a failed send-keys throws here: no wake-sent
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

  /** A tmux entry lives as long as the registry holds it (its session ending forgets it). */
  const isLive = (id: string | undefined) => {
    const entry = id ? registry.get(id) : undefined;
    return !!entry && (!!entry.session || entry.terminal?.exitStatus === undefined);
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
      claude.terminal?.show(false);
      // Direct terminals: codex splits beside claude here. tmux: both start
      // detached and showing their project attaches them as one split group.
      const codex = await spawnAgent(spawnDeps, {
        kind: "codex",
        alias: alias.codex,
        cwd,
        peer: alias.claude,
        parentTerminal: claude.terminal,
      });
      registry.focus(claude.agent_id);
      paired = { claude: claude.agent_id, codex: codex.agent_id };
      log(`paired claude=${claude.agent_id} codex=${codex.agent_id} window=${window}`);
      await tree.reload();
    } catch (err) {
      const msg = errorText(err);
      log(`pair failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: pair failed — ${msg}`);
    }
  };

  // --- spawn one agent (callers run the doctor gate first), then show its
  // project and focus it
  const spawnOne = async (req: { kind: Kind; alias: string; cwd: string; task?: string; autoSuffix?: boolean }) => {
    const { agent_id, alias } = await spawnAgent(spawnDeps, req);
    registry.focus(agent_id);
    log(`spawned ${alias}=${agent_id} in ${req.cwd} window=${window}`);
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

  type Start = Kind | "shell" | "worktree";
  /** A row's + picker. Picking is the only prompt: the choice starts at once. */
  const pickStart = async (where: string, withWorktree: boolean): Promise<Start | undefined> => {
    const items: (vscode.QuickPickItem & { start: Start })[] = [
      { label: "$(sparkle) Claude", description: "Claude Code", start: "claude" },
      { label: "$(hubot) Codex", description: "Codex", start: "codex" },
      { label: "$(terminal) Terminal", description: "a shell", start: "shell" },
    ];
    if (withWorktree) items.push({ label: "$(git-branch) New worktree…", description: "a worktree for a task, with an agent in it", start: "worktree" });
    return (await vscode.window.showQuickPick(items, { placeHolder: `Start in ${where}` }))?.start;
  };

  /** Claude, Codex or a shell in `cwd`, alias `<folder>-<kind>` (auto-suffixed), shown at once. */
  const startHere = async (start: Kind | "shell", cwd: string) => {
    if (start === "shell") {
      if (!vscode.workspace.isTrusted) throw new Error(UNTRUSTED_MESSAGE);
      if (!spawnDeps.tmux) {
        // No tmux: today's plain terminal; it closes with the window.
        vscode.window.createTerminal({ name: terminalName(cwd, "shell"), cwd }).show(false);
        return;
      }
      const id = await startShell(spawnDeps, cwd);
      registry.focus(id);
      log(`started shell ${id} in ${cwd}`);
      return;
    }
    if (!(await preflightOk(cwd, "start an agent"))) return;
    await spawnOne({ kind: start, alias: defaultAlias(path.basename(cwd), start), cwd, autoSuffix: true });
  };

  // --- New Agent Workspace: worktree for a task + an agent in it.
  // From a project row's + button the project comes with the click.
  const newWorkspace = async (arg?: unknown) => {
    try {
      let project = argProject(arg);
      if (!project && arg instanceof vscode.Uri) {
        // Right-click on a project folder in the Explorer: the folder names the project.
        const projects = await runTop<ProjectEntry[]>(["projects", "list", "--json"], workspaceCwd());
        project = projects.find((p) => p.root === arg.fsPath);
        if (!project) {
          vscode.window.showErrorMessage(`VZT: ${arg.fsPath} is not a registered project — add it with VZT: Add Project.`);
          return;
        }
      }
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

  // --- Start in Project: a project row's + — Claude, Codex or a shell in the
  // project's main checkout, started at once; or a new worktree
  const startInProject = async (arg?: unknown) => {
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
        project = (
          await vscode.window.showQuickPick(
            usable.map((p) => ({ label: p.name, description: p.root, project: p })),
            { placeHolder: "Project" }
          )
        )?.project;
        if (!project) return;
      }
      const start = await pickStart(project.name, true);
      if (!start) return;
      if (start === "worktree") {
        await newWorkspace({ kind: "project", registered: true, name: project.name, root: project.root });
        return;
      }
      await startHere(start, project.root);
    } catch (err) {
      const msg = errorText(err);
      log(`start in project failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: start failed — ${msg}`);
    }
  };

  // --- Add Agent Here: Claude, Codex or a shell in a worktree row's folder (its
  // + button) or in a folder this window already has open
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
      const start = await pickStart(path.basename(cwd), false);
      if (!start || start === "worktree") return;
      await startHere(start, cwd);
    } catch (err) {
      const msg = errorText(err);
      log(`add agent failed: ${msg}`);
      vscode.window.showErrorMessage(`VZT: add agent failed — ${msg}`);
    }
  };

  // --- restore this window's agents from before a reload or restart
  const restore = async () => {
    const saved = context.workspaceState.get<SavedState>(SAVED_KEY);
    if (!saved || !vscode.workspace.getConfiguration("vztMux").get<boolean>("agents.restore", true)) return;
    const savedShells = saved.shells ?? [];
    if (!saved.agents?.length && !savedShells.length) return;
    if (!vscode.workspace.isTrusted) {
      log(`restore skipped: workspace not trusted (${saved.agents.length} agents saved)`);
      return;
    }
    restoring = true;
    const keep: SavedState["agents"] = []; // not restored now, but not gone: try again next start
    const counts: Record<string, number> = {};
    try {
      // tmux sessions first: they need no terminal to come back, so nothing to wait for.
      for (const agent of saved.agents.filter((a) => a.session)) {
        try {
          const outcome = await restoreSession(spawnDeps, tmux, agent, agent.from ?? saved.window);
          if (outcome === "gone" || outcome === "elsewhere") {
            log(`restore ${agent.alias} (${agent.agent_id}): ${outcome}`);
            continue;
          }
          counts[outcome] = (counts[outcome] || 0) + 1;
          log(`restore ${agent.alias} (${agent.agent_id}): ${outcome}${outcome === "adopted" ? ` (tmux session ${agent.session})` : ""}`);
        } catch (err) {
          // --from-window still names the old window; adopting again from it is allowed.
          keep.push({ ...agent, from: agent.from ?? saved.window });
          log(`restore ${agent.alias} failed, kept for next start: ${errorText(err)}`);
        }
      }
      for (const shell of savedShells) {
        const back = await restoreShell(registry, tmux, shell);
        log(`restore shell ${shell.session}: ${back ? "adopted" : "gone"}`);
      }
      // Attach the active project's sessions now, not after the wait below for
      // pre-0.10 terminals — quietly: no Explorer reveal, no terminal raised.
      if (registry.active) registry.showProject(registry.active, { reveal: false, show: false });

      // Pre-0.10 agents (no session): their terminals are the agents.
      const adopted: { agent: SavedState["agents"][number]; a: Adopted }[] = [];
      for (const agent of saved.agents.filter((a) => !a.session)) {
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
      const { agents, shells } = registry.saved();
      save([...agents, ...keep.filter((k) => !registry.get(k.agent_id))], shells);
    }
    // The project the panel showed before: attach what resumed above, too.
    if (registry.active) registry.showProject(registry.active, { reveal: false, show: false });
    const back = [...registry.entries()].filter(([, e]) => e.kind !== "shell").length;
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
    vscode.commands.registerCommand("vzt-mux.agents.startInProject", startInProject),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void tree.reload();
    }),
    // A terminal the user closed ends its tmux session; one whose session ended
    // is forgotten (its lease lapses in 30 s → stale); a project swap's own
    // disposals change nothing. One closed by VS Code shutting down stays saved
    // for restore — its session lives on in tmux.
    vscode.window.onDidCloseTerminal((closed) => {
      const r = closed.exitStatus?.reason;
      const reason: CloseReason =
        r === vscode.TerminalExitReason.Shutdown ? "shutdown" : r === vscode.TerminalExitReason.User ? "user" : "other";
      registry.closed(closed, reason).catch((err) => log(`terminal close: ${errorText(err)}`));
    }),
    // Where the user moved each attached terminal, saved so a swap or a reload
    // brings it back there. A closed terminal tab is checked a beat later: a
    // terminal moved back to the panel is still live then, one closed by
    // shutdown, a swap or the user is not — and must not overwrite its column.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      const terminals = () => [...registry.entries()].map(([, en]) => en.terminal).filter((t): t is vscode.Terminal => !!t && t.exitStatus === undefined);
      for (const t of terminals()) {
        const column = editorColumn(t);
        if (column !== undefined) registry.placed(t, column);
      }
      if (e.closed.some((tab) => tab.input instanceof vscode.TabInputTerminal)) {
        setTimeout(() => {
          if (stopped) return;
          for (const t of terminals()) if (editorColumn(t) === undefined) registry.placed(t, undefined);
        }, 500);
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

  return {
    registry,
    runTop,
    refreshBus: () => tree.reload(),
    onActiveProject: (listener) => {
      activeListeners.push(listener);
    },
  };
}
