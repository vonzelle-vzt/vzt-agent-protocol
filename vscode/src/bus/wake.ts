/**
 * Wake executor — the ONLY place the extension types into an agent terminal.
 *
 * Kept free of the `vscode` module on purpose: test/bus-vscode.test.mjs imports
 * the compiled file directly and drives it with a fake terminal.
 *
 * What is typed is decided entirely by the bus (`bus wake-plan`). The line is
 * the fixed WAKE_LINE constant the CLI returns — never message content, never a
 * command composed here.
 *
 * Codex has paste-burst detection: text plus Enter arriving together is taken
 * as a pasted newline, not a submit. So the line goes in WITHOUT a newline, and
 * a bare "\r" follows after a pause. A wake that still is not confirmed gets one
 * `retry-enter` (Enter only) from the planner.
 */

export interface WakeAction {
  agent_id: string;
  alias: string;
  action: "wake" | "retry-enter";
  line: string;
  attempt_id: string;
}

export interface TextSink {
  sendText(text: string, addNewLine?: boolean): void;
}

export const WAKE_ENTER_DELAY_MS = 400;

/**
 * Type one planned wake action into `terminal`. Returns true when something was
 * typed — the caller then reports it with `bus wake-sent --attempt`. An action
 * kind this build does not know is left untouched (false), never guessed at.
 */
export async function executeWakeAction(
  action: WakeAction,
  terminal: TextSink,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  if (action.action === "wake") {
    terminal.sendText(action.line, false);
    await sleep(WAKE_ENTER_DELAY_MS);
    terminal.sendText("\r", false);
    return true;
  }
  if (action.action === "retry-enter") {
    terminal.sendText("\r", false);
    return true;
  }
  return false;
}
