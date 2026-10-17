# SHIP SPEC — vscode-orca-workspaces

> Written before code. Prose is for humans; the fenced JSON block is machine
> truth (`vzt-agent ship-check` validates it).
>
> **Origin.** 2026-10-17 session. The user said: "I want the VS Code panes to act like the Orca panes,
> where agents recognize and talk to each other… especially separating the
> workspaces for the projects."
>
> **User decisions:**
> - Separation model: **one VS Code window per project**.
> - v1 scope: agents per worktree, agent-to-agent talk, Orca status + attention,
>   and the Agent Dashboard.
>
> Plan: `~/.claude/plans/we-haev-a-vs-lexical-mango.md`.

## Contract

vzt-mux becomes an Orca-style agent workspace inside VS Code:

1. **Projects.** A **Projects** view lists every registered project. Under each project it shows the project's git
   worktrees, and under each worktree the bus agents running in it. Each agent and worktree shows Orca's status glyphs:
   working, needs-you, done, idle and stale.
2. **One window per project.** Opening a project opens or focuses that project's own VS Code window.
3. **New Agent Workspace.** This command creates a git worktree for a task and starts Claude or Codex in it, as a
   terminal named `<worktree>·<alias>`. That agent is on the bus and can
   address any other agent of the **same project**, in any worktree, by alias.
   Agents of other projects are unreachable unless `--cross-workspace` is given.
4. **Attention.** When an agent this window owns goes from working to needs-you or done, a notification appears. Its
   **Show** action focuses the agent's terminal. A status-bar item counts the agents that
   need you.
5. **Agent Dashboard.** A webview kanban (Needs You / Working / Done / Idle) shows agents across all
   projects. Clicking a card focuses that agent, in whatever window owns it.

**Done-state a stranger can check:**
- Every unit oracle passes offline.
- `npm run compile:vscode && npm test` is green.
- The live gate (below) passes.

## Ownership

- **Repo:** `vzt-agent-protocol` (the bus, `vzt-agent`, and the vzt-mux VS Code extension
  in `vscode/`).
- **Not `vzt-orca-flow`.** Its CLAUDE.md forbids its `vscode/` client from opening
  terminals or invoking agents.
- **Agent argv** still comes only from `bus argv`, which mirrors vzt-orca-flow's
  `AGENT_ARGV`. Nothing in this spec writes an agent invocation.

## Baseline

- main @ `827fc7b`.
- `npm --prefix vscode run compile && npm test` → **280/280 pass** (2026-10-17).
- Tests import `vscode/out/`, so compile before testing.

## Resolved questions

| Question | Resolution |
|---|---|
| Why can't agents in two worktrees talk today? | The bus's workspace is `realpath(git rev-parse --show-toplevel)` (`cli/bus/cli.mjs` `resolveWorkspace`). Each worktree has its own toplevel, so `send --to` fails across worktrees unless `--cross-workspace` is given. **Fix:** add a **project** scope that worktrees share: the main checkout of `git rev-parse --git-common-dir`. |
| Is the alias unique per worktree or per project? | **Per project.** `send --to <alias>` must be unambiguous across the project. The DB keeps its `UNIQUE (workspace, alias)` constraint, and `register` additionally refuses an alias that another workspace of the same project already holds (exit 4). |
| Existing agents on schema upgrade? | The v1→v2 migration sets `project = workspace` for existing rows. Old agents stay isolated per worktree, which is the conservative choice; they re-register on the next pair or spawn. |
| Where do projects come from? | An explicit registry, `~/.vzt/projects.json`, the same idea as Orca's `repo add`. No scanning of the disk. |
| Where do worktrees go? | `<parent of project root>/<project basename>-worktrees/<slug>`, on branch `<slug>`. node_modules is symlinked the way ship-watch's integration worktree does it. |
| How does a window focus a terminal it does not own? | VS Code terminals belong to one window. Another window writes a focus request file, `<baseDir>/focus/<agent_id>.json`, holding the owning `window_id`. The owner polls every 1 s, claims the file with an atomic rename (the same pattern as the ship queue), and calls `terminal.show()`. To raise the owner's window, the requester also runs `vscode.openFolder(projectRoot, {forceNewWindow: true})`. VS Code focuses an existing window that already holds that folder; **verify this in the live/manual gate**. |
| How is "done" distinguished from "idle"? | The bus has only `idle`. Rule: `idle` for less than 30 min since `state_ts_ms` → **done**; longer → **idle**, which is Orca's 30-min Idle column. |
| Do the extension views poll too much? | Attention polls `bus agents --all` every 2 s. Projects and Dashboard poll every 3 s / 2 s, **only while visible**. Each poll is one short CLI process, the same cost model as the existing bus poller. |

## Interfaces (pinned — units implement, never redesign)

### Bus (u1) — `cli/bus/store.mjs`, `cli/bus/cli.mjs`, `cli/agent-argv.mjs`

**Schema migration (v1 → v2):**
- `SCHEMA_VERSION = 2`.
- v1→v2 runs in one tx:
  - `ALTER TABLE agents ADD COLUMN project TEXT NOT NULL DEFAULT ''`
  - `UPDATE agents SET project = workspace WHERE project = ''`
  - `CREATE INDEX agents_project ON agents (project, alias)` (non-unique)
- v0→v2 creates the full schema including `project`.
- A version above 2 is refused, as today.

**`resolveProject(dir)`** (exported from cli.mjs):
- Run `git rev-parse --path-format=absolute --git-common-dir` in dir.
- If the result's basename is `.git`, the project is its parent; otherwise (a bare repo) it is the result itself.
- `realpath` the result.
- Not a git repo → fall back to `resolveWorkspace(dir)`.

**`register`:**
- Computes workspace and project from `--workspace` (or cwd).
- If an agent with the same alias exists in the **same project but a different workspace** → `BusError(4, 'alias "<a>" is already used in this project by <workspace>')`.
- Same workspace and alias → today's reuse behaviour, unchanged.

**`send` / `ask`** (no `--cross-workspace`):
- Resolve `--to` in the sender's workspace first, then in the sender's project.
- Not found → exit 2 with the existing message text plus ` or project <project>`.
- `--cross-workspace <dir>` is unchanged.

**`agents`:**
- `--project` (a boolean flag) → agents whose project is the project of `--workspace` or cwd.
- `--all` and the default are unchanged.
- Every agent row now includes `project`.

**`inbox --project`:** threads where the sender or recipient agent belongs to the project.

**`bootstrap-prompt`:**
- `--peer` becomes optional.
- With `--peer`, the output is **byte-identical** to today's `BOOTSTRAP_PROMPT(alias, peer)`.
- Without it, `BOOTSTRAP_PROMPT(alias)` returns a multi-agent prompt:
  `You are "<alias>", one of the agents working on this project over the VZT bus. See who is up with: vzt-agent bus agents --project --json . Talk to another agent ONLY via: vzt-agent bus send --to <alias> --type message|task|question --subject ... --body ... ; read your inbox with: vzt-agent bus check --json ; answer questions with: vzt-agent bus reply --id <id> --body ... . A line starting "vzt: new bus message" means run that check.`
- The trailing instructions of the paired prompt (check, reply, the wake line) are reused verbatim where they exist; read `cli/agent-argv.mjs`.

### Workspace CLI (u2) — `cli/workspace/{projects.mjs,cli.mjs}`

**`main(argv, io)` in `cli/workspace/cli.mjs`:**
- `argv[0]` ∈ {`projects`, `worktree`}.
- Exit codes: 0 ok, 2 usage/not found, 4 conflict.
- `--json` prints JSON.
- The module also runs when executed directly.
- Node stdlib only; git runs via `execFileSync('git', …)`, never a shell.

**Registry:**
- Location: `$VZT_PROJECTS_FILE`, else `~/.vzt/projects.json`.
- Format: `{"version":1,"projects":[{"name","root","baseRef"}]}`.
- Permissions: dir 0700, file 0600.
- Writes are atomic (tmp + rename).
- A missing file reads as empty.

**`projects add <dir> [--name N] [--base REF]`:**
- `root = resolveProject(dir)`; reuse the same algorithm, imported from `../bus/cli.mjs`.
- Not a git repo → 2.
- `name` defaults to `basename(root)` and must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`.
- Duplicate name or root → 4.
- `baseRef` defaults to the target of `git symbolic-ref --short refs/remotes/origin/HEAD` (e.g. `origin/main`), else the current branch.

**`projects remove <name>`:** edits the registry only, never the disk. Unknown name → 2.

**`projects list`:** returns `[{name, root, baseRef, exists, worktrees:[{path, branch, head, main}]}]`.
- `worktrees` comes from `git worktree list --porcelain`, with each path realpath'd.
- `branch` is the short name or `null` when detached.
- `main` is true for the main checkout.
- `exists:false` with `worktrees:[]` when root is gone.

**`worktree create --project N --name SLUG [--base REF]`:**
- SLUG matches `^[a-z0-9][a-z0-9._-]{0,62}$`.
- path = `<dirname(root)>/<basename(root)>-worktrees/<SLUG>`.
- Refuses with 4 if the path exists or `refs/heads/SLUG` exists.
- Runs `git worktree add -b SLUG <path> <base>`.
- Then, for `node_modules` at root and one directory level down: if it exists in root and is absent in the worktree, `symlink` it.
- Prints `{path, branch, base, head}`.

**`worktree remove --project N --name SLUG [--force]`:**
- Runs `git worktree remove [--force] <path>`.
- Never deletes the branch.

### Extension — shared types (each unit declares the subset it needs, structurally)

```ts
interface BusAgentRow { agent_id: string; workspace: string; project: string; alias: string;
  kind: "claude" | "codex"; state: "launching" | "working" | "idle" | "blocked";
  state_ts_ms: number; liveness: "live" | "stale" | "never-started";
  wake_unconfirmed: boolean; unread: number; window_id: string | null; }
interface ProjectEntry { name: string; root: string; baseRef: string; exists: boolean;
  worktrees: { path: string; branch: string | null; head: string; main: boolean }[]; }
type Run = <T>(args: string[], cwd?: string) => Promise<T>;   // args WITHOUT the leading "vzt-agent"
```

Units that are tested from `test/*.test.mjs` import compiled `vscode/out/**`. So every
**pure** module named below must not import `vscode` at runtime (`import type` is fine).

### Status (u3) — `vscode/src/projects/status.ts` (pure)

**Glyphs:**
- `export type Glyph = "working" | "needs-you" | "done" | "idle" | "stale" | "launching";`
- `export const DONE_WINDOW_MS = 30 * 60_000;`

**`glyphFor(a: BusAgentRow, nowMs: number): Glyph`:**
1. `liveness !== "live"` → `stale`.
2. `blocked` → `needs-you`.
3. `working` → `working`.
4. `launching` → `launching`.
5. `idle` → `done` if `nowMs - state_ts_ms < DONE_WINDOW_MS`, else `idle`.

**Rollup:** `rollup(glyphs: Glyph[]): Glyph | null` takes the highest by precedence:
`needs-you > working > launching > done > idle > stale`.

**Icon map:** `GLYPH_ICON: Record<Glyph, { codicon: string; color?: string }>`.

| Glyph | codicon | color |
|---|---|---|
| working | `sync~spin` | — |
| needs-you | `question` | `charts.yellow` |
| done | `pass` | `charts.green` |
| idle | `circle-outline` | `disabledForeground` |
| stale | `error` | `charts.red` |
| launching | `loading~spin` | — |

### Projects view (u3) — `vscode/src/projects/{status.ts,model.ts,focus.ts,projectsTree.ts}`

**`model.ts`** (pure): `buildProjectTree(projects, agents, nowMs)` returns project nodes → worktree nodes → agent nodes.
- An agent belongs to the worktree where `agent.workspace === worktree.path`.
- Agents whose `project` matches no registered root go under a final group, `Unregistered projects`, grouped by `project` path.
- Worktree and project nodes carry `rollup` of their agents.
- Sort order: projects by name; the main worktree first, then by branch; agents by alias.

**`focus.ts`** (pure, `fs` only):
- `requestFocus(baseDir, agentId, windowId, nowMs)` atomically writes `focus/<agent_id>.json` = `{agent_id, window_id, requested_ms}`, creating `focus/` with 0700.
- `claimFocus(baseDir, windowId, nowMs): string[]`:
  - For each record whose `window_id === windowId`: rename it to a unique `.claimed-*` name (losing the race → skip), unlink it, and collect `agent_id`.
  - Records older than 60 s are unlinked by any window.
  - Malformed files are unlinked.

**`projectsTree.ts`** (vscode):
- `registerProjects(context, deps: { run: Run; windowId: string; baseDir: string; focusLocal(agentId: string): boolean })` registers:
  - the tree view `vztProjects`;
  - the commands `vzt-mux.projects.refresh`, `vzt-mux.projects.add` (folder picker → `projects add`), `vzt-mux.projects.remove`, `vzt-mux.projects.openWindow`, `vzt-mux.projects.focusAgent`.
- Data comes from `run(["projects","list","--json"])` and `run(["bus","agents","--all","--json"])`, polled every 3 s while visible and on refresh.
- **openWindow(project):**
  - If a folder of this window is the project root → reveal only.
  - Else `vscode.openFolder(Uri.file(root), {forceNewWindow: true})`.
- **focusAgent(agent):**
  - If `agent.window_id === windowId` and `focusLocal(id)` succeeds → done.
  - Otherwise `requestFocus(...)`, then openWindow for the agent's project if it is registered.
- **Focus claim loop:** every 1 s, `claimFocus(baseDir, windowId)` → `focusLocal` for each id.
- Exports `{ refresh(): void }`.

### Spawn (u4) — `vscode/src/bus/{registry.ts,spawn.ts,pair.ts,wake.ts,busCli.ts}`

**`registry.ts`** (pure): `class AgentRegistry` over `Map<agent_id, {alias, cwd, terminal}>`.
- Methods: `set`, `get`, `delete`, `entries()`, `size`, `removeTerminal(t)`.
- `focus(id): boolean` → `terminal.show(false)`; returns false if the id is unknown or the terminal has exited (`exitStatus !== undefined`).

**`spawn.ts`** (pure; `import type` only):
- `spawnAgent(deps, req)`.
  - `deps = { run, createTerminal(opts), launch(terminal, cmd, label), windowId, registry, isTrusted(): boolean }`.
  - `req = { kind, alias, cwd, peer?, task?, parentTerminal? }`.
- Steps, in order:
  1. Refuse (throw) when `!isTrusted()`.
  2. If kind is claude → `bus trust-claude --workspace cwd`.
  3. `bus register --alias --kind --window windowId --workspace cwd`.
  4. `bus argv --kind`.
  5. `bus bootstrap-prompt --alias [--peer]`. If `task` is given, the prompt becomes `prompt + "\n\nYour first task: " + task`.
  6. `createTerminal({ name: basename(cwd) + "·" + alias, cwd, env, location? })`. env = `VZT_BUS_AGENT`, `VZT_BUS_KIND`, `VZT_BUS_WINDOW`, plus `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` for claude only. `location` = `{ parentTerminal }` when given.
  7. `registry.set`.
  8. `launch(terminal, shellQuoted argv+prompt, label)`.
- Returns `{ agent_id, terminal }`.
- Also `preflight(run, cwd): Promise<string[]>`, which returns doctor problems. These are the two checks pair has today, moved here verbatim.

**`busCli.ts`:** add `runTop(args, cwd)`, the same as `run` but with no `bus` prefix and no forced `--json` (callers pass it). `run` is unchanged.

**`pair.ts`:**
- `registerAgentBus(...)` now **returns** `{ registry: AgentRegistry; runTop: Run; refreshBus(): Promise<void> }`.
- The poller leases every live registry terminal, as today.
- `pair` = preflight + two `spawnAgent` calls with `peer` set, so prompts are unchanged; codex splits beside claude.
- Pair refuses when this window already has a live `claude` and `codex` from a pair.

**New commands, registered here:**
- `vzt-mux.agents.newWorkspace` steps:
  1. QuickPick a project (`projects list`); none → offer `vzt-mux.projects.add`.
  2. InputBox the slug, with the pinned regex.
  3. QuickPick the kind: claude or codex.
  4. Optional InputBox for the first task.
  5. `worktree create`.
  6. `updateWorkspaceFolders(len, 0, {uri})`.
  7. `spawnAgent` with alias `<slug>-<kind>`.
- `vzt-mux.agents.addHere`:
  1. QuickPick a workspace folder.
  2. Pick the kind.
  3. InputBox the alias, default `<folder basename>-<kind>`.
  4. `spawnAgent`.

**`wake.ts`:** unchanged unless compile requires a change.

### Attention (u5) — `vscode/src/attention/{watcher.ts,statusBar.ts}`

**`watcher.ts`** (pure; imports `glyphFor` from `../projects/status`):
- `class AttentionWatcher(windowId)`.
- `.update(agents, nowMs): Transition[]`:
  - Remembers the last glyph per agent_id.
  - Emits `{agent_id, alias, project, to: "needs-you" | "done"}` only for agents whose `window_id === windowId` whose previous glyph was `working` or `launching` and whose new glyph is `needs-you` or `done`.
  - The first sighting of an agent never emits.
  - Agents that disappear are forgotten.
- `needsYou(agents, nowMs): number` counts every agent across all projects with glyph `needs-you`.

**`statusBar.ts`** (vscode): `registerAttention(context, deps: { run, windowId, focusLocal, openDashboard(): void, setBadge(n: number): void })`.
- Polls `bus agents --all --json` every 2 s.
- Status-bar item `$(bell) N need you`:
  - hidden when N = 0;
  - clicking it runs `openDashboard`.
- When `vztMux.attention.notify` is true (default true), each transition shows `showInformationMessage("<alias> needs you" | "<alias> is done", "Show")`. Show → `focusLocal`.

### Dashboard (u6) — `vscode/src/dashboard/{model.ts,panel.ts}`

**`model.ts`** (pure):
- `bucket(agents, nowMs, showIdle)` → `{ needsYou, working, done, idle }` using `glyphFor`.
- Bucket mapping:
  - `launching` goes to working.
  - `stale` goes to idle.
  - idle is empty unless `showIdle`.
- `escapeHtml(s)` escapes `& < > " '`.
- `renderHtml(board, { nonce, cspSource, showIdle })` returns the full document.
  - CSP: `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`.
  - Each card shows alias, kind, project basename, worktree basename and the unread count. Every one of these goes through `escapeHtml`.
  - A card click posts `{type:"focus", agent_id}`; a toggle posts `{type:"toggleIdle"}`.
  - No message bodies; no remote resources.

**`panel.ts`** (vscode): `openDashboard(context, deps: { run, focusAgent(agent: BusAgentRow): void })`.
- Singleton `WebviewPanel` titled "Agent Dashboard".
- Refreshes every 2 s while visible.
- Ignores a `focus` message whose agent_id is not in the last fetched list.

### Wiring (u7) — shared files

**`cli/vzt-agent.js`:**
- `case 'projects': case 'worktree':` dispatches to `main` in `./workspace/cli.mjs` with `process.argv.slice(2)` and exits with its code.
- Add both to the usage text.

**`vscode/src/extension.ts`:**
- `const bus = registerAgentBus(...)`.
- `registerProjects({ run: bus.runTop, windowId: vscode.env.sessionId, baseDir, focusLocal: id => bus.registry.focus(id) })`.
- `registerAttention({..., openDashboard: () => vscode.commands.executeCommand("vzt-mux.dashboard.open"), setBadge: n => projectsView.badge })`. The badge goes through a setter returned by registerProjects. If that setter is missing, wiring adds `badge` support via an optional `setBadge` export; u3 returns `{ refresh, setBadge }`.
- Command `vzt-mux.dashboard.open` → `openDashboard({ run: bus.runTop, focusAgent: projects' focusAgent })`.

**`vscode/package.json`:**
- View `vztProjects` ("Projects") first in the `vztShip` container.
- Commands, all titled `VZT: …`:
  - `vzt-mux.projects.refresh`, `.add`, `.remove`, `.openWindow`, `.focusAgent`
  - `vzt-mux.agents.newWorkspace`, `.addHere`
  - `vzt-mux.dashboard.open`
- View/title menu entries for refresh, add, newWorkspace and dashboard.
- Setting `vztMux.attention.notify` (boolean, default true).
- Version **0.8.0**.

**Docs:** `README.md` and `vscode/README.md` each get an "Orca-style workspaces" section mapping Orca concepts to vzt-mux:

| Orca | vzt-mux |
|---|---|
| project | Projects view |
| worktree | New Agent Workspace |
| orchestration send/ask | `vzt-agent bus send/ask` |
| status glyphs | Projects view glyphs |
| bell | attention |
| Agent Dashboard | Agent Dashboard |

## Failure cases → handling

| Case | Handling |
|---|---|
| Alias collides within the project | `register` exit 4, shown verbatim by spawn; the user picks another alias. |
| Slug's path or branch exists | `worktree create` exit 4, shown; nothing is created. |
| Workspace not trusted | spawn refuses; same message as pair today. |
| Codex hooks untrusted / no node:sqlite | `preflight` refuses spawn and pair, as today. |
| Focus request for a window that is closed | The record expires after 60 s and any window unlinks it. |
| `projects list` fails (CLI missing) | The tree shows one error node; it never throws. |
| Agent-controlled strings in the dashboard | Always escaped (u6 test). |
| Running inside an Orca pane | Bus verbs still exit 3 by design. Every test that spawns the CLI strips `ORCA_TERMINAL_HANDLE`. |

## Out of scope

- Restoring agent terminals after a window reload.
- Orchestration DAG and decision gates.
- Remote/SSH hosts.
- Any change to vzt-orca-flow.
- Migrating ship-watch sentinels.
- New flags on the house agent argv.
- Deleting branches.

## Live gate (chair, after integration)

1. `test/live/project-workspaces-live.mjs`:
   - Fresh `VZT_BUS_DIR` and a temp `VZT_PROJECTS_FILE`.
   - Register the repo; `worktree create` A and B.
   - Real claude in A and real codex in B, driven via `test/live/pty_host.py` exactly like `bus-roundtrip-live.mjs`.
   - A harness agent tasks claude to `bus ask` codex (the alias of B, a different worktree) for 6*7.
   - **Pass iff** the answer is 42 and an agent registered in a second temp repo gets exit 2 sending to claude's alias.
2. A manual pass in real VS Code with the installed 0.8.0 VSIX:
   - two projects → two windows;
   - New Agent Workspace;
   - the dashboard;
   - a notification;
   - cross-window focus.

## Units

<!-- vzt-spec — machine-readable truth. `vzt-agent ship-check <this file>` validates it. -->
```json
{
  "specVersion": 1,
  "slug": "vscode-orca-workspaces",
  "title": "Orca-style agent workspaces in VS Code: projects, worktree agents, project-scoped bus, attention, dashboard",
  "root": "/Users/vonzellebrown/github-projects/vzt-agent-protocol",
  "contract": "vzt-mux gets a Projects view (project → worktree → agent with Orca status glyphs, one VS Code window per project), New Agent Workspace (git worktree + Claude/Codex terminal on the bus), a project-scoped bus so agents in different worktrees of one project address each other by alias while other projects stay unreachable, attention notifications + a needs-you status bar, and an Agent Dashboard kanban. Every unit oracle passes offline and `npm run compile:vscode && npm test` is green.",
  "outOfScope": [
    "restoring agent terminals after window reload",
    "orchestration DAG and decision gates",
    "remote/SSH hosts",
    "any change to vzt-orca-flow",
    "new flags on the house agent argv",
    "deleting git branches"
  ],
  "manifest": [
    { "path": "cli/bus/store.mjs", "op": "modify" },
    { "path": "cli/bus/cli.mjs", "op": "modify" },
    { "path": "cli/agent-argv.mjs", "op": "modify" },
    { "path": "test/bus-project.test.mjs", "op": "new" },
    { "path": "cli/workspace/projects.mjs", "op": "new" },
    { "path": "cli/workspace/cli.mjs", "op": "new" },
    { "path": "test/workspace.test.mjs", "op": "new" },
    { "path": "vscode/src/projects/status.ts", "op": "new" },
    { "path": "vscode/src/projects/model.ts", "op": "new" },
    { "path": "vscode/src/projects/focus.ts", "op": "new" },
    { "path": "vscode/src/projects/projectsTree.ts", "op": "new" },
    { "path": "test/projects-vscode.test.mjs", "op": "new" },
    { "path": "vscode/src/bus/registry.ts", "op": "new" },
    { "path": "vscode/src/bus/spawn.ts", "op": "new" },
    { "path": "vscode/src/bus/pair.ts", "op": "modify" },
    { "path": "vscode/src/bus/wake.ts", "op": "modify" },
    { "path": "vscode/src/bus/busCli.ts", "op": "modify" },
    { "path": "test/spawn-vscode.test.mjs", "op": "new" },
    { "path": "vscode/src/attention/watcher.ts", "op": "new" },
    { "path": "vscode/src/attention/statusBar.ts", "op": "new" },
    { "path": "test/attention-vscode.test.mjs", "op": "new" },
    { "path": "vscode/src/dashboard/model.ts", "op": "new" },
    { "path": "vscode/src/dashboard/panel.ts", "op": "new" },
    { "path": "test/dashboard-vscode.test.mjs", "op": "new" },
    { "path": "cli/vzt-agent.js", "op": "modify" },
    { "path": "vscode/src/extension.ts", "op": "modify" },
    { "path": "vscode/package.json", "op": "modify" },
    { "path": "README.md", "op": "modify" },
    { "path": "vscode/README.md", "op": "modify" },
    { "path": "test/workspaces-wiring.test.mjs", "op": "new" }
  ],
  "units": [
    {
      "id": "u1-bus-project",
      "title": "Project scope on the bus: schema v2, per-project alias, cross-worktree send, agents/inbox --project, multi-agent bootstrap prompt",
      "agentType": "vzt-builder",
      "filesInScope": [
        "cli/bus/store.mjs",
        "cli/bus/cli.mjs",
        "cli/agent-argv.mjs",
        "test/bus-project.test.mjs",
        "test/bus-core.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Bus (u1)' exactly, never redesign. Read cli/bus/store.mjs, cli/bus/cli.mjs and cli/agent-argv.mjs first. ESM, Node stdlib only. Schema v2 migration (v1→v2 in one tx; v0→v2 full schema); export resolveProject from cli.mjs; register refuses an alias held by another workspace of the same project (exit 4); send/ask resolve --to in workspace then project; agents --project; inbox --project; every agents row carries project; bootstrap-prompt --peer optional — with --peer the output must stay byte-identical to today. Touch test/bus-core.test.mjs ONLY if an existing assertion genuinely changes because of schema v2 (e.g. user_version) and say so in your report. Every child process your tests spawn must run with ORCA_TERMINAL_HANDLE removed from env. Build fixtures with real temp git repos: one repo with a second worktree (`git worktree add`), plus a separate repo. test/bus-project.test.mjs must contain node:test cases whose titles include EXACTLY: 'migrates v1 db to v2', 'project is the main checkout', 'send reaches another worktree of the project', 'other project refused', 'cross-workspace still works', 'alias unique per project', 'agents --project lists both worktrees', 'inbox --project', 'paired prompt unchanged', 'multi-agent prompt names agents --project'. For 'migrates v1 db to v2': create a v1 DB by executing the v1 schema text (copy it into the test as a fixture) with user_version=1 and one agent row, open with the new store, assert user_version=2 and project equals workspace.",
      "machineCheck": "node --test test/bus-project.test.mjs test/bus-core.test.mjs test/agent-argv.test.mjs && for t in 'migrates v1 db to v2' 'project is the main checkout' 'send reaches another worktree of the project' 'other project refused' 'cross-workspace still works' 'alias unique per project' 'agents --project lists both worktrees' 'inbox --project' 'paired prompt unchanged' 'multi-agent prompt names agents --project'; do grep -qF \"$t\" test/bus-project.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && grep -q 'SCHEMA_VERSION = 2' cli/bus/store.mjs && grep -q 'export function resolveProject' cli/bus/cli.mjs",
      "expect": "exit 0"
    },
    {
      "id": "u2-workspace-cli",
      "title": "vzt-agent projects add|remove|list and worktree create|remove",
      "agentType": "vzt-builder",
      "filesInScope": [
        "cli/workspace/projects.mjs",
        "cli/workspace/cli.mjs",
        "test/workspace.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Workspace CLI (u2)' exactly. ESM, Node stdlib only; git only via execFileSync('git', args) — never a shell string. cli/workspace/projects.mjs holds the registry + git logic (pure functions taking an env/file path); cli/workspace/cli.mjs exports main(argv, io = {out: process.stdout, err: process.stderr}) returning an exit code and runs main when executed directly (`node cli/workspace/cli.mjs projects list --json`). resolveProject: if `import { resolveProject } from '../bus/cli.mjs'` is not available yet (it lands in a parallel unit), implement the identical pinned algorithm locally as a private function in projects.mjs — do NOT edit cli/bus/*. Do NOT edit cli/vzt-agent.js (u7 wires it). Tests use temp git repos (git init, one commit, `git -c user.email=t@t -c user.name=t`), a temp VZT_PROJECTS_FILE, and run the CLI as a child process `node cli/workspace/cli.mjs ...` with ORCA_TERMINAL_HANDLE removed from env. test/workspace.test.mjs titles must include EXACTLY: 'add registers the main checkout from a worktree path', 'add refuses non-git dir', 'add refuses duplicate', 'registry file is 0600', 'list shows worktrees', 'list marks missing root', 'create makes worktree on base', 'create refuses existing slug', 'create refuses bad slug', 'create symlinks node_modules', 'remove keeps the branch', 'remove project leaves disk untouched'.",
      "machineCheck": "node --test test/workspace.test.mjs && for t in 'add registers the main checkout from a worktree path' 'add refuses non-git dir' 'add refuses duplicate' 'registry file is 0600' 'list shows worktrees' 'list marks missing root' 'create makes worktree on base' 'create refuses existing slug' 'create refuses bad slug' 'create symlinks node_modules' 'remove keeps the branch' 'remove project leaves disk untouched'; do grep -qF \"$t\" test/workspace.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && F=$(mktemp -d)/p.json && env -u ORCA_TERMINAL_HANDLE VZT_PROJECTS_FILE=$F node cli/workspace/cli.mjs projects list --json | python3 -c 'import json,sys; assert json.load(sys.stdin)==[]' && ! grep -rqE \"execSync\\(|shell: *true\" cli/workspace",
      "expect": "exit 0"
    },
    {
      "id": "u3-projects-view",
      "title": "Projects view: status glyphs, project→worktree→agent model, cross-window focus requests, window per project",
      "agentType": "vzt-builder",
      "filesInScope": [
        "vscode/src/projects/status.ts",
        "vscode/src/projects/model.ts",
        "vscode/src/projects/focus.ts",
        "vscode/src/projects/projectsTree.ts",
        "test/projects-vscode.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement sections 'Extension — shared types', 'Status (u3)' and 'Projects view (u3)' exactly. Read vscode/src/bus/busTree.ts and vscode/src/shipTree.ts for the house TreeDataProvider style first. status.ts, model.ts and focus.ts are PURE: no runtime `import ... from \"vscode\"` (import type only) so tests can import compiled vscode/out/projects/*.js under plain node. projectsTree.ts is the only vscode-facing file; it exports registerProjects(context, deps) returning { refresh(): void; setBadge(n: number): void; focusAgent(agent): Promise<void> } (setBadge sets view.badge {value:n, tooltip:'agents need you'} or undefined at 0). Do NOT edit vscode/src/extension.ts or vscode/package.json (u7 wires and contributes) — the module must still compile standalone. Tests: test/projects-vscode.test.mjs imports compiled out files (assert.fail with a 'run npm --prefix vscode run compile' hint if missing) and must contain titles EXACTLY: 'glyph working', 'glyph needs-you when blocked', 'glyph done within 30 minutes', 'glyph idle after 30 minutes', 'glyph stale when lease lapsed', 'rollup precedence', 'agents land in their worktree', 'unregistered project group', 'focus claimed only by owner window', 'focus claim race has one winner', 'stale focus request expires', 'pure modules do not import vscode' (read the three .ts files and assert no runtime vscode import).",
      "machineCheck": "npm --prefix vscode run compile && node --test test/projects-vscode.test.mjs && for t in 'glyph working' 'glyph needs-you when blocked' 'glyph done within 30 minutes' 'glyph idle after 30 minutes' 'glyph stale when lease lapsed' 'rollup precedence' 'agents land in their worktree' 'unregistered project group' 'focus claimed only by owner window' 'focus claim race has one winner' 'stale focus request expires' 'pure modules do not import vscode'; do grep -qF \"$t\" test/projects-vscode.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && grep -q 'export function registerProjects' vscode/src/projects/projectsTree.ts",
      "expect": "exit 0"
    },
    {
      "id": "u4-spawn",
      "title": "spawnAgent + AgentRegistry, pair rebuilt on spawn, New Agent Workspace and Add Agent Here commands",
      "agentType": "vzt-builder",
      "filesInScope": [
        "vscode/src/bus/registry.ts",
        "vscode/src/bus/spawn.ts",
        "vscode/src/bus/pair.ts",
        "vscode/src/bus/wake.ts",
        "vscode/src/bus/busCli.ts",
        "test/spawn-vscode.test.mjs",
        "test/bus-vscode.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Spawn (u4)' exactly. Read vscode/src/bus/pair.ts, busCli.ts, wake.ts and the sendWhenReady comment in vscode/src/extension.ts first. registry.ts and spawn.ts are PURE (import type only from vscode) so tests import compiled vscode/out/bus/{registry,spawn}.js under plain node with fake terminals/createTerminal/launch/run. Nothing here may hand-write an agent command: argv comes only from `bus argv`, the prompt from `bus bootstrap-prompt`. registerAgentBus must RETURN { registry, runTop, refreshBus } — extension.ts currently ignores its return value, so it keeps compiling; do NOT edit extension.ts or vscode/package.json (u7 contributes the new command ids vzt-mux.agents.newWorkspace and vzt-mux.agents.addHere; register them with vscode.commands.registerCommand here). The `projects list` / `worktree create` CLI verbs land in a parallel unit: call them via runTop(['projects','list','--json']) / runTop(['worktree','create','--project',p,'--name',slug,'--json']) per the spec; unit tests stub run. Keep existing test/bus-vscode.test.mjs green; edit it only if an assertion about pair.ts internals genuinely changes. test/spawn-vscode.test.mjs titles must include EXACTLY: 'spawn registers then launches', 'spawn refuses untrusted workspace', 'spawn pre-trusts claude only', 'spawn names terminal worktree dot alias', 'spawn env carries bus identity', 'task is appended to prompt', 'three agents across two worktrees', 'pair passes peer', 'registry focus false for exited terminal', 'spawn never hand-writes argv' (assert spawn.ts/pair.ts contain no 'dangerously' and no literal 'claude --' / 'codex --').",
      "machineCheck": "npm --prefix vscode run compile && node --test test/spawn-vscode.test.mjs test/bus-vscode.test.mjs && for t in 'spawn registers then launches' 'spawn refuses untrusted workspace' 'spawn pre-trusts claude only' 'spawn names terminal worktree dot alias' 'spawn env carries bus identity' 'task is appended to prompt' 'three agents across two worktrees' 'pair passes peer' 'registry focus false for exited terminal' 'spawn never hand-writes argv'; do grep -qF \"$t\" test/spawn-vscode.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && ! grep -rq 'dangerously' vscode/src && grep -q 'vzt-mux.agents.newWorkspace' vscode/src/bus/pair.ts",
      "expect": "exit 0"
    },
    {
      "id": "u5-attention",
      "title": "Attention: transition watcher, needs-you status bar, notifications with Show",
      "agentType": "vzt-builder",
      "dependsOn": ["u3-projects-view"],
      "filesInScope": [
        "vscode/src/attention/watcher.ts",
        "vscode/src/attention/statusBar.ts",
        "test/attention-vscode.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Attention (u5)' exactly. watcher.ts is PURE (import type only from vscode) and imports glyphFor from '../projects/status' (already landed). statusBar.ts exports registerAttention(context, deps) per the spec; it reads the setting vztMux.attention.notify (u7 contributes it to package.json — do NOT edit package.json or extension.ts). Never overlap polls (setTimeout chain, like vscode/src/bus/pair.ts). test/attention-vscode.test.mjs imports compiled vscode/out/attention/watcher.js; titles EXACTLY: 'first sighting never notifies', 'working to needs-you notifies once', 'working to done notifies once', 'foreign window never notifies', 'idle to idle is silent', 'needs-you counts all projects', 'forgets vanished agents'.",
      "machineCheck": "npm --prefix vscode run compile && node --test test/attention-vscode.test.mjs && for t in 'first sighting never notifies' 'working to needs-you notifies once' 'working to done notifies once' 'foreign window never notifies' 'idle to idle is silent' 'needs-you counts all projects' 'forgets vanished agents'; do grep -qF \"$t\" test/attention-vscode.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && grep -q 'export function registerAttention' vscode/src/attention/statusBar.ts",
      "expect": "exit 0"
    },
    {
      "id": "u6-dashboard",
      "title": "Agent Dashboard webview: kanban buckets, escaped cards, strict CSP, focus on click",
      "agentType": "vzt-builder",
      "dependsOn": ["u3-projects-view"],
      "filesInScope": [
        "vscode/src/dashboard/model.ts",
        "vscode/src/dashboard/panel.ts",
        "test/dashboard-vscode.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Dashboard (u6)' exactly. model.ts is PURE (import type only) and imports glyphFor from '../projects/status' (already landed). panel.ts exports openDashboard(context, deps). Use a fresh random nonce per render (crypto.randomBytes). No remote scripts/styles/fonts; never render message bodies. Do NOT edit package.json or extension.ts. test/dashboard-vscode.test.mjs imports compiled vscode/out/dashboard/model.js; titles EXACTLY: 'buckets by glyph', 'idle hidden unless toggled', 'launching counts as working', 'stale goes to idle', 'escapes agent strings', 'csp has nonce and no remote', 'no message bodies' (renderHtml output for an agent row with an extra body field must not contain it).",
      "machineCheck": "npm --prefix vscode run compile && node --test test/dashboard-vscode.test.mjs && for t in 'buckets by glyph' 'idle hidden unless toggled' 'launching counts as working' 'stale goes to idle' 'escapes agent strings' 'csp has nonce and no remote' 'no message bodies'; do grep -qF \"$t\" test/dashboard-vscode.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && ! grep -rqE 'https?://' vscode/src/dashboard",
      "expect": "exit 0"
    },
    {
      "id": "u7-wiring",
      "title": "Wire CLI verbs, extension registration, package.json contributions 0.8.0, docs",
      "agentType": "vzt-builder",
      "dependsOn": ["u1-bus-project", "u2-workspace-cli", "u3-projects-view", "u4-spawn", "u5-attention", "u6-dashboard"],
      "filesInScope": [
        "cli/vzt-agent.js",
        "vscode/src/extension.ts",
        "vscode/package.json",
        "README.md",
        "vscode/README.md",
        "test/workspaces-wiring.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-orca-workspaces/SPEC.md in full; implement section 'Wiring (u7)' exactly against the APIs the earlier units actually landed (read vscode/src/projects/projectsTree.ts, bus/pair.ts, attention/statusBar.ts, dashboard/panel.ts, cli/workspace/cli.mjs first; adapt to their real exported signatures, never edit those files — if an export the spec pins is missing, stop and report it). cli/vzt-agent.js: add `case 'projects': case 'worktree':` dispatching to main from ./workspace/cli.mjs with process.argv.slice(2), plus usage lines; change nothing else in that file. extension.ts: register in the order bus → projects → attention → dashboard command; baseDir = the existing vztMux.baseDir resolution used for the ship queue. package.json: views/commands/menus/setting/version per spec; keep every existing contribution. Docs: the 'Orca-style workspaces' sections with the Orca→vzt-mux mapping table. test/workspaces-wiring.test.mjs (child processes with ORCA_TERMINAL_HANDLE removed, temp VZT_PROJECTS_FILE and VZT_BUS_DIR) titles EXACTLY: 'package contributes projects view first', 'package contributes workspace commands', 'package version 0.8.0', 'attention setting defaults true', 'vzt-agent projects list dispatches', 'vzt-agent worktree usage exits 2', 'extension wires all four features'.",
      "machineCheck": "npm --prefix vscode run compile && node --test test/workspaces-wiring.test.mjs && for t in 'package contributes projects view first' 'package contributes workspace commands' 'package version 0.8.0' 'attention setting defaults true' 'vzt-agent projects list dispatches' 'vzt-agent worktree usage exits 2' 'extension wires all four features'; do grep -qF \"$t\" test/workspaces-wiring.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && grep -q 'Orca-style workspaces' README.md && grep -q 'Orca-style workspaces' vscode/README.md && npm test",
      "expect": "exit 0"
    }
  ],
  "integration": {
    "machineCheck": "npm run compile:vscode && npm test",
    "expect": "exit 0"
  }
}
```
