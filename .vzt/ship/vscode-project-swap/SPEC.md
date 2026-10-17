# SPEC — vscode-project-swap (vzt-mux 0.10.0)

## Why
User, 2026-10-17: "orca opens a terminal separately for each [project] … if i go
to a new project in the workspace it has its own terminal … i can go back to
project 1 terminal to work any time". Today every agent's terminal lands in the
one window's terminal panel, mixed across projects. And the + on a project row
starts "New Agent Workspace" (worktree name → kind → task), so clicking + and
dismissing the first box starts nothing ("i see the + but its not opening claude
or codex").

User decisions (2026-10-17): **tmux-backed swap in ONE window** (supersedes the
earlier window-per-project default; "Open Project Window" stays as a menu item),
and **project + = pick Claude/Codex/Terminal and start now** in the project's
main checkout.

## Contract
1. **Agents live in tmux, VS Code terminals are attach clients.**
   - Private server: `tmux -L vzt-mux -f ~/.vzt/mux/tmux.conf` — never the user's
     default tmux server. The extension (re)writes that conf on activation:
     `mouse on`, `status off`, `history-limit 50000`, `escape-time 0`,
     `default-terminal "tmux-256color"`, `window-size latest`,
     `set-clipboard on`, and copy-mode `MouseDragEnd1Pane` →
     `copy-pipe-and-cancel pbcopy` (macOS).
   - One session per agent: `vzt-<agent_id>`; one per plain terminal:
     `vzt-sh-<random>`. Created with `new-session -d -s <name> -c <cwd>
     -e K=V …` (the same env spawn.ts sets today) running the default login
     shell; the agent command (same words as today, from `bus argv` /
     `bus bootstrap-prompt`, shell-quoted exactly as now) is typed with
     `send-keys -l` + `Enter`, so an exited agent leaves a shell prompt, as now.
   - The VS Code terminal is `createTerminal({ name, shellPath: <tmux>,
     shellArgs: ["-L","vzt-mux","attach-session","-t",<name>], location? })`.
   - `src/bus/tmux.ts` holds every tmux call, vscode-free at runtime (an
     injected `exec(file, args) → Promise<{stdout}>`), so tests drive it with a
     fake exec. No other file builds a tmux argv.
2. **Registry entries outlive their terminal.** `RegistryEntry` gains
   `session?: string` and `terminal` becomes optional (undefined = detached).
   Lease uses the tmux pane pid (`display-message -p -t <s> '#{pane_pid}'`) for
   tmux entries, the terminal pid for legacy ones. Wake typing goes through a
   `TextSink` backed by `tmux send-keys -l` (for `"\r"` send `Enter`) so a
   detached agent is still woken; wake.ts itself does not change.
3. **Active project = one terminal set.** The window holds `activeProject`
   (the bus `project` root; persisted in workspaceState). `showProject(root)`:
   - disposes the attach terminals of every entry (agent or shell) of other
     projects — marked as swap-initiated so the close handler does NOT kill
     their sessions;
   - attaches every entry of `root` that has no terminal, one split group per
     worktree (first entry's terminal is the parent, the rest
     `location: { parentTerminal }`), and shows the lead terminal;
   - reveals the project's folder in the Explorer when it is a workspace folder
     (`revealInExplorer`), never changes workspace folders.
   An entry's project = `git rev-parse --git-common-dir`'s main checkout of its
   cwd (same rule as the bus); cache it on the entry.
4. **Closing.** A terminal the user closes (exit reason User) kills its tmux
   session (Orca: closing a tab ends it) and forgets the entry. A session that
   ended by itself (the shell exited → attach exits, reason Process) forgets the
   entry. Shutdown keeps everything (sessions live on in tmux).
5. **Sidebar.**
   - Project row click → `showProject(root)` (was openWindow). The active
     project row's description starts with `active`.
   - Project row inline + → new command `vzt-mux.agents.startInProject`: quick
     pick `Claude` / `Codex` / `Terminal` / `New worktree…` (the last runs the
     existing newWorkspace with the project). Claude/Codex start immediately in
     the project root with alias `<basename>-<kind>`, auto-suffixed `-2`…`-9`
     when the bus refuses an alias as taken; Terminal starts a tmux shell entry.
     Then `showProject(root)` and focus the new terminal. No other prompts.
   - Worktree row inline + (addHere) → the same picker minus `New worktree…`,
     no alias prompt.
   - Agent/worktree row click on another project → `showProject` first, then
     focus. "Open Project Window" stays as a context-menu item.
6. **Restore.** For a saved entry with `session`: `tmux has-session` true →
   `bus adopt` and keep it detached (attached when its project is shown; the
   saved activeProject is shown after restore). Session gone → today's resume
   path, into a NEW tmux session. Entries without `session` (pre-0.10) go
   through today's restoreAgent unchanged. Plain shell entries are saved too
   and restored only when their session exists.
7. **No tmux** (binary not found or `vztMux.agents.tmux` = false): today's
   direct-terminal behaviour, plus one warning naming the missing tmux.
8. Pair (`vzt-mux.bus.pair`) uses the tmux path too.

## Files in scope
`vscode/src/bus/{tmux.ts (new),spawn.ts,registry.ts,restore.ts,pair.ts}`,
`vscode/src/projects/projectsTree.ts`, `vscode/src/extension.ts` (wiring only),
`vscode/package.json` (command, menus, setting, version 0.10.0),
`test/tmux-vscode.test.mjs` (new), `test/spawn-vscode.test.mjs`,
`test/restore-vscode.test.mjs`, `test/projects-vscode.test.mjs`,
`test/live/tmux-swap-live.mjs` (new), README/CHANGELOG lines if they exist.

## Oracle (all must pass)
1. `npm --prefix vscode run compile` — clean.
2. `npm test` at the repo root — all green, including new unit tests: tmux argv
   building (private socket, conf, session names, env, send-keys literal +
   Enter, attach args), registry with detached entries, showProject disposing
   other projects' terminals WITHOUT killing sessions and attaching this
   project's in one split group per worktree, user-close kills the session,
   alias auto-suffix, restore with a live session = no launch.
3. `node test/live/tmux-swap-live.mjs` — real tmux, no agents: create two
   sessions in two temp git repos running `cat`, send a line via the sink,
   verify it with `capture-pane`, read pane pids, detach/reattach via a real
   `attach-session` under a pty (test/live/pty_host.py), kill one, confirm
   `has-session` false, and leave no `vzt-mux` sessions behind. Exit 0.
4. `grep -rn '"-L"' vscode/src` matches only `vscode/src/bus/tmux.ts`.
