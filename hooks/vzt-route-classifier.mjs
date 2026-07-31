#!/usr/bin/env node
/**
 * VZT Agent Protocol — UserPromptSubmit classifier hook.
 *
 * Runs on every prompt. Scores the prompt against the routing matrix and
 * injects an advisory routing directive as additional context, so the session
 * automatically uses the right model tier (Fable 5 / Opus 5 / Sonnet 5 /
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
// Used only on the ship-block miss path (resolving a linked worktree back to its
// primary checkout), never on the common no-active-run path.
import { execFileSync } from 'node:child_process';
// import.meta.dirname would do, but engines allow node 18, where it does not exist.
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.VZT_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'vzt-router');

// cost = relative price multiplier vs Haiku, anchored to current sticker pricing
// (Fable $10/$50, Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per 1M in/out →
// ratios 10/5/3/1); intelligence/taste on a 10-scale.
// Mirrored in docs/ROUTING-MATRIX.md and skills/vzt-route/SKILL.md — a sync
// test enforces the cost values match across all three.
export const TIERS = {
  fable: { label: 'Fable 5 (frontier reasoning)', agents: { plan: 'vzt-planner', debug: 'vzt-oracle' }, effort: 'high', cost: 10, intelligence: 10, taste: 10 },
  opus: { label: 'Opus 5 (heavy implementation/review)', agents: { build: 'vzt-heavy-builder', review: 'vzt-reviewer', horizon: 'vzt-heavy-builder', plan: 'vzt-architect', ui: 'vzt-art-director' }, effort: 'high', cost: 5, intelligence: 9, taste: 9 },
  sonnet: { label: 'Sonnet 5 (standard execution)', agents: { build: 'vzt-builder', ui: 'vzt-stylist' }, effort: 'medium', cost: 3, intelligence: 8, taste: 8 },
  haiku: { label: 'Haiku 4.5 (mechanical/recon)', agents: { scout: 'vzt-scout', mech: 'vzt-mechanic' }, effort: 'low', cost: 1, intelligence: 5, taste: 4 },
};

// Suggested per-prompt effort: mirrors the tier default, with three adjustments on
// Opus. A low-confidence Opus classification downgrades to medium (don't burn high
// effort on a guess); a HIGH-confidence Opus BUILD earns xhigh — the current
// Claude Code default for hard coding/agentic work, and what the vzt-heavy-builder
// this routes to already runs at, so the inline suggestion matches the delegate.
// Opus review and horizon-supervision stay at high (not dense inline coding).
//
// Opus PLAN returns 'max' — this is the `opus@max` rung of the escalation ladder,
// and it is the one place the classifier suggests max. Opus 5 is a step change on
// deep reasoning at half Fable's cost, so routine architecture/planning that used
// to earn Fable now runs here instead (see the demotion in classify()). The older
// "never returns max by construction" invariant was retired with that rung: max is
// no longer exclusive to pinned fable agents.
export function suggestEffort(tier, confidence, kind) {
  if (tier === 'opus' && kind === 'plan') return 'max';
  if (tier === 'opus' && confidence === 'low') return 'medium';
  if (tier === 'opus' && kind === 'build' && confidence === 'high') return 'xhigh';
  return TIERS[tier].effort;
}

// ——— HORIZON: the two-factor gate ————————————————————————————————————————
//
// SCOPE language alone is a PLANNING question ("design the architecture for the
// whole system") and routes to the planning rungs — in practice Fable, because
// most HORIZON_SCOPE terms (from scratch, greenfield, ground-up, multi-tenant)
// are also FRONTIER_NOVEL markers; plainer planning lands on opus@max instead.
// SCOPE + a BUILD verb is a SHIPPING question, and shipping-at-scale is what
// /vzt-ship exists for.
//
// Deliberately absent from BUILD: "design", "plan", "refactor", "migrate" — the
// first two are planning, and the last two describe work on an existing system
// that Opus already handles inline without a spec ceremony.
// NOTE the shared noun list across "entire"/"whole"/"across the". It used to
// differ between them — `entire (codebase|repo|…)` but `whole (app|system|…)`
// with repo and codebase MISSING — so "build every feature across the entire
// repo" routed opus:horizon while "…across the whole repo" routed sonnet:build.
// Same sentence, one synonym, two tiers apart. Keep the nouns in one place.
const SCOPE_NOUNS = '(codebase|repo(sitory)?|app|system|product|platform|protocol|stack|project|monorepo|thing)';
const HORIZON_SCOPE = new RegExp(
  `\\b((entire|whole|across the) ${SCOPE_NOUNS}|from scratch|greenfield|ground[- ]up|across (all|every|multiple)|end[- ]to[- ]end|multi[- ](tenant|region|agent|repo)|overnight|every (screen|route|endpoint|page|model|service|table))\\b`,
  'i'
);
const HORIZON_BUILD = /\b(build|implement|ship|create|write|stand up|scaffold|port|rewrite|deliver|generate)\b/i;

// ——— FRONTIER_NOVEL: what still earns Fable on a PLAN ————————————————————
//
// Opus 5 is a step change on deep reasoning and long-horizon work at HALF Fable's
// cost, with the full low..max effort ladder. That collapsed most of the planning
// band: "design the auth system", "plan the migration", "write the tech spec" are
// all Opus-at-max work now. What Opus 5 does NOT subsume is planning with no prior
// art to pattern-match against — a novel system, a from-scratch architecture, a
// distributed-systems or multi-tenancy decision whose blast radius is the whole
// product. Those keep the frontier tier.
//
// Applied in classify() as a post-scoring demotion so every SIGNALS weight below
// stays untouched: fable:plan without a frontier marker falls to opus:plan @ max.
// The fable:DEBUG band is deliberately NOT gated by this — an impossible bug is
// frontier work regardless of how ordinary the system it lives in sounds.
const FRONTIER_NOVEL = /\b(novel|greenfield|from scratch|ground[- ]up|net[- ]new|first principles|clean[- ]sheet|multi[- ](tenant|region|repo|cloud)|distributed system|consensus|shard(ed|ing)|replication|event[- ]sourc(ed|ing)|re-?platform|migrate off|rearchitect|re-?architect)\b/i;

// ——— VISUAL: the taste lane ——————————————————————————————————————————————
//
// The word "design" is ALREADY SPOKEN FOR. `fable:plan` claims
// `design (the|a|an) (system|schema|api|architecture)`, and `vzt-architect` /
// /vzt-design mean TECHNICAL design (the opus@max planning rung). Nothing below
// may fire on a bare "design the <technical noun>". The visual lane is entered
// by TASTE nouns and RESTYLE verbs — never by "design" standing alone.
//
// The split between the two regexes is the whole design, and it is a split by
// WHO HAS TO DECIDE:
//   TASTE   — the request contains a judgement nobody has written down yet
//             ("make it look premium", "establish the brand"). Someone has to
//             invent an answer. Scored on OPUS.
//   SURFACE — the request names a visual PROPERTY of an existing screen
//             ("the spacing", "dark mode", "the hero"). It says what to change,
//             not what it should become. Scored on SONNET.
//
// SURFACE is on Sonnet DELIBERATELY, and it is the safety property of this lane:
// a SURFACE false positive CANNOT up-route. `layout`, `hero`, `responsive` and
// `animation` all appear in ordinary engineering prose, and every one of those
// prompts would have routed to Sonnet anyway — the worst a SURFACE FP can do is
// mislabel a kind. Measured proof: the existing `longTrivial` regression case
// ("...adjust the spacing...") asserts tier === 'sonnet'. Put SURFACE on Opus and
// that test goes red on precisely the failure it exists to prevent — length must
// never buy a tier.
//
// Several narrowings below are not cosmetic; each closes a measured false
// positive: `brand` caught "a brand new endpoint"; bare `premium` caught "the
// premium plan users"; bare `contrast` caught "contrast the two approaches";
// bare `transition` caught "the transition from Postgres"; bare `grid` caught
// "grid search the hyperparameters"; bare `responsive` caught "a responsive
// retry with backoff". Bare `header`/`footer`/`nav`/`button`/`icon` are excluded
// entirely — `header` alone drags the legacy haiku case "fix the typo in the
// header" into this lane.
const VISUAL_TASTE = new RegExp(
  '\\b(' +
    'look and feel|art direction|visual (design|identity|language|hierarchy|direction|polish)|' +
    'design (system|tokens?|language)|style ?guide|' +
    'brand(ing)?\\b(?![- ]new)|off[- ]brand|on[- ]brand|' +
    '(look|looks|looking|feel|feels|feeling)[^.!?]{0,24}\\b(premium|polished|slick|refined|beautiful|gorgeous|stunning|elegant|high[- ]end|world[- ]class|cohesive|expensive|dated|like an? [\\w ]{0,20}(template|wireframe|mock-?up|prototype))|' +
    '(look|looks|feel|feels)[^.!?]{0,24}\\b(ugly|cheap|dated|generic|amateur\\w*|bland|clunky|cramped|cluttered|janky|awful|unfinished)|' +
    'make (it|this|them|the [\\w -]{1,30}?) (look|feel)|' +
    're-?design (the|this|our|a|an|its)' +
  ')',
  'i'
);

const VISUAL_SURFACE = new RegExp(
  '\\b(' +
    're-?style|re-?theme|re-?skin|skin (the|this)|polish (the|this|up)|' +
    'spacing|padding|margins?|whitespace|alignment|' +
    'typograph(y|ic)|type scale|font (size|weight|stack|family)|line[- ]height|' +
    'palette|colou?r (scheme|palette|token|ramp)|contrast ratio|colou?r contrast|wcag|' +
    'layout|hero|landing page|above the fold|empty state|css grid|grid (layout|system|gap)|' +
    'dark mode|light mode|responsive (layout|design|breakpoints?)|responsive on|make .{0,24} responsive|breakpoints?|mobile (view|layout)|' +
    'animat(e|es|ed|ing|ion)|micro-?interaction|motion design|(page|hover|css|enter|exit) transition|' +
    'glassmorphi\\w*|neumorphi\\w*|drop shadow|border[- ]radius|iconograph(y|ic)' +
  ')',
  'i'
);

// The tier the ui lane authors taste on. Named rather than inlined so there is
// one place to change it and the reason is greppable: Opus is the cheapest tier
// with Taste 9 (see the Taste column in docs/ROUTING-MATRIX.md). That column
// stays DOCUMENTATION on purpose — the 10/9/8/4 values were assigned by feel, so
// deriving control flow from them would be a fake derivation, and it would mean
// someone tidying a docs table could silently re-tier the whole visual lane.
export const TASTE_TIER = 'opus';

// Signal groups. Each hit adds its weight to that tier's score.
const SIGNALS = [
  // ——— Fable 5: planning, architecture, hard reasoning ———
  { tier: 'fable', kind: 'plan', w: 3, re: /\b(architect(ure)?|system design|design (the|a|an) (system|schema|api|architecture)|tech(nical)? (spec|strategy|roadmap)|migration (plan|strategy)|plan (out|the)|prd|break (this|it) down|approach for)\b/i },
  { tier: 'fable', kind: 'debug', w: 3, re: /\b(root cause|race condition|deadlock|heisenbug|intermittent(ly)?|flaky|can'?t (figure|reproduce)|no idea why|impossible bug|corrupt(ed|ion)|memory leak|why (is|does|would|did).{0,40}(fail|break|crash|hang|wrong)|still (broken|failing) after)\b/i },
  { tier: 'fable', kind: 'plan', w: 2, re: /\b(trade-?offs?|evaluate (options|approaches)|compare (approaches|architectures|designs)|which (approach|architecture|design)|pros and cons)\b/i },
  // A *security hole*, an exploit or a threat model is frontier reasoning.
  // A routine "security review of the login flow" is NOT — it is exactly what
  // vzt-reviewer (Opus) advertises itself for, and it used to land on Fable and
  // stay there: the FRONTIER_NOVEL demotion is deliberately gated to kind==='plan',
  // so a fable:debug verdict bypassed the opus@max rung entirely. That is a
  // standing leak in the ≤10% Fable budget this release exists to hold.
  // w3, matching the other fable:debug row. At w2 this lost outright to the
  // haiku scout row (`find (all|the|every)`, w3), so "find the security hole in
  // the auth token handling" routed to HAIKU at high confidence — a pre-existing
  // bug, not introduced by the audit/review split above. Finding an exploitable
  // hole is adversarial reasoning; it is never recon.
  { tier: 'fable', kind: 'debug', w: 3, re: /\b(security hole|vulnerab|exploit|threat model|pen(etration)? test)\b/i },

  // ——— Opus 5: heavy implementation, deep review ———
  { tier: 'opus', kind: 'build', w: 3, re: /\b(refactor (the|this|our|across|everything)|large refactor|rewrite (the|this|our)|migrate (the|this|our|all|from)|overhaul|re-?architect|port (the|this|it) (to|from))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(performance|optimi[sz]e|concurren(t|cy)|parallel(ize)?|distributed|caching layer|algorithm)\b/i },
  { tier: 'opus', kind: 'review', w: 2, re: /\b(deep (review|dive)|thorough(ly)? (review|audit)|code review|review (the|this|my) (pr|diff|branch|change))\b/i },
  // The INSPECTION family. Auditing, analysing and investigating an existing
  // system is read-heavy synthesis over lots of evidence — Opus work. Until this
  // row existed, "audit" only scored when preceded by "security" or "thorough":
  // a bare "audit the protocol to see what needs updating" matched NOTHING and
  // fell through to the sonnet default at low confidence. Verified against the
  // live log: 48% of all decisions were sonnet+low+zero-signals.
  // `security review` lands here too, by design (see the fable:debug row above).
  { tier: 'opus', kind: 'review', w: 2, re: /\b(audit|analy[sz]e|analysis of|investigate|inspect|assess|diagnos(e|tic)|post-?mortem|retrospective|security (audit|review)|figure out (what|why|where|how))\b/i },
  { tier: 'opus', kind: 'build', w: 2, re: /\b(complex|tricky|gnarly|hairy|hard(est)? part|edge cases?)\b/i },
  // Scope language used to route to FABLE — i.e. to the SLOWER model — which is
  // the bug this release exists to fix. Long-horizon work fails on lost
  // coherence, not on raw model IQ, and coherence is lost to context
  // compaction. A slower model does not fix that; a plan on disk does.
  // Big blast radius ⇒ Opus + spec-first. Escalate the PROCESS, not the MODEL.
  { tier: 'opus', kind: 'horizon', w: 3, re: HORIZON_SCOPE },
  // Taste origination. LAST in the Opus block on purpose: kinds[tier] is
  // last-write-wins, so a prompt carrying BOTH scope and taste language
  // ("restyle every screen to feel premium") keeps kind 'ui' instead of being
  // reset to 'build' by the horizon-miss reset in classify(). A genuine HORIZON
  // (scope + a BUILD verb) still hard-pins ahead of this via the early return —
  // note "restyle"/"redesign" are deliberately NOT in HORIZON_BUILD, so a
  // whole-app restyle lands here rather than in a ship ceremony.
  { tier: 'opus', kind: 'ui', w: 3, re: VISUAL_TASTE },

  // ——— Sonnet 5: standard build/execute (also the fallback default) ———
  { tier: 'sonnet', kind: 'build', w: 2, re: /\b(implement|build|add (a|an|the)|create (a|an|the)|wire (up|in)|hook up|integrate|write (a|an|the|some)? ?(test|spec)s?|fix (the|this|a) bug|endpoint|component|page|form|crud|api route)\b/i },
  { tier: 'sonnet', kind: 'build', w: 1, re: /\b(update|change|adjust|tweak|extend|modify|improve)\b/i },
  // Visual SURFACE work. w2 matches the sonnet:build row it usually co-fires
  // with, so "restyle the landing page hero" scores sonnet 4 — enough to own the
  // lane, not enough to out-argue any opus w3 row. Last in the block so the kind
  // label reads 'ui' rather than 'build'. It ties opus:build w2
  // (performance|optimize|…) and LOSES on precedence, which is correct:
  // "optimize the layout algorithm in the pdf renderer" is Opus build work.
  { tier: 'sonnet', kind: 'ui', w: 2, re: VISUAL_SURFACE },

  // ——— Haiku 4.5: mechanical, recon, glue ———
  { tier: 'haiku', kind: 'mech', w: 3, re: /\b(typo|rename|bump (the )?version|format(ting)?|lint|prettier|sort (the )?imports|remove (unused|dead)|delete (the )?(comment|console\.log|log)s?|commit message|changelog entry|copy (the|this) file|move (the|this) file)\b/i },
  { tier: 'haiku', kind: 'scout', w: 3, re: /\b(where (is|are|does)|find (all|the|every)|list (all|the|every)|search (for|the)|grep|how many|which files?|locate|look up|what('| i)s in)\b/i },
  { tier: 'haiku', kind: 'scout', w: 2, re: /\b(summari[sz]e|tl;?dr|give me an overview|recap|status of)\b/i },
];

/**
 * @param {string} prompt
 * @param {string} [cwd] Project directory, used ONLY by the ui lane's taste-cache
 *   gate. Omitted (every existing test, a payload with no cwd) ⇒ cache MISS, which
 *   is the safe side: taste work stays on Opus.
 */
export function classify(prompt, cwd) {
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
  // Length AMPLIFIES existing evidence; it is not evidence by itself.
  //
  // These used to be unconditional, and tie precedence is fable > opus > haiku >
  // sonnet — so an 80-word prompt matching only the weak sonnet w1 row scored
  // opus 1 / sonnet 1 and the tiebreak handed it to OPUS, with `matched:
  // ["sonnet:build"]` as the sole evidence. A long-but-trivial prompt bought the
  // expensive tier on word count alone. Requiring a real signal first keeps the
  // heuristic as a nudge rather than a promotion.
  const words = prompt.trim().split(/\s+/).length;
  if (words > 150 && scores.fable > 0) scores.fable += 1;
  if (words > 60 && scores.opus > 0) scores.opus += 1;
  // Same rule in the other direction: the short-prompt nudge may only reinforce a
  // haiku lead, never overturn a stronger tier. Unconditional, it did overturn
  // one — "find the security hole in the auth token handling" and "find the race
  // condition in the sync" are both under 15 words, so haiku's scout hit got +1
  // and beat a TIED fable:debug signal that precedence would otherwise have won.
  // Recon phrasing ("find the …") wraps plenty of genuinely hard questions.
  if (words < 15 && scores.haiku > Math.max(scores.fable, scores.opus, scores.sonnet)) scores.haiku += 1;

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

  // The `opus@max` rung. A PLAN that won Fable on generic planning language, with no
  // FRONTIER_NOVEL marker, is Opus-at-max work — same reasoning depth, half the cost.
  // Debug keeps Fable unconditionally; an impossible bug is frontier work either way.
  if (best === 'fable' && kinds.fable === 'plan' && !FRONTIER_NOVEL.test(prompt)) {
    matched.push('opus:plan(demoted-from-fable)');
    return {
      tier: 'opus',
      kind: 'plan',
      confidence,
      effort: suggestEffort('opus', confidence, 'plan'),
      demotedFrom: 'fable',
      matched,
      scores,
      words,
    };
  }

  // ——— VISUAL: the taste-cache gate ————————————————————————————————————
  //
  // Two-factor, structurally identical to the HORIZON gate above — except the
  // second factor is a FILE, not a second regex.
  //
  //   cache HIT (a real DESIGN.md exists) → SONNET, unconditionally. The taste
  //     has already been bought and written down; what remains is faithful
  //     application, and faithful application is execution work. This is the
  //     headline: the FILE, not the model, is where the taste lives.
  //   cache MISS + TASTE language → OPUS. The judgement has to come from the
  //     model, so it comes from the tier that has the taste to supply it — and
  //     the first move is to WRITE the cache, not hand-style one screen.
  //   cache MISS + SURFACE language only → stays where it scored (Sonnet).
  //     Promoting "tweak the padding" to Opus on every prompt in a repo that
  //     will never own a DESIGN.md is the over-routing this protocol exists to
  //     prevent. The directive carries the nudge instead of the router carrying
  //     the cost.
  //
  // Guard order vs. the opus@max block above is irrelevant — that one requires
  // best === 'fable', this one requires kinds[best] === 'ui', and no SIGNALS row
  // labels a fable kind 'ui'. Stated so a future edit need not re-derive it.
  if (kinds[best] === 'ui') {
    const designDoc = designDocPath(cwd);
    const tier = designDoc ? 'sonnet' : VISUAL_TASTE.test(prompt) ? TASTE_TIER : best;
    return {
      tier,
      kind: 'ui',
      confidence,
      effort: suggestEffort(tier, confidence, 'ui'),
      designDoc,
      matched: [...matched, designDoc ? `ui:cache-hit(${designDoc})` : 'ui:cache-miss'],
      scores,
      words,
    };
  }

  return { tier: best, kind: kinds[best], confidence, effort: suggestEffort(best, confidence, kinds[best]), matched, scores, words };
}

function tierOf(raw) {
  const s = (raw || '').toLowerCase();
  for (const t of ['fable', 'opus', 'sonnet', 'haiku']) if (s.includes(t)) return t;
  return null;
}

/**
 * Which model is ACTUALLY in the chair right now.
 *
 * chair.json is stamped once, at SessionStart, and `/model` fires no hook — so a
 * mid-session model switch could never propagate. That is not a missing
 * directive, it is a CONFIDENTLY WRONG one, because directive() branches on
 * RANK[chair]: believing an Opus chair is still seated while the user has
 * switched to Fable makes every opus-tier task print "chair matches target tier
 * — handle inline" when the correct advice is "delegate DOWN to conserve fable
 * quota". The staleness therefore suppresses down-delegation on the single most
 * expensive tier — the exact opposite of what the budget doctrine wants.
 * Measured on the live log: 4+ hours of decisions after a switch still recorded
 * the pre-switch chair.
 *
 * Sources, freshest first:
 *   1. the hook payload — free and exactly right, IF the harness supplies it
 *   2. settings.json `model` — `/model` rewrites this ("saved as your default"),
 *      so it tracks the most recent switch
 *   3. chair.json for this session, then `latest`
 *
 * Caveat, stated rather than hidden: (2) is a single global value, so with two
 * concurrent sessions on different models it describes whichever switched last.
 * That is still strictly better than a value that cannot update at all, and (1)
 * makes it moot wherever the payload carries the model.
 */
function chairModel(sessionId, payloadModel) {
  const r = resolveChair(sessionId, payloadModel);
  return r.tier;
}

/**
 * @returns {{tier: string, source: string}} — `source` is logged so a wrong
 * chair can be attributed to a source instead of guessed at.
 */
function resolveChair(sessionId, payloadModel) {
  const fromPayload = tierOf(payloadModel);
  if (fromPayload) {
    rememberChair(sessionId, payloadModel);
    return { tier: fromPayload, source: 'payload' };
  }

  // Fallback order, and WHY it is this way round.
  //
  // Neither file source is trustworthy on its own — they go stale in OPPOSITE
  // directions, which is what makes this subtle:
  //
  //   chair.json[sessionId] is stamped once at SessionStart. Correct when the
  //     session begins, stale the moment you `/model` mid-session.
  //   settings.json `model` is global, not session-scoped. It tracks the last
  //     `/model` anywhere, and it does NOT reliably clear — observed live on
  //     2026-07-29: it still read `claude-fable-5[1m]` while the session was
  //     demonstrably on Opus 5, so the router reported the wrong chair.
  //
  // So session-scoped-but-possibly-stale beats global-and-provably-stale:
  // chair.json first. settings.json only when this session has no entry at all,
  // where a global hint beats nothing.
  //
  // The real answer is `payload.model` above. `modelSource` is logged on every
  // decision precisely so we can see whether the payload carries it — if it
  // does, both of these fallbacks become dead weight and should be deleted.
  try {
    const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'chair.json'), 'utf8'));
    const fromSession = tierOf(state[sessionId]);
    if (fromSession) return { tier: fromSession, source: 'chair.json[session]' };

    const fromSettings = tierOf(readSettingsModel());
    if (fromSettings) return { tier: fromSettings, source: 'settings.json' };

    const fromLatest = tierOf(state.latest);
    if (fromLatest) return { tier: fromLatest, source: 'chair.json.latest' };
  } catch {
    const fromSettings = tierOf(readSettingsModel());
    if (fromSettings) return { tier: fromSettings, source: 'settings.json' };
  }
  return { tier: 'unknown', source: 'none' };
}

function readSettingsModel() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model || '';
  } catch {
    return '';
  }
}

/** Self-heal chair.json when a fresher source disagrees with it. */
function rememberChair(sessionId, model) {
  if (!sessionId || !model) return;
  try {
    const file = path.join(STATE_DIR, 'chair.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
    if (state[sessionId] === model && state.latest === model) return; // already current
    state[sessionId] = model;
    state.latest = model;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    /* never let bookkeeping break a prompt */
  }
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
  } else if (result.kind === 'ui' && result.designDoc) {
    lines.push(
      `  action: VISUAL task with a TASTE CACHE on disk (${result.designDoc}). Read that file FIRST — before you open a stylesheet, before you look at the component. It is the spec, not a suggestion.`,
      `  how: delegate to the "${t.agents.ui}" subagent (Sonnet 5), or invoke /vzt-ui if the change needs full conversation context (a screenshot, "more like X", a brand conversation).`,
      '  rule: every value you write traces to a token or a rule in that file — spacing step, color, radius, type step, motion duration. If what you need is not in there, you have found a GAP in the cache: name the gap and stop. Do not invent a value, and do not "improve" one that is already decided — a value invented here is a value the next prompt will invent differently.',
      '  scope: a problem visible only under a scoped variant (a dark theme, an admin skin) is fixed INSIDE that variant. Editing a base token to fix a scoped surface silently restyles every other surface — the most expensive mistake available in this lane.',
      '  why NOT Opus: the taste for this repo has already been bought and written down. Re-buying it on a premium tier once per prompt is exactly how a UI drifts — three Opus turns, three slightly different greys, none of them wrong on its own. A DESIGN.md is to visual work what a SPEC on disk is to long-horizon work: it moves what would otherwise live in the model onto the filesystem, where a cheaper tier can apply it faithfully. Escalate the PROCESS, not the MODEL — same doctrine, one axis over.',
      '  verify: run the file\'s ## Compliance check and paste the real output, then name the tokens you used. "It looks right" is not a check — and the oracle proves you used tokens, not that the screen is any good, so look at it too.'
    );
  } else if (result.kind === 'ui' && result.tier === 'opus') {
    lines.push(
      '  action: VISUAL task with NO taste cache — do NOT hand-style one screen. The taste has to come from the model, which means from THIS tier, which means it should be written down ONCE instead of re-derived on every prompt for the rest of the project.',
      `  step 1: write DESIGN.md at the project root — inline at effort high if this chair is Opus or Fable, otherwise delegate to the "${t.agents.ui}" subagent, or invoke /vzt-ui when the look needs the conversation. Start from ${templateRef('DESIGN.md')}, and derive every value by READING the repo's real token layer (tokens.css / globals.css @theme / theme.ts) — a DESIGN.md naming tokens the code does not have is worse than none.`,
      '  step 2: apply it to the screen that was actually asked for — that one, and no others. A cache is proved by being applied once, not by being long. An unapplied DESIGN.md is a document, and a document is a tax.',
      `  step 3: everything after this routes DOWN, automatically. Once DESIGN.md exists the classifier sends visual work to "${TIERS.sonnet.agents.ui}" (Sonnet) on its own, because the judgement is on disk instead of in the tier. This turn is the only expensive one — spend it properly.`,
      '  why NOT Sonnet: this is a taste question with no answer written down yet, and taste is the one axis where the tiers genuinely differ (see the Taste column in docs/ROUTING-MATRIX.md). Sonnet APPLYING a written spec is indistinguishable from Opus applying it; Sonnet INVENTING the spec is not, and the difference compounds across every screen built afterwards.',
      '  why NOT Fable: taste is not frontier reasoning. There is no no-prior-art problem here — every product ever shipped is prior art. Fable would cost twice as much and pick the same greys.'
    );
  } else if (result.kind === 'ui') {
    lines.push(
      `  action: VISUAL surface change — make exactly the change asked for. Delegate to the "${t.agents.ui}" subagent (Sonnet 5), or handle inline if this chair is Sonnet.`,
      '  constraint: this project has NO DESIGN.md, so nothing on disk constrains the value you pick. Match what the neighbouring components already do, and say in your report which one you matched — an unexplained value is a decision nobody can reproduce.',
      '  offer it once, do not run it uninvited: if this is the second or third visual request in a row, say so and offer /vzt-ui — ONE Opus turn that writes the taste cache, after which every request like this routes to Sonnet permanently. Paying for taste one prompt at a time is the expensive way to buy it.'
    );
  } else if (result.kind === 'plan' && result.tier === 'opus') {
    lines.push(
      '  action: PLAN task on the `opus@max` rung — design first, do NOT start implementing. Produce a plan with a step-routing table whose execution steps hand DOWN to "vzt-builder".',
      `  how: inline at effort max if this chair is Opus or Fable; otherwise delegate to the "${t.agents.plan}" subagent, or invoke /vzt-design when the plan needs full conversation context.`,
      result.demotedFrom === 'fable'
        ? '  why NOT Fable: this is planning with prior art to pattern-match against. Opus 5 covers that band at max effort for half the cost. Fable is reserved for planning with no prior art — a novel/greenfield/from-scratch architecture, distributed-systems or multi-tenancy decisions — and for impossible bugs (/vzt-fix). If this task is genuinely novel and you can say why, escalate one rung and say so.'
        : '  escalation: if the design turns out to have no prior art to reason from, escalate one rung to Fable ("vzt-planner" / /vzt-plan) and state the reason.'
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
    '  escalation ladder: if the chosen tier fails twice on the same problem, escalate exactly one rung (haiku→sonnet→opus→opus@max→fable) and say so.',
    '  budget rules: mechanical/recon work never rises above Haiku; Sonnet burns its own separate weekly bucket — prefer it for all routine execution; keep Fable turns ≤10% of the session (opus@max absorbs the planning that used to go there).',
    '  effort note: start xhigh for coding/agentic work and high elsewhere, then sweep DOWN — Opus 5 is unusually strong at low/medium, so prior-model effort defaults over-spend. max is the opus@max planning rung, not a routine setting.'
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

/**
 * The PRIMARY checkout for `dir`, or null.
 *
 * Mirrors `primaryCheckoutRoot` in cli/vzt-agent.js — deliberately duplicated
 * because this hook installs to ~/.claude/hooks/vzt-router/ and cannot import
 * from the CLI package. `test/ship.test.mjs` carries a drift guard for the
 * reducer pair; the same reasoning applies here.
 *
 * Why it matters: `.vzt/ship/` is git-tracked, so every unit worktree gets its
 * OWN copy of the ledger directory — and the CLI deliberately redirects all
 * writes to the primary checkout so the run cannot fork. A chair working inside
 * a unit worktree that resolved `.vzt/ship` relative to its own cwd therefore
 * read a ledger nobody writes to, and rendered "units: (none reported yet)" for
 * a run that was well underway.
 */
function primaryCheckoutRoot(dir) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n').find((l) => l.startsWith('worktree '));
    return first ? first.slice('worktree '.length).trim() : null;
  } catch {
    return null; // git missing or not a repo — caller falls back to cwd
  }
}

// ——— Shipped templates: name them by a path that RESOLVES ————————————————
//
// The doctrine tells an agent to "start from the DESIGN.md template". The agent
// reading that line stands in the USER's project, where there is no templates/
// directory — the file lives under .claude/, next to the hooks. So a bare
// relative reference resolved to nothing on every project, and the agent
// reported the template as missing while a good 10KB copy sat on disk.
//
// Resolve from where THIS FILE was installed instead. That is the one location
// that is correct for both install shapes: a project install puts us at
// <project>/.claude/hooks/vzt-router/, a global one at ~/.claude/hooks/vzt-router/,
// and the templates are two levels up either way. Falling back to the global
// home covers the case where a project install predates a template being added.
//
// Returning null rather than a best guess is the whole point — a path that
// lies is worse than an admission, because the agent will "fix" the wrong file.
const TEMPLATES_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');
const TEMPLATES_FALLBACK = path.join(os.homedir(), '.claude', 'templates');

/**
 * Absolute path to a shipped template, or null if it is not installed.
 * @param {string} name e.g. 'DESIGN.md'
 */
export function installedTemplate(name) {
  for (const dir of [TEMPLATES_HOME, TEMPLATES_FALLBACK]) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not there — try the fallback */ }
  }
  return null;
}

/** The same path, phrased for injection: either a real path or an honest repair instruction. */
export function templateRef(name) {
  return installedTemplate(name) || `${name} (NOT INSTALLED — run \`vzt-agent install\`)`;
}

// ——— DESIGN.md: the taste cache ————————————————————————————————————————
//
// A DESIGN.md is to visual work what SPEC.md is to long-horizon work: it moves
// what the model would otherwise hold in its head onto disk, where it survives
// compaction, survives the next session, and — the part that matters for routing
// — survives being handed to a cheaper tier. Taste in the FILE instead of in the
// TIER is a 5×→3× cost change on every visual prompt after the first.
//
// Cost: this runs ONLY after the ui lane has already won the classification,
// i.e. on visual prompts. Routine turns pay nothing — the same budget the
// [VZT-SHIP] re-injection below holds itself to ("ONE existsSync, no measurable
// latency"). Worst case on a visual prompt: four statSync calls, then one
// `git worktree list` only if all four miss.
//
// The SIZE FLOOR is not decoration. A three-line placeholder DESIGN.md would
// down-route every visual request in the repo to Sonnet forever while containing
// no taste to apply — the cache would be a LIE, and the routing would be
// confidently wrong in the one direction that costs quality rather than money.
// Expressed as (dir, filename) rather than as joined path literals on purpose.
// A joined literal beginning with a shipped-directory name reads to the
// doctrine-path guard in test/classifier.test.mjs as a reference to a file THIS
// PACKAGE ships — and it is not. These are candidate locations inside the USER's
// repo, resolved at runtime. Keeping them un-joined states that distinction in
// the code instead of in a comment the guard cannot read.
const DESIGN_DOC_DIRS = ['', 'docs', path.join('docs', 'design'), '.vzt'];
const DESIGN_DOC_FILE = 'DESIGN.md';
const DESIGN_DOC_MIN_BYTES = 400;

function designDocIn(root) {
  for (const dir of DESIGN_DOC_DIRS) {
    const rel = path.join(dir, DESIGN_DOC_FILE);
    try {
      if (fs.statSync(path.join(root, rel)).size >= DESIGN_DOC_MIN_BYTES) return rel;
    } catch { /* missing candidate — try the next */ }
  }
  return null;
}

/**
 * The project's taste cache, as a path relative to its root — or null.
 * @param {string|undefined} cwd
 */
export function designDocPath(cwd) {
  // No filesystem context (unit tests, a payload with no cwd, a sandboxed hook)
  // is a cache MISS, never a hit. That is the safe side of the asymmetry: a wrong
  // MISS costs 5× instead of 3× on one prompt; a wrong HIT sends a taste question
  // to a tier with no written taste to apply, and you get a UI that looks like
  // three different products.
  if (!cwd) return null;
  const here = designDocIn(cwd);
  if (here) return here;
  // Same fallback, same reasoning, as activeShipBlock(): we may be inside a
  // linked worktree (a /vzt-ship unit pane) where the real repo root is the
  // primary checkout. Only paid for after the cheap local check misses, and only
  // on a visual prompt.
  try {
    const primary = primaryCheckoutRoot(cwd);
    if (primary && primary !== cwd) return designDocIn(primary);
  } catch { /* git missing or not a repo */ }
  return null;
}

export function activeShipBlock(cwd) {
  try {
    let base = path.join(cwd, '.vzt', 'ship');
    if (!fs.existsSync(base)) {
      // Not here — but we may be inside a linked worktree, where the real ledger
      // lives in the primary checkout. Only pay for `git worktree list` when the
      // cheap local check misses, so the common no-ship-run path stays one syscall.
      const primary = primaryCheckoutRoot(cwd);
      if (!primary || primary === cwd) return '';
      base = path.join(primary, '.vzt', 'ship');
      if (!fs.existsSync(base)) return '';
    }
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
    : classify(prompt, payload.cwd || process.cwd());
  const seat = resolveChair(payload.session_id, payload.model);
  const chair = seat.tier;

  logDecision({
    ts: new Date().toISOString(),
    session: payload.session_id || null,
    chair,
    // Which source the chair came from, and whether the hook payload carried a
    // model at all. Both file fallbacks are known to go stale (in opposite
    // directions), so when a routing directive is wrong this is the difference
    // between attributing it and guessing. If `modelSource` reads "payload"
    // consistently, the fallbacks are dead weight and should be deleted.
    modelSource: seat.source,
    payloadHadModel: Boolean(payload.model),
    tier: result.tier,
    kind: result.kind,
    // The taste-cache hit/miss, as evidence. This is what makes the ui lane's
    // thesis FALSIFIABLE: if cache hits stay near zero after 20+ ui decisions,
    // nobody is writing DESIGN.md, the lane is buying an Opus turn per prompt
    // and nothing else — and it should be deleted rather than defended.
    designDoc: result.designDoc || null,
    confidence: result.confidence,
    effort: result.effort,
    demotedFrom: result.demotedFrom || null,
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
