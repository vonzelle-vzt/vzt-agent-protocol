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

## Settings

- `vztMux.baseDir` — overrides the mux filesystem directory. Empty means
  `~/.vzt/vscode-mux`; `VZT_VSCODE_DIR` still wins when set.
- `vztMux.autoDoctorOnStartup` — defaults on; runs a lightweight readiness
  check when the extension activates.
- `vztMux.showSetupPrompts` — defaults on; shows a one-time setup prompt in a
  workspace with no project/global VZT hooks.
