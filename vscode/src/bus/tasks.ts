/**
 * Tasks across the bus — the Agent Bus view's answer to Orca's worker list:
 * every `task` message with where it stands, newest open work first. A task's
 * report (`bus complete`) is matched by reply_to. Bodies are never read here,
 * like the rest of the view; subjects only.
 *
 * Kept free of the `vscode` module so test/bus-tasks.test.mjs drives it directly.
 */

export interface InboxMessage {
  id: string;
  seq: number;
  type: string;
  from: string;
  to: string;
  subject: string;
  state: string;
  reply_to?: string | null;
}

export type TaskStatus = "waiting" | "working" | "done" | "failed";

export interface TaskRow {
  id: string;
  seq: number;
  subject: string;
  /** Who asked (alias). */
  from: string;
  /** The worker (alias). */
  to: string;
  status: TaskStatus;
  /** The report's subject once the worker completed it. */
  report?: string;
}

/** queued/delivered/seen: not picked up yet; acknowledged: the worker took it. */
export function taskStatus(state: string): TaskStatus {
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  if (state === "acknowledged") return "working";
  return "waiting";
}

export function taskRows(threads: { messages: InboxMessage[] }[]): TaskRow[] {
  const all = threads.flatMap((t) => t.messages);
  const reports = new Map(all.filter((m) => m.type === "report" && m.reply_to).map((m) => [m.reply_to as string, m.subject]));
  const open = (s: TaskStatus) => s === "waiting" || s === "working";
  return all
    .filter((m) => m.type === "task")
    .map((m) => ({ id: m.id, seq: m.seq, subject: m.subject, from: m.from, to: m.to, status: taskStatus(m.state), report: reports.get(m.id) }))
    .sort((a, b) => Number(open(b.status)) - Number(open(a.status)) || b.seq - a.seq);
}
