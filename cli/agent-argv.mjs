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

// Resume a recorded session: the house argv plus each CLI's own resume form.
// sessionId is the one the agent's SessionStart hook reported to the bus.
export function RESUME_ARGV(kind, sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(sessionId || '')) throw new Error('session id must be 1-128 chars of [A-Za-z0-9-], not starting with -');
  return kind === 'claude'
    ? [...AGENT_ARGV.claude, '--resume', sessionId]
    : [...AGENT_ARGV.codex, 'resume', sessionId];
}

// The only text ever typed into an agent terminal (plus a bare Enter).
// ASCII, fixed, never carries message data.
export const WAKE_LINE = 'vzt: new bus message - run: vzt-agent bus check --json';

// With a peer: the paired prompt (byte-stable). Without one: the multi-agent
// prompt for an agent that addresses any agent of its project by alias.
export function BOOTSTRAP_PROMPT(alias, peer) {
  if (peer === undefined) {
    return (
      `You are "${alias}", one of the agents working on this project over the VZT bus. ` +
      'See who is up with: vzt-agent bus agents --project --json . ' +
      'Talk to another agent ONLY via: vzt-agent bus send --to <alias> --type message|task|question --subject ... --body ... ; ' +
      'read your inbox with: vzt-agent bus check --json ; ' +
      'answer questions with: vzt-agent bus reply --id <id> --body ... . ' +
      'A line starting "vzt: new bus message" means run that check.'
    );
  }
  return (
    `You are "${alias}", paired with "${peer}" over the VZT bus in this workspace. ` +
    `Talk to ${peer} ONLY via: vzt-agent bus send --to ${peer} --type message|task|question --subject ... --body ... ; ` +
    'read with: vzt-agent bus check --json ; ack each id with: vzt-agent bus ack --id ID ; ' +
    'answer questions with: vzt-agent bus reply --id ID --body ... ; ' +
    'finish tasks with: vzt-agent bus complete --id ID --outcome succeeded|failed. ' +
    'When you see "vzt: new bus message", run the check command. Now run: vzt-agent bus check --json'
  );
}
