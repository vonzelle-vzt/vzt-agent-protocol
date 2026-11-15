/**
 * File rows for the Projects view: each known worktree row holds a Files
 * folder (projectsTree.ts) built from these helpers, and the file context
 * menu (open to the side, reveal, copy path) acts on its rows.
 *
 * 0.14.2 dropped the standalone Files view (`vztFiles`): it sat below the
 * project list, off screen with dozens of projects, and repeated what every
 * worktree row already shows. Folders load lazily, one listing per expand
 * (files.ts); a click opens the file in an editor.
 */

import * as path from "path";
import * as vscode from "vscode";
import { excludeGlobs, FileEntry, listDir } from "./files";

const isEntry = (n: unknown): n is FileEntry =>
  !!n && typeof n === "object" && typeof (n as FileEntry).path === "string" && typeof (n as FileEntry).dir === "boolean";

/** One file or folder row; the Projects view's per-worktree Files node uses it too. */
export function fileTreeItem(entry: FileEntry, id: string): vscode.TreeItem {
  const uri = vscode.Uri.file(entry.path);
  const item = new vscode.TreeItem(uri, entry.dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  // A stable id keeps folders expanded across refreshes.
  item.id = id;
  item.tooltip = entry.path;
  item.contextValue = entry.dir ? "vztFolder" : "vztFile";
  if (!entry.dir) item.command = { command: "vscode.open", title: "Open File", arguments: [uri] };
  return item;
}

/** `dir` listed against `root`'s files.exclude; [] when unreadable. */
export function listFiles(dir: string, root: string): FileEntry[] {
  const exclude = excludeGlobs(vscode.workspace.getConfiguration("files", vscode.Uri.file(root)).get<Record<string, unknown>>("exclude"));
  return listDir(dir, root, exclude).entries;
}

/** The file context menu of the Projects view's Files folders; a row is `{ kind: "file", entry, root }`. */
export function registerFileCommands(context: vscode.ExtensionContext): void {
  const target = (arg: unknown): FileEntry | undefined => {
    const wrapped = arg as { kind?: string; entry?: unknown } | undefined;
    return wrapped?.kind === "file" && isEntry(wrapped.entry) ? wrapped.entry : undefined;
  };
  const rootOf = (arg: unknown): string | undefined => {
    const wrapped = arg as { kind?: string; root?: unknown } | undefined;
    return wrapped?.kind === "file" && typeof wrapped.root === "string" ? wrapped.root : undefined;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.files.openToSide", (arg?: unknown) => {
      const e = target(arg);
      if (e && !e.dir) void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(e.path), vscode.ViewColumn.Beside);
    }),
    vscode.commands.registerCommand("vzt-mux.files.revealInOS", (arg?: unknown) => {
      const e = target(arg);
      if (e) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(e.path));
    }),
    vscode.commands.registerCommand("vzt-mux.files.copyPath", (arg?: unknown) => {
      const e = target(arg);
      if (e) void vscode.env.clipboard.writeText(e.path);
    }),
    vscode.commands.registerCommand("vzt-mux.files.copyRelativePath", (arg?: unknown) => {
      const e = target(arg);
      const root = rootOf(arg);
      if (e && root) void vscode.env.clipboard.writeText(path.relative(root, e.path));
    })
  );
}
