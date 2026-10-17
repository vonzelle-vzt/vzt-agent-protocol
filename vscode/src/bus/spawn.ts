/**
 * Start one bus agent (Claude or Codex) in an integrated terminal.
 *
 * Kept free of the `vscode` module at runtime (`import type` only) so
 * test/spawn-vscode.test.mjs can drive it with a fake run/createTerminal/launch.
 *
 * Nothing here decides WHAT to launch: the agent argv comes from `bus argv`, the
 * first prompt from `bus bootstrap-prompt`. This file only registers the agent,
 * opens its terminal, and hands the CLI's command to `launch` (the delayed
 * sendWhenReady in extension.ts).
 */

import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import type { AgentRegistry } from "./registry";

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
}

export interface SpawnRequest {
  kind: Kind;
  alias: string;
  cwd: string;
  peer?: string;
  task?: string;
  parentTerminal?: vscode.Terminal;
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

export async function spawnAgent(
  deps: SpawnDeps,
  req: SpawnRequest
): Promise<{ agent_id: string; terminal: vscode.Terminal }> {
  const { run, windowId } = deps;
  const { kind, alias, cwd } = req;

  await gateTrust(deps, kind, cwd);
  const { agent_id } = await run<{ agent_id: string }>(
    ["register", "--alias", alias, "--kind", kind, "--window", windowId, "--workspace", cwd],
    cwd
  );
  const terminal = await startAgent(deps, { ...req, agent_id });
  return { agent_id, terminal };
}

/** The terminal name of an agent; restore finds a revived terminal by it. */
export function terminalName(cwd: string, alias: string): string {
  return `${path.basename(cwd)}·${alias}`;
}

/**
 * Open a terminal for an already-registered (or adopted) agent and launch it:
 * resumed from `resume` (the session id its SessionStart hook recorded), else
 * fresh with the bootstrap prompt. The caller has run gateTrust.
 */
export async function startAgent(
  deps: SpawnDeps,
  req: SpawnRequest & { agent_id: string; resume?: string | null }
): Promise<vscode.Terminal> {
  const { run, windowId } = deps;
  const { kind, alias, cwd, agent_id } = req;

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
  const terminal = deps.createTerminal({
    name: terminalName(cwd, alias),
    cwd,
    env,
    ...(req.parentTerminal ? { location: { parentTerminal: req.parentTerminal } } : {}),
  });
  deps.registry.set(agent_id, { alias, kind, cwd, terminal });

  deps.launch(terminal, words.map(shellQuote).join(" "), `bus ${alias} (${agent_id})`);
  return terminal;
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
