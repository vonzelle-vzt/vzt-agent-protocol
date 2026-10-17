/**
 * Cross-window focus requests — pure, `fs` only.
 *
 * A VS Code terminal belongs to exactly one window. Another window that wants it
 * shown writes `<baseDir>/focus/<agent_id>.json` naming the owning window; the
 * owner polls, claims the record with an atomic rename (the ship-queue pattern:
 * exactly one claimer wins, the loser's rename throws ENOENT) and shows the
 * terminal. A record whose owner is gone expires after 60 s and any window may
 * delete it.
 */

import * as fs from "fs";
import * as path from "path";

export const FOCUS_TTL_MS = 60_000;

interface FocusRecord {
  agent_id: string;
  window_id: string;
  requested_ms: number;
}

function focusDir(baseDir: string): string {
  return path.join(baseDir, "focus");
}

function unique(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The agent id as a single path segment, so an id can never escape `focus/`. */
function fileFor(baseDir: string, agentId: string): string {
  return path.join(focusDir(baseDir), `${encodeURIComponent(agentId)}.json`);
}

export function requestFocus(baseDir: string, agentId: string, windowId: string, nowMs: number): void {
  const dir = focusDir(baseDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: FocusRecord = { agent_id: agentId, window_id: windowId, requested_ms: nowMs };
  const file = fileFor(baseDir, agentId);
  const tmp = `${file}.tmp-${unique()}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — another window cleaned it up
  }
}

function parse(text: string): FocusRecord | null {
  try {
    const r = JSON.parse(text);
    if (r && typeof r.agent_id === "string" && typeof r.window_id === "string" && typeof r.requested_ms === "number") {
      return r;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Claim this window's pending focus requests; returns the agent ids to show. */
export function claimFocus(baseDir: string, windowId: string, nowMs: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(focusDir(baseDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // nobody has asked yet
    throw err;
  }
  const claimed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // tmp-* and claimed-* are someone's work in flight
    const file = path.join(focusDir(baseDir), name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // claimed or expired by another window between readdir and read
    }
    const record = parse(text);
    if (!record) {
      unlinkQuiet(file);
      continue;
    }
    if (nowMs - record.requested_ms > FOCUS_TTL_MS) {
      unlinkQuiet(file);
      continue;
    }
    if (record.window_id !== windowId) continue;
    const tomb = `${file}.claimed-${unique()}`;
    try {
      fs.renameSync(file, tomb);
    } catch {
      continue; // lost the race — another claimer has it
    }
    unlinkQuiet(tomb);
    claimed.push(record.agent_id);
  }
  return claimed;
}
