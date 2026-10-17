/**
 * Which Claude Code IDE server a tmux-hosted claude should connect to.
 *
 * Kept free of the `vscode` module so test/ide-vscode.test.mjs can drive it
 * with a temp lock directory.
 *
 * In a VS Code terminal, Claude's own extension injects CLAUDE_CODE_SSE_PORT
 * and claude auto-connects. A tmux session is born from the tmux server, not
 * from that terminal, so the variable never arrives and TERM_PROGRAM is "tmux"
 * (claude 2.1.302: auto-connect needs the port, a VS Code terminal, or the
 * autoConnectIde setting). So we pass the port ourselves, read from the lock
 * file Claude's extension writes per window: ~/.claude/ide/<port>.lock
 * = { pid, workspaceFolders, ideName, ... }. Every VS Code window shares the
 * main process pid, so the window is told apart by its folders.
 */

import * as fs from "fs";
import * as path from "path";

interface IdeLock {
  port: string;
  pid: number;
  folders: string[];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLocks(ideDir: string, isAlive: (pid: number) => boolean): IdeLock[] {
  let names: string[];
  try {
    names = fs.readdirSync(ideDir);
  } catch {
    return []; // Claude's extension never ran: nothing to connect to
  }
  const locks: IdeLock[] = [];
  for (const name of names) {
    const m = /^(\d+)\.lock$/.exec(name);
    if (!m) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ideDir, name), "utf8"));
      if (typeof d.pid !== "number" || !isAlive(d.pid)) continue; // a crashed window's leftover
      const folders = Array.isArray(d.workspaceFolders) ? d.workspaceFolders.filter((f: unknown) => typeof f === "string") : [];
      locks.push({ port: m[1], pid: d.pid, folders });
    } catch {
      // half-written or foreign file: skip
    }
  }
  return locks;
}

function inside(dir: string, cwd: string): boolean {
  const rel = path.relative(dir, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The port of THIS window's Claude IDE server: the live lock whose folders are
 * exactly this window's folders; else the only live lock with a folder holding
 * `cwd`. Undefined when none or several qualify — claude then falls back to
 * its own detection, never to a guessed window.
 */
export function claudeIdePort(
  ideDir: string,
  windowFolders: string[],
  cwd: string,
  isAlive: (pid: number) => boolean = alive
): string | undefined {
  const locks = readLocks(ideDir, isAlive);
  const want = [...windowFolders].sort().join("\n");
  if (want) {
    const same = locks.filter((l) => [...l.folders].sort().join("\n") === want);
    if (same.length === 1) return same[0].port;
  }
  const holding = locks.filter((l) => l.folders.some((f) => inside(f, cwd)));
  return holding.length === 1 ? holding[0].port : undefined;
}
