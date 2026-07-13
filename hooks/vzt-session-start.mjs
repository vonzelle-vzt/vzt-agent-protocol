#!/usr/bin/env node
/**
 * VZT Agent Protocol — SessionStart hook.
 *
 * Captures the chair model (the model the session was launched with) into
 * ~/.claude/vzt-router/chair.json so the per-prompt classifier can apply the
 * right routing profile, and injects the chair-matched routing doctrine once
 * per session.
 *
 * Chair profiles (the doctrine inverts with the chair):
 *   Fable 5  — tokens are the scarce resource: delegate execution DOWN hard.
 *   Opus 4.8 — wall-clock is scarce: inline heavy work, push mechanical down.
 *   Sonnet 5 — capability is scarce: escalate UP only when a task earns it.
 *   Haiku    — recon chair: delegate almost everything up.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = process.env.VZT_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'vzt-router');

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const model = (payload.model || '').toLowerCase();
let chair = 'unknown';
for (const t of ['fable', 'opus', 'sonnet', 'haiku']) if (model.includes(t)) chair = t;

// Persist chair state keyed by session, plus a `latest` fallback.
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, 'chair.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* fresh state */
  }
  if (payload.session_id) state[payload.session_id] = payload.model || 'unknown';
  state.latest = payload.model || 'unknown';
  // Keep the file small: cap at ~50 sessions.
  const keys = Object.keys(state).filter((k) => k !== 'latest');
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete state[k];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
} catch {
  /* best-effort */
}

const PROFILES = {
  fable: `Chair = Fable 5. Fable tokens are the scarcest resource in this session.
- Do planning, architecture, and root-cause reasoning INLINE (that is what this chair is for).
- Delegate ALL execution down: standard builds → "vzt-builder" (Sonnet 5), mechanical edits/recon → "vzt-mechanic"/"vzt-scout" (Haiku 4.5), heavy parallel implementation → "vzt-heavy-builder" (Opus 4.8).
- Never do file-by-file mechanical work inline. Batch delegations; pass complete context so subagents finish in one shot.
- Long-horizon builds do NOT belong at this chair: they are spec-first process work, not frontier reasoning. Write the spec, then hand it to /vzt-ship on Opus.
- When orchestrating multi-step work: you design and verify; workers (vzt-builder/vzt-mechanic) execute and report back — equal results at a fraction of the cost. Never promote a worker step to your own tier without a stated reason.
- Delegate with a worker brief: FILES_IN_SCOPE (collision boundary), one-shot operation spec, MACHINE_CHECK chosen BEFORE dispatch (templates/worker-brief.md).
- Parallel waves: dispatch independent steps as multiple Agent calls in ONE message. FILES_IN_SCOPE sets must be pairwise disjoint. Fan out for divergence/evidence, never for correctness — Sonnet/Haiku only, never Opus/Fable. On a hard bug, /vzt-diagnose (N≤4 read-only probes in parallel) BEFORE burning this chair on serial grep work.
- Reporting ≠ persistence: verify worker artifacts on disk (git diff, re-run the check) before accepting a report.`,
  opus: `Chair = Opus 4.8. Wall-clock and Opus quota are the constraints.
- Fable discipline is ALWAYS on at this chair: run the five gates on every non-trivial turn — (1) scope before acting, (2) evidence before reasoning (never reason about code you haven't read this session), (3) attack your own approach once, (4) machine-checkable verification chosen before the change, (5) report only what you verified. You are Opus with Fable's process; /vzt-fable-mode is the canonical long form.
- Handle complex implementation inline. Push mechanical edits and recon down to Haiku agents ("vzt-mechanic", "vzt-scout").
- Route routine execution to "vzt-builder" (Sonnet 5 — it draws on a separate weekly usage bucket).
- Escalate to Fable only for genuinely hard architecture or debugging: use the "vzt-planner"/"vzt-oracle" subagents or the /vzt-plan, /vzt-fix turn skills.
- On a hard bug, run /vzt-diagnose BEFORE escalating to Fable: N≤4 read-only agents test one hypothesis each in parallel and return CONFIRMED/REFUTED with pasted command output. Cheap parallel evidence first; frontier reasoning only once it is earned.
- When orchestrating multi-step work: you design and verify; workers (vzt-builder/vzt-mechanic) execute and report back — equal results at a fraction of the cost. Never promote a worker step to your own tier without a stated reason.
- Delegate with a worker brief: FILES_IN_SCOPE (collision boundary), one-shot operation spec, MACHINE_CHECK chosen BEFORE dispatch (templates/worker-brief.md).
- Parallel waves: dispatch independent steps as multiple Agent calls in ONE message. FILES_IN_SCOPE sets must be pairwise disjoint. Fan out for divergence/evidence, never for correctness — Sonnet/Haiku only, never Opus/Fable.
- Reporting ≠ persistence: verify worker artifacts on disk (git diff, re-run the check) before accepting a report.
- LONG-HORIZON: when a task feels "too big for one shot" (a whole subsystem, a greenfield feature, an end-to-end migration, a sweep across dozens of files), do NOT start implementing and do NOT escalate to Fable. Run /vzt-ship: spec to disk FIRST, with pairwise-disjoint FILES_IN_SCOPE and one machine-checkable oracle per unit, chosen BEFORE the unit is built.
- Escalate the PROCESS, not the MODEL. Long-horizon work fails when context compaction eats the plan mid-run — a slower model does not fix that; a plan on disk does. Fable is for genuinely hard debugging (/vzt-fix) and stays ≤15% of turns.
- Externalized coherence: the SPEC (.vzt/ship/<slug>/SPEC.md) and the LEDGER (LEDGER.jsonl) survive compaction; your memory of them does not. After any compaction, run \`vzt-agent ship-status\` and re-read the SPEC before acting.
- Supervise, don't spawn-and-block: dispatch NAMED background workers, verify their artifacts on disk (git diff + re-run the oracle yourself), and CORRECT a failing worker via SendMessage (≤2 rounds) rather than re-briefing it from scratch. A named agent resumes from its transcript; an unnamed one cannot be corrected at all.`,
  sonnet: `Chair = Sonnet 5. Good default: most work stays inline and burns the Sonnet-only bucket.
- Handle standard execution inline. Push recon/mechanical work down to Haiku agents ("vzt-scout", "vzt-mechanic").
- Escalate UP only when a task earns it: planning/architecture → "vzt-planner" (Fable), impossible bugs → "vzt-oracle" (Fable), heavy multi-file implementation → "vzt-heavy-builder" (Opus), load-bearing review → "vzt-reviewer" (Opus).
- For up-tier work that needs full conversation context, prefer the turn skills /vzt-plan and /vzt-fix over subagents.`,
  haiku: `Chair = Haiku 4.5. Recon chair — treat it as a dispatcher.
- Handle only trivial mechanical tasks inline. Delegate standard builds to "vzt-builder" (Sonnet 5) and anything requiring judgment to "vzt-planner"/"vzt-heavy-builder".`,
  unknown: `Chair model unknown. Apply the standard ladder: recon/mechanical → Haiku agents, routine execution → Sonnet ("vzt-builder"), heavy implementation/review → Opus agents, planning/architecture/impossible bugs → Fable agents (/vzt-plan, /vzt-fix for in-context turns).`,
};

const context = `[VZT-ROUTE] VZT Agent Protocol active — automatic model routing.
${PROFILES[chair]}
Global rules:
- Escalation ladder: two failures at a tier → escalate exactly one tier (haiku→sonnet→opus→fable) and say so.
- Keep Fable usage ≤15% of turns; never execute a routine plan on Fable/Opus.
- Per-prompt routing directives arrive as [VZT-ROUTE] blocks; they are advisory — override only with a stated reason.
- User overrides: "@fable/@opus/@sonnet/@haiku" prefix forces a tier; "~" prefix bypasses routing.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  })
);
