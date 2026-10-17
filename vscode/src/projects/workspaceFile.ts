/**
 * Workspace file builder — picked projects → a `.code-workspace` object, pure, no `vscode` at runtime.
 *
 * Orca lets you tick which projects populate a workspace; this is the file half
 * of that flow. The command half lives in workspaceCommands.ts.
 */

import * as fs from "fs";
import * as path from "path";

export interface WorkspaceFolderEntry {
  name: string;
  path: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/** 57 repos in one window otherwise floods Source Control. */
const DEFAULT_SETTINGS: Record<string, unknown> = { "git.autoRepositoryDetection": "openEditors" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Folders = the picked set in order (deduped by path, first wins). An existing
 * parsed workspace keeps its settings and every other top-level key; only
 * `folders` is replaced.
 */
export function buildWorkspace(
  picked: { name: string; root: string }[],
  existing?: unknown
): { folders: WorkspaceFolderEntry[]; settings: Record<string, unknown> } {
  const seen = new Set<string>();
  const folders: WorkspaceFolderEntry[] = [];
  for (const p of picked) {
    if (seen.has(p.root)) continue;
    seen.add(p.root);
    folders.push({ name: p.name, path: p.root });
  }
  const base = isObject(existing) ? existing : {};
  const settings = isObject(base.settings) ? base.settings : { ...DEFAULT_SETTINGS };
  return { ...base, folders, settings };
}

/** `<baseDir>/<name>.code-workspace`; throws on a name that could escape baseDir or is unwieldy. */
export function workspaceFilePath(baseDir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid workspace name: ${JSON.stringify(name)}`);
  return path.join(baseDir, `${name}.code-workspace`);
}

/** mkdir -p, then write JSON (2-space, trailing newline) via tmp file + rename. */
export function writeWorkspaceFile(file: string, ws: object): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(ws, null, 2) + "\n", { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}
