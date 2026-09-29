#!/usr/bin/env node
/**
 * VZT Agent Protocol — SubagentStart hook.
 *
 * Records which subagent the chair actually dispatched, so routing compliance
 * (advised tier vs dispatched tier) can be measured by `vzt-agent stats`.
 * Appends one {kind:"dispatch"} row to decisions.jsonl. Never fails the
 * session and never writes to stdout.
 *
 * Payload fields (Claude Code SubagentStart): session_id, agent_type.
 * `subagent_type` and tool_input.subagent_type are accepted as fallbacks.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function agentModel(agentType) {
  // Agent names are file basenames; refuse anything path-like.
  if (!/^[\w.-]+$/.test(agentType)) return null;
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.claude', 'agents', `${agentType}.md`), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const m = fm && fm[1].match(/^model:\s*["']?([^\s"'#]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const subagentType = payload.agent_type || payload.subagent_type || payload.tool_input?.subagent_type || null;
  const model = subagentType ? agentModel(String(subagentType)) : null;
  const stateDir = process.env.VZT_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'vzt-router');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(
    path.join(stateDir, 'decisions.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'dispatch',
      session: payload.session_id || null,
      subagent_type: subagentType,
      model,
      modelSource: model ? 'agent-frontmatter' : 'unknown',
    }) + '\n'
  );
} catch {
  /* best-effort: never fail the session */
}
process.exit(0);
