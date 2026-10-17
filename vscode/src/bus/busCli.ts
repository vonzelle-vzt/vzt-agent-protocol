/**
 * Thin client for `vzt-agent bus <verb> --json`.
 *
 * The extension never touches the bus store itself: every read and write is a
 * short-lived CLI process, so the store has exactly one implementation (the
 * CLI) and the window can reload at any moment without holding anything open.
 *
 * Command resolution (pinned in the spec):
 *   1. setting `vztMux.busCommand` (a shell command prefix)
 *   2. `$SHELL -lc 'command -v vzt-agent'`
 *   3. the repo checkout's `node <repo>/cli/vzt-agent.js` (cliPath)
 *   4. refuse with an install hint
 *
 * The extension host is often launched by launchd with a bare PATH, so `node`
 * and `vzt-agent` are not found from it. The login shell's PATH is captured once
 * and every bus call runs with it — the same PATH the agent terminals (and the
 * hooks they fire) see.
 */

import * as vscode from "vscode";
import { execFile } from "child_process";

export class BusCliError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message);
  }
}

interface LoginShell {
  path: string;
  vztAgent: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function execFileText(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(file, args, { ...opts, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr || (err && code === null ? err.message : "")), code });
    });
  });
}

export class BusCli {
  private login: Promise<LoginShell> | null = null;

  constructor(private readonly cliPath: () => string | null) {}

  /** Forget the resolved command, e.g. after `vztMux.busCommand` changes. */
  reset(): void {
    this.login = null;
  }

  private loginShell(): Promise<LoginShell> {
    if (!this.login) {
      const shell = process.env.SHELL || "/bin/sh";
      this.login = execFileText(
        shell,
        ["-lc", 'printf "%s\\n" "$PATH"; command -v vzt-agent || true'],
        { timeout: 10_000 }
      ).then(({ stdout }) => {
        const [pathLine = "", vztLine = ""] = stdout.split("\n");
        return { path: pathLine.trim() || process.env.PATH || "", vztAgent: vztLine.trim() };
      });
    }
    return this.login;
  }

  /** The shell command prefix that runs `vzt-agent`, plus the PATH to run it with. */
  async resolve(): Promise<{ prefix: string; path: string; source: string }> {
    const login = await this.loginShell();
    const configured = (vscode.workspace.getConfiguration("vztMux").get<string>("busCommand") || "").trim();
    if (configured) return { prefix: configured, path: login.path, source: "setting vztMux.busCommand" };
    if (login.vztAgent.startsWith("/")) return { prefix: shellQuote(login.vztAgent), path: login.path, source: "login shell PATH" };
    const cli = this.cliPath();
    if (cli) return { prefix: `node ${shellQuote(cli)}`, path: login.path, source: "repo checkout" };
    throw new BusCliError(
      "vzt-agent not found. Install it (npm i -g github:vonzelle-vzt/vzt-agent-protocol) or set vztMux.busCommand.",
      null,
      ""
    );
  }

  /**
   * Run `<busCommand> bus <args...> --json` and parse stdout. Arguments are
   * passed as positional parameters ("$@"), never spliced into the shell text.
   * Non-zero exit → BusCliError carrying the CLI's stderr.
   */
  async run<T = unknown>(args: string[], cwd?: string): Promise<T> {
    return this.exec<T>(["bus", ...args, "--json"], cwd);
  }

  /**
   * Run `<busCommand> <args...>` — a top-level verb such as `projects list` or
   * `worktree create`. No `bus` prefix and no forced `--json`: callers pass it.
   */
  async runTop<T = unknown>(args: string[], cwd?: string): Promise<T> {
    return this.exec<T>(args, cwd);
  }

  private async exec<T>(args: string[], cwd?: string): Promise<T> {
    const { prefix, path } = await this.resolve();
    const env = { ...process.env, PATH: path };
    const { stdout, stderr, code } = await execFileText(
      "/bin/sh",
      ["-c", `${prefix} "$@"`, "vzt-agent", ...args],
      { cwd, env, timeout: 30_000 }
    );
    const verb = (args[0] === "bus" ? args.slice(0, 2) : args.slice(0, 1)).join(" ");
    if (code !== 0) {
      throw new BusCliError(
        `vzt-agent ${verb} failed (exit ${code ?? "?"}): ${stderr.trim() || "no output"}`,
        code,
        stderr
      );
    }
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new BusCliError(`vzt-agent ${verb} printed non-JSON output: ${stdout.slice(0, 200)}`, code, stderr);
    }
  }
}
