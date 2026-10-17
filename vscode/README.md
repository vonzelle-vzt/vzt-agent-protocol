# VZT Ship Mux

A thin VS Code companion extension for the VZT Agent Protocol. It lets
`vzt-agent ship-watch --mux vscode` open each ship unit as a native VS Code
integrated terminal instead of a tmux pane.

It is meant to be **passively active** in daily projects: when VS Code opens,
the extension loads, writes its host heartbeat, checks whether the project or
global `.claude/settings.json` is wired for VZT, and keeps a `VZT: ...` status
bar item ready. It does not spawn agents by itself; it only starts work when
you run Claude Code/VZT commands.

## What it does

- Polls `~/.vzt/vscode-mux/queue/` for JSON files the CLI writes, one per ship
  unit. For each new file it creates an integrated terminal (with the unit's
  `cwd` and `env`), runs the unit's command, then deletes the queue file so it
  is processed exactly once.
- Polls `~/.vzt/vscode-mux/state/` for `<unitKey>.status` files (`PASS`,
  `FAIL`, or `SCOPE_BREACH`) the CLI writes as units finish, and reflects them
  into:
  - the **"VZT Ship"** output channel (`[PASS] <unitKey>` / `[FAIL] <unitKey>`)
  - a status bar item showing a running tally, e.g. `VZT ship: 2 ✓  1 ✗`
- Reports each `.status` file per WRITE (keyed on mtime), so re-running a unit
  in the same window reports again instead of being silently skipped.
- Ignores the lifecycle sentinels in `~/.vzt/vscode-mux/state/`
  (`<unit>.started` / `.blocked` / `.idle`) — those are written by the shell
  hook `hooks/vzt-vscode-agent-state.sh` and consumed by `ship-watch`, not by
  this extension.
- Contributes a **Ship Run tree** (activity bar → *VZT Ship*) listing every
  unit with live status, driven by the persistent unit records the CLI writes
  to `~/.vzt/vscode-mux/units/`. Units with a `dependsOn` graph are grouped
  under collapsible **`Wave N`** nodes that roll up to their worst member; a
  unit still waiting on an unmet dependency shows a distinct **`waiting`**
  state (grey), and a unit that wrote outside its declared `FILES_IN_SCOPE`
  shows **`SCOPE_BREACH`** (red, a different icon from `FAIL`). A run from an
  older CLI has no wave data and renders as a flat list, same as before.
- Shows readiness in the status bar: `ready`, `setup needed`, `running`, or
  `blocked`. Clicking it runs **VZT: Doctor** and writes the current mux dir,
  hook install state, and queue/state/unit counts to the output channel.
- Offers daily-use commands:
  - **VZT: Doctor**
  - **VZT: Install Protocol In This Project**
  - **VZT: Install Protocol Globally**
  - **VZT: Open Ship Run**
  - **VZT: Start Ship Watch From Spec**

### Will my agents survive a closed window?

**No — and the tree now says so.** A ship unit is a VS Code *integrated
terminal*, which is a child of the extension host, so closing or reloading the
window (or a host crash) kills every in-flight agent. The sentinels, however,
are files: `.started` stays on disk and `.idle` never arrives, so a unit that
died yesterday used to render as a cheerful spinner forever.

The extension stamps `activatedAt` into `~/.vzt/vscode-mux/host.json` on
activation. Any unit dispatched *before* this host booted is shown as
**`interrupted`** (orange `debug-disconnect`) with a tooltip explaining why and
what to do. A recorded verdict still wins — `PASS` is durable, liveness is not
— and with no heartbeat on disk nothing is marked interrupted at all, so a
first install never paints a healthy run orange.

For a run that must outlive the editor, use `--mux herdr`: herdr's panes are
owned by a separate daemon rather than by a window. On macOS, `ship-watch` also
holds a `caffeinate -i` idle-sleep assertion for the length of the run
(`VZT_NO_CAFFEINATE=1` to opt out) so an unattended run is not suspended
mid-turn — but no userland assertion overrides a lid-close without an external
display, and none of it keeps a killed terminal alive.

### Known VS Code constraint

A terminal's tab title **cannot be renamed** after creation, so this
extension never attempts it. Status lives in the Ship Run tree, the output
channel and the status bar — not on the tab.

## Install

```bash
npm install
npm --prefix vscode install
npm run install:vscode:local
```

Then **Developer: Reload Window**. The extension host caches its code, so a
freshly built `out/` does not take effect until the window reloads — a stale
host silently running an older build is an easy hour to lose.

## Local development

```bash
cd vscode
npm install
npm run compile
```

Then in VS Code, either:

- Run **"Developer: Install Extension from Location..."** and point it at
  this `vscode/` directory, or
- Open this `vscode/` folder in VS Code and press `F5` to launch an
  Extension Development Host with the extension loaded.

Once active, the extension creates `~/.vzt/vscode-mux/{queue,state,prompts}`
if they don't already exist, then starts polling.

## Commands

- **VZT: Watch Ship Run** (`vzt-mux.watchShipRun`) — reveals all known ship
  unit terminals. If none are active, shows an info message instead.
- **VZT: Doctor** (`vzt-mux.doctor`) — reports readiness, mux directory,
  project/global protocol install state, and queue/state/unit counts.
- **VZT: Install Protocol In This Project** (`vzt-mux.installProject`) —
  opens a terminal that runs `vzt-agent install --target <workspace>` using the
  local repo CLI when available, else the GitHub `npx` entrypoint.
- **VZT: Install Protocol Globally** (`vzt-mux.installGlobal`) — opens a
  terminal that runs `vzt-agent install --global` the same way.
- **VZT: Open Ship Run** (`vzt-mux.openShipRun`) — focuses the VZT Ship view.
- **VZT: Start Ship Watch From Spec** (`vzt-mux.startShipWatchFromSpec`) —
  picks a `SPEC.md` and starts `ship-watch --mux vscode` in a terminal.
- **VZT: Refresh Ship Run** (`vzt-mux.refresh`) — force a tree refresh (it
  also polls every second).

Per-unit, from the Ship Run tree:

- **Focus Terminal** (`vzt-mux.focusTerminal`) — jump to that unit's terminal.
- **Open Worktree Diff** (`vzt-mux.openWorktree`) — add the unit's git
  worktree as a workspace folder and open the SCM view, so you can read what
  the agent is writing *while it is still running*.
- **Re-run Oracle** (`vzt-mux.rerunOracle`) — run that unit's recorded
  `machineCheck` in its own worktree. The command comes from the unit record,
  so it is byte-identical to what `ship-watch` graded with.

## Pairing with the CLI

This extension is the receiving end of:

```bash
vzt-agent ship-watch --mux vscode
```

The CLI is responsible for writing queue and state files per the filesystem
contract in this repo's ship-watch mux code; this extension only reads and
reacts to them.

## Pair Claude + Codex

Run **VZT: Pair Claude + Codex** (`vzt-mux.bus.pair`, also the button in the
**Agent Bus** view) to open Claude in a `claude` terminal and Codex in a
`codex` terminal split beside it, talking over the local VZT agent bus (see
the root README, "VS Code agent bus").

- **Before launching**, it runs `vzt-agent bus doctor` and refuses if the CLI's
  Node lacks `node:sqlite` or Codex's bus hooks are untrusted — open `codex`,
  run `/hooks`, and trust the 4 vzt-bus hooks.
- **The extension never touches the database.** It shells out to
  `vzt-agent bus … --json`; agent argv, the first prompt and every wake come
  from the CLI. Every 1500 ms it renews the agents' leases and types whatever
  `bus wake-plan` returns: a fixed wake line, then a bare Enter 400 ms later.
- **Agent Bus sidebar** lists each paired agent (liveness `live` / `stale` /
  `never-started`, state, and a warning when a wake went unconfirmed) and the
  message threads. **VZT: Refresh Agent Bus** reloads it.

**Window-reload caveat.** The terminals — and the agents in them — die with
the window, like any integrated terminal. The mail does not: it is on disk.
Leases expire within 30 s; run Pair again and the bus hands back the same agent
identities with their queues intact. A second window cannot pair an alias whose
lease is still live elsewhere.

## Orca-style workspaces

The **Projects** view (first in the VZT Ship sidebar) mirrors Orca's model:
project → git worktree → the bus agents running in it.

| Orca | vzt-mux |
|---|---|
| project | Projects view |
| worktree | New Agent Workspace |
| orchestration send/ask | `vzt-agent bus send/ask` |
| status glyphs | Projects view glyphs |
| bell | attention |
| Agent Dashboard | Agent Dashboard |

- **Projects view.** Lists every project in `~/.vzt/projects.json` (add one
  with **VZT: Add Project**). Each worktree and agent shows a status glyph:
  working (spinning), needs-you (yellow ?), done (green; idle for less than
  30 min), idle, stale (red; lease lapsed). Clicking a project opens it in its
  own window, or focuses that window if it is already open. Clicking an agent
  focuses its terminal, even when another window owns it: that window claims a
  focus request under `<vztMux.baseDir>/focus/` within a second.
- **VZT: New Agent Workspace** (`vzt-mux.agents.newWorkspace`). Pick a project
  and a slug; it runs `vzt-agent worktree create`, then starts Claude or Codex
  there in a terminal named `<worktree>·<alias>`, on the bus. **VZT: Add Agent
  Here** (`vzt-mux.agents.addHere`) adds an agent to the current folder.
- **Attention.** When an agent this window owns turns needs-you or done, a
  notification appears (its **Show** focuses the terminal), and a status-bar
  bell counts the agents that need you. Turn off the notifications with
  `vztMux.attention.notify`; the count stays.
- **VZT: Open Agent Dashboard** (`vzt-mux.dashboard.open`). A kanban of agents
  across all projects: Needs You / Working / Done / Idle. Clicking a card
  focuses that agent.

Commands: `vzt-mux.projects.refresh`, `.add`, `.remove`, `.openWindow`,
`.focusAgent`. Refresh, add, New Agent Workspace and the dashboard are buttons
on the Projects view title.

## Settings

- `vztMux.baseDir` — overrides the mux filesystem directory. Empty means
  `~/.vzt/vscode-mux`; `VZT_VSCODE_DIR` still wins when set.
- `vztMux.autoDoctorOnStartup` — defaults on; runs a lightweight readiness
  check when the extension activates.
- `vztMux.showSetupPrompts` — defaults on; shows a one-time setup prompt in a
  workspace with no project/global VZT hooks.
- `vztMux.busCommand` — command prefix for the agent bus, e.g. `vzt-agent` or
  `node /path/to/cli/vzt-agent.js`. Empty means auto: `command -v vzt-agent` in
  your login shell, else this extension's repo CLI.
- `vztMux.attention.notify` — defaults on; shows a notification when an agent
  this window owns turns needs-you or done.
