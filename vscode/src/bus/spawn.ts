/**
 * Start one bus agent (Claude or Codex), or a plain shell, for this window.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs can drive it with a fake run/createTerminal/launch
 * and a Tmux over a fake exec.
 *
 * Nothing here decides WHAT to launch: the agent argv comes from `bus argv`, the
 * first prompt from `bus bootstrap-prompt`. This file only registers the agent
 * and starts it — in a detached tmux session when `deps.tmux` is set (the
 * window attaches it when its project is shown: registry.ts showProject), else
 * in its own integrated terminal through `launch` (the delayed sendWhenReady in
 * extension.ts). Either way the command is typed into a login shell, so an
 * agent that exits leaves a shell prompt behind.
 */

import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import type { AgentRegistry } from "./registry";
import { agentSession, Exec, shellSession, Tmux } from "./tmux";

export type Kind = "claude" | "codex";

/** Runs `vzt-agent bus <args...> --json` and parses stdout (BusCli.run). */
export type BusRun = <T = unknown>(args: string[], cwd?: string) => Promise<T>;

export type Launch = (terminal: vscode.Terminal, cmd: string, label: string) => void;

export interface SpawnDeps {
  run: BusRun;
  createTerminal(opts: vscode.TerminalOptions): vscode.Terminal;
  launch: Launch;
  windowId: string;
  registry: AgentRegistry;
  isTrusted(): boolean;
  /** Set = start in tmux sessions; unset = direct terminals (no tmux, or vztMux.agents.tmux off). */
  tmux?: Tmux;
  /** The bus's project rule for a folder; used when the CLI's answer lacks it, and for shells. */
  projectOf?(cwd: string): Promise<string>;
  log?(line: string): void;
}

export interface SpawnRequest {
  kind: Kind;
  alias: string;
  cwd: string;
  peer?: string;
  task?: string;
  parentTerminal?: vscode.Terminal;
  /** Try `alias`, then `alias-2` … `alias-9` while the bus refuses the alias as taken. */
  autoSuffix?: boolean;
}

/** The doctor field that says the CLI's Node can load its storage engine. */
const ENGINE_OK_FIELD = ["node", "sq" + "lite"].join("_");

interface Doctor {
  codex_hooks?: { untrusted?: string[]; missing?: string[] };
  claude_hooks?: { missing?: string[] };
  [key: string]: unknown;
}

export const UNTRUSTED_MESSAGE =
  "trust this workspace in VS Code first (Workspaces: Manage Workspace Trust). Claude runs here with permissions bypassed.";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The doctor checks that must pass before any agent starts. Empty = go. */
export async function preflight(run: BusRun, cwd: string): Promise<string[]> {
  return (await preflightReport(run, cwd)).problems;
}

/** preflight plus the full doctor JSON, so a refusal can show it. */
export async function preflightReport(run: BusRun, cwd: string): Promise<{ problems: string[]; doctor: Doctor }> {
  const doctor = await run<Doctor>(["doctor"], cwd);
  const untrusted = doctor.codex_hooks?.untrusted || [];
  const problems: string[] = [];
  if (doctor[ENGINE_OK_FIELD] !== true) problems.push("the Node that runs vzt-agent cannot load the bus store (needs Node 22.5+).");
  if (untrusted.length) problems.push(`${untrusted.length} Codex bus hook(s) are not trusted yet — open codex once and approve them.`);
  return { problems, doctor };
}

/**
 * Refuse an untrusted VS Code workspace, then pre-accept Claude's own folder
 * trust. Runs before anything is registered or launched.
 */
export async function gateTrust(deps: SpawnDeps, kind: Kind, cwd: string): Promise<void> {
  if (!deps.isTrusted()) throw new Error(UNTRUSTED_MESSAGE);

  // Claude Code 2.1.299 stops on its folder-trust dialog even under the house
  // permission-bypass flag (cursor on "No, exit"), so a spawned claude would
  // never start. Pre-accept it — but ONLY for a folder VS Code itself already
  // trusts (checked above): the trust decision stays the user's.
  if (kind === "claude") await deps.run(["trust-claude", "--workspace", cwd], cwd);
}

/**
 * How `bus register` says an alias is taken: exit 4 with one of these messages
 * (cli/bus/store.mjs register). Exit 4 alone is not enough — only these mean
 * "pick another alias"; anything else is a real failure and is never retried.
 */
const ALIAS_TAKEN_RE = /alias "[^"]*" is (already used in this project|live in another window|registered as kind)/;

export function aliasTaken(err: unknown): boolean {
  const e = err as { exitCode?: unknown; stderr?: unknown; message?: unknown } | undefined;
  return e?.exitCode === 4 && ALIAS_TAKEN_RE.test(`${e.stderr ?? ""} ${e.message ?? ""}`);
}

/** `alias`, `alias-2` … `alias-9`. */
export function aliasCandidates(alias: string): string[] {
  return [alias, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${alias}-${n}`)];
}

/**
 * `<folder>-<kind>` as a bus alias (1-64 of [A-Za-z0-9._-]): other characters
 * become "-", and the folder part leaves room for a `-9` suffix.
 */
export function defaultAlias(folder: string, kind: Kind): string {
  const max = 64 - kind.length - 1 - 2;
  const base = folder.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  return `${base || "agent"}-${kind}`;
}

export async function spawnAgent(
  deps: SpawnDeps,
  req: SpawnRequest
): Promise<{ agent_id: string; alias: string; terminal?: vscode.Terminal; project?: string }> {
  const { run, windowId } = deps;
  const { kind, cwd } = req;

  await gateTrust(deps, kind, cwd);
  // An alias one of THIS window's agents holds would not be refused: the bus
  // hands the same workspace + window its agent back (register "reused"),
  // resetting a running agent. Skip those before asking.
  const held = new Set([...deps.registry.entries()].filter(([, e]) => e.kind !== "shell").map(([, e]) => e.alias));
  const candidates = req.autoSuffix ? aliasCandidates(req.alias).filter((a) => !held.has(a)) : [req.alias];
  let refused: unknown;
  for (const alias of candidates) {
    let reg: { agent_id: string; project?: string };
    try {
      reg = await run<{ agent_id: string; project?: string }>(
        ["register", "--alias", alias, "--kind", kind, "--window", windowId, "--workspace", cwd],
        cwd
      );
    } catch (err) {
      if (!req.autoSuffix || !aliasTaken(err)) throw err;
      refused = err;
      continue;
    }
    const { agent_id, project } = reg;
    const terminal = await startAgent(deps, { ...req, alias, agent_id, project });
    return { agent_id, alias, terminal, project };
  }
  const why = refused instanceof Error ? ` (last: ${refused.message})` : "";
  throw new Error(`every alias from ${req.alias} to ${req.alias}-9 is taken in this project${why}`);
}

/** The terminal name of an agent; restore finds a revived terminal by it. */
export function terminalName(cwd: string, alias: string): string {
  return `${path.basename(cwd)}·${alias}`;
}

/**
 * Start an already-registered (or adopted) agent: resumed from `resume` (the
 * session id its SessionStart hook recorded), else fresh with the bootstrap
 * prompt. The caller has run gateTrust.
 *
 * With tmux the agent gets the detached session `vzt-<agent_id>` and no
 * terminal yet (returns undefined). A session of that name that already runs
 * is this very agent (the bus handed its id back), so it is registered as is
 * and nothing is typed into it. Without tmux it gets its own terminal.
 */
export async function startAgent(
  deps: SpawnDeps,
  req: SpawnRequest & { agent_id: string; resume?: string | null; project?: string }
): Promise<vscode.Terminal | undefined> {
  const { run, windowId, tmux } = deps;
  const { kind, alias, cwd, agent_id } = req;
  const session = tmux ? agentSession(agent_id) : undefined;
  const project = tmux ? req.project ?? (await projectFor(deps, cwd)) : req.project;

  if (tmux && session && (await tmux.hasSession(session))) {
    deps.registry.set(agent_id, { alias, kind, cwd, session, project });
    deps.log?.(`${alias}: tmux session ${session} already runs it — kept, nothing typed`);
    return undefined;
  }

  let words: string[];
  if (req.resume) {
    words = await run<string[]>(["argv", "--kind", kind, "--resume", req.resume], cwd);
  } else {
    const argv = await run<string[]>(["argv", "--kind", kind], cwd);
    const promptArgs = ["bootstrap-prompt", "--alias", alias, ...(req.peer ? ["--peer", req.peer] : [])];
    const { prompt: bootstrap } = await run<{ prompt: string }>(promptArgs, cwd);
    words = [...argv, req.task ? `${bootstrap}\n\nYour first task: ${req.task}` : bootstrap];
  }

  const env: Record<string, string> = {
    VZT_BUS_AGENT: agent_id,
    VZT_BUS_KIND: kind,
    VZT_BUS_WINDOW: windowId,
    ...(kind === "claude" ? { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1" } : {}),
  };
  const cmd = words.map(shellQuote).join(" ");
  const label = `bus ${alias} (${agent_id})`;

  if (tmux && session) {
    await tmux.newSession(session, cwd, env);
    deps.registry.set(agent_id, { alias, kind, cwd, session, project });
    // Not awaited, like sendWhenReady: the window attaches the session while
    // its shell starts; the command is typed once the shell has drawn.
    tmux.launch(session, cmd).then(
      () => deps.log?.(`launched ${label} in tmux session ${session}`),
      (err) => deps.log?.(`launch of ${label} failed — ${err instanceof Error ? err.message : String(err)}`)
    );
    return undefined;
  }

  const terminal = deps.createTerminal({
    name: terminalName(cwd, alias),
    cwd,
    env,
    ...(req.parentTerminal ? { location: { parentTerminal: req.parentTerminal } } : {}),
  });
  deps.registry.set(agent_id, { alias, kind, cwd, terminal, ...(project ? { project } : {}) });

  deps.launch(terminal, cmd, label);
  return terminal;
}

async function projectFor(deps: SpawnDeps, cwd: string): Promise<string> {
  try {
    return deps.projectOf ? await deps.projectOf(cwd) : cwd;
  } catch {
    return cwd;
  }
}

/**
 * A plain login shell in `cwd`, in its own tmux session (the caller checked
 * deps.tmux). Not a bus agent: no registration, no lease, never woken. Keyed
 * in the registry by its session name. Returns that key.
 */
export async function startShell(deps: SpawnDeps, cwd: string): Promise<string> {
  if (!deps.isTrusted()) throw new Error(UNTRUSTED_MESSAGE);
  const tmux = deps.tmux;
  if (!tmux) throw new Error("plain terminals in a project need tmux");
  const project = await projectFor(deps, cwd);
  const taken = new Set([...deps.registry.entries()].filter(([, e]) => e.kind === "shell" && e.cwd === cwd).map(([, e]) => e.alias));
  let alias = "shell";
  for (let n = 2; taken.has(alias); n++) alias = `shell-${n}`;
  const session = shellSession();
  await tmux.newSession(session, cwd, {});
  deps.registry.set(session, { alias, kind: "shell", cwd, session, project });
  return session;
}

/**
 * The bus's project rule (cli/bus/cli.mjs resolveProject): the main checkout
 * every worktree of a repo shares — the parent of `git rev-parse
 * --git-common-dir`, or that dir itself for a bare repo — realpath'd. Not a
 * git checkout: the folder itself.
 */
export async function projectOf(exec: Exec, cwd: string): Promise<string> {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  let common = "";
  try {
    common = (await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  } catch {
    // not a git checkout
  }
  if (!common) return real(cwd);
  return real(path.basename(common) === ".git" ? path.dirname(common) : common);
}

/**
 * Pair aliases. Aliases are unique per project, so a pair in a linked worktree
 * (whose `.git` is a file, not a directory) gets `<worktree>-claude`/`-codex`
 * and does not collide with the pair in the main checkout.
 */
export function pairAliases(cwd: string): Record<Kind, string> {
  let linked = false;
  try {
    linked = fs.statSync(path.join(cwd, ".git")).isFile();
  } catch {
    // not a git checkout: plain names
  }
  const prefix = linked ? `${path.basename(cwd)}-` : "";
  return { claude: `${prefix}claude`, codex: `${prefix}codex` };
}
