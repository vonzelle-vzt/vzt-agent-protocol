#!/usr/bin/env node
/**
 * VZT Agent Protocol — UserPromptSubmit classifier hook.
 *
 * Runs on every prompt. Scores the prompt against the routing matrix and
 * injects an advisory routing directive as additional context, so the session
 * automatically uses the right model tier (Fable 5 / Opus 4.8 / Sonnet 5 /
 * Haiku 4.5) without the user ever touching /model.
 *
 * Deterministic, zero-API-cost, <50ms. Chair-aware: reads the session model
 * captured by vzt-session-start.mjs and inverts the routing doctrine
 * accordingly (on Fable, tokens are scarce → delegate DOWN; on Sonnet,
 * capability is scarce → delegate UP only when a task earns it).
 *
 * Overrides:
 *   @fable / @opus / @sonnet / @haiku  — force a tier for this prompt
 *   ~                                  — bypass routing entirely
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = process.env.VZT_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'vzt-router');

// cost = relative price multiplier vs Haiku, anchored to current sticker pricing
// (Fable $10/$50, Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per 1M in/out →
// ratios 10/5/3/1); intelligence/taste on a 10-scale.
// Mirrored in docs/ROUTING-MATRIX.md and skills/vzt-route/SKILL.md — a sync
// test enforces the cost values match across all three.
export const TIERS = {
  fable: { label: 'Fable 5 (frontier reasoning)', agents: { plan: 'vzt-planner', debug: 'vzt-oracle' }, effort: 'high', cost: 10, intelligence: 10, taste: 10 },
  opus: { label: 'Opus 4.8 (heavy implementation/review)', agents: { build: 'vzt-heavy-builder', review: 'vzt-reviewer', horizon: 'vzt-heavy-builder' }, effort: 'high', cost: 5, intelligence: 9, taste: 9 },
  sonnet: { label: 'Sonnet 5 (standard execution)', agents: { build: 'vzt-builder' }, effort: 'medium', cost: 3, intelligence: 8, taste: 8 },
  haiku: { label: 'Haiku 4.5 (mechanical/recon)', agents: { scout: 'vzt-scout', mech: 'vzt-mechanic' }, effort: 'low', cost: 1, intelligence: 5, taste: 4 },
};

// Suggested per-prompt effort: mirrors the tier default, with two adjustments on
// Opus. A low-confidence Opus classification downgrades to medium (don't burn high
// effort on a guess); a HIGH-confidence Opus BUILD earns xhigh — the current
// Claude Code default for hard coding/agentic work, and what the vzt-heavy-builder
// this routes to already runs at, so the inline suggestion matches the delegate.
// Opus review and horizon-supervision stay at high (not dense inline coding).
// Never returns 'max' by construction — that's reserved for pinned fable agents.
export function suggestEffort(tier, confidence, kind) {
  if (tier === 'opus' && confidence === 'low') return 'medium';
  if (tier === 'opus' && kind === 'build' && confidence === 'high') return 'xhigh';
  return TIERS[tier].effort;
}

// ——— HORIZON: the two-factor gate ————————————————————————————————————————
//
// SCOPE language alone is a PLANNING question ("design the architecture for the
// whole system") and stays on Fable. SCOPE + a BUILD verb is a SHIPPING question,
// and shipping-at-scale is what /vzt-ship exists for.
//
// Deliberately absent from BUILD: "design", "plan", "refactor", "migrate" — the
// first two are planning, and the last two describe work on an existing system
// that Opus already handles inline without a spec ceremony.
const HORIZON_SCOPE = /\b(entire (codebase|repo|app|system|product|platform)|whole (app|system|product|platform|thing)|from scratch|greenfield|ground[- ]up|across (all|every|multiple)|end[- ]to[- ]end|multi[- ](tenant|region|agent|repo)|overnight|every (screen|route|endpoint|page|model|service|table))\b/i;
const HORIZON_BUILD = /\b(build|implement|ship|create|write|stand up|scaffold|port|rewrite|deliver|generate)\b/i;

// Signal groups. Each hit adds its weight to that tier's score.
const SIGNALS = [
  // ——— Fable 5: planning, architecture, hard reasoning ———
  { tier: 'fable', kind: 'plan', w: 3, re: /\b(architect(ure)?|system design|design (the|a|an) (system|schema|api|architecture)|tech(nical)? (spec|strategy|roadmap)|migration (plan|strategy)|plan (out|the)|prd|break (this|it) down|approach for)\b/i },
  { tier: 'fable', kind: 'debug', w: 3, re: /\b(root cause|race condition|deadlock|heisenbug|intermittent(ly)?|flaky|can'?t (figure|reproduce)|no idea why|impossible bug|corrupt(ed|ion)|memory leak|why (is|does|would|did).{0,40}(fail|break|crash|hang|wrong)|still (broken|failing) after)\b/i },
  { tier: 'fable', kind: 'plan', w: 2, re: /\b(trade-?offs?|evaluate (options|approaches)|compare (approaches|architectures|designs)|which (approach|architecture|design)|pros and cons)\b/i },
  { tier: 'fable', kind: 'debug', w: 2, re: /\b(security (audit|review|hole)|vulnerab|exploit|threat model|pen(etration)? test)\b/i },

  // ——— Opus 4.8: heavy implementation, deep review ———
  { tier: 'opus', kind: 'build', w: 3, re: /\b(refactor (the|this|our|across|everything)|large refactor|rewrite (the|this|our)|migrate (the|this|our|all|from)|overhaul|re-?architect|port (the|this|it) (to|from))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(performance|optimi[sz]e|concurren(t|cy)|parallel(ize)?|distributed|caching layer|algorithm)\b/i },
  { tier: 'opus', kind: 'review', w: 2, re: /\b(deep (review|dive)|thorough(ly)? (review|audit)|code review|review (the|this|my) (pr|diff|branch|change))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(complex|tricky|gnarly|hairy|hard(est)? part|edge cases?)\b/i },
  // Scope language used to route to FABLE — i.e. to the SLOWER model — which is
  // the bug this release exists to fix. Long-horizon work fails on lost
  // coherence, not on raw model IQ, and coherence is lost to context
  // compaction. A slower model does not fix that; a plan on disk does.
  // Big blast radius ⇒ Opus + spec-first. Escalate the PROCESS, not the MODEL.
  { tier: 'opus', kind: 'horizon', w: 3, re: HORIZON_SCOPE },

  // ——— Sonnet 5: standard build/execute (also the fallback default) ———
  { tier: 'sonnet', kind: 'build', w: 2, re: /\b(implement|build|add (a|an|the)|create (a|an|the)|wire (up|in)|hook up|integrate|write (a|an|the|some)? ?(test|spec)s?|fix (the|this|a) bug|endpoint|component|page|form|crud|api route)\b/i },
  { tier: 'sonnet', kind: 'build', w: 1, re: /\b(update|change|adjust|tweak|extend|modify|improve)\b/i },

  // ——— Haiku 4.5: mechanical, recon, glue ———
  { tier: 'haiku', kind: 'mech', w: 3, re: /\b(typo|rename|bump (the )?version|format(ting)?|lint|prettier|sort (the )?imports|remove (unused|dead)|delete (the )?(comment|console\.log|log)s?|commit message|changelog entry|copy (the|this) file|move (the|this) file)\b/i },
  { tier: 'haiku', kind: 'scout', w: 3, re: /\b(where (is|are|does)|find (all|the|every)|list (all|the|every)|search (for|the)|grep|how many|which files?|locate|look up|what('| i)s in)\b/i },
  { tier: 'haiku', kind: 'scout', w: 2, re: /\b(summari[sz]e|tl;?dr|give me an overview|recap|status of)\b/i },
];

export function classify(prompt) {
  const scores = { fable: 0, opus: 0, sonnet: 0, haiku: 0 };
  const kinds = { fable: 'plan', opus: 'build', sonnet: 'build', haiku: 'mech' };
  const matched = [];
  for (const s of SIGNALS) {
    if (s.re.test(prompt)) {
      scores[s.tier] += s.w;
      kinds[s.tier] = s.kind;
      matched.push(`${s.tier}:${s.kind}`);
    }
  }

  // The two-factor HORIZON gate. The SIGNALS row above labels the opus kind
  // 'horizon' whenever the scope regex fires; only a BUILD verb alongside it
  // earns the label. Scope alone stays a planning question.
  const isHorizon = HORIZON_SCOPE.test(prompt) && HORIZON_BUILD.test(prompt);
  if (kinds.opus === 'horizon' && !isHorizon) kinds.opus = 'build';

  // Length heuristics: long multi-requirement prompts trend up-tier;
  // very short prompts with a mechanical/scout hit stay down-tier.
  const words = prompt.trim().split(/\s+/).length;
  if (words > 150) scores.fable += 1;
  if (words > 60) scores.opus += 1;
  if (words < 15 && scores.haiku > 0) scores.haiku += 1;

  // Pin it. A long-horizon BUILD must never fall through to fable:plan (slower,
  // no more coherent) or to sonnet:build (which starts typing immediately —
  // the exact failure this release exists to prevent).
  if (isHorizon) {
    return { tier: 'opus', kind: 'horizon', confidence: 'high', effort: 'high', matched, scores, words };
  }

  // Pick winner; precedence on ties: fable > opus > haiku > sonnet
  // (specific signals beat the generic execution tier).
  const order = ['fable', 'opus', 'haiku', 'sonnet'];
  let best = 'sonnet';
  let bestScore = 0;
  for (const t of order) {
    if (scores[t] > bestScore) {
      best = t;
      bestScore = scores[t];
    }
  }
  if (bestScore === 0)
    return { tier: 'sonnet', kind: 'build', confidence: 'low', effort: suggestEffort('sonnet', 'low'), matched, scores, words };

  const runnerUp = Math.max(...order.filter((t) => t !== best).map((t) => scores[t]));
  const confidence = bestScore >= 4 && bestScore - runnerUp >= 2 ? 'high' : bestScore >= 2 ? 'medium' : 'low';
  return { tier: best, kind: kinds[best], confidence, effort: suggestEffort(best, confidence, kinds[best]), matched, scores, words };
}

function chairModel(sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'chair.json'), 'utf8'));
    const raw = (state[sessionId] || state.latest || '').toLowerCase();
    for (const t of ['fable', 'opus', 'sonnet', 'haiku']) if (raw.includes(t)) return t;
  } catch {
    /* no state yet */
  }
  return 'unknown';
}

const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3, unknown: 1 };

export function directive(result, chair) {
  const t = TIERS[result.tier];
  const agent = t.agents[result.kind] || Object.values(t.agents)[0];
  const lines = [
    '[VZT-ROUTE] Automatic model routing (advisory — override only with a stated reason):',
    `  task: ${result.kind.toUpperCase()} → target tier: ${t.label} @ effort ${result.effort}`,
    `  chair: ${chair}  confidence: ${result.confidence}  signals: ${result.matched.slice(0, 6).join(', ') || 'none (default tier)'}`,
  ];

  const target = RANK[result.tier];
  const seat = RANK[chair];

  if (result.kind === 'horizon') {
    lines.push(
      '  action: HORIZON task — do NOT start implementing. Not one file, not one function. This is spec-first work.',
      '  step 1: run /vzt-ship. It writes a SPEC to .vzt/ship/<slug>/SPEC.md BEFORE any code: contract, out-of-scope, file manifest, the interfaces that cross unit boundaries, and a unit decomposition whose FILES_IN_SCOPE sets are pairwise disjoint — with ONE machine-checkable oracle per unit, chosen before that unit is built.',
      '  step 2: gate the spec with a command, not an opinion — `vzt-agent ship-check <spec>` exits non-zero on overlapping scopes, a manifest file no unit owns, or a unit with no oracle. Bring the spec to the user before spending anything.',
      '  step 3: /vzt-ship drives the units as supervised background workers (barrier → parallel → independent verification → bounded repair → integration gate) and re-runs every oracle itself. You supervise; you do not hand-code the units.',
      '  why NOT Fable: long-horizon work fails on lost coherence, not on raw model IQ — and the coherence is lost to context compaction, which a slower model does not fix. Put the plan on disk and the chair stays coherent across compaction at Opus wall-clock. Escalate the PROCESS, not the MODEL.',
      '  if compaction already ate the plan: run `vzt-agent ship-status`, then re-read SPEC.md. The file is the plan; your memory of it is a hypothesis.'
    );
  } else if (chair !== 'unknown' && target === RANK[chair] && result.tier !== 'haiku') {
    lines.push('  action: chair matches target tier — handle inline. Do not spawn a subagent for this.');
  } else if (target > seat) {
    // Up-tier work from a cheaper chair: delegate up via pinned subagent,
    // or use the turn-level skill for full-context work.
    lines.push(
      `  action: this task is above the chair tier. Delegate to the "${agent}" subagent (Agent tool), passing complete context in the prompt.`,
      `  alternative: if the task needs full conversation context, invoke the matching turn skill instead (/vzt-plan for planning, /vzt-fix for hard debugging) — skill model overrides switch THIS turn to the target tier.`
    );
    if (result.tier === 'fable') {
      lines.push('  then: hand the approved plan to "vzt-builder" (Sonnet 5) for execution — never execute a routine plan on the frontier tier.');
    }
  } else {
    // Down-tier work from an expensive chair: push it down to save quota.
    const costCite = chair !== 'unknown' ? ` (~${Math.round(TIERS[chair].cost / t.cost)}× cost saving)` : '';
    lines.push(
      `  action: this task is below the chair tier. Delegate to the "${agent}" subagent (Agent tool) to conserve ${chair === 'unknown' ? 'premium' : chair} quota${costCite}. Only handle inline if delegation overhead exceeds the task itself.`
    );
  }

  if (result.tier === 'opus') {
    lines.push('  discipline: the Opus tier ALWAYS runs the fable-mode gates (scope → evidence → attack → verify → report) — same model, frontier process. The Opus agents carry them as Rule 1; /vzt-fable-mode is the long form.');
  }

  lines.push(
    '  escalation ladder: if the chosen tier fails twice on the same problem, escalate exactly one tier (haiku→sonnet→opus→fable) and say so.',
    '  budget rules: mechanical/recon work never rises above Haiku; Sonnet burns its own separate weekly bucket — prefer it for all routine execution; keep Fable turns ≤15% of the session.',
    '  effort note: use the suggested effort — Fable-low ≈ Opus-high. xhigh is the right setting for HARD coding/agentic work (the heavy-builder runs there); on routine work xhigh/max overthinks, not improves.'
  );
  return lines.join('\n');
}

// ——— [VZT-SHIP] re-injection ————————————————————————————————————————————
//
// Compaction does NOT re-fire SessionStart. This classifier is the only hook
// that runs afterwards — which makes it the only place a long-horizon run can
// be made self-healing. The moment compaction eats the plan, the next prompt
// puts the pointer back.
//
// Cost on the common path: ONE existsSync. No .vzt/ ⇒ return '' immediately.
// No network, no LLM, no measurable latency on routine turns.

/** Mirror of ship-lib's reduceLedger. A test asserts the two agree — drift is caught by a command, not by discipline. */
export function reduceLedgerInline(text) {
  const state = { runId: null, specPath: null, wfRunId: null, units: {}, active: false };
  if (typeof text !== 'string' || !text.trim()) return state;
  let terminal = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue; // a truncated last line is the EXPECTED state after a crash
    }
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'run_started') {
      state.runId = e.runId || state.runId;
      state.specPath = e.specPath || state.specPath;
      terminal = false;
    } else if (e.kind === 'workflow_launched') state.wfRunId = e.wfRunId || state.wfRunId;
    else if (e.kind === 'unit_result' && e.unit)
      state.units[e.unit] = { status: e.status || 'DISPATCHED', round: typeof e.round === 'number' ? e.round : 0 };
    else if (e.kind === 'run_complete' || e.kind === 'aborted') terminal = true;
  }
  state.active = Boolean(state.runId) && !terminal;
  return state;
}

export function activeShipBlock(cwd) {
  try {
    const base = path.join(cwd, '.vzt', 'ship');
    if (!fs.existsSync(base)) return ''; // the common path: one syscall, then out
    let newest = null;
    for (const slug of fs.readdirSync(base)) {
      const file = path.join(base, slug, 'LEDGER.jsonl');
      if (!fs.existsSync(file)) continue;
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    if (!newest) return '';
    const state = reduceLedgerInline(fs.readFileSync(newest.file, 'utf8'));
    if (!state.active) return '';

    const units = Object.keys(state.units).length
      ? Object.entries(state.units)
          .map(([id, u]) => `${id} ${u.status}${u.round ? `(${u.round})` : ''}`)
          .join(' | ')
      : '(none reported yet)';

    return [
      `[VZT-SHIP] ACTIVE RUN ${state.runId} — the plan lives on disk, not in this context.`,
      `  spec:  ${state.specPath || '(unknown)'}   ← re-read this before acting. Do NOT re-plan from memory.`,
      `  units: ${units}`,
      state.wfRunId ? `  resume: Workflow({scriptPath, resumeFromRunId:"${state.wfRunId}"})` : null,
      '  full state: `vzt-agent ship-status`',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return ''; // never let rehydration break the prompt
  }
}

function logDecision(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    /* logging is best-effort */
  }
}

// ——— main (skipped when imported by tests) ———
if (import.meta.url === `file://${process.argv[1]}`) {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  let prompt = (payload.prompt || '').trim();

  // Bypass: "~" prefix, slash commands, memory shorthand, tiny conversational turns.
  if (!prompt || prompt.startsWith('~') || prompt.startsWith('/') || prompt.startsWith('#') || prompt.split(/\s+/).length < 4) {
    process.exit(0);
  }

  // Manual tier override: "@fable ..." / "@opus ..." / "@sonnet ..." / "@haiku ..."
  let override = null;
  const m = prompt.match(/^@(fable|opus|sonnet|haiku)\b/i);
  if (m) {
    override = m[1].toLowerCase();
    prompt = prompt.slice(m[0].length).trim();
  }

  const result = override
    ? { tier: override, kind: 'build', confidence: 'high', effort: TIERS[override].effort, matched: ['user-override'], scores: {}, words: prompt.split(/\s+/).length }
    : classify(prompt);
  const chair = chairModel(payload.session_id);

  logDecision({
    ts: new Date().toISOString(),
    session: payload.session_id || null,
    chair,
    tier: result.tier,
    kind: result.kind,
    confidence: result.confidence,
    effort: result.effort,
    override: Boolean(override),
    words: result.words,
    signals: result.matched,
  });

  // An active ship run re-announces itself on every prompt. This is what makes
  // the ledger self-healing across a compaction.
  const ship = activeShipBlock(payload.cwd || process.cwd());

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ship ? `${directive(result, chair)}\n\n${ship}` : directive(result, chair),
      },
    })
  );
}
