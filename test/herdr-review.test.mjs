// Stage 2 (the review loop) — the acceptance checks from
// docs/herdr-fleet-vscode-PLAN.md, written before the surface was believed:
//
//   "comments left on two different files arrive in the target agent as ONE
//    message, and the target is the agent whose diff you reviewed, never a
//    different one."
//
// Both halves are tested against real compiled code. The target half runs the
// real HerdrClient over a real unix socket to a fake daemon, so it asserts the
// bytes on the wire rather than an intention in the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(REPO_ROOT, 'vscode', 'out', 'herdr');
const req = createRequire(import.meta.url);

/** Enough of `vscode` for the modules under test to load and run. */
function vscodeStub() {
  return {
    EventEmitter: class {
      constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; }
      fire(v) { for (const fn of this.l) fn(v); }
      dispose() { this.l = []; }
    },
    // fleetTree.ts builds its ICONS table at module load, so these must exist.
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    comments: { createCommentController: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    window: { showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {}, showQuickPick: async () => undefined },
    workspace: { getConfiguration: () => ({ get: () => undefined }), openTextDocument: async () => { throw new Error('no doc'); } },
    extensions: { getExtension: () => undefined },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, path: p }) },
  };
}

function load(file) {
  const orig = Module._load;
  Module._load = function (r, p, m) { return r === 'vscode' ? vscodeStub() : orig.call(this, r, p, m); };
  try {
    const full = path.join(OUT, file);
    if (!fs.existsSync(full)) assert.fail(`${full} missing — run \`npm run compile\` in vscode/`);
    delete req.cache[req.resolve(full)];
    return req(full);
  } finally {
    Module._load = orig;
  }
}

const comment = (over = {}) => ({ file: 'src/a.ts', line: 10, original: false, body: 'fix this', ...over });

// --- half one: ONE message, both files ---------------------------------------

test('comments on two different files render as ONE message containing both', () => {
  const { formatReview } = load('review.js');
  const text = formatReview(
    [
      comment({ file: 'src/b.ts', line: 3, body: 'wrong order' }),
      comment({ file: 'src/a.ts', line: 10, body: 'fix this' }),
    ],
    'myrepo'
  );

  assert.equal(typeof text, 'string', 'the batch must be a single string, not a list of messages');
  assert.ok(text.includes('src/a.ts:10'), 'file one must be in the message');
  assert.ok(text.includes('src/b.ts:3'), 'file two must be in the message');
  assert.ok(text.includes('fix this') && text.includes('wrong order'), 'both bodies must survive');
  assert.ok(/2 comments across 2 files/.test(text), `header must count both files — got: ${text.split('\n')[0]}`);
});

test('comments are grouped by file and ordered by line, not by click order', () => {
  // An agent handed comments in the order they were clicked has to reconstruct
  // the reading order itself, and will interleave two files while editing.
  const { formatReview } = load('review.js');
  const text = formatReview(
    [
      comment({ file: 'src/b.ts', line: 90, body: 'last' }),
      comment({ file: 'src/a.ts', line: 50, body: 'second' }),
      comment({ file: 'src/a.ts', line: 5, body: 'first' }),
    ],
    'myrepo'
  );
  const at = (s) => text.indexOf(s);
  assert.ok(at('src/a.ts:5') < at('src/a.ts:50'), 'lines within a file must ascend');
  assert.ok(at('src/a.ts:50') < at('src/b.ts:90'), 'files must not interleave');
});

test('a file-level comment is never emitted as path:0', () => {
  // CommentThread.range is optional. Rendering the missing range as line 0 gives
  // the agent a `path:0` reference that resolves nowhere, and rendering it as
  // line 1 is a different review comment than the one that was written.
  const { formatReview } = load('review.js');
  const text = formatReview([comment({ line: 0, body: 'this file should not exist' })], 'myrepo');
  assert.ok(!/src\/a\.ts:0/.test(text), 'must not emit a path:0 reference');
  assert.ok(text.includes('src/a.ts (whole file)'), `expected a whole-file marker — got:\n${text}`);
});

test('a comment on the original side is labelled, so the agent does not edit the wrong side', () => {
  const { formatReview } = load('review.js');
  const text = formatReview([comment({ original: true })], 'myrepo');
  assert.ok(/original side/.test(text), 'original-side comments must say so');
});

test('the anchored source line travels with the comment', () => {
  const { formatReview } = load('review.js');
  const text = formatReview([comment({ context: '  const x = 1;' })], 'myrepo');
  assert.ok(text.includes('const x = 1;'), 'the anchored line gives "this" a referent');
});

// --- half two: the TARGET, asserted on the wire ------------------------------

/** A fake herdr daemon: one request per connection, exactly as the real one. */
function fakeDaemon(sockPath, onRequest) {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const frame = JSON.parse(buf.slice(0, nl));
      onRequest(frame);
      sock.write(JSON.stringify({ id: frame.id, result: {} }) + '\n');
      sock.end(); // the real server closes after answering
    });
  });
  return new Promise((res) => server.listen(sockPath, () => res(server)));
}

test('client.prompt puts the PANE ID on the wire as target, and nothing else', async () => {
  // The one failure this surface must not have is a review landing in a
  // different agent. Measured against live herdr 0.7.5: agent.get (same target
  // string as agent.prompt) resolves `w5G:p1` but answers agent_not_found for
  // the workspace label, the workspace id and the terminal title. So a pane id
  // is the only safe target, and this asserts the bytes, not the intent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fake-'));
  const sockPath = path.join(dir, 'herdr.sock');
  const seen = [];
  const server = await fakeDaemon(sockPath, (f) => seen.push(f));

  const prev = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sockPath;
  try {
    const { HerdrClient } = load('client.js');
    const client = new HerdrClient({ appendLine() {}, show() {} });
    await client.prompt('w5G:p1', 'Code review on myrepo — 2 comments across 2 files.');

    assert.equal(seen.length, 1, 'a review batch must be exactly ONE request, not one per file');
    assert.equal(seen[0].method, 'agent.prompt');
    assert.equal(seen[0].params.target, 'w5G:p1', 'target must be the pane id');
    assert.ok(seen[0].params.text.includes('2 comments across 2 files'), 'the whole batch must be in one text field');
    assert.ok(!('pane_id' in seen[0].params), 'agent.prompt takes `target`, not `pane_id`');
  } finally {
    if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prev;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the send path targets agent.pane_id — never a label the daemon cannot resolve', () => {
  // Structural, and deliberately so: the failure mode is someone later making
  // the target "friendlier" by passing a name. herdr answers agent_not_found
  // for every name form, so that change fails at send time, in front of a
  // review someone just wrote.
  const js = fs.readFileSync(path.join(OUT, 'review.js'), 'utf8');
  const call = js.match(/client\.prompt\(([^)]*)/);
  assert.ok(call, 'review.js must call client.prompt');
  assert.ok(
    /agent\.pane_id/.test(call[1]),
    `client.prompt must be called with agent.pane_id — got: client.prompt(${call[1]}`
  );
  assert.equal(
    (js.match(/client\.prompt\(/g) || []).length,
    1,
    'exactly one send call site — a second one is how a batch becomes two messages'
  );
});

test('a failed send KEEPS the comments', () => {
  // Losing a written review to a transport error is unforgivable, and it is the
  // natural shape of the code to dispose the threads right after the await.
  const js = fs.readFileSync(path.join(OUT, 'review.js'), 'utf8');
  const send = js.slice(js.indexOf('client.prompt('));
  const cat = send.slice(send.indexOf('catch'), send.indexOf('catch') + 400);
  assert.ok(!/disposeAll\(\)/.test(cat), 'the catch branch must not discard the threads');
});
