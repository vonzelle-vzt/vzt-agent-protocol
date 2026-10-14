// House agent argv for the VZT agent bus. Must equal vzt-orca-flow's
// AGENT_ARGV (lib/vzt_orca_flow/core.py) — test/agent-argv.test.mjs enforces it.
// Never add flags here; the pane-side argv is the house standard.

export const AGENT_ARGV = Object.freeze({
  claude: Object.freeze(['claude', '--dangerously-skip-permissions']),
  codex: Object.freeze([
    'codex',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
  ]),
});

// The only text ever typed into an agent terminal (plus a bare Enter).
// ASCII, fixed, never carries message data.
export const WAKE_LINE = 'vzt: new bus message - run: vzt-agent bus check --json';

export function BOOTSTRAP_PROMPT(alias, peer) {
  return (
    `You are "${alias}", paired with "${peer}" over the VZT bus in this workspace. ` +
    `Talk to ${peer} ONLY via: vzt-agent bus send --to ${peer} --type message|task|question --subject ... --body ... ; ` +
    'read with: vzt-agent bus check --json ; ack each id with: vzt-agent bus ack --id ID ; ' +
    'answer questions with: vzt-agent bus reply --id ID --body ... ; ' +
    'finish tasks with: vzt-agent bus complete --id ID --outcome succeeded|failed. ' +
    'When you see "vzt: new bus message", run the check command. Now run: vzt-agent bus check --json'
  );
}
