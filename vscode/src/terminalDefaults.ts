/**
 * Orca's terminal mouse: right-click pastes, selecting copies. Contributed as
 * `configurationDefaults` (0.10.3–0.11.2) they did not take effect — with
 * 0.11.2 installed and the window reloaded, right-click still opened VS Code's
 * context menu (2026-10-17), and no log said why — so they are written to the
 * user's settings instead: once, and only where the user set nothing. After
 * that the user owns them — changed or removed, never rewritten.
 *
 * Kept free of the `vscode` module so test/terminal-defaults.test.mjs drives it.
 */

export const TERMINAL_DEFAULTS: readonly [string, unknown][] = [
  ["terminal.integrated.rightClickBehavior", "paste"],
  ["terminal.integrated.copyOnSelection", true],
];

/** The state key that records the defaults were offered, so they are never written twice. */
export const APPLIED_KEY = "vztMux.terminalDefaultsApplied";

export interface TerminalDefaultsDeps {
  /** True when the user set `key` anywhere (user, workspace or folder settings). */
  isSet(key: string): boolean;
  /** Write `key` to the user (global) settings. */
  write(key: string, value: unknown): Promise<void>;
  applied(): boolean;
  markApplied(): Promise<void>;
}

/** Returns the keys written. */
export async function applyTerminalDefaults(deps: TerminalDefaultsDeps): Promise<string[]> {
  if (deps.applied()) return [];
  const written: string[] = [];
  for (const [key, value] of TERMINAL_DEFAULTS) {
    if (deps.isSet(key)) continue;
    await deps.write(key, value);
    written.push(key);
  }
  await deps.markApplied();
  return written;
}
