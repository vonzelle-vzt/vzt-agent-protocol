/**
 * Files view model — one directory listing for the active project's file tree.
 *
 * vscode-free so plain node can test it: the tree provider (filesTree.ts) hands
 * in the `files.exclude` globs it read from the settings.
 */

import * as fs from "fs";
import * as path from "path";

export interface FileEntry {
  name: string;
  path: string;
  /** A real directory — a symlink to one is listed as a file, so a loop never recurses. */
  dir: boolean;
  symlink: boolean;
}

export interface Listing {
  entries: FileEntry[];
  /** The read failed (unreadable, vanished); entries is empty. */
  error?: string;
}

/** Always hidden, whatever files.exclude says. */
const ALWAYS_HIDDEN = new Set([".git"]);

/** A files.exclude glob as a regex over a root-relative, `/`-separated path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "/" && glob.slice(i) === "/**") {
      // `foo/**` hides the folder itself too, as VS Code does.
      re += "(?:/.*)?";
      break;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{" && !inBraces) {
      inBraces = true;
      re += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      re += ")";
    } else if (c === "," && inBraces) re += "|";
    else if (c === "[" && glob.indexOf("]", i + 2) > i) {
      const end = glob.indexOf("]", i + 2);
      const body = glob.slice(i + 1, end);
      re += `[${body[0] === "!" ? "^" + body.slice(1) : body}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return /(?!)/; // a malformed glob hides nothing
  }
}

/** Globs whose files.exclude value is true; `{ when: ... }` entries are skipped. */
export function excludeGlobs(setting: Record<string, unknown> | undefined): RegExp[] {
  return Object.entries(setting || {})
    .filter(([, on]) => on === true)
    .map(([glob]) => globToRegExp(glob));
}

/** List `dir`, folders first, each group sorted case-insensitively. Never throws. */
export function listDir(dir: string, root: string, exclude: RegExp[] = []): Listing {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    if (ALWAYS_HIDDEN.has(d.name)) continue;
    const full = path.join(dir, d.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (exclude.some((re) => re.test(rel))) continue;
    entries.push({ name: d.name, path: full, dir: d.isDirectory(), symlink: d.isSymbolicLink() });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { entries };
}
