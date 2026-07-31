/**
 * VZT: Paste & Drop Files into Terminal
 *
 * WHY THIS EXISTS
 * Claude Code on macOS reads the clipboard directly via AppleScript (its binary carries
 * `the clipboard as «class PNGf»`), which is why Ctrl+V attaches a screenshot in
 * Terminal.app and iTerm2. The VS Code integrated terminal never delivers that keystroke
 * to the running TUI, so the paste is simply lost.
 *
 * We do NOT need to bridge clipboard bytes. Claude Code reads image *paths* natively, so
 * we stage the clipboard image to a file (`vzt-shot`, which already does exactly this for
 * Herdr) and type the path into the terminal. Same trick, different injection backend.
 *
 * AND THAT IS WHY IT GENERALISES.
 * Nothing in the transport is image-specific — a path is a path, and the agent opens it
 * itself. Zips, PDFs, spreadsheets and docs ride the exact same wire. Measured: dropping
 * `RProtocolAPI.0.89.0.0.zip` DID open a tab with a usable file:// uri; the only thing
 * that rejected it was an image-shaped regex. See classify.js for what replaced it.
 *
 * THE FALL-THROUGH IS LOAD-BEARING.
 * This binds Cmd+V, the only paste key in the terminal. Every path that is not "we
 * successfully staged an image" MUST end in workbench.action.terminal.paste, or normal
 * text pasting breaks. Stated as the repo's guard rule:
 *
 *   This guard blocks normal paste. It clears when the clipboard has no image. That can
 *   happen without this extension ever succeeding, because the check is a plain
 *   clipboard read plus a `vzt-shot` exit code — neither depends on us.
 *
 * So: text present -> paste immediately (fast path, never even spawns a process).
 *     no terminal / no image / non-zero exit / timeout / thrown -> paste.
 *     staged image -> sendText(path).
 */
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyDrop } = require('./classify');

// Diagnostic trace. Cheap, append-only, never throws. Exists because the tab-capture
// path is invisible from VS Code's own logs — when a drop "does nothing" there is
// otherwise no way to tell whether the event never fired, the tab shape was different
// than expected, or a guard rejected it.
const LOG = path.join(os.homedir(), '.vzt', 'paste-image.log');
function trace(...parts) {
  try {
    const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
    fs.appendFileSync(LOG, line);
  } catch {
    /* logging must never break the feature */
  }
}

const VZT_SHOT = path.join(os.homedir(), '.local', 'bin', 'vzt-shot');
const STAGE_TIMEOUT_MS = 10_000;

/**
 * Stage the clipboard image to disk and return its absolute path, or null.
 * Never rejects — the caller's fallback must not depend on catching.
 */
function stageClipboardImage() {
  return new Promise((resolve) => {
    try {
      // vzt-shot prepends Homebrew to PATH itself, which matters here: the extension
      // host is started by the macOS GUI and does not inherit a login shell PATH, so
      // /opt/homebrew/bin (and therefore pngpaste) would otherwise be invisible.
      execFile(
        VZT_SHOT,
        ['--print', '--clipboard-only'],
        { timeout: STAGE_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve(null); // non-zero exit == no image on the clipboard
          const p = String(stdout || '').trim();
          resolve(p || null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The path of a file copied in Finder (Cmd+C), or null.
 *
 * ⚠️ THE existsSync IS NOT DEFENSIVE, IT IS THE TEST.
 * `the clipboard as «class furl»` does not fail when the clipboard holds text — AppleScript
 * coerces the text into a path and exits 0. Measured with ordinary text on the clipboard:
 *
 *   $ osascript -e 'POSIX path of (the clipboard as «class furl»)'
 *   /tradetech-commissions-sync (links leg)          exit=0
 *
 * So the exit code proves nothing. Existence on disk is the only real signal, and without
 * it this branch would swallow half the ordinary pastes in the terminal.
 *
 * Only the first file of a multi-file copy comes back — `«class furl»` is singular. Drops
 * do not have this limit (N files open N tabs), so the workaround is to drag instead.
 *
 * Never rejects: the caller's fall-through must not depend on catching.
 */
function clipboardFilePath() {
  return new Promise((resolve) => {
    try {
      execFile(
        '/usr/bin/osascript',
        ['-e', 'POSIX path of (the clipboard as «class furl»)'],
        { timeout: STAGE_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = String(stdout || '').trim();
          if (!p) return resolve(null);
          try {
            // Directories count. `claude` reading a folder path is a legitimate ask.
            resolve(fs.existsSync(p) ? p : null);
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function normalPaste() {
  await vscode.commands.executeCommand('workbench.action.terminal.paste');
}

/**
 * DRAG-AND-DROP SUPPORT.
 *
 * VS Code's terminal DOES accept file drops natively (onDropFile -> sendPath), but only
 * when the drop lands on the terminal's own text area. Its split overlay is gated on
 * dragging *Terminals*, not files, so a file drop never splits the terminal — which means
 * a drop that "opens a new pane" actually missed the terminal and hit the editor region.
 * That region is most of the window, so missing is the common case, not the exception.
 *
 * So we let the miss happen and catch it: when a file opens as an editor tab, forward its
 * path to the terminal and close the tab. The drop target becomes the whole editor area
 * instead of a thin strip.
 *
 * Cost, stated plainly: this also fires when you open a file deliberately. Three brakes —
 * it only acts when a terminal actually exists, `classifyDrop` decides which files are
 * plausible drops at all (that is the whole guard; read classify.js before widening it),
 * and each tier has its own `vzt.pasteImage.*` switch.
 */
function uriFromTab(tab) {
  const input = tab && tab.input;
  if (!input || typeof input !== 'object') return null;
  return input.uri || null; // TabInputCustom (image preview) and TabInputText both carry .uri
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

// Escape spaces the way a shell expects. Verified: Claude Code ingests
// `/path/Screenshot\ 2026-07-24\ at\ 16.40.27.png` as an image, so a Desktop screenshot
// with a space-laden name survives the trip. Sending it raw would not.
function escapeForPrompt(fsPath) {
  return fsPath.replace(/([ "'\\])/g, '\\$1');
}

/**
 * Is this path somewhere the OS is entitled to delete out from under us?
 *
 * Dragging the macOS screenshot thumbnail yields a path under
 * `TemporaryItems/NSIRD_screencaptureui_XXXX` — observed live, and it does not survive.
 * A path we forward has to still be there when the agent gets around to reading it.
 */
function isVolatilePath(fsPath) {
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(fsPath);
  return resolved.startsWith(tmp + path.sep) || resolved.includes('/TemporaryItems/');
}

/**
 * Copy a dropped file into ~/.vzt/shots (images) or ~/.vzt/drops (everything else) under a
 * space-free name, and return the new path.
 *
 * Images are ALWAYS copied: their source is the volatile screenshot temp dir above, and a
 * copy with no spaces in the name removes the quoting question entirely. It also makes a
 * drop land in exactly the same place as a Cmd+V, so both routes behave identically.
 */
function stageDroppedFile(fsPath, kind) {
  const dir = path.join(os.homedir(), '.vzt', kind === 'image' ? 'shots' : 'drops');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = (path.extname(fsPath) || (kind === 'image' ? '.png' : '')).toLowerCase();
  const dest = path.join(dir, `drop-${stamp}${ext}`);
  fs.copyFileSync(fsPath, dest);
  return dest;
}

/**
 * Where should the terminal be pointed — the original path, or a copy?
 *
 * Non-images are NOT copied. `copyFileSync` is synchronous and this runs on the extension
 * host: duplicating a 2 GB zip would freeze the whole window, to solve a problem a zip in
 * ~/Downloads does not have. Its path is stable, and escapeForPrompt already handles the
 * spaces. Copy only when the source is genuinely volatile — which for images is always.
 */
function resolveSendPath(fsPath, kind) {
  if (kind !== 'image' && !isVolatilePath(fsPath)) return fsPath;
  try {
    return stageDroppedFile(fsPath, kind);
  } catch (err) {
    trace('  STAGE FAILED, using original path:', err && err.message);
    return fsPath;
  }
}

/**
 * Which terminal gets the path.
 *
 * `activeTerminal` goes null the moment focus leaves the panel — and dragging a file is
 * exactly that: you grab it in Finder, the VS Code window loses focus, you drop on the
 * editor. So at the instant we need it, the one reliable-looking answer is often gone, and
 * the old fallback was `terminals[0]` — creation order, not intent.
 *
 * Observed: four terminals open, the user working in "BlackOps Trading", the screenshot
 * typed into "Tradescriptai" because it happened to be created first. The path was
 * delivered, to a session nobody was looking at, which reads as the feature not working.
 *
 * So remember the last terminal that WAS active and prefer it. Creation order is kept only
 * as the final resort, for the case where no terminal has ever been focused this session.
 */
let lastActiveTerminal = null;

function registerTerminalTracking(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((term) => {
      // Ignore the null edge — that IS focus leaving, and forgetting on it defeats the point.
      if (term) lastActiveTerminal = term;
    }),
    vscode.window.onDidCloseTerminal((term) => {
      if (term === lastActiveTerminal) lastActiveTerminal = null;
    }),
  );
  lastActiveTerminal = vscode.window.activeTerminal || null;
}

function targetTerminal() {
  const open = vscode.window.terminals || [];
  const active = vscode.window.activeTerminal;
  if (active) return { term: active, why: 'active' };
  // A closed terminal can linger in the variable if the close event was missed.
  if (lastActiveTerminal && open.includes(lastActiveTerminal)) {
    return { term: lastActiveTerminal, why: 'last-active' };
  }
  return { term: open[0] || null, why: 'first-open' };
}

// Guards against the same drop being forwarded twice. VS Code reports one tab as BOTH
// `opened` and `changed` roughly 1ms apart, which typed the path in twice.
const recentlyForwarded = new Map();
function alreadyForwarded(key) {
  const now = Date.now();
  for (const [k, t] of recentlyForwarded) if (now - t > 5000) recentlyForwarded.delete(k);
  if (recentlyForwarded.has(key)) return true;
  recentlyForwarded.set(key, now);
  return false;
}

// The 5s window above is sized for the opened/changed pair, not for the life of a tab. A
// long-lived tab keeps emitting `changed`: the log shows one PLAN.md re-notifying at 04:10,
// 04:50, 04:56 and 05:06. Anything we have already forwarded stays suppressed until its tab
// actually closes, so a file left open cannot re-inject itself an hour later.
const forwardedWhileOpen = new Set();
function releaseClosedTabs(closed) {
  for (const tab of closed || []) {
    const uri = uriFromTab(tab);
    if (uri) forwardedWhileOpen.delete(uri.fsPath);
  }
}

function registerDroppedTabCapture(context) {
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(async (e) => {
      try {
        const groups = [
          ['opened', e.opened || []],
          ['changed', e.changed || []],
        ];
        trace(
          'onDidChangeTabs',
          `opened=${(e.opened || []).length}`,
          `changed=${(e.changed || []).length}`,
          `closed=${(e.closed || []).length}`,
        );
        for (const [kind, list] of groups) {
          for (const t of list) {
            const inp = t && t.input;
            if (!inp || !inp.uri) continue; // skip the constant churn from session tabs
            trace(
              `  ${kind} tab`,
              `label=${JSON.stringify(t && t.label)}`,
              `inputCtor=${inp && inp.constructor && inp.constructor.name}`,
              `keys=${inp ? JSON.stringify(Object.keys(inp)) : 'null'}`,
              `uri=${inp && inp.uri ? inp.uri.scheme + '://' + inp.uri.fsPath : 'none'}`,
              `viewType=${(inp && inp.viewType) || 'n/a'}`,
            );
          }
        }

        // Do this before any early return: a tab that closes must be released even when
        // capture is switched off, or turning the setting back on finds a stale suppression.
        releaseClosedTabs(e.closed);

        const wsCfg = vscode.workspace.getConfiguration('vzt.pasteImage');
        const cfg = {
          captureDroppedImages: wsCfg.get('captureDroppedImages', true),
          captureDroppedFiles: wsCfg.get('captureDroppedFiles', true),
          captureDroppedFilesOutsideWorkspace: wsCfg.get(
            'captureDroppedFilesOutsideWorkspace',
            true,
          ),
        };
        const folders = workspaceFolderPaths();

        // Consider changed tabs too: a preview tab that gets reused reports as `changed`,
        // not `opened`, so an opened-only scan can miss a drop entirely.
        for (const tab of [...(e.opened || []), ...(e.changed || [])]) {
          const uri = uriFromTab(tab);
          if (!uri) continue;

          const kind = classifyDrop(uri.fsPath, {
            workspaceFolders: folders,
            cfg,
            scheme: uri.scheme,
          });
          if (!kind) continue;

          if (alreadyForwarded(uri.fsPath) || forwardedWhileOpen.has(uri.fsPath)) {
            trace('  SKIP: duplicate event for', uri.fsPath);
            continue;
          }

          // No terminal means no one is waiting for this path — leave the file alone
          // so ordinary viewing still works when you are not in a session.
          const { term, why } = targetTerminal();
          if (!term) {
            trace('  SKIP:', kind, 'tab but NO terminal open ->', uri.fsPath);
            continue;
          }

          const staged = resolveSendPath(uri.fsPath, kind);
          forwardedWhileOpen.add(uri.fsPath);

          trace(
            '  FORWARDING',
            `[${kind}]`,
            '->',
            staged,
            '| terminal =',
            JSON.stringify(term.name),
            `(via ${why})`,
            '| active =',
            JSON.stringify(vscode.window.activeTerminal && vscode.window.activeTerminal.name),
            '| lastActive =',
            JSON.stringify(lastActiveTerminal && lastActiveTerminal.name),
            '| all =',
            JSON.stringify((vscode.window.terminals || []).map((t) => t.name)),
          );
          // Focus the terminal instead of preserving focus. When the path landed in a
          // session you were not looking at, the drop read as "nothing happened" — that
          // is exactly how this failed. Taking you to the target makes it self-evident.
          term.show(false);
          term.sendText(escapeForPrompt(staged) + ' ', false);
          try {
            await vscode.window.tabGroups.close(tab, false);
            trace('  tab closed');
          } catch (err) {
            trace('  tab close failed (path already delivered):', err && err.message);
          }
        }
      } catch (err) {
        trace('  HANDLER THREW:', (err && err.stack) || err);
      }
    }),
  );
}

function activate(context) {
  trace('=== activate() v1.3.1 | terminals =', (vscode.window.terminals || []).length);
  registerTerminalTracking(context);
  registerDroppedTabCapture(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('vzt.pasteImage', async () => {
      try {
        const term = vscode.window.activeTerminal;
        if (!term) return await normalPaste();

        // Fast path: if the clipboard carries text, this is an ordinary paste. Bail out
        // before spawning anything. This keeps the overwhelmingly common case both
        // byte-identical and latency-identical to stock VS Code, which is the whole
        // safety argument for binding Cmd+V at all.
        let text = '';
        try {
          text = await vscode.env.clipboard.readText();
        } catch {
          text = '';
        }
        if (text && text.length > 0) return await normalPaste();

        // A file copied in Finder puts no text on the pasteboard, so we only get here for
        // it — which is what keeps the fast path above untouched. Ordered before the image
        // check because a copied .png is a file, and its real path beats a fresh copy.
        if (vscode.workspace.getConfiguration('vzt.pasteImage').get('pasteClipboardFiles', true)) {
          const filePath = await clipboardFilePath();
          if (filePath) return term.sendText(escapeForPrompt(filePath) + ' ', false);
        }

        const imagePath = await stageClipboardImage();
        if (!imagePath) return await normalPaste();

        // Trailing space, and NO newline: you add your question before submitting.
        // Mirrors vzt-shot's deliberate send-text behaviour under Herdr.
        term.sendText(imagePath + ' ', false);
      } catch {
        try {
          await normalPaste();
        } catch {
          /* nothing left to do; never let this throw into the keybinding */
        }
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
