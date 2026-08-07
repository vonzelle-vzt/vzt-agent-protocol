import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, suggestEffort, directive, TIERS, installedTemplate } from '../hooks/vzt-route-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const cases = [
  // fable — planning/architecture
  ['Design the system architecture for a multi-tenant SaaS billing platform', 'fable', 'high'],
  ['Help me plan out the migration strategy from Postgres to a sharded setup, weighing trade-offs', 'fable', 'high'],
  // fable — impossible bugs
  ['There is a race condition somewhere, the job intermittently fails and I have no idea why it breaks', 'fable', 'high'],
  ['Find the root cause of this memory leak, it is still failing after three fixes', 'fable', 'high'],
  // opus — heavy build
  ['Refactor the entire payment module and migrate all the handlers to the new event bus', 'opus', 'high'],
  ['Optimize the concurrency of the ingest pipeline, the parallelism is wrong under load', 'opus', 'high'],
  // sonnet — standard build
  ['Add a settings page with a form to update the user profile', 'sonnet', 'medium'],
  ['Fix the bug where the modal does not close after submit and write a test for it', 'sonnet', 'medium'],
  // haiku — mechanical
  ['Fix the typo in the header and bump the version to 2.1.0', 'haiku', 'low'],
  ['Rename getUserData to fetchUserProfile everywhere', 'haiku', 'low'],
  // haiku — scout
  ['Where is the stripe webhook handler defined and which files import it?', 'haiku', 'low'],
  ['Summarize the status of the auth module for me', 'haiku', 'low'],
  // default
  ['Thanks, that looks good, please continue with the next one', 'sonnet', 'medium'],
];

for (const [prompt, expectedTier, expectedEffort] of cases) {
  test(`"${prompt.slice(0, 60)}..." → ${expectedTier}/${expectedEffort}`, () => {
    const r = classify(prompt);
    assert.equal(r.tier, expectedTier, `got ${r.tier} (scores: ${JSON.stringify(r.scores)})`);
    assert.equal(r.effort, expectedEffort, `got effort ${r.effort} (confidence: ${r.confidence})`);
  });
}

// ——— HORIZON: long-horizon builds are spec-first Opus work, not Fable work ———

const horizonCases = [
  'Build the entire notification system from scratch, end-to-end',
  'Implement the whole admin dashboard greenfield across every route',
  'Ship a multi-tenant billing subsystem from the ground up',
];

for (const prompt of horizonCases) {
  test(`HORIZON: "${prompt.slice(0, 50)}..." → opus/horizon/high`, () => {
    const r = classify(prompt);
    assert.equal(r.tier, 'opus', `got ${r.tier} (scores: ${JSON.stringify(r.scores)})`);
    assert.equal(r.kind, 'horizon', `got kind ${r.kind}`);
    assert.equal(r.effort, 'high');
  });
}

// THE REGRESSION GUARD. Scope language used to route to Fable — i.e. to the
// SLOWER model — on exactly the prompts where a slower model buys nothing,
// because long-horizon work fails on lost coherence, not on model IQ.
test('no long-horizon BUILD ever routes to fable (the bug this release fixes)', () => {
  for (const prompt of horizonCases) {
    assert.notEqual(classify(prompt).tier, 'fable', `"${prompt}" escalated the MODEL instead of the PROCESS`);
  }
});

// The gate is two-factor on purpose: scope alone is a planning question.
test('two-factor gate: SCOPE without a BUILD verb is NOT horizon (stays planning)', () => {
  const r = classify('Design the architecture for the whole system from scratch');
  assert.equal(r.tier, 'fable', 'a pure design question must still reach the planning tier');
  assert.notEqual(r.kind, 'horizon');
});

test('two-factor gate: a BUILD verb without SCOPE is NOT horizon (stays routine)', () => {
  const r = classify('Build a settings page with a form');
  assert.equal(r.tier, 'sonnet');
  assert.notEqual(r.kind, 'horizon');
});

test('no legacy case is misclassified as horizon', () => {
  for (const [prompt] of cases) {
    assert.notEqual(classify(prompt).kind, 'horizon', `"${prompt}" wrongly became a horizon task`);
  }
});

test('the horizon directive forbids implementing and routes to /vzt-ship', () => {
  const r = classify(horizonCases[0]);
  const d = directive(r, 'opus');
  for (const phrase of ['/vzt-ship', 'do NOT start implementing', 'ship-check', 'Escalate the PROCESS, not the MODEL', 'ship-status']) {
    assert.ok(d.includes(phrase), `horizon directive missing "${phrase}"`);
  }
  // Never fan a subagent at a spec — the chair writes it, then supervises.
  assert.ok(!d.includes('Delegate to the "'), 'horizon directive must not delegate the spec to a subagent');
  // It is still the Opus tier, so the gates still apply.
  assert.ok(d.includes('fable-mode gates'), 'horizon is an Opus surface — it must carry the gates');
});

test('classifier returns confidence and signals', () => {
  const r = classify('Design the architecture for the new system from scratch');
  assert.ok(['low', 'medium', 'high'].includes(r.confidence));
  assert.ok(Array.isArray(r.matched));
});

test('classify() reserves max for the opus@max PLAN rung — everything else stays low..xhigh', () => {
  for (const [prompt] of cases) {
    const r = classify(prompt);
    if (r.effort === 'max') {
      // The one sanctioned max: routine planning demoted off Fable onto opus@max.
      assert.equal(r.tier, 'opus', `max effort outside the opus tier for "${prompt}"`);
      assert.equal(r.kind, 'plan', `max effort outside the plan rung for "${prompt}"`);
      continue;
    }
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(r.effort), `unexpected effort "${r.effort}" for "${prompt}"`);
  }
});

test('classify() lifts a HARD (multi-signal) opus build to xhigh (matches the heavy-builder it delegates to)', () => {
  // A single opus signal is medium-confidence and stays at high; only a clearly-hard
  // build (refactor + performance/concurrency + complexity) reaches high → xhigh.
  const r = classify('Refactor the ingest pipeline for performance — the concurrency is gnarly with tricky edge cases');
  assert.equal(r.tier, 'opus');
  assert.equal(r.kind, 'build');
  assert.equal(r.confidence, 'high');
  assert.equal(r.effort, 'xhigh');
});

test('classify() keeps a single-signal opus build at high (not every opus build is xhigh)', () => {
  const r = classify('Refactor the payment module handlers');
  assert.equal(r.tier, 'opus');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.effort, 'high');
});

test('suggestEffort: opus downgrades to medium on low confidence', () => {
  assert.equal(suggestEffort('opus', 'low'), 'medium');
  assert.equal(suggestEffort('opus', 'high'), 'high'); // no kind → tier default
});

test('suggestEffort: high-confidence opus BUILD earns xhigh; review/moderate stay high', () => {
  assert.equal(suggestEffort('opus', 'high', 'build'), 'xhigh');
  assert.equal(suggestEffort('opus', 'high', 'review'), 'high');
  assert.equal(suggestEffort('opus', 'medium', 'build'), 'high');
  assert.equal(suggestEffort('opus', 'low', 'build'), 'medium');
});

test('suggestEffort: haiku is always low regardless of confidence', () => {
  assert.equal(suggestEffort('haiku', 'low'), 'low');
  assert.equal(suggestEffort('haiku', 'medium'), 'low');
  assert.equal(suggestEffort('haiku', 'high'), 'low');
});

test('suggestEffort: fable never returns max', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    assert.notEqual(suggestEffort('fable', confidence), 'max');
  }
});

test('suggestEffort: the opus PLAN rung is max at every confidence (opus@max)', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    assert.equal(suggestEffort('opus', confidence, 'plan'), 'max');
  }
  // ...and the rung does not leak into the other opus kinds.
  assert.equal(suggestEffort('opus', 'high', 'review'), 'high');
  assert.equal(suggestEffort('opus', 'high', 'horizon'), 'high');
  assert.equal(suggestEffort('opus', 'low', 'build'), 'medium');
});

test('routine planning is demoted off Fable onto the opus@max rung', () => {
  for (const prompt of [
    'Design the system architecture for the internal admin tool',
    'Help me plan the technical roadmap for Q3',
    'Write a tech spec for the notifications service',
  ]) {
    const r = classify(prompt);
    assert.equal(r.tier, 'opus', `expected demotion to opus for "${prompt}"`);
    assert.equal(r.kind, 'plan', `expected kind=plan for "${prompt}"`);
    assert.equal(r.effort, 'max', `expected max effort for "${prompt}"`);
    assert.equal(r.demotedFrom, 'fable');
    assert.ok(r.matched.includes('opus:plan(demoted-from-fable)'), 'demotion is not recorded in signals');
  }
});

test('planning with no prior art KEEPS Fable (the demotion is not blanket)', () => {
  for (const prompt of [
    'Design a novel architecture for the multi-tenant billing platform',
    'Design the greenfield architecture for our event-sourced ledger',
    'Design the sharding strategy and plan the migration, weighing the trade-offs',
  ]) {
    const r = classify(prompt);
    assert.equal(r.tier, 'fable', `frontier planning wrongly demoted for "${prompt}"`);
    assert.equal(r.kind, 'plan');
    assert.equal(r.demotedFrom, undefined);
  }
});

test('the DEBUG band is never demoted — an impossible bug stays frontier', () => {
  for (const prompt of [
    'There is a race condition somewhere and I have no idea why it breaks',
    'Find the root cause of this memory leak, it is still failing after three fixes',
  ]) {
    const r = classify(prompt);
    assert.equal(r.tier, 'fable', `debug wrongly demoted for "${prompt}"`);
    assert.equal(r.kind, 'debug');
    assert.notEqual(r.effort, 'max', 'debug should not pick up the opus@max effort');
  }
});

test('the opus@max directive names the plan agent and explains why it is not Fable', () => {
  const d = directive(classify('Design the system architecture for the internal admin tool'), 'opus');
  assert.ok(d.includes('opus@max'), 'directive does not name the rung');
  assert.ok(d.includes(TIERS.opus.agents.plan), 'directive does not name the plan agent');
  assert.ok(d.includes('why NOT Fable'), 'directive does not justify skipping Fable');
  assert.ok(d.includes('/vzt-design'), 'directive does not offer the turn skill');
});

test('down-tier build directives use visible Orca panes when available', () => {
  const r = {
    tier: 'sonnet',
    kind: 'build',
    confidence: 'high',
    effort: 'medium',
    matched: [],
    scores: {},
    words: 10,
  };
  const d = directive(r, 'opus', { ORCA_TERMINAL_HANDLE: 'term_x' });
  assert.ok(d.includes('pane run'), 'Orca down-tier build should name pane run');
  assert.ok(d.includes('term_x'), 'Orca down-tier build should name the terminal handle');
  assert.ok(d.includes('--detach'), 'Orca down-tier build should mention detach/background operation');
  assert.ok(!d.includes('Delegate to the "'), 'Orca down-tier build should not default to Agent-tool delegation');
});

test('down-tier build directives keep Agent-tool wording without Orca', () => {
  const r = {
    tier: 'sonnet',
    kind: 'build',
    confidence: 'high',
    effort: 'medium',
    matched: [],
    scores: {},
    words: 10,
  };
  const d = directive(r, 'opus', {});
  assert.ok(d.includes('Delegate to the "'), 'non-Orca down-tier build should keep Agent-tool wording');
  assert.ok(!d.includes('pane run'), 'non-Orca down-tier build should not name pane run');
});

test('down-tier scout directives keep Agent-tool wording even with Orca', () => {
  const r = {
    tier: 'haiku',
    kind: 'scout',
    confidence: 'high',
    effort: 'low',
    matched: [],
    scores: {},
    words: 10,
  };
  const d = directive(r, 'opus', { ORCA_TERMINAL_HANDLE: 'term_x' });
  assert.ok(d.includes('Delegate to the "'), 'scout work should stay on Agent-tool delegation');
  assert.ok(!d.includes('pane run'), 'scout work should not switch to pane run');
});

test('docs mirror TIERS cost values exactly (sync check)', () => {
  const matrix = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ROUTING-MATRIX.md'), 'utf8');
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  for (const tier of Object.keys(TIERS)) {
    const costString = `${TIERS[tier].cost}×`;
    assert.ok(matrix.includes(costString), `docs/ROUTING-MATRIX.md missing "${costString}" for ${tier}`);
    assert.ok(skill.includes(costString), `skills/vzt-route/SKILL.md missing "${costString}" for ${tier}`);
  }
});

// ——— Model-currency guard ————————————————————————————————————————————————
//
// The protocol's doctrine names specific models in prose, across a dozen files.
// When a model launches, the fleet agents auto-upgrade (they pin ALIASES — `model:
// opus` resolves to "the latest Opus"), but the prose does not — so the docs start
// describing a model nobody is running. These two tests turn "remember to update
// nine files" into a failing command.

test('docs mirror the TIERS model names (currency guard — fails on the next model launch)', () => {
  const surfaces = {
    'docs/ROUTING-MATRIX.md': fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ROUTING-MATRIX.md'), 'utf8'),
    'skills/vzt-route/SKILL.md': fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8'),
    'README.md': fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8'),
    'docs/CHAIR-PROFILES.md': fs.readFileSync(path.join(REPO_ROOT, 'docs', 'CHAIR-PROFILES.md'), 'utf8'),
  };
  for (const tier of Object.keys(TIERS)) {
    // 'Opus 5 (heavy implementation/review)' -> 'Opus 5'
    const model = TIERS[tier].label.replace(/\s*\(.*$/, '').trim();
    for (const [file, text] of Object.entries(surfaces)) {
      assert.ok(text.includes(model), `${file} does not mention "${model}" — TIERS says that is the ${tier} tier`);
    }
  }
});

// ——— Regressions found by auditing the live decision log (2026-07-28) ————————
// 48% of 2,037 real decisions were sonnet + low-confidence + ZERO matched
// signals. These are the specific holes behind that number.

test('the INSPECTION family routes up — auditing an existing system is Opus work', () => {
  // Until this landed, bare "audit"/"analyze"/"investigate" matched NOTHING and
  // fell to the sonnet default. The audit prompt that FOUND this bug is the
  // first case: the classifier could not route a request to audit itself.
  const cases = [
    'audit the protocol to see what else needs to be optimized, updated, added',
    'analyze the failure modes of this design',
    'investigate why the deploy keeps timing out',
    'inspect the migration for anything that could lose data',
  ];
  for (const p of cases) {
    const r = classify(p);
    assert.equal(r.tier, 'opus', `"${p}" → ${r.tier} (inspection belongs on opus)`);
    assert.ok(r.matched.length > 0, `"${p}" matched no signals at all`);
  }
});

test('a ROUTINE security review is opus; a security HOLE is still fable', () => {
  // `security (audit|review)` used to score fable:debug, and the FRONTIER_NOVEL
  // demotion is gated to kind==='plan' — so routine pre-merge security review
  // bypassed the opus@max rung entirely and burned frontier quota every time.
  assert.equal(classify('do a security audit of the login flow').tier, 'opus');
  assert.equal(classify('security review of the new payout endpoint').tier, 'opus');
  assert.equal(classify('find the security hole in the auth token handling').tier, 'fable');
  assert.equal(classify('write a threat model for the webhook receiver').tier, 'fable');
});

test('HORIZON scope nouns are symmetric across entire/whole/across-the', () => {
  // The noun lists diverged: `entire (codebase|repo|…)` vs `whole (app|system|…)`
  // with repo and codebase missing. One synonym, two tiers apart.
  for (const scope of ['entire', 'whole', 'across the']) {
    for (const noun of ['repo', 'codebase', 'system', 'platform']) {
      const r = classify(`build every feature across the ${scope === 'across the' ? '' : scope + ' '}${noun}`.replace('across the across the', 'across the'));
      assert.equal(r.kind, 'horizon', `"${scope} ${noun}" → ${r.tier}:${r.kind}, expected horizon`);
    }
  }
});

test('length and brevity AMPLIFY evidence — they never overturn it', () => {
  // (a) A long prompt with zero opus evidence used to score opus+1 and win the
  //     fable>opus>haiku>sonnet tiebreak on word count alone.
  const longTrivial = 'just tweak the copy on this page a bit ' + 'and also adjust the spacing '.repeat(12);
  const r = classify(longTrivial);
  assert.equal(r.tier, 'sonnet', `long-but-trivial → ${r.tier}; length must not buy a tier`);

  // (b) The short-prompt haiku nudge used to fire unconditionally, so a sub-15-word
  //     prompt carrying a TIED fable signal lost to recon phrasing.
  assert.equal(classify('find the race condition in the sync').tier, 'fable');
  // …while genuine recon stays down-tier.
  assert.equal(classify('find all the callers of loadDashboard').tier, 'haiku');
  assert.equal(classify('where is the payout handler').tier, 'haiku');
});

test('the chair follows a mid-session /model switch, in BOTH directions', () => {
  // chair.json is stamped only at SessionStart and `/model` fires no hook, so the
  // chair could never update mid-session. That is worse than no directive:
  // directive() branches on RANK[chair], so a stale "opus" seat makes every
  // opus-tier task print "handle inline" when the truth is "delegate DOWN to
  // conserve fable quota". Measured live: 4+ hours of post-switch decisions all
  // recorded the pre-switch chair.
  //
  // Driven as a subprocess because chairModel is module-internal — this exercises
  // the real hook exactly as Claude Code invokes it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-chair-'));
  const state = path.join(dir, 'state');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(state); fs.mkdirSync(cfg);
  const chairFile = path.join(state, 'chair.json');
  fs.writeFileSync(chairFile, JSON.stringify({ 'sess-1': 'claude-opus-5[1m]', latest: 'claude-opus-5[1m]' }));

  const hook = path.join(REPO_ROOT, 'hooks', 'vzt-route-classifier.mjs');
  const chairFor = (settings, payloadExtra = {}) => {
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(settings));
    const out = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: 'refactor the entire payment module', session_id: 'sess-1', cwd: '/tmp', ...payloadExtra }),
      env: { ...process.env, VZT_ROUTER_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg },
      encoding: 'utf8',
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    return (/chair:\s*(\w+)/.exec(ctx) || [])[1];
  };

  // Neither file source is trustworthy alone — they go stale in OPPOSITE
  // directions. chair.json[sessionId] is stamped once at SessionStart (stale
  // after a mid-session /model); settings.json is global and was observed live
  // on 2026-07-29 still reading `claude-fable-5[1m]` while the session was
  // demonstrably on Opus 5. Session-scoped beats provably-stale-global.
  assert.equal(chairFor({}), 'opus', 'no settings model → session entry');
  assert.equal(
    chairFor({ model: 'claude-fable-5[1m]' }),
    'opus',
    'a stale GLOBAL settings model must not override this session\'s own entry'
  );

  // settings.json is still better than nothing for a session we have never seen.
  const unseen = execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ prompt: 'refactor the entire payment module', session_id: 'never-seen', cwd: '/tmp' }),
    env: { ...process.env, VZT_ROUTER_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg },
    encoding: 'utf8',
  });
  assert.equal((/chair:\s*(\w+)/.exec(JSON.parse(unseen).hookSpecificOutput.additionalContext) || [])[1], 'fable');

  // Settings-derived reads must never be persisted, or chair.json inherits the
  // staleness it exists to correct.
  assert.equal(
    JSON.parse(fs.readFileSync(chairFile, 'utf8'))['sess-1'],
    'claude-opus-5[1m]',
    'settings.json reads must not write chair.json'
  );

  // The payload, when the harness supplies it, IS authoritative and self-heals.
  assert.equal(chairFor({}, { model: 'claude-haiku-4-5' }), 'haiku');
  assert.equal(JSON.parse(fs.readFileSync(chairFile, 'utf8'))['sess-1'], 'claude-haiku-4-5');
});

test('no retired model version survives anywhere in the shipped protocol', () => {
  // Add a row here whenever a model is superseded; the value is the replacement.
  const RETIRED = [
    [/Opus 4\.8/g, 'Opus 5'],
    [/opus-4-8/g, 'claude-opus-5 (or the `opus` alias)'],
  ];
  // Enumerating files by hand is how the guard grows holes: the audit found it
  // was missing vzt-design and vzt-plan (the two NEWEST skills), CLAUDE-snippet,
  // docs/VSCODE.md, the planner/oracle agents and all of vscode/ — so a retired
  // model name could sit in the newest surface and this test would pass.
  // Glob every shipped doctrine surface instead, so new files are covered on the
  // day they land.
  const files = [
    'README.md',
    'package.json',
    'cli/vzt-agent.js',
    'cli/ship-lib.mjs',
    ...fs.readdirSync(path.join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'hooks')).map((f) => `hooks/${f}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((f) => fs.existsSync(path.join(REPO_ROOT, f))),
    ...fs.readdirSync(path.join(REPO_ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `agents/${f}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'templates')).filter((f) => f.endsWith('.md')).map((f) => `templates/${f}`),
    'vscode/README.md',
    'vscode/package.json',
    'vscode/src/extension.ts',
  ].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  assert.ok(files.length >= 25, `expected to scan the whole doctrine surface, only found ${files.length} files`);
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const [pattern, replacement] of RETIRED) {
      // The release-notes section is a historical record — it is allowed to name old models.
      const body = rel === 'README.md' ? text.split('## Release notes')[0] : text;
      assert.equal(
        pattern.test(body),
        false,
        `${rel} still names a retired model (${pattern.source}) — should be "${replacement}"`
      );
      pattern.lastIndex = 0; // /g regexes are stateful across .test() calls
    }
  }
});

test('worker-brief template exists and defines the collision-boundary contract', () => {
  const brief = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'worker-brief.md'), 'utf8');
  for (const phrase of ['FILES_IN_SCOPE', 'MACHINE_CHECK', 'EXPECT', 'Collision boundary is law', 'Reporting ≠ persistence']) {
    assert.ok(brief.includes(phrase), `templates/worker-brief.md missing "${phrase}"`);
  }
});

// The doctrine referenced templates/worker-brief.md in every session, but the
// installer never copied templates/ — so at runtime the brief pointed at
// nothing. The file existed; the install did not. Guard the reference, not just
// the file.
test('every file path the doctrine references is actually installed', () => {
  const referenced = new Set();
  const scan = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'hooks')).map((f) => path.join(REPO_ROOT, 'hooks', f)),
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'skills'))
      .map((d) => path.join(REPO_ROOT, 'skills', d, 'SKILL.md'))
      .filter((f) => fs.existsSync(f)),
  ];
  for (const file of scan) {
    const contents = fs.readFileSync(file, 'utf8');
    // Generalized past the v1.4.0 bug: ANY shipped directory the doctrine points
    // at must be copied by install(), not just templates/.
    // `docs` and `orca` were NOT in this alternation, which is why
    // skills/vzt-ship/SKILL.md could point at `docs/VSCODE.md` and
    // skills/vzt-route at `orca/README.md` — neither of which install() copies —
    // and this guard stayed green. A doctrine reference that does not resolve
    // from the INSTALLED location is the v1.4.0 bug wearing a different hat.
    for (const m of contents.matchAll(/(templates|workflows|docs|orca)\/[A-Za-z0-9._-]+\.(md|js|sh)/g)) referenced.add(m[0]);
  }
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'vzt-agent.js'), 'utf8');
  assert.ok(referenced.size > 0, 'expected the doctrine to reference at least one shipped file');

  // Each shipped directory declares HOW install() places it and how uninstall()
  // takes it back. orca/ is the odd one out — it goes to a fixed ~/.orca/vzt/
  // home rather than into .claude, so it has its own installer.
  const INSTALLERS = {
    templates: { install: /copyDirContents\(TEMPLATES_DIR/, uninstall: /\[TEMPLATES_DIR,/ },
    workflows: { install: /copyDirContents\(WORKFLOWS_DIR/, uninstall: /\[WORKFLOWS_DIR,/ },
    docs: { install: /copyDirContents\(DOCS_DIR/, uninstall: /\[DOCS_DIR,/ },
    orca: { install: /installOrcaHelpers\(\)/, uninstall: /ORCA_VZT_DIR/ },
  };
  for (const ref of referenced) {
    // (a) the file exists in the repo …
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ref)), `doctrine references ${ref}, which does not exist in the repo`);
    // (b) … and install() actually places the directory it lives in, and
    //     uninstall() actually removes it. A doctrine pointing at a file the
    //     installer never copied is exactly the v1.4.0 bug — and it recurred
    //     with docs/ (skills say "see docs/VSCODE.md"; install never copied it).
    const dir = ref.split('/')[0];
    const rules = INSTALLERS[dir];
    assert.ok(rules, `doctrine references ${ref} from an unrecognised directory "${dir}/" — teach this test how it installs`);
    assert.ok(rules.install.test(cli), `doctrine references ${ref} but cli/vzt-agent.js never installs ${dir}/`);
    assert.ok(rules.uninstall.test(cli), `cli/vzt-agent.js installs ${dir}/ but uninstall() never removes it`);
  }
});

// The guard above proves the file is INSTALLED. It never proved the reference
// RESOLVES from where the agent reading it actually stands — and it does not.
// An agent's cwd is the USER's project root; `templates/` lives under .claude/.
// No project has a root-level templates/ directory, so every bare reference
// resolved to nothing, 100% of the time. That is how a 10KB DESIGN.md sitting
// correctly on disk gets reported as "missing" on every retrofit.
//
// Installation guarded, resolution not — the v1.4.0 bug one level deeper.
test('doctrine names shipped files by a path that RESOLVES from the agent cwd', () => {
  // Static surfaces must carry the .claude/ prefix. Runtime surfaces (the hooks)
  // must not carry a literal path at all — they interpolate installedTemplate(),
  // which is the only form that is correct for BOTH a global and a project
  // install, so a bare literal there is a bug even if it were prefixed.
  const surfaces = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'hooks')).map((f) => `hooks/${f}`),
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'skills'))
      .map((d) => `skills/${d}/SKILL.md`)
      .filter((f) => fs.existsSync(path.join(REPO_ROOT, f))),
    ...fs.readdirSync(path.join(REPO_ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `agents/${f}`),
    'cli/vzt-agent.js',
    'cli/ship-lib.mjs',
  ];
  assert.ok(surfaces.length >= 20, `expected the whole doctrine surface, found ${surfaces.length}`);

  // templates/ and docs/ install INTO .claude/ and must carry that prefix.
  // orca/ does not: install() sends it to a FIXED ~/.orca/vzt/ home, so its
  // correct written form is that absolute path, never a .claude/ one.
  //
  // docs/ is the nastier of the two .claude ones. A bare `templates/x.md` fails
  // loudly because no repo has a root templates/ dir — but plenty of repos DO
  // have docs/, so a bare `docs/ROUTING-MATRIX.md` can resolve to the USER's
  // unrelated file and be read as ours. Wrong beats missing, so it is gated too.
  const RULES = [
    { re: /(?<!\.claude\/)templates\/[A-Za-z0-9._-]+\.(?:md|js|sh)/g, fix: (m) => `".claude/${m}", or interpolate templateRef() in a hook` },
    { re: /(?<!\.claude\/)docs\/[A-Za-z0-9._-]+\.(?:md|js|sh)/g, fix: (m) => `".claude/${m}", or interpolate docRef() in a hook` },
    { re: /(?<!\.orca\/vzt\/)\borca\/[A-Za-z0-9._-]+\.(?:md|js|sh)/g, fix: (m) => `"~/.orca/vzt/${m.slice('orca/'.length)}", or interpolate orcaRef() — orca does NOT install into .claude` },
  ];
  // A `//` line comment is read by maintainers of THIS repo, where the bare
  // repo-relative path is the correct thing to write. Only text that can reach
  // an agent is gated.
  const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
  const offenders = [];
  for (const rel of surfaces) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      for (const { re, fix } of RULES) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          offenders.push(`${rel}:${i + 1}: "${m[0]}" — write ${fix(m[0])}`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `doctrine points agents at a path that does not exist from a project root:\n  ${offenders.join('\n  ')}`
  );
});

// The resolver is the whole fix for the runtime surfaces; if it silently
// returns a non-existent path we are back to shipping a lie, just a longer one.
test('installedTemplate() returns a real absolute path, or null — never a guess', () => {
  for (const name of fs.readdirSync(path.join(REPO_ROOT, 'templates')).filter((f) => f.endsWith('.md'))) {
    const resolved = installedTemplate(name);
    assert.ok(resolved !== null, `installedTemplate(${name}) returned null while the template is right there in the repo`);
    assert.ok(path.isAbsolute(resolved), `installedTemplate(${name}) returned "${resolved}", which is not absolute`);
    assert.ok(fs.existsSync(resolved), `installedTemplate(${name}) returned "${resolved}", which does not exist`);
  }
  assert.equal(installedTemplate('no-such-template.md'), null, 'a missing template must be null, not a path that lies');
});

test('the ship spec template encodes the machine-readable contract', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'spec.md'), 'utf8');
  for (const phrase of ['<!-- vzt-spec', 'FILES_IN_SCOPE', 'machineCheck', 'expect', 'barrier', 'pairwise disjoint']) {
    assert.ok(spec.includes(phrase), `templates/spec.md missing "${phrase}"`);
  }
});

test('worker-brief encodes the supervision + correction protocol', () => {
  const brief = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'worker-brief.md'), 'utf8');
  for (const phrase of ['CORRECTION', 'SCOPE_BREACH', 'SendMessage', 'Two rounds is the ceiling', 'Name every worker']) {
    assert.ok(brief.includes(phrase), `templates/worker-brief.md missing "${phrase}"`);
  }
});

test('/vzt-ship ships, authorizes Workflow, and carries its own kill-switch', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-ship', 'SKILL.md'), 'utf8');
  for (const phrase of ['Workflow', 'ship-check', 'pairwise disjoint', 'no filesystem access', 'Falsification rule', 'templates/worker-brief.md']) {
    assert.ok(skill.includes(phrase), `skills/vzt-ship/SKILL.md missing "${phrase}"`);
  }
});

test('vzt-diagnose ships and encodes the fan-out limits', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-diagnose', 'SKILL.md'), 'utf8');
  for (const phrase of ['CONFIRMED', 'REFUTED', 'INCONCLUSIVE', 'read-only', 'confirmed_idx']) {
    assert.ok(skill.includes(phrase), `skills/vzt-diagnose/SKILL.md missing "${phrase}"`);
  }
  const route = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  assert.ok(route.includes('never for CORRECTNESS'), 'vzt-route missing the fan-out purpose rule');
  assert.ok(route.includes('Rejected — do not re-propose'), 'vzt-route missing the recorded worktree/judge rejection');
});

test('worker agents enforce the collision boundary', () => {
  for (const agent of ['vzt-builder.md', 'vzt-mechanic.md', 'vzt-heavy-builder.md']) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, 'agents', agent), 'utf8');
    assert.ok(contents.includes('Collision boundary'), `agents/${agent} missing "Collision boundary"`);
  }
});

test('every Opus surface carries the fable-mode gates (always-on discipline)', () => {
  // Both Opus agents state the gates as a rule.
  for (const agent of ['vzt-heavy-builder.md', 'vzt-reviewer.md']) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, 'agents', agent), 'utf8');
    assert.ok(contents.includes('fable-mode gates — always on'), `agents/${agent} missing always-on fable-mode gates rule`);
  }
  // The Opus chair profile injects the gates at session start.
  const sessionStart = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'vzt-session-start.mjs'), 'utf8');
  assert.ok(/opus: `[^`]*five gates/.test(sessionStart), 'opus chair profile missing the five gates');
  // Opus-targeted directives restate the discipline; other tiers do not.
  const opusDirective = directive({ tier: 'opus', kind: 'build', confidence: 'high', effort: 'high', matched: [], scores: {}, words: 10 }, 'sonnet');
  assert.ok(opusDirective.includes('fable-mode gates'), 'opus [VZT-ROUTE] directive missing the gates line');
  const sonnetDirective = directive({ tier: 'sonnet', kind: 'build', confidence: 'high', effort: 'medium', matched: [], scores: {}, words: 10 }, 'sonnet');
  assert.ok(!sonnetDirective.includes('fable-mode gates'), 'sonnet directive should not carry the opus gates line');
});

// This doctrine once lived ONLY in the installed copy under ~/.claude and was
// absent from this repo — so the next `install --global` would have overwritten
// the hook and silently deleted it from every project at once. The chair would
// then go back to in-process subagents, which can never appear in a pane, and the
// user would see no agents working with nothing to explain why. Pin it at the
// SOURCE, which is the only copy install can preserve.
test('every chair profile tells the chair to dispatch waves as real panes', () => {
  const sessionStart = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'vzt-session-start.mjs'), 'utf8');
  assert.ok(sessionStart.includes('const VISIBLE_PARALLELISM = {'), 'session-start lost the visible parallelism text map');
  for (const chair of ['fable', 'opus', 'sonnet', 'haiku']) {
    const profile = new RegExp(`${chair}: \`[^\`\\\\]*(?:\\\\.[^\`\\\\]*)*`, 's').exec(sessionStart);
    assert.ok(profile, `no ${chair} chair profile found`);
    assert.ok(profile[0].includes(`visibleParallelism(VISIBLE_PARALLELISM.${chair})`),
      `${chair} chair profile lost the VISIBLE PARALLELISM doctrine`);
    // The doctrine is only actionable if it names the command that splits a pane.
    assert.ok(new RegExp(`${chair}: '.*vzt-orca-flow pane run`, 's').test(sessionStart),
      `${chair} visible parallelism text names no pane command`);
  }
});

test('vzt-route skill references the worker-brief template', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'vzt-route', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('worker-brief'), 'skills/vzt-route/SKILL.md missing reference to "worker-brief"');
});

// ——— The ui lane: the taste cache ————————————————————————————————————————

test('the ui lane never cannibalizes the technical design lane', () => {
  // "design" is the most overloaded word in this protocol: /vzt-design and
  // vzt-architect mean TECHNICAL design. If the visual regexes ever start
  // eating these, routine architecture silently becomes a styling task.
  for (const p of [
    'Design the system architecture for the internal admin tool',
    'Design the architecture for the whole system from scratch',
    'analyze the failure modes of this design',
    'Design a novel architecture for the multi-tenant billing platform',
  ]) {
    assert.notEqual(classify(p).kind, 'ui', `"${p}" was eaten by the visual lane`);
  }
});

test('no legacy case becomes a ui task', () => {
  for (const [p] of cases) assert.notEqual(classify(p).kind, 'ui', `"${p}" wrongly became visual`);
});

test('taste with NO cache routes UP to opus and never returns max', () => {
  for (const p of [
    'make the dashboard look more premium and less cramped',
    'design the look and feel of the marketing site',
    'establish a design system with design tokens',
  ]) {
    const r = classify(p, undefined);
    assert.equal(r.tier, 'opus', `"${p}" should author taste on Opus`);
    assert.equal(r.kind, 'ui');
    assert.equal(r.designDoc, null);
    assert.notEqual(r.effort, 'max', 'max is the opus@max PLAN rung, not a visual setting');
  }
});

test('a real DESIGN.md routes visual work DOWN to sonnet (the taste cache)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-design-'));
  try {
    fs.writeFileSync(path.join(repo, 'DESIGN.md'), 'x'.repeat(600));
    const r = classify('make the dashboard look more premium and less cramped', repo);
    assert.equal(r.tier, 'sonnet', 'taste on disk must not buy a premium tier');
    assert.equal(r.kind, 'ui');
    assert.equal(r.designDoc, 'DESIGN.md');
    assert.ok(directive(r, 'opus').includes('DESIGN.md'), 'the directive must name the file to read');
    assert.ok(directive(r, 'opus').includes(TIERS.sonnet.agents.ui), 'cache-hit directive must name the applier');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a STUB DESIGN.md is not a taste cache (size floor)', () => {
  // A placeholder would down-route every visual request in the repo forever
  // while containing no taste to apply — a cache that lies.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vzt-stub-'));
  try {
    fs.writeFileSync(path.join(repo, 'DESIGN.md'), '# Design\n\nTODO\n');
    const r = classify('make the dashboard look more premium', repo);
    assert.equal(r.tier, 'opus', 'an empty placeholder must not down-route visual work');
    assert.equal(r.designDoc, null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('surface work without a cache stays on sonnet — visual FPs never buy a tier', () => {
  for (const p of [
    'add dark mode to the settings page',
    'fix the contrast ratio on the buttons',
    'make the pricing table responsive on mobile',
  ]) {
    assert.equal(classify(p, undefined).tier, 'sonnet', `"${p}" over-routed`);
  }
});

test('engineering prose that merely SOUNDS visual does not enter the ui lane', () => {
  // Each of these caught a naive form of the regexes during design.
  for (const p of [
    'add a brand new endpoint for webhooks',
    'the premium plan users cannot see the export button',
    'contrast the two caching approaches',
    'grid search the hyperparameters',
    'handle the transition from Postgres to MySQL',
  ]) {
    assert.notEqual(classify(p, undefined).kind, 'ui', `"${p}" wrongly entered the visual lane`);
  }
});

test('the ui directives name the right agent and explain why not the other tier', () => {
  const miss = directive(classify('design the look and feel of the marketing site'), 'sonnet');
  assert.ok(miss.includes('/vzt-ui'), 'cache-miss directive must offer the skill');
  assert.ok(miss.includes('DESIGN.md'), 'cache-miss directive must name the artifact to write');
  assert.ok(miss.includes(TIERS.opus.agents.ui), 'cache-miss directive must name the author agent');
  assert.ok(miss.includes('why NOT Sonnet') && miss.includes('why NOT Fable'), 'must justify the tier both ways');
  assert.ok(miss.includes('fable-mode gates'), 'an Opus surface must carry the gates');
});
