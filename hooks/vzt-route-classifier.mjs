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

// cost = relative multiplier (not dollars); intelligence/taste on a 10-scale.
// Mirrored in docs/ROUTING-MATRIX.md and skills/vzt-route/SKILL.md — a sync
// test enforces the cost values match across all three.
export const TIERS = {
  fable: { label: 'Fable 5 (frontier reasoning)', agents: { plan: 'vzt-planner', debug: 'vzt-oracle' }, effort: 'high', cost: 25, intelligence: 10, taste: 10 },
  opus: { label: 'Opus 4.8 (heavy implementation/review)', agents: { build: 'vzt-heavy-builder', review: 'vzt-reviewer' }, effort: 'high', cost: 15, intelligence: 9, taste: 9 },
  sonnet: { label: 'Sonnet 5 (standard execution)', agents: { build: 'vzt-builder' }, effort: 'medium', cost: 3, intelligence: 8, taste: 8 },
  haiku: { label: 'Haiku 4.5 (mechanical/recon)', agents: { scout: 'vzt-scout', mech: 'vzt-mechanic' }, effort: 'low', cost: 1, intelligence: 5, taste: 4 },
};

// Suggested per-prompt effort: mirrors the tier default, except a low-confidence
// Opus classification downgrades to medium (don't burn high effort on a guess).
// Never returns 'max' by construction — that's reserved for pinned fable agents.
export function suggestEffort(tier, confidence) {
  if (tier === 'opus' && confidence === 'low') return 'medium';
  return TIERS[tier].effort;
}

// Signal groups. Each hit adds its weight to that tier's score.
const SIGNALS = [
  // ——— Fable 5: planning, architecture, hard reasoning ———
  { tier: 'fable', kind: 'plan', w: 3, re: /\b(architect(ure)?|system design|design (the|a|an) (system|schema|api|architecture)|tech(nical)? (spec|strategy|roadmap)|migration (plan|strategy)|plan (out|the)|prd|break (this|it) down|approach for)\b/i },
  { tier: 'fable', kind: 'debug', w: 3, re: /\b(root cause|race condition|deadlock|heisenbug|intermittent(ly)?|flaky|can'?t (figure|reproduce)|no idea why|impossible bug|corrupt(ed|ion)|memory leak|why (is|does|would|did).{0,40}(fail|break|crash|hang|wrong)|still (broken|failing) after)\b/i },
  { tier: 'fable', kind: 'plan', w: 2, re: /\b(trade-?offs?|evaluate (options|approaches)|compare (approaches|architectures|designs)|which (approach|architecture|design)|pros and cons)\b/i },
  { tier: 'fable', kind: 'debug', w: 2, re: /\b(security (audit|review|hole)|vulnerab|exploit|threat model|pen(etration)? test)\b/i },
  { tier: 'fable', kind: 'plan', w: 2, re: /\b(entire (codebase|repo|app|system)|across (all|every|multiple)|end[- ]to[- ]end|from scratch|greenfield|multi[- ](tenant|region|agent|repo))\b/i },

  // ——— Opus 4.8: heavy implementation, deep review ———
  { tier: 'opus', kind: 'build', w: 3, re: /\b(refactor (the|this|our|across|everything)|large refactor|rewrite (the|this|our)|migrate (the|this|our|all|from)|overhaul|re-?architect|port (the|this|it) (to|from))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(performance|optimi[sz]e|concurren(t|cy)|parallel(ize)?|distributed|caching layer|algorithm)\b/i },
  { tier: 'opus', kind: 'review', w: 2, re: /\b(deep (review|dive)|thorough(ly)? (review|audit)|code review|review (the|this|my) (pr|diff|branch|change))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(complex|tricky|gnarly|hairy|hard(est)? part|edge cases?)\b/i },

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

  // Length heuristics: long multi-requirement prompts trend up-tier;
  // very short prompts with a mechanical/scout hit stay down-tier.
  const words = prompt.trim().split(/\s+/).length;
  if (words > 150) scores.fable += 1;
  if (words > 60) scores.opus += 1;
  if (words < 15 && scores.haiku > 0) scores.haiku += 1;

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
  return { tier: best, kind: kinds[best], confidence, effort: suggestEffort(best, confidence), matched, scores, words };
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

  if (chair !== 'unknown' && target === RANK[chair] && result.tier !== 'haiku') {
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

  lines.push(
    '  escalation ladder: if the chosen tier fails twice on the same problem, escalate exactly one tier (haiku→sonnet→opus→fable) and say so.',
    '  budget rules: mechanical/recon work never rises above Haiku; Sonnet burns its own separate weekly bucket — prefer it for all routine execution; keep Fable turns ≤15% of the session.',
    '  effort note: use the suggested effort — Fable-low ≈ Opus-high; xhigh/max on routine work causes overthinking, not quality.'
  );
  return lines.join('\n');
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

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: directive(result, chair),
      },
    })
  );
}
