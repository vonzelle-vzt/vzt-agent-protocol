/**
 * The review loop — Stage 2, and the reason to look at a fleet from VS Code at
 * all rather than from a terminal.
 *
 * A herdr pane has no cursor. Every terminal-based review tool therefore makes
 * you retype `path:line` by hand to tell an agent which line you mean. Here the
 * native diff editor and the Comments API — the same one the GitHub PR
 * extension uses — do it for free, and one command ships the whole batch back
 * into the agent as a single prompt.
 *
 * WHICH DIFF, and why it is not "the agent's":
 *
 *   The build plan says to open "the agent's diff". herdr cannot tell us what
 *   that is. Measured against 0.7.5 on a live five-workspace fleet: every agent
 *   reports `cwd` AND `foreground_cwd` as $HOME, because herdr's `new_cwd` is
 *   $HOME and the agent cd's on its own afterwards. `WorkspaceInfo.worktree`
 *   exists in the schema and would give us `checkout_path`, but it is unset on
 *   every workspace not created as a worktree workspace — all five of them here.
 *
 *   So there is no field to derive a repo from, and inferring one from terminal
 *   scrollback is the kind of guessing this codebase keeps getting burned by.
 *   The diff is THIS WINDOW'S repo — which VS Code already knows exactly — and
 *   the agent is chosen explicitly. Nothing is inferred, so nothing can be
 *   inferred wrong.
 *
 * THE ONE FAILURE THIS SURFACE MUST NOT HAVE is comments landing in a different
 * agent than the one you picked. Targets are `pane_id` throughout, never a
 * label; see HerdrClient.prompt.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { HerdrClient } from "./client";
import type { Agent, FleetModel } from "./model";
import { AgentNode } from "./fleetTree";

/** One line comment, flattened out of the thread it lives in. */
export interface ReviewComment {
  /** Repo-relative, POSIX separators — this string goes to the agent verbatim. */
  file: string;
  /** 1-based, as humans and every `path:line` convention count. 0 = whole file. */
  line: number;
  /** True when the comment was left on the ORIGINAL side of the diff. */
  original: boolean;
  body: string;
  /** The source line the comment is anchored to, when we could read it. */
  context?: string;
}

/**
 * Render the batch as one prompt.
 *
 * Pure, and exported for test: the acceptance check is that comments on two
 * different files arrive as ONE message, which is a property of this string,
 * not of the transport.
 *
 * Grouped by file and sorted by line because that is the order someone reads a
 * diff in, and an agent given comments in click-order has to reconstruct it.
 */
export function formatReview(comments: ReviewComment[], repoName: string): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }

  const files = [...byFile.keys()].sort();
  const total = comments.length;
  const header =
    `Code review on ${repoName} — ${total} comment${total === 1 ? "" : "s"} ` +
    `across ${files.length} file${files.length === 1 ? "" : "s"}.`;

  const blocks = files.map((file) => {
    const lines = byFile
      .get(file)!
      .slice()
      .sort((a, b) => a.line - b.line)
      .map((c) => {
        // `path:line` is the form every tool and every agent already parses.
        // A file-level comment has no line, and emitting `path:0` would be a
        // reference that resolves nowhere.
        const at = c.line > 0 ? `${c.file}:${c.line}` : `${c.file} (whole file)`;
        const where = `${at}${c.original ? " (original side)" : ""}`;
        // The anchored source line goes in so the agent does not have to re-read
        // the file to know what "this" refers to.
        const context = c.context ? `\n    > ${c.context.trim()}` : "";
        return `  ${where}${context}\n    ${c.body.trim().split("\n").join("\n    ")}`;
      });
    return `${file}\n${lines.join("\n\n")}`;
  });

  return [header, "", ...blocks, "", "Please address these."].join("\n");
}

/** The Git extension's API, narrowed to the two things we use. */
interface GitAPI {
  repositories: {
    rootUri: vscode.Uri;
    state: { workingTreeChanges: { uri: vscode.Uri }[]; indexChanges: { uri: vscode.Uri }[] };
  }[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

function gitApi(): GitAPI | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>("vscode.git");
  return ext?.isActive ? ext.exports.getAPI(1) : undefined;
}

/**
 * A `git:` URI carries the real file path in `.path`, so both sides of a diff
 * normalise to the same repo-relative string. Without this, a comment on the
 * original side would be filed under a path the agent cannot open.
 */
function repoRelative(uri: vscode.Uri, root: vscode.Uri): { file: string; original: boolean } {
  const original = uri.scheme === "git";
  const abs = original ? uri.with({ scheme: "file", query: "" }).fsPath : uri.fsPath;
  return { file: path.relative(root.fsPath, abs).split(path.sep).join("/"), original };
}

export function registerHerdrReview(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  model: FleetModel,
  client: HerdrClient
): void {
  const controller = vscode.comments.createCommentController("vzt-mux.herdr.review", "Herdr Review");
  context.subscriptions.push(controller);

  // Comment anywhere in a file that belongs to an open repo. Narrower rules
  // (changed lines only) need the hunk ranges, and a range provider that is
  // wrong just makes the gutter "+" silently not appear on the line you want.
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (document.uri.scheme !== "file" && document.uri.scheme !== "git") {
        return [];
      }
      const api = gitApi();
      const root = api?.repositories[0]?.rootUri;
      if (!root) {
        return [];
      }
      const { file } = repoRelative(document.uri, root);
      if (file.startsWith("..")) {
        return []; // outside the repo
      }
      return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
    },
  };

  // The controller does not expose its threads, so we hold them ourselves. This
  // Set IS the review — everything sent is read out of here.
  const threads = new Set<vscode.CommentThread>();

  const collect = async (): Promise<ReviewComment[]> => {
    const api = gitApi();
    const root = api?.repositories[0]?.rootUri;
    const out: ReviewComment[] = [];
    for (const thread of threads) {
      const { file, original } = root
        ? repoRelative(thread.uri, root)
        : { file: thread.uri.fsPath, original: thread.uri.scheme === "git" };
      // A thread's range can drift as the file is edited; VS Code keeps it
      // current, so read it at send time rather than at creation time. It is
      // also optional — a file-level thread has none — which we render as line
      // 0 rather than guessing line 1, because "the whole file" and "the first
      // line" are different review comments.
      const range = thread.range;
      const line = range ? range.start.line + 1 : 0;
      let contextLine: string | undefined;
      if (range) {
        try {
          const doc = await vscode.workspace.openTextDocument(thread.uri);
          contextLine = doc.lineAt(range.start.line).text;
        } catch {
          /* the file may be gone or binary — the comment still stands alone */
        }
      }
      for (const comment of thread.comments) {
        const body = typeof comment.body === "string" ? comment.body : comment.body.value;
        if (body.trim()) {
          out.push({ file, line, original, body, context: contextLine });
        }
      }
    }
    return out;
  };

  const disposeAll = () => {
    for (const t of threads) {
      t.dispose();
    }
    threads.clear();
  };
  context.subscriptions.push({ dispose: disposeAll });

  context.subscriptions.push(
    // --- open the diff ------------------------------------------------------
    vscode.commands.registerCommand("vzt-mux.herdr.reviewChanges", async () => {
      const api = gitApi();
      const repo = api?.repositories[0];
      if (!repo) {
        void vscode.window.showWarningMessage(
          "Herdr Review: no git repository open in this window. The diff comes from this window's repo, not from the agent."
        );
        return;
      }
      // Staged and unstaged both — an agent's work is often half-staged, and a
      // review that silently skips the staged half reviews the wrong thing.
      const seen = new Set<string>();
      const changes = [...repo.state.workingTreeChanges, ...repo.state.indexChanges].filter((c) => {
        if (seen.has(c.uri.fsPath)) return false;
        seen.add(c.uri.fsPath);
        return true;
      });
      if (changes.length === 0) {
        void vscode.window.showInformationMessage("Herdr Review: no changes in the working tree.");
        return;
      }
      for (const change of changes) {
        await vscode.commands.executeCommand(
          "vscode.diff",
          api!.toGitUri(change.uri, "HEAD"),
          change.uri,
          `${path.basename(change.uri.fsPath)} (working tree)`,
          { preview: false, preserveFocus: true }
        );
      }
      log.appendLine(`[herdr] review: opened ${changes.length} diff(s) from ${repo.rootUri.fsPath}`);
    }),

    // --- leave a comment ----------------------------------------------------
    vscode.commands.registerCommand("vzt-mux.herdr.addComment", (reply: vscode.CommentReply) => {
      const thread = reply.thread;
      thread.comments = [
        ...thread.comments,
        {
          body: new vscode.MarkdownString(reply.text),
          mode: vscode.CommentMode.Preview,
          author: { name: "You" },
        },
      ];
      thread.label = "Herdr review";
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      threads.add(thread);
    }),

    vscode.commands.registerCommand("vzt-mux.herdr.deleteThread", (thread: vscode.CommentThread) => {
      threads.delete(thread);
      thread.dispose();
    }),

    vscode.commands.registerCommand("vzt-mux.herdr.discardReview", async () => {
      const n = threads.size;
      disposeAll();
      void vscode.window.showInformationMessage(`Herdr Review: discarded ${n} thread(s).`);
    }),

    // --- send ---------------------------------------------------------------
    vscode.commands.registerCommand("vzt-mux.herdr.sendReview", async (node?: AgentNode) => {
      const comments = await collect();
      if (comments.length === 0) {
        void vscode.window.showWarningMessage(
          "Herdr Review: no comments to send. Click the + in the diff gutter to leave one."
        );
        return;
      }

      // Target is a pane_id, always. From the tree node when invoked from its
      // context menu; otherwise picked explicitly. There is deliberately no
      // "the obvious agent" fallback — sending a review to a guess is the one
      // failure this surface must not have.
      let agent: Agent | undefined = node?.agent;
      if (!agent) {
        const running = model.getAgents();
        if (running.length === 0) {
          void vscode.window.showWarningMessage("Herdr Review: no agents running to send to.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          running.map((a) => ({
            label: `${a.agent} · ${a.agent_status}`,
            description: a.terminal_title_stripped ?? a.pane_id,
            detail: a.pane_id,
            agent: a,
          })),
          { title: `Send ${comments.length} review comment(s) to which agent?`, matchOnDetail: true }
        );
        agent = picked?.agent;
      }
      if (!agent) {
        return; // cancelled — say nothing, send nothing
      }

      const api = gitApi();
      const repoName = api?.repositories[0] ? path.basename(api.repositories[0].rootUri.fsPath) : "this repo";
      const text = formatReview(comments, repoName);

      try {
        // ONE prompt for the whole batch. Per-file sends would arrive as
        // separate turns and the agent would start acting on file 1 while
        // file 2 was still in flight.
        await client.prompt(agent.pane_id, text);
        log.appendLine(
          `[herdr] review: sent ${comments.length} comment(s) to ${agent.agent} on ${agent.pane_id}`
        );
        disposeAll();
        void vscode.window.showInformationMessage(
          `Herdr Review: sent ${comments.length} comment(s) to ${agent.agent} (${agent.pane_id}).`
        );
      } catch (err) {
        // Keep the threads. Losing a written review to a transport error would
        // be unforgivable, and a retry is one click away.
        void vscode.window.showErrorMessage(`Herdr Review: send failed — ${err}. Your comments were kept.`);
      }
    })
  );
}
