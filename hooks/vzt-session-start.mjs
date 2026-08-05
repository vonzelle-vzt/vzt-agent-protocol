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
 *   Opus 5   — wall-clock is scarce: inline heavy work, push mechanical down.
 *   Sonnet 5 — capability is scarce: escalate UP only when a task earns it.
 *   Haiku    — recon chair: delegate almost everything up.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Shipped templates must be named by an ABSOLUTE path: the chair profile below is
// read by an agent standing in the user's project, where `templates/` does not
// exist. Both hooks install side by side, so this import always resolves.
import { templateRef } from './vzt-route-classifier.mjs';

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
- Delegate ALL execution down: standard builds → "vzt-builder" (Sonnet 5), mechanical edits/recon → "vzt-mechanic"/"vzt-scout" (Haiku 4.5), heavy parallel implementation → "vzt-heavy-builder" (Opus 5).
- Routine planning does NOT need this chair either: architecture/specs/roadmaps with prior art belong on the opus@max rung ("vzt-architect" / /vzt-design). Stay inline only for planning with no prior art — novel/greenfield architecture, one-way-door distributed-systems calls — and for impossible bugs.
- Never do file-by-file mechanical work inline. Batch delegations; pass complete context so subagents finish in one shot.
- Long-horizon builds do NOT belong at this chair: they are spec-first process work, not frontier reasoning. Write the spec, then hand it to /vzt-ship on Opus.
- When orchestrating multi-step work: you design and verify; workers (vzt-builder/vzt-mechanic) execute and report back — equal results at a fraction of the cost. Never promote a worker step to your own tier without a stated reason.
- Delegate with a worker brief: FILES_IN_SCOPE (collision boundary), one-shot operation spec, MACHINE_CHECK chosen BEFORE dispatch (${templateRef('worker-brief.md')}).
- Parallel waves: dispatch independent steps as multiple Agent calls in ONE message. FILES_IN_SCOPE sets must be pairwise disjoint. Fan out for divergence/evidence, never for correctness — Sonnet/Haiku only, never Opus/Fable. On a hard bug, /vzt-diagnose (N≤4 read-only probes in parallel) BEFORE burning this chair on serial grep work.
- VISIBLE PARALLELISM — inside an Orca terminal, delegate execution DOWN as REAL agent panes rather than invisible in-process subagents: \`vzt-orca-flow pane run --agent claude|codex --task "<worker brief>" --title <short-name>\` per track, all in ONE message so they work concurrently. Each splits a pane, runs a real CLI, and closes itself when the agent signals \`pane done\`; one that never signals is left open on purpose. \`--agent codex\` runs GPT-5.5 and burns NO Anthropic quota at all — from this chair especially, prefer codex panes for execution so Fable tokens stay on reasoning. Capped by VZT_PANE_MAX (default 4), spawn depth 2. Every repo, not just vzt-orca-flow. No Orca terminal → use Agent-tool subagents and say so.
- Reporting ≠ persistence: verify worker artifacts on disk (git diff, re-run the check) before accepting a report.`,
  opus: `Chair = Opus 5. Wall-clock and Opus quota are the constraints.
- Wall-clock lever: /fast runs this Opus chair at up to ~2.5× output speed (same Opus 5 model, premium tokens: $10/$50 per MTok — i.e. Fable-tier PRICE for Opus-tier intelligence). Reach for it when latency matters more than token cost, e.g. a long interactive build you're watching; it is a bad default.
- Fable discipline is ALWAYS on at this chair: run the five gates on every non-trivial turn — (1) scope before acting, (2) evidence before reasoning (never reason about code you haven't read this session), (3) attack your own approach once, (4) machine-checkable verification chosen before the change, (5) report only what you verified. You are Opus with Fable's process; /vzt-fable-mode is the canonical long form.
- Handle complex implementation inline. Push mechanical edits and recon down to Haiku agents ("vzt-mechanic", "vzt-scout").
- Route routine execution to "vzt-builder" (Sonnet 5 — it draws on a separate weekly usage bucket).
- PLANNING IS YOURS NOW — the opus@max rung. Architecture, tech specs, roadmaps, migration plans and PRD breakdowns run HERE at max effort (inline, or "vzt-architect" / /vzt-design), not on Fable. Fable keeps only planning with no prior art to reason from — a novel/greenfield architecture, a one-way-door distributed-systems or multi-tenancy call — and impossible bugs.
- Escalate to Fable only for those two cases: "vzt-planner"/"vzt-oracle" subagents or the /vzt-plan, /vzt-fix turn skills. Escalating to look thorough is a cost bug, not diligence.
- On a hard bug, run /vzt-diagnose BEFORE escalating to Fable: N≤4 read-only agents test one hypothesis each in parallel and return CONFIRMED/REFUTED with pasted command output. Cheap parallel evidence first; frontier reasoning only once it is earned.
- When orchestrating multi-step work: you design and verify; workers (vzt-builder/vzt-mechanic) execute and report back — equal results at a fraction of the cost. Never promote a worker step to your own tier without a stated reason.
- Delegate with a worker brief: FILES_IN_SCOPE (collision boundary), one-shot operation spec, MACHINE_CHECK chosen BEFORE dispatch (${templateRef('worker-brief.md')}).
- DELEGATION CAP — this chair over-reaches for subagents by default, so bound it. Do NOT delegate work you could finish in a handful of tool calls; a subagent re-establishes context, re-explores, reports back, and then you re-read the report. Prefer ONE subagent over several. Keep spawn counts low, and never exceed 20 parallel agents unless explicitly asked. Once you delegate, COMMIT: never redo a worker's work or re-derive its findings.
- Parallel waves are for genuinely independent tracks (unrelated modules, a wide multi-file sweep), NOT for splitting one modest job into pieces. When steps really are independent, dispatch them as multiple Agent calls in ONE message with pairwise-disjoint FILES_IN_SCOPE. Fan out for divergence/evidence, never for correctness — Sonnet/Haiku only, never Opus/Fable.
- VISIBLE PARALLELISM — when this session is running inside an Orca terminal, dispatch a parallel wave as REAL agent panes, not invisible in-process subagents: \`vzt-orca-flow pane run --agent claude|codex --task "<worker brief>" --title <short-name>\` per track, each in ONE message so they work concurrently. Each opens a split pane, runs a real CLI, and CLOSES ITSELF when the agent signals \`pane done\`; an agent that never signals is left open on purpose (a stray pane costs one command, a pane killed mid-task costs the work). \`--agent codex\` runs GPT-5.5 (\`codex --yolo\`) and burns NO Anthropic quota — use it to widen a wave past what Opus/Sonnet quota alone would allow, and mix lanes freely within one wave. Use \`--tab\` for a separate tab, \`--keep\` to inspect afterwards, \`vzt-orca-flow pane list\` to see what is live. Bounded by VZT_PANE_MAX (default 4, well under the 20-agent cap) and a spawn-depth ceiling of 2, so a pane agent cannot recursively fan out. This applies in EVERY repo, not just vzt-orca-flow. Agent-tool subagents run in-process and can never appear in a pane — if the user expects to watch agents work, panes are the only mechanism that shows them. No Orca terminal (no anchor pane) → fall back to Agent-tool subagents and say so.
- Verification belongs in THIS loop. Verify external artifacts relentlessly: run the oracle yourself, and check worker output on disk (git diff, re-run the check) before accepting a report — reporting ≠ persistence. But do NOT spawn a subagent to double-check your OWN inline work, and do not pad turns with re-verification passes; this chair already self-checks without being told, so extra verify instructions buy nothing.
- Scope and concision: deliver what was asked at the scope intended. No unrequested refactors, abstractions, helpers, or error handling for cases that cannot happen. Lead with the outcome — say what happened first, detail after.
- LONG-HORIZON: when a task feels "too big for one shot" (a whole subsystem, a greenfield feature, an end-to-end migration, a sweep across dozens of files), do NOT start implementing and do NOT escalate to Fable. Run /vzt-ship: spec to disk FIRST, with pairwise-disjoint FILES_IN_SCOPE and one machine-checkable oracle per unit, chosen BEFORE the unit is built. Drive the supervised run in a live agent multiplexer BY DEFAULT — \`vzt-agent ship-watch <SPEC.md>\` (Herdr via \`VZT_MUX=herdr\`, omit \`--mux\`; or \`--mux vscode\` for native VS Code integrated terminals) so each unit runs as a real claude agent in a watchable/attachable worktree pane; fall back to the headless Workflow driver only when no mux is live, and say which you used. Never auto-merge — ship-watch stops at the green gate.
- Escalate the PROCESS, not the MODEL. Long-horizon work fails when context compaction eats the plan mid-run — a slower model does not fix that; a plan on disk does. Fable is for genuinely hard debugging (/vzt-fix) and no-prior-art architecture, and stays ≤10% of turns.
- Externalized coherence: the SPEC (.vzt/ship/<slug>/SPEC.md) and the LEDGER (LEDGER.jsonl) survive compaction; your memory of them does not. After any compaction, run \`vzt-agent ship-status\` and re-read the SPEC before acting.
- Supervise, don't spawn-and-block: dispatch NAMED background workers, verify their artifacts on disk (git diff + re-run the oracle yourself), and CORRECT a failing worker via SendMessage (≤2 rounds) rather than re-briefing it from scratch. A named agent resumes from its transcript; an unnamed one cannot be corrected at all.
- VISUAL work is a lane, not a build task. If the repo has a DESIGN.md, READ IT FIRST and delegate DOWN to "vzt-stylist" (Sonnet) — the taste is on disk, so applying it is execution and every value must trace to a token. If there is NO DESIGN.md, the first move is to WRITE one ("vzt-art-director" / /vzt-ui), once, from the repo's real token layer — never hand-style a single screen from imagination. Same doctrine as /vzt-ship, one axis over: put the judgement on disk and a cheaper tier can carry it.`,
  sonnet: `Chair = Sonnet 5. Good default: most work stays inline and burns the Sonnet-only bucket.
- Handle standard execution inline. Push recon/mechanical work down to Haiku agents ("vzt-scout", "vzt-mechanic").
- Escalate UP only when a task earns it, and stop at the FIRST rung that can do the job: planning/architecture → "vzt-architect" (Opus 5 @ max), heavy multi-file implementation → "vzt-heavy-builder" (Opus 5), load-bearing review → "vzt-reviewer" (Opus 5).
- Fable is the LAST rung, not the first: "vzt-planner" only for planning with no prior art (novel/greenfield architecture, one-way-door distributed-systems calls), "vzt-oracle" only for impossible bugs. Routine architecture is an opus@max job now.
- For up-tier work that needs full conversation context, prefer the turn skills — /vzt-design (Opus @ max) for planning, /vzt-plan and /vzt-fix (Fable) for the rare frontier turn — over subagents.
- VISUAL work: if the repo has a DESIGN.md, this chair is the right tier — read it FIRST and make every value trace to a token; a missing token is a gap you report, never a value you invent. If there is NO DESIGN.md, escalate UP exactly once to "vzt-art-director" (Opus) or /vzt-ui to write it, after which visual work routes back here permanently.
- VISIBLE PARALLELISM — inside an Orca terminal, dispatch a parallel wave as REAL agent panes rather than invisible in-process subagents: \`vzt-orca-flow pane run --agent claude|codex --task "<worker brief>" --title <short-name>\` per track, all in ONE message so they work concurrently. Each splits a pane, runs a real CLI, and closes itself when the agent signals \`pane done\`; one that never signals is left open on purpose. \`--agent codex\` runs GPT-5.5 and burns NO Anthropic quota — reach for it to widen a wave past the Sonnet bucket. Capped by VZT_PANE_MAX (default 4), spawn depth 2. Every repo, not just vzt-orca-flow. No Orca terminal → use Agent-tool subagents and say so.`,
  haiku: `Chair = Haiku 4.5. Recon chair — treat it as a dispatcher.
- Handle only trivial mechanical tasks inline. Delegate standard builds to "vzt-builder" (Sonnet 5) and anything requiring judgment to "vzt-planner"/"vzt-heavy-builder".
- VISIBLE PARALLELISM — inside an Orca terminal, dispatch independent tracks as REAL agent panes rather than invisible in-process subagents: \`vzt-orca-flow pane run --agent claude|codex --task "<worker brief>" --title <short-name>\` per track, all in ONE message so they work concurrently. Each splits a pane, runs a real CLI, and closes itself when the agent signals \`pane done\`; one that never signals is left open on purpose. \`--agent codex\` runs GPT-5.5 and burns NO Anthropic quota — a dispatcher chair should reach for it first. Capped by VZT_PANE_MAX (default 4), spawn depth 2. Every repo, not just vzt-orca-flow. No Orca terminal → use Agent-tool subagents and say so.`,
  unknown: `Chair model unknown. Apply the standard ladder: recon/mechanical → Haiku agents, routine execution → Sonnet ("vzt-builder"), heavy implementation/review → Opus agents, planning/architecture → "vzt-architect" (Opus 5 @ max) or /vzt-design, and ONLY no-prior-art architecture or impossible bugs → Fable agents (/vzt-plan, /vzt-fix for in-context turns).`,
};

const context = `[VZT-ROUTE] VZT Agent Protocol active — automatic model routing.
${PROFILES[chair]}
Global rules:
- Escalation ladder: two failures at a rung → escalate exactly one rung (haiku→sonnet→opus→opus@max→fable) and say so.
- Keep Fable usage ≤10% of turns; never execute a routine plan on Fable/Opus. The opus@max rung absorbs the planning that used to reach Fable.
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
