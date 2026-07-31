/**
 * Which dropped files reach the terminal.
 *
 * These are not invented cases. Every path below was copied out of ~/.vzt/paste-image.log,
 * which records each editor tab the extension sees. That log is the whole reason this
 * module exists: it showed one dropped .zip being rejected (the bug) and 37 workspace-file
 * opens that must KEEP being rejected (the reason a wildcard is not the fix).
 *
 * So each case carries its control. The rows expecting null are the ones a permissive
 * regex would have broken, and they are the point of the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyDrop } = require('../vscode-paste-image/classify.js');

// The workspace that was open when the log entries below were recorded.
const WS = ['/Users/vonzellebrown/github-projects'];
const opts = (over = {}) => ({ workspaceFolders: WS, cfg: {}, ...over });

test('the drop that failed: a zip in ~/Downloads is forwarded', () => {
  // 2026-07-31T13:13:24.411Z opened tab label="RProtocolAPI.0.89.0.0.zip"
  //   uri=file:///Users/vonzellebrown/Downloads/RProtocolAPI.0.89.0.0.zip
  // VS Code opened the tab; only the image regex rejected it.
  assert.equal(
    classifyDrop('/Users/vonzellebrown/Downloads/RProtocolAPI.0.89.0.0.zip', opts()),
    'file',
  );
});

test('CONTROL: workspace files opened on purpose are never forwarded', () => {
  // 23 occurrences of the .md, 14 of the .json, across two days of deliberate opens.
  // A wildcard classifier types a path into the terminal on every one of these.
  assert.equal(
    classifyDrop('/Users/vonzellebrown/github-projects/herdr-fleet-vscode-PLAN.md', opts()),
    null,
  );
  assert.equal(
    classifyDrop('/Users/vonzellebrown/github-projects/herdr-api-schema.json', opts()),
    null,
  );
  // Source files are the case that would hurt most, and are not in the log only because
  // the log predates anyone opening one with this extension installed.
  assert.equal(
    classifyDrop('/Users/vonzellebrown/github-projects/vzt-agent-protocol/cli/index.ts', opts()),
    null,
  );
});

test('the one success stays a success: a screenshot is still an image', () => {
  // 2026-07-31T03:31:13.704Z ... viewType=imagePreview.previewEditor -> FORWARDING
  assert.equal(
    classifyDrop(
      '/var/folders/lt/xlk3xk6j6tl_0pjnvg2wcx5c0000gn/T/TemporaryItems/' +
        'NSIRD_screencaptureui_tNz44f/Screenshot 2026-07-29 at 14.17.12.png',
      opts(),
    ),
    'image',
  );
});

test('tier 2: an unlisted type forwards from outside the workspace, not inside', () => {
  assert.equal(classifyDrop('/Users/vonzellebrown/Downloads/notes.md', opts()), 'outside');
  assert.equal(
    classifyDrop('/Users/vonzellebrown/github-projects/notes.md', opts()),
    null,
    'same extension, inside the workspace — this is the whole distinction',
  );
});

test('workspace containment does not match a sibling by prefix', () => {
  // /Users/vonzellebrown/github-projects-scratch must NOT count as inside
  // /Users/vonzellebrown/github-projects. A plain startsWith gets this wrong.
  assert.equal(
    classifyDrop('/Users/vonzellebrown/github-projects-scratch/notes.md', opts()),
    'outside',
  );
});

test('with no folder open, everything is outside — nothing is "your project"', () => {
  assert.equal(
    classifyDrop('/Users/vonzellebrown/anywhere/notes.md', opts({ workspaceFolders: [] })),
    'outside',
  );
});

test('each tier has its own off switch, and they are independent', () => {
  const zip = '/Users/vonzellebrown/Downloads/x.zip';
  const png = '/Users/vonzellebrown/Downloads/x.png';
  const md = '/Users/vonzellebrown/Downloads/x.md';

  assert.equal(classifyDrop(zip, opts({ cfg: { captureDroppedFiles: false } })), null);
  assert.equal(classifyDrop(png, opts({ cfg: { captureDroppedImages: false } })), null);
  assert.equal(
    classifyDrop(md, opts({ cfg: { captureDroppedFilesOutsideWorkspace: false } })),
    null,
  );

  // Turning tier 1 off must not take images or tier 2 with it.
  const noFiles = opts({ cfg: { captureDroppedFiles: false } });
  assert.equal(classifyDrop(png, noFiles), 'image');
  assert.equal(classifyDrop(md, noFiles), 'outside');
});

test('only file:// URIs — a diff or an untitled buffer has no path to forward', () => {
  for (const scheme of ['untitled', 'git', 'vscode-remote', 'output']) {
    assert.equal(
      classifyDrop('/Users/vonzellebrown/Downloads/x.zip', opts({ scheme })),
      null,
      `${scheme}: scheme must be rejected before the extension is ever considered`,
    );
  }
});

test('an extensionless path is not a drop', () => {
  // Directories, dotfiles and scratch buffers all land here. Requiring an extension costs
  // a rare real case and removes a noisy false one.
  assert.equal(classifyDrop('/Users/vonzellebrown/Downloads/README', opts()), null);
  assert.equal(classifyDrop('/Users/vonzellebrown/Downloads/somedir', opts()), null);
});

test('the tier 1 list covers what people actually drag', () => {
  const cases = {
    'a.zip': 'file',
    'a.tar.gz': 'file',
    'a.7z': 'file',
    'a.pdf': 'file',
    'a.docx': 'file',
    'a.xlsx': 'file',
    'a.pptx': 'file',
    'a.csv': 'file',
    'a.mp4': 'file',
    'a.mov': 'file',
    'a.heic': 'file',
    'a.PDF': 'file', // extension matching is case-insensitive
    'a.JPG': 'image',
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(
      classifyDrop(`/Users/vonzellebrown/github-projects/${name}`, opts()),
      expected,
      `${name} — tier 1 and images must classify from INSIDE the workspace too, since ` +
        'the outside-workspace rule is only the fallback for unlisted types',
    );
  }
});

test('bad input is rejected rather than thrown on', () => {
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.equal(classifyDrop(bad, opts()), null);
  }
  // Missing opts entirely — the handler builds them, but a throw here kills the whole
  // onDidChangeTabs listener for the session.
  assert.equal(classifyDrop('/x/y.zip', undefined), 'file');
});
