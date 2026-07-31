/**
 * Which dropped files get forwarded to the terminal, and which are left alone.
 *
 * WHY THIS IS A SEPARATE, VSCODE-FREE MODULE
 * The drop path is caught from `tabGroups.onDidChangeTabs`, which fires for EVERY editor
 * tab — a dropped file and a file you opened on purpose are the same event. There is no
 * API that tells them apart, so the whole feature rests on this guess. A guess that cannot
 * be tested is a guess that drifts, and the failure mode is loud: a stray path typed into
 * a live agent session. So the decision lives here, importing nothing, and is pinned by
 * `test/paste-image-classify.test.mjs` against real entries from ~/.vzt/paste-image.log.
 *
 * THE THREE TIERS, AND WHY THE MIDDLE ONE IS A LIST AND NOT A WILDCARD
 * `~/.vzt/paste-image.log` recorded 23 `.md` and 14 `.json` tab events over two days — all
 * of them files opened deliberately from the workspace. A permissive `/./` would have typed
 * a path into the terminal on every one. So:
 *
 *   image   — unchanged behaviour, staged to ~/.vzt/shots (the source is a volatile temp path)
 *   file    — types VS Code cannot usefully edit, so opening one is ~always a missed drop
 *   outside — anything else, but ONLY from outside the workspace: ~/Downloads/notes.md is a
 *             drop, <repo>/PLAN.md is you working. This is the escape hatch that keeps the
 *             `file` list from having to be exhaustive.
 */
const path = require('path');

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Tier 1. The test is not "is it binary" but "would you ever open this in VS Code on
// purpose?" — a .zip fails that test, a .json passes it, which is why .json is absent.
const FILE_RE = new RegExp(
  '\\.(' +
    // archives
    'zip|tar|gz|tgz|bz2|xz|7z|rar|' +
    // documents
    'pdf|docx?|xlsx?|pptx?|rtf|odt|ods|odp|epub|pages|numbers|key|' +
    // tabular data (dropped to be analysed, never edited here)
    'csv|tsv|' +
    // media
    'mp3|wav|m4a|aac|flac|mp4|mov|m4v|avi|mkv|webm|heic|heif|tiff?|psd|ai|sketch' +
    ')$',
  'i',
);

/**
 * Is `fsPath` inside one of the open workspace folders?
 *
 * Mirrors `ownsWorkspace` in vscode/src/extension.ts:51 — resolve both sides and compare
 * with a trailing separator, so `/foo` does not match `/foobar`. A naive startsWith here
 * would silently widen tier 2 to sibling directories.
 */
function isInsideWorkspace(fsPath, workspaceFolders) {
  if (!workspaceFolders || workspaceFolders.length === 0) return false;
  const target = path.resolve(fsPath);
  return workspaceFolders.some((folder) => {
    if (!folder) return false;
    const dir = path.resolve(folder);
    return target === dir || target.startsWith(dir + path.sep);
  });
}

/**
 * @param {string} fsPath      absolute path from the tab's uri
 * @param {object} opts
 * @param {string[]} opts.workspaceFolders  fsPaths of vscode.workspace.workspaceFolders
 * @param {object} opts.cfg    { captureDroppedImages, captureDroppedFiles,
 *                               captureDroppedFilesOutsideWorkspace } — all default true
 * @param {string} [opts.scheme='file']     the uri scheme
 * @returns {'image'|'file'|'outside'|null}
 */
function classifyDrop(fsPath, opts) {
  const { workspaceFolders = [], cfg = {}, scheme = 'file' } = opts || {};
  if (!fsPath || typeof fsPath !== 'string') return null;

  // Only real files on disk. `untitled:`, `git:`, `vscode-remote:` and friends have no path
  // the agent could read, and a diff view would otherwise forward its left-hand side.
  if (scheme !== 'file') return null;

  const on = (key) => cfg[key] !== false; // absent means on; only an explicit false disables

  if (IMAGE_RE.test(fsPath)) return on('captureDroppedImages') ? 'image' : null;
  if (FILE_RE.test(fsPath)) return on('captureDroppedFiles') ? 'file' : null;

  if (!on('captureDroppedFilesOutsideWorkspace')) return null;
  if (isInsideWorkspace(fsPath, workspaceFolders)) return null;

  // No extension at all is far more often a directory, a dotfile, or an editor scratch
  // buffer than a deliberate drop. Requiring one costs a rare case and removes a noisy one.
  if (!path.extname(fsPath)) return null;

  return 'outside';
}

module.exports = { classifyDrop, isInsideWorkspace, IMAGE_RE, FILE_RE };
