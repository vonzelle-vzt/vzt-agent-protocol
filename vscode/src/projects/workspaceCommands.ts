/**
 * Workspace commands — Orca-style "pick projects → workspace" for VS Code.
 *
 * `workspace.create` writes a `.code-workspace` from ticked projects and opens
 * it; `workspace.editProjects` re-ticks the folders of a window that is already
 * a saved workspace. The file building is in the vscode-free workspaceFile.ts.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildWorkspace, workspaceFilePath, writeWorkspaceFile } from "./workspaceFile";

type Run = <T>(args: string[], cwd?: string) => Promise<T>;

export interface WorkspaceDeps {
  run: Run;
  baseDir: string;
}

interface ProjectRow {
  name: string;
  root: string;
  exists?: boolean;
}

/** Accept both a bare array and `{ projects: [...] }`, whichever the CLI prints. */
function projectRows(out: unknown): ProjectRow[] {
  const arr = Array.isArray(out) ? out : (out as { projects?: unknown } | null)?.projects;
  return Array.isArray(arr) ? (arr as ProjectRow[]) : [];
}

async function existingProjects(run: Run): Promise<ProjectRow[]> {
  const out = await run<unknown>(["projects", "list", "--json"]);
  return projectRows(out).filter((p) => p.exists === true);
}

function readExisting(file: string): unknown {
  try {
    // .code-workspace may carry comments/trailing commas; a failed parse means "start fresh".
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const showError = (err: unknown) =>
  vscode.window.showErrorMessage(`VZT: ${err instanceof Error ? err.message : String(err)}`);

async function createWorkspace(deps: WorkspaceDeps): Promise<void> {
  const projects = await existingProjects(deps.run);
  if (!projects.length) {
    vscode.window.showInformationMessage("VZT: no registered projects — add one or import from Orca first.");
    return;
  }
  const picks = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.root, project: p })),
    { canPickMany: true, placeHolder: "Projects in this workspace" }
  );
  if (!picks?.length) return;
  const name = await vscode.window.showInputBox({
    prompt: "Workspace name",
    value: "Daily Projects",
    validateInput: (v) => {
      try {
        workspaceFilePath(deps.baseDir, v);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (!name) return;

  const file = workspaceFilePath(path.join(deps.baseDir, "workspaces"), name);
  writeWorkspaceFile(file, buildWorkspace(picks.map((p) => p.project), readExisting(file)));

  const OPEN = "Open Here";
  const NEW = "Open in New Window";
  const answer = await vscode.window.showInformationMessage(
    `Workspace written to ${file}. Open now?`,
    OPEN,
    NEW,
    "Later"
  );
  if (answer === OPEN || answer === NEW) {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file), {
      forceNewWindow: answer === NEW,
    });
  }
}

async function editProjects(deps: WorkspaceDeps): Promise<void> {
  // updateWorkspaceFolders in a single-folder window turns it into a workspace and
  // restarts the extension host. Only a window that is already a saved .code-workspace
  // is safe, so refuse everything else.
  const wsFile = vscode.workspace.workspaceFile;
  if (!wsFile || wsFile.scheme !== "file") {
    vscode.window.showInformationMessage(
      "Open a .code-workspace first, or use Create Workspace from Projects"
    );
    return;
  }
  const projects = await existingProjects(deps.run);
  const current = new Set((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath));
  const picks = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.root, picked: current.has(p.root), project: p })),
    { canPickMany: true, placeHolder: "Projects in this workspace" }
  );
  if (!picks) return;
  if (!picks.length) {
    // An empty workspace would restart the extension host and drop its agents.
    vscode.window.showInformationMessage("VZT: keep at least one project in the workspace.");
    return;
  }
  const want = new Set(picks.map((p) => p.project.root));

  // One call: VS Code refuses a second updateWorkspaceFolders before the first
  // has applied. Kept folders stay in order (the first one too, so the
  // extension host keeps running); new ones go at the end.
  const folders = vscode.workspace.workspaceFolders || [];
  const kept = folders.filter((f) => want.has(f.uri.fsPath)).map((f) => ({ uri: f.uri, name: f.name }));
  const keptPaths = new Set(kept.map((f) => f.uri.fsPath));
  const adds = picks
    .filter((p) => !keptPaths.has(p.project.root))
    .map((p) => ({ uri: vscode.Uri.file(p.project.root), name: p.project.name }));
  if (kept.length === folders.length && !adds.length) return;
  if (!vscode.workspace.updateWorkspaceFolders(0, folders.length, ...kept, ...adds)) {
    vscode.window.showErrorMessage("VZT: VS Code refused the folder change — try again.");
  }
}

export function registerWorkspaceCommands(context: vscode.ExtensionContext, deps: WorkspaceDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vzt-mux.workspace.create", () => createWorkspace(deps).catch(showError)),
    vscode.commands.registerCommand("vzt-mux.workspace.editProjects", () => editProjects(deps).catch(showError))
  );
}
