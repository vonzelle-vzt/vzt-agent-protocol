/**
 * Files view (`vztFiles`) — the active project's file tree, under Projects.
 *
 * Follows the project swap: a project row click makes it active (bus/registry.ts
 * showProject) and this view re-roots there, so its files are one glance away
 * without the Explorer — which shows only the window's workspace folders, not
 * the active project. Without an active project it shows the first workspace
 * folder. Folders load lazily, one listing per expand (files.ts); a click
 * opens the file in an editor.
 */

import * as path from "path";
import * as vscode from "vscode";
import { excludeGlobs, FileEntry, listDir } from "./files";

export interface FilesDeps {
  activeProject(): string | undefined;
}

export interface FilesApi {
  setRoot(root: string | undefined): void;
}

const REFRESH_MS = 300;
/** A build that never stops writing still redraws this often. */
const MAX_WAIT_MS = 2_000;

type Node = FileEntry | { kind: "empty"; text: string };

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

class FilesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  root: string | undefined;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!this.root) return [{ kind: "empty", text: "Click a project to see its files" }];
    if (node && (!isEntry(node) || !node.dir)) return [];
    const exclude = excludeGlobs(vscode.workspace.getConfiguration("files", vscode.Uri.file(this.root)).get<Record<string, unknown>>("exclude"));
    const listing = listDir(node ? node.path : this.root, this.root, exclude);
    if (listing.error) return node ? [] : [{ kind: "empty", text: `Cannot read ${this.root}: ${listing.error}` }];
    return listing.entries;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (!isEntry(node)) {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    return fileTreeItem(node, node.path);
  }
}

export function registerFiles(context: vscode.ExtensionContext, deps: FilesDeps): FilesApi {
  const provider = new FilesTreeProvider();
  const view = vscode.window.createTreeView("vztFiles", { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(view);

  let watcher: vscode.FileSystemWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstEvent = 0;
  const refreshSoon = (uri?: vscode.Uri) => {
    // Git churn would redraw the tree on every fetch.
    if (uri && /[\\/]\.git([\\/]|$)/.test(uri.fsPath)) return;
    if (timer) clearTimeout(timer);
    const now = Date.now();
    if (!firstEvent) firstEvent = now;
    timer = setTimeout(() => {
      firstEvent = 0;
      provider.refresh();
    }, Math.max(0, Math.min(REFRESH_MS, firstEvent + MAX_WAIT_MS - now)));
  };

  function setRoot(root: string | undefined): void {
    const next = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (next === provider.root) return;
    provider.root = next;
    view.description = next ? path.basename(next) : undefined;
    watcher?.dispose();
    watcher = undefined;
    if (next) {
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(next), "**/*"));
      watcher.onDidCreate(refreshSoon);
      watcher.onDidDelete(refreshSoon);
    }
    provider.refresh();
  }

  // A row of this view is a FileEntry; a row under a Projects worktree wraps one with its root.
  const target = (arg: unknown): FileEntry | undefined => {
    const wrapped = arg as { kind?: string; entry?: unknown } | undefined;
    if (wrapped?.kind === "file" && isEntry(wrapped.entry)) return wrapped.entry;
    return isEntry(arg) ? arg : undefined;
  };
  const rootOf = (arg: unknown): string | undefined => {
    const wrapped = arg as { kind?: string; root?: unknown } | undefined;
    return wrapped?.kind === "file" && typeof wrapped.root === "string" ? wrapped.root : provider.root;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.files.refresh", () => provider.refresh()),
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
    }),
    // Without an active project the root is the first workspace folder; follow it.
    vscode.workspace.onDidChangeWorkspaceFolders(() => setRoot(deps.activeProject())),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration("files.exclude")) provider.refresh();
    }),
    {
      dispose: () => {
        if (timer) clearTimeout(timer);
        watcher?.dispose();
      },
    }
  );

  setRoot(deps.activeProject());
  return { setRoot };
}
