// Agent Dashboard (u6): kanban buckets and the escaped, strict-CSP webview document.
//
// model.js is imported from the COMPILED extension (vscode/out) — run
// `npm --prefix vscode run compile` first. It is deliberately vscode-free so
// plain node can load it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(REPO_ROOT, 'vscode', 'out', 'dashboard', 'model.js');

async function load() {
  if (!fs.existsSync(MODEL)) {
    assert.fail('vscode/out/dashboard/model.js missing — run `npm --prefix vscode run compile` before testing');
  }
  return import(pathToFileURL(MODEL).href);
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function agent(over = {}) {
  return {
    agent_id: 'id-' + (over.alias ?? 'a'),
    workspace: '/repos/proj/.worktrees/feat-x',
    project: '/repos/proj',
    alias: 'a',
    kind: 'claude',
    state: 'working',
    state_ts_ms: NOW - MIN,
    liveness: 'live',
    wake_unconfirmed: false,
    unread: 0,
    window_id: null,
    ...over,
  };
}

const ids = (col) => col.map((a) => a.agent_id);
const OPTS = { nonce: 'n0nceABC', cspSource: 'vscode-webview://x', showIdle: false };

test('buckets by glyph', async () => {
  const { bucket } = await load();
  const board = bucket(
    [
      agent({ alias: 'blocked', state: 'blocked' }),
      agent({ alias: 'busy', state: 'working' }),
      agent({ alias: 'fresh', state: 'idle', state_ts_ms: NOW - 5 * MIN }),
      agent({ alias: 'old', state: 'idle', state_ts_ms: NOW - 60 * MIN }),
    ],
    NOW,
    true
  );
  assert.deepEqual(ids(board.needsYou), ['id-blocked']);
  assert.deepEqual(ids(board.working), ['id-busy']);
  assert.deepEqual(ids(board.done), ['id-fresh']);
  assert.deepEqual(ids(board.idle), ['id-old']);
});

test('idle hidden unless toggled', async () => {
  const { bucket, renderHtml } = await load();
  const rows = [agent({ alias: 'old', state: 'idle', state_ts_ms: NOW - 60 * MIN })];
  const hidden = bucket(rows, NOW, false);
  assert.deepEqual(hidden.idle, []);
  assert.doesNotMatch(renderHtml(hidden, OPTS), /id-old/);
  const shown = bucket(rows, NOW, true);
  assert.deepEqual(ids(shown.idle), ['id-old']);
  assert.match(renderHtml(shown, { ...OPTS, showIdle: true }), /id-old/);
});

test('launching counts as working', async () => {
  const { bucket } = await load();
  const board = bucket([agent({ alias: 'boot', state: 'launching' })], NOW, true);
  assert.deepEqual(ids(board.working), ['id-boot']);
  assert.equal(board.needsYou.length + board.done.length + board.idle.length, 0);
});

test('stale goes to idle', async () => {
  const { bucket } = await load();
  const rows = [
    agent({ alias: 'gone', state: 'working', liveness: 'stale' }),
    agent({ alias: 'never', state: 'blocked', liveness: 'never-started' }),
  ];
  const board = bucket(rows, NOW, true);
  assert.deepEqual(ids(board.idle), ['id-gone', 'id-never']);
  assert.equal(board.working.length + board.needsYou.length + board.done.length, 0);
  assert.deepEqual(bucket(rows, NOW, false).idle, []);
});

test('escapes agent strings', async () => {
  const { bucket, escapeHtml, renderHtml } = await load();
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderHtml(
    bucket(
      [
        agent({
          agent_id: `"><script>bad()</script>`,
          alias: evil,
          kind: '<b>k</b>',
          project: `/repos/<p'roj>`,
          workspace: '/repos/proj/.worktrees/<wt&x>',
          unread: 3,
        }),
      ],
      NOW,
      false
    ),
    OPTS
  );
  assert.ok(!html.includes(evil));
  assert.ok(!html.includes('<script>bad()'));
  assert.ok(!html.includes('<b>k</b>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;p&#39;roj&gt;'));
  assert.ok(html.includes('&lt;wt&amp;x&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.match(html, />3</);
  // Only the one nonce'd script tag exists.
  assert.equal(html.match(/<script/g).length, 1);
});

test('csp has nonce and no remote', async () => {
  const { bucket, renderHtml } = await load();
  const html = renderHtml(bucket([agent()], NOW, false), OPTS);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  assert.equal(
    csp,
    "default-src 'none'; style-src vscode-webview://x 'unsafe-inline'; script-src 'nonce-n0nceABC'"
  );
  const scripts = [...html.matchAll(/<script([^>]*)>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attrs] of scripts) assert.match(attrs, /nonce="n0nceABC"/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<(link|img|iframe)\b|@import|\bsrc=/i);
  assert.match(html, /type: "focus", agent_id/);
  assert.match(html, /type: "toggleIdle"/);
});

test('no message bodies', async () => {
  const { bucket, renderHtml } = await load();
  const body = 'SECRET-BODY-should-never-render';
  const row = { ...agent({ alias: 'talker', unread: 2 }), body, subject: 'SUBJ-x', messages: [{ body }] };
  for (const showIdle of [false, true]) {
    const html = renderHtml(bucket([row], NOW, showIdle), { ...OPTS, showIdle });
    assert.ok(html.includes('talker'));
    assert.ok(!html.includes(body));
    assert.ok(!html.includes('SUBJ-x'));
  }
});
