#!/usr/bin/env node
/**
 * THE LIVE GATE for the herdr review loop. Manual — it needs a running herdr
 * daemon and it stages a real Claude Code agent.
 *
 *   npm run test:live            # stages its own agent, tears it down after
 *   npm run test:live -- --pane w5G:p1   # reuse an agent you already have
 *   npm run test:live -- --keep  # leave the staged pane up for inspection
 *
 * WHY THIS EXISTS AND CANNOT BE A `node --test` SUITE
 * ---------------------------------------------------
 * `test/herdr-review.test.mjs` pins the BYTES: that `enter` follows
 * `agent.prompt`, that `target` is a pane_id. It runs the real HerdrClient over
 * a real socket to a FAKE daemon, and it is worth every line — but a fake
 * daemon cannot tell you whether a real agent SUBMITTED the text, because the
 * bytes were correct in the broken version too. `agent.prompt` returns ok in
 * ~150ms either way. Only firing at a live agent and then READING THE PANE
 * shows the difference. This file is that check, and it is what found the bug.
 *
 * Deliberately NOT named `*.test.mjs`, so `npm test`
 * (`node --test 'test/*.test.mjs'`) cannot pick it up. An automated suite that
 * silently needs a staged agent is a suite that goes red for the wrong reason.
 *
 * TWO PHASES, AND THE ORDER IS THE POINT
 * --------------------------------------
 *   CONTROL  raw `agent.prompt`, no `enter` — the pre-fix code path. MUST stay
 *            idle with the text parked as "[Pasted text #1 +N lines]".
 *   FIXED    the real compiled HerdrClient.prompt. MUST leave idle within ~2s
 *            and be visible in the pane.
 *
 * A green FIXED phase proves nothing on its own: it is also what you get from a
 * daemon that submits everything, or from an assertion reading the wrong field.
 * The CONTROL is the mutation, run every time rather than trusted from history.
 * If the CONTROL ever passes (i.e. the multi-line prompt submits by itself),
 * that is NOT good news to skip past — herdr changed, and the `enter` in
 * client.ts needs re-deriving rather than assuming.
 *
 * TRAPS ENCODED HERE — each one cost a debugging session
 * ------------------------------------------------------
 * - `pane.read` over the SOCKET needs `source` and answers `result.read.text`.
 *   The CLI hides both: `herdr pane read <id>` prints rendered text, while the
 *   same call over the socket without `source` is rejected outright. Reading a
 *   guessed field yields `undefined`, and `undefined` contains no "[Pasted
 *   text" marker — so the composer assertion PASSES while looking at nothing.
 *   A false green on the one assertion this gate exists for.
 * - NEVER pass `--lines`/`lines`. Pane reads are tail-like; a line cap returns
 *   blank rows above the content you are looking for.
 * - There is NO `timeout` binary on macOS. Every wait here is background-and-
 *   poll against a deadline. An unbounded probe hangs the gate, and a hanging
 *   gate is no better than one never run.
 * - The review body carries MARKERS (HERDR-PROBE-A/B), never instructions. An
 *   earlier version asked the agent to "reply ACKNOWLEDGED" as a delivery
 *   signal and the agent correctly refused, on the grounds that anyone able to
 *   file a review comment could otherwise steer the session. It is right, and
 *   the gate must not depend on an agent choosing to obey injected text.
 * - A freshly started `claude` sits on the trust prompt, which herdr reports as
 *   `idle`. Prompting there types into a dialog. Cleared explicitly below.
 * - No daemon means CANNOT RUN (exit 2), never PASS. Reporting a gate green
 *   because it did not execute is the failure mode this repo keeps hitting.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'vscode', 'out', 'herdr');
const req = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : undefined;
};
const REUSE_PANE = typeof flag('pane') === 'string' ? flag('pane') : undefined;
const KEEP = Boolean(flag('keep'));

const SOCK =
  process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');

/** Budget for the FIXED phase to leave idle. The observed figure is ~500ms. */
const SUBMIT_BUDGET_MS = 8000;
/** How long the CONTROL must sit stuck before we believe it is stuck. */
const CONTROL_DWELL_MS = 8000;

// --- transport ---------------------------------------------------------------

/**
 * One request, one fresh connection, one line back — the server closes after
 * answering, so a shared socket throws EPIPE on the second write. Same shape as
 * HerdrClient.request; kept separate on purpose, because the CONTROL phase must
 * be able to send a bare `agent.prompt` that the real client no longer can.
 */
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK);
    let buf = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(20_000, () => done(new Error(`${method} timed out after 20s`)));
    sock.on('error', done);
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: `live-${method}`, method, params })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let frame;
      try {
        frame = JSON.parse(buf.slice(0, nl));
      } catch {
        return done(new Error(`${method}: unparseable frame ${buf.slice(0, 200)}`));
      }
      frame.error ? done(new Error(`${method} [${frame.error.code}]: ${frame.error.message}`)) : done(undefined, frame.result);
    });
    sock.on('close', () => done(new Error(`herdr closed the connection during ${method}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const statusOf = async (pane) => (await rpc('agent.get', { target: pane })).agent.agent_status;

/** `source` is REQUIRED and the text lives at result.read.text. See header. */
const readPane = async (pane) => {
  const res = await rpc('pane.read', { pane_id: pane, source: 'recent' });
  const text = res?.read?.text;
  if (typeof text !== 'string') {
    throw new Error(
      `pane.read returned no result.read.text (keys: ${Object.keys(res?.read ?? res ?? {}).join(',')}). ` +
        `The wire shape changed — fix this probe rather than trusting its assertions.`
    );
  }
  return text;
};

/** Poll for the agent to LEAVE idle, bounded by a deadline. */
async function waitLeftIdle(pane, budgetMs) {
  const started = Date.now();
  const deadline = started + budgetMs;
  while (Date.now() < deadline) {
    const s = await statusOf(pane);
    if (s !== 'idle') return { left: true, status: s, elapsed: Date.now() - started };
    await sleep(250);
  }
  return { left: false, status: await statusOf(pane), elapsed: Date.now() - started };
}

// --- the vscode shim, identical to the offline suites ------------------------

function vscodeStub() {
  return {
    EventEmitter: class {
      constructor() {
        this.l = [];
        this.event = (fn) => {
          this.l.push(fn);
          return { dispose() {} };
        };
      }
      fire(v) { for (const fn of this.l) fn(v); }
      dispose() { this.l = []; }
    },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Range: class {
      constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; }
    },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    comments: { createCommentController: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    window: {
      showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {},
      showQuickPick: async () => undefined,
    },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      openTextDocument: async () => { throw new Error('no doc'); },
    },
    extensions: { getExtension: () => undefined },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, path: p }) },
  };
}

function load(file) {
  const orig = Module._load;
  Module._load = function (r, p, m) { return r === 'vscode' ? vscodeStub() : orig.call(this, r, p, m); };
  try {
    const full = path.join(OUT, file);
    if (!fs.existsSync(full)) {
      throw new Error(`${full} missing — run \`npm run compile\` in vscode/ first`);
    }
    delete req.cache[req.resolve(full)];
    return req(full);
  } finally {
    Module._load = orig;
  }
}

// --- reporting ---------------------------------------------------------------

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) failures++;
};
const step = (msg) => console.log(`  · ${msg}`);

function cannotRun(why) {
  console.error(`\nLIVE GATE: CANNOT RUN — ${why}`);
  console.error('This is NOT a pass. Start herdr and re-run.');
  process.exit(2);
}

// --- staging -----------------------------------------------------------------

// 🔴 PANE TEXT IS HARD-WRAPPED AT THE PANE WIDTH, so any multi-word regex can
// straddle a newline and silently never match. The first version of this used
// /Is this a project you created or one you trust/ — copied from how the dialog
// LOOKS — and the pane actually contains:
//
//     Quick safety check: Is this a project you created or
//     one you trust? (Like your own code, ...
//
// It matched nothing, the trust prompt was never cleared, and the run died 90s
// later blaming the composer. Match SHORT fragments that cannot wrap.
const TRUST_PROMPT = /Yes, I trust this folder/i;
/** Claude Code's composer footer — the only reliable "ready for input" signal. */
const COMPOSER_READY = /shortcuts/i;

/**
 * Create a throwaway project and a pane for it, then start a real agent.
 *
 * The project is a temp dir, never a real checkout: the review we send names
 * files, and an agent that decides to act on it must not be able to reach
 * anything that matters.
 */
async function stageAgent(staged) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-'));
  // Record on the shared object IMMEDIATELY, before anything that can throw.
  // Staging half-succeeded once and leaked both a pane and a temp dir, because
  // the caller only learned about them on a clean return.
  staged.dir = dir;
  staged.created = true;
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function one() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function two() {\n  return 2;\n}\n');
  step(`throwaway project at ${dir}`);

  const { panes } = await rpc('pane.list');
  if (!panes?.length) cannotRun('herdr is running but has no panes to split');
  const host = panes.find((p) => p.focused) ?? panes[0];

  // focus:false — a gate that steals the user's focus is a gate they stop running.
  const split = await rpc('pane.split', {
    target_pane_id: host.pane_id,
    direction: 'right',
    cwd: dir,
    focus: false,
  });
  const pane = split.pane.pane_id;
  staged.pane = pane;
  step(`split ${host.pane_id} -> ${pane}`);

  // `agent.start` requires the pane to be AT its interactive shell prompt, and
  // a freshly split pane is not — the shell is still starting. It answers
  // `agent_pane_busy`, which reads like the pane is in use rather than merely
  // not ready yet. Retry against a deadline instead of sleeping a guessed
  // constant: shell startup depends on the user's rc files, not on us.
  const startDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      await rpc('agent.start', { name: 'herdr-live-gate', kind: 'claude', pane_id: pane, timeout_ms: 120_000 });
      break;
    } catch (err) {
      if (!/agent_pane_busy|not an available shell/.test(err.message)) throw err;
      if (Date.now() > startDeadline) {
        throw new Error(`pane ${pane} never reached an interactive shell prompt in 60s: ${err.message}`);
      }
      step('waiting for the shell prompt…');
      await sleep(2000);
    }
  }
  step(`agent started in ${pane}`);

  // 🔴 Readiness must be POSITIVE — "the composer is on screen" — not "no trust
  // dialog is on screen". A fresh `claude` shows a startup screen first, so an
  // absence check passes before the dialog has even rendered, and the run then
  // dies on `agent.prompt [agent_not_ready]: not an active named agent`.
  // herdr reports `idle` throughout, and `agent.wait --until idle` returns
  // happily, because from the daemon's side nothing is running — the dialog is
  // just a program drawing characters. Neither signal can see it; the pane can.
  await rpc('agent.wait', { target: pane, until: ['idle'], timeout_ms: 60_000 });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    const text = await readPane(pane);
    if (TRUST_PROMPT.test(text)) {
      step('clearing the trust prompt');
      await rpc('pane.send_keys', { pane_id: pane, keys: ['enter'] });
      await sleep(3000);
      continue;
    }
    if (COMPOSER_READY.test(text)) {
      ready = true;
      break;
    }
    await sleep(2000);
  }
  if (!ready) {
    // Print what we actually saw. A readiness timeout with no pane dump sends
    // the next person guessing at regexes, which is exactly how the wrap bug
    // above survived two runs.
    console.log('  --- pane at timeout ---');
    console.log((await readPane(pane)).split('\n').slice(-20).map((l) => `      | ${l}`).join('\n'));
    throw new Error(
      `agent in ${pane} never reached its composer in 90s — start one by hand and pass --pane`
    );
  }
  step('composer ready');
}

// --- the gate ----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(SOCK)) cannotRun(`no herdr socket at ${SOCK}`);

  let pong;
  try {
    pong = await rpc('ping');
  } catch (err) {
    cannotRun(`herdr socket exists but does not answer ping: ${err.message}`);
  }

  const { HERDR_PROTOCOL } = load('types.gen.js');
  console.log(`socket   : ${SOCK}`);
  console.log(`daemon   : herdr ${pong.version}, protocol ${pong.protocol}`);
  console.log(`extension: built for protocol ${HERDR_PROTOCOL}`);
  if (pong.protocol !== HERDR_PROTOCOL) {
    cannotRun(
      `protocol mismatch (daemon ${pong.protocol}, extension ${HERDR_PROTOCOL}) — ` +
        `run \`npm run compile\` in vscode/ to regenerate types`
    );
  }

  // Shared with stageAgent so a PARTIAL staging still gets torn down.
  const staged = { pane: REUSE_PANE, dir: undefined, created: false };
  try {
    if (REUSE_PANE) {
      console.log(`\n=== STAGING (reusing ${REUSE_PANE}) ===`);
      const s = await statusOf(REUSE_PANE).catch(() => undefined);
      if (!s) cannotRun(`no agent at ${REUSE_PANE} — \`target\` is a pane_id, never a label`);
      if (s !== 'idle') cannotRun(`agent at ${REUSE_PANE} is ${s}, not idle — wait for it`);
    } else {
      console.log('\n=== STAGING ===');
      await stageAgent(staged);
    }
    const PANE = staged.pane;

    // The review, composed by the REAL formatReview. Markers, not instructions.
    const { formatReview } = load('review.js');
    const review = formatReview(
      [
        { file: 'src/b.ts', line: 2, original: false, body: 'HERDR-PROBE-B: comment on file two.' },
        { file: 'src/a.ts', line: 2, original: false, body: 'HERDR-PROBE-A: comment on file one.' },
      ],
      'herdr-live'
    );
    console.log(`\nreview   : ${review.split('\n').length} lines, ${review.length} bytes`);
    console.log(review.split('\n').map((l) => `  | ${l}`).join('\n'));

    // -- PHASE 1: CONTROL ----------------------------------------------------
    console.log('\n=== PHASE 1 — CONTROL (bare agent.prompt, no enter: the pre-fix path) ===');
    check((await statusOf(PANE)) === 'idle', 'agent_status before = idle');

    const t0 = Date.now();
    await rpc('agent.prompt', { target: PANE, text: review });
    step(`agent.prompt returned ok in ${Date.now() - t0}ms`);

    const control = await waitLeftIdle(PANE, CONTROL_DWELL_MS);
    check(
      !control.left,
      `CONTROL: multi-line prompt does NOT submit — still idle after ${CONTROL_DWELL_MS}ms`,
      control.left
        ? `agent went ${control.status} on its own. herdr may have FIXED this — re-derive the ` +
          `enter in client.ts rather than assuming it is still needed.`
        : `agent_status = ${control.status}`
    );

    const controlPane = await readPane(PANE);
    const stuck = /\[Pasted text/.test(controlPane);
    check(
      stuck,
      'CONTROL: the text is PARKED in the composer, not delivered',
      stuck
        ? (controlPane.match(/[^\n]*\[Pasted text[^\n]*/) || [''])[0].trim()
        : 'no "[Pasted text" marker — the daemon may render a stuck paste differently now'
    );

    // Clear it, so phase 2 measures its own send rather than this leftover.
    for (let i = 0; i < 2; i++) {
      await rpc('agent.send_keys', { target: PANE, keys: ['ctrl+c'] });
      await sleep(1500);
    }
    step(`composer cleared (agent ${await statusOf(PANE)})`);

    // -- PHASE 2: FIXED ------------------------------------------------------
    console.log('\n=== PHASE 2 — FIXED (real compiled HerdrClient.prompt) ===');
    const { HerdrClient } = load('client.js');
    const client = new HerdrClient({ appendLine: (m) => console.log(`      [log] ${m}`) });

    check((await statusOf(PANE)) === 'idle', 'agent_status before = idle');

    const t1 = Date.now();
    await client.prompt(PANE, review);
    step(`client.prompt returned in ${Date.now() - t1}ms`);

    const fixed = await waitLeftIdle(PANE, SUBMIT_BUDGET_MS);
    check(
      fixed.left,
      `FIXED: the agent LEFT idle — submitted (status ${fixed.status})`,
      `observed after ~${fixed.elapsed}ms`
    );

    await sleep(4000);
    const finalPane = await readPane(PANE);

    check(
      !/\[Pasted text[^\n]*\n?\s*$/.test(finalPane.trimEnd()),
      'FIXED: nothing left parked in the composer'
    );

    const sawA = finalPane.includes('HERDR-PROBE-A');
    const sawB = finalPane.includes('HERDR-PROBE-B');
    check(
      sawA && sawB,
      'FIXED: BOTH files’ comments are VISIBLE in the pane (one message, not two)',
      `HERDR-PROBE-A: ${sawA ? 'visible' : 'MISSING'} · HERDR-PROBE-B: ${sawB ? 'visible' : 'MISSING'}`
    );

    console.log('\n--- pane tail ---');
    console.log(finalPane.split('\n').slice(-24).map((l) => `  | ${l}`).join('\n'));
  } finally {
    if (staged.created && !KEEP) {
      // Runs on the failure path too — staging can throw between the split and
      // the agent, and a leaked pane makes the next run pick a different host.
      console.log('\n=== TEARDOWN ===');
      if (staged.pane) {
        await rpc('pane.close', { pane_id: staged.pane })
          .then(() => step(`closed ${staged.pane}`))
          .catch((e) => step(`close ${staged.pane} failed: ${e.message}`));
      }
      if (staged.dir) {
        fs.rmSync(staged.dir, { recursive: true, force: true });
        step(`removed ${staged.dir}`);
      }
    } else if (staged.created) {
      console.log(`\n=== KEPT ${staged.pane} (${staged.dir}) ===`);
    }
  }

  console.log(`\n${failures === 0 ? 'LIVE GATE: PASS' : `LIVE GATE: FAIL (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nLIVE GATE: ERROR — ${err.message}`);
  process.exit(1);
});
