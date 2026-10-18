/**
 * Every tmux call vzt-mux makes, all of them against its PRIVATE server.
 *
 * Why tmux: a VS Code terminal dies with its window, and a one-window project
 * swap has to dispose terminals. So an agent runs in a tmux session and its VS
 * Code terminal is only an attach client: swapping projects, closing the window
 * or reloading it detaches the client and the agent runs on (Orca's model).
 *
 * Why a private server (`-L vzt-mux`, config `~/.vzt/mux/tmux.conf`): the
 * user's own tmux server, its sessions and its ~/.tmux.conf are never touched
 * or read. `-f <conf>` goes on every command that can START a server —
 * new-session, and attach-session (tmux 3.7b starts a server for it, then
 * prints "no sessions"); a running server ignores it.
 *
 * Kept free of the `vscode` module and of child_process: every call goes through
 * the injected `exec`, so test/tmux-vscode.test.mjs drives it with a fake and
 * asserts the exact argv. No other file builds a tmux argv.
 *
 * Targets are exact: `=name` for a session, `=name:` for its pane. A bare name
 * is a PREFIX match (has-session -t vzt-ab succeeds while only vzt-abc exists),
 * so a bare target could kill or type into another agent. `=name` alone is not
 * a pane target ("can't find pane"), hence the trailing colon.
 *
 * Literal text (`send-keys -l`) has two traps, both reproduced on tmux 3.7b:
 *   - an argument ending in ";" is a command separator: the ";" is dropped, and
 *     the "\;" escape also eats a backslash before it. Trailing semicolons are
 *     sent as hex keys (`-H 3b`) instead.
 *   - one command over ~16 KB fails with "command too long", so text goes in
 *     chunks under a UTF-8 byte budget — a long first task can exceed it.
 * And with `mouse on`, scrolling up puts the pane in copy-mode, where typed
 * keys never reach the agent ("no current client"). Every typing call first
 * leaves any mode (`copy-mode -q`, a no-op otherwise), so a wake still lands.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TextSink } from "./wake";

/** Runs `file args...` and resolves stdout; rejects on a non-zero exit, carrying stderr. */
export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export const SOCKET = "vzt-mux";

/** Where tmux lives when the extension host's PATH is launchd's bare one. */
export const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Bytes of literal text per send-keys — far under tmux's ~16 KB command limit. */
export const CHUNK_BYTES = 4096;

const NO_SERVER_RE = /no server running|error connecting to/i;

export function defaultConfPath(home: string = os.homedir()): string {
  return path.join(home, ".vzt", "mux", "tmux.conf");
}

/** The private server's config: an invisible host for agent TUIs, mouse-scrollable. */
export function confText(platform: NodeJS.Platform = process.platform): string {
  const lines = [
    "# Written by the vzt-mux VS Code extension on every activation; edits are overwritten.",
    "# Read only by its private agent server (tmux -L vzt-mux), never by your own tmux.",
    "set -g mouse on",
    "set -g status off",
    "set -g history-limit 50000",
    "set -s escape-time 0",
    'set -g default-terminal "tmux-256color"',
    "set -g window-size latest",
    "set -s set-clipboard on",
    // Truecolor for agent TUIs (VS Code's terminal renders it), and through a
    // layout pane, whose attach client sees TERM=tmux-256color.
    'set -as terminal-features ",xterm-256color:RGB"',
    'set -as terminal-features ",tmux-256color:RGB"',
    "set-environment -g COLORTERM truecolor",
    // No prefix key: the server is invisible, and C-b is Claude Code's
    // background-a-command key — a prefix would eat the first press.
    "set -g prefix None",
    "unbind-key C-b",
    // Right-click pastes (VS Code's terminal.integrated.rightClickBehavior,
    // defaulted to "paste" by package.json); tmux's own right-click menu would
    // pop up over it.
    "unbind-key -n MouseDown3Pane",
  ];
  if (platform === "darwin") {
    // Both tables: tmux picks vi copy-mode keys on its own when $EDITOR or
    // $VISUAL mentions vi, and a drag that copies nothing is the bug.
    lines.push(
      'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
      'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"'
    );
  }
  return lines.join("\n") + "\n";
}

/** (Re)write the config atomically, so a server starting right now never reads half of it. */
export function writeConf(file: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, confText(platform));
  fs.renameSync(tmp, file);
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The tmux binary: PATH first, then the Homebrew prefixes. Null = not installed. */
export function findTmux(
  pathEnv: string = process.env.PATH || "",
  isExecutable: (file: string) => boolean = isExecutableFile
): string | null {
  const dirs = [...pathEnv.split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const file = path.join(dir, "tmux");
    if (isExecutable(file)) return file;
  }
  return null;
}

/** tmux rewrites "." and ":" in session names; keep names verbatim so `=name` targets match. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** One session per bus agent. */
export function agentSession(agentId: string): string {
  return `vzt-${safeName(agentId)}`;
}

/**
 * One layout session per worktree: its panes are attach clients of that
 * worktree's agent sessions, so they split side by side in ONE VS Code
 * terminal and tmux keeps the arrangement across swaps and reloads.
 */
export function layoutSession(cwd: string): string {
  return `vzt-lay-${crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
}

/** One session per plain terminal. */
export function shellSession(random: () => string = () => crypto.randomBytes(4).toString("hex")): string {
  return `vzt-sh-${safeName(random())}`;
}

/** Split text into send-keys chunks under `maxBytes` of UTF-8, never inside a code point. */
export function literalChunks(text: string, maxBytes: number = CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (cur && bytes + n > maxBytes) {
      chunks.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface TmuxOptions {
  bin: string;
  exec: Exec;
  conf: string;
  /** The `-L` socket name. Tests pass their own so they never meet real agents. */
  socket?: string;
  sleep?: (ms: number) => Promise<void>;
}

/** What a VS Code terminal needs to be an attach client of `session`. */
export interface AttachOptions {
  shellPath: string;
  shellArgs: string[];
  /** A VS Code started from inside tmux passes $TMUX on, and tmux then refuses to attach ("nested"). */
  env: Record<string, string | null>;
}

/** A wake sink whose keystrokes are tmux commands; `done()` settles once they all ran. */
export interface TmuxSink extends TextSink {
  done(): Promise<void>;
}

export class Tmux {
  readonly bin: string;
  readonly socket: string;
  readonly conf: string;
  private readonly exec: Exec;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TmuxOptions) {
    this.bin = opts.bin;
    this.socket = opts.socket ?? SOCKET;
    this.conf = opts.conf;
    this.exec = opts.exec;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  private run(args: string[], startsServer = false): Promise<{ stdout: string }> {
    const base = startsServer ? ["-L", this.socket, "-f", this.conf] : ["-L", this.socket];
    return this.exec(this.bin, [...base, ...args]);
  }

  /** A detached session running the default login shell in `cwd`, with `env` set. */
  async newSession(name: string, cwd: string, env: Record<string, string>): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    await this.run(["new-session", "-d", "-s", name, "-c", cwd, ...envArgs], true);
  }

  /** False for a missing session, a stopped server, or any failure to ask. */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  /** Leave copy-mode (or any mode) so keys reach the program, not tmux. */
  private async leaveMode(name: string): Promise<void> {
    await this.run(["copy-mode", "-q", "-t", `=${name}:`]);
  }

  /** Type `text` literally into the session's pane (no Enter). */
  async sendText(name: string, text: string): Promise<void> {
    const chunks = literalChunks(text);
    if (chunks.length) await this.leaveMode(name);
    for (const chunk of chunks) {
      const semis = /;+$/.exec(chunk);
      const literal = semis ? chunk.slice(0, semis.index) : chunk;
      if (literal) await this.run(["send-keys", "-t", `=${name}:`, "-l", "--", literal]);
      if (semis) await this.run(["send-keys", "-t", `=${name}:`, "-H", ...semis[0].split("").map(() => "3b")]);
    }
  }

  async sendEnter(name: string): Promise<void> {
    await this.leaveMode(name);
    await this.run(["send-keys", "-t", `=${name}:`, "Enter"]);
  }

  /** The pane's visible screen as plain text. */
  async capture(name: string): Promise<string> {
    return (await this.run(["capture-pane", "-p", "-t", `=${name}:`])).stdout;
  }

  /** The pid of the session's pane process (its login shell): the agent's lease pid. */
  async panePid(name: string): Promise<number | undefined> {
    const out = (await this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"])).stdout.trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  /**
   * Every session's first pane pid in ONE call (the poller's lease, every 1.5 s).
   * A stopped server has no sessions: an empty map, not an error.
   */
  async panePids(): Promise<Map<string, number>> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]));
    } catch (err) {
      const e = err as { stderr?: unknown; message?: unknown };
      if (NO_SERVER_RE.test(`${e.stderr ?? ""} ${e.message ?? ""}`)) return new Map();
      throw err;
    }
    const pids = new Map<string, number>();
    for (const line of stdout.split("\n")) {
      const [name, pid] = line.split("\t");
      const n = Number(pid);
      if (name && Number.isInteger(n) && n > 0 && !pids.has(name)) pids.set(name, n);
    }
    return pids;
  }

  attachOptions(name: string): AttachOptions {
    return {
      shellPath: this.bin,
      shellArgs: ["-L", this.socket, "-f", this.conf, "attach-session", "-t", `=${name}`],
      env: { TMUX: null, TMUX_PANE: null },
    };
  }

  /** Re-read the config into a server that is already running (no server: nothing to do). */
  async sourceConf(): Promise<void> {
    try {
      await this.run(["source-file", this.conf]);
    } catch {
      // no server yet: the next new-session reads the file itself
    }
  }

  /**
   * A layout pane's command: an attach client of `session`, run as argv (never
   * through the pane's shell — zsh reads `=name` as a command lookup). $TMUX
   * unset, or tmux refuses to attach from inside one of its own panes.
   */
  private attachArgv(session: string): string[] {
    return ["env", "-u", "TMUX", this.bin, "-L", this.socket, "attach-session", "-t", `=${session}`];
  }

  /**
   * The layout's panes by the session each one shows; undefined when the
   * layout session does not exist. A pane not marked yet (the window reloaded
   * between its split and its mark) is known by its attach command, so it is
   * never added twice.
   */
  async layoutPanes(layout: string): Promise<Map<string, string> | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(["list-panes", "-s", "-t", `=${layout}`, "-F", "#{@vzt-session}\t#{pane_id}\t#{pane_start_command}"]));
    } catch {
      return undefined;
    }
    const panes = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [marked, pane, command = ""] = line.split("\t");
      const session = marked || /attach-session -t =([A-Za-z0-9_-]+)/.exec(command)?.[1];
      if (session && pane) panes.set(session, pane);
    }
    return panes;
  }

  /** Mark a layout pane with the session it shows and the label on its border. */
  private async markPane(pane: string, session: string, label: string): Promise<void> {
    await this.run(["set-option", "-p", "-t", pane, "@vzt-session", session]);
    await this.run(["set-option", "-p", "-t", pane, "@vzt-label", label]);
  }

  /** Start the layout session for `cwd` with one pane showing `session`. */
  async newLayout(layout: string, cwd: string, session: string, label: string): Promise<void> {
    const pane = (
      await this.run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", layout, "-c", cwd, "--", ...this.attachArgv(session)], true)
    ).stdout.trim();
    // Each pane is titled with its agent, as Orca's pane headers are.
    await this.run(["set-option", "-w", "-t", `=${layout}:`, "pane-border-status", "top"]);
    await this.run(["set-option", "-w", "-t", `=${layout}:`, "pane-border-format", " #{?@vzt-label,#{@vzt-label},#{pane_current_command}} "]);
    await this.markPane(pane, session, label);
  }

  /** Split a pane showing `session` to the right of the active one, keeping focus where it is (Orca's split). */
  async addPane(layout: string, cwd: string, session: string, label: string): Promise<void> {
    const pane = (
      await this.run(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", `=${layout}:`, "-c", cwd, "--", ...this.attachArgv(session)])
    ).stdout.trim();
    await this.markPane(pane, session, label);
  }

  /** Make the pane showing `session` the layout's active one; false when it has none. */
  async selectPane(layout: string, session: string): Promise<boolean> {
    const pane = (await this.layoutPanes(layout))?.get(session);
    if (!pane) return false;
    await this.run(["select-pane", "-t", pane]);
    return true;
  }

  /**
   * Type a command into the session's shell once it has drawn something (its
   * prompt), then Enter. Typed-ahead keys are buffered by the pty anyway; the
   * wait only keeps them out of a shell rc that reads the terminal.
   */
  async launch(name: string, cmd: string, polls = 50, pollMs = 100): Promise<void> {
    for (let i = 0; i < polls; i++) {
      const screen = await this.capture(name).catch(() => "");
      if (screen.trim()) break;
      await this.sleep(pollMs);
    }
    await this.sendText(name, cmd);
    await this.sendEnter(name);
  }

  /**
   * A TextSink for wake.ts: "\r" is the Enter key, anything else literal text.
   * Calls run in order; a failure skips the rest and rejects `done()`, so the
   * poller never reports a wake that was not typed.
   */
  sink(name: string): TmuxSink {
    let chain: Promise<void> = Promise.resolve();
    return {
      sendText: (text: string, addNewLine = true) => {
        const parts = text.split("\r");
        chain = chain.then(async () => {
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) await this.sendEnter(name);
            if (parts[i]) await this.sendText(name, parts[i]);
          }
          if (addNewLine) await this.sendEnter(name);
        });
        chain.catch(() => {}); // observed by done(); never an unhandled rejection meanwhile
      },
      done: () => chain,
    };
  }
}
