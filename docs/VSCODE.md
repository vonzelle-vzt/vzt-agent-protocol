# Using the VZT Agent Protocol in VS Code

The protocol is a set of hooks, agents, and skills wired through
`~/.claude/settings.json` (or a project's `.claude/`). None of that is
terminal-specific — so the question isn't "does VZT work in VS Code," it's
which VS Code surface gives you the full engine. This doc covers both, plus
the in-progress native integration.

## Part 1 — The routing protocol already works in VS Code

`[VZT-ROUTE]` and `[VZT-SHIP]` directives come from plain `node` hooks that
read JSON on stdin and write `additionalContext` to stdout — `SessionStart`
for chair profiles, `UserPromptSubmit` for the per-prompt classifier. State
lives in `~/.claude/vzt-router/` (`decisions.jsonl`, etc.). There's no TTY
dependency anywhere in that path: no pane detection, no ANSI, no assumption
about what's driving stdin/stdout.

`~/.claude/settings.json` is the **same file** the Claude Code terminal CLI
and the VS Code extension both read. Whatever hooks are wired there —
`install --global` puts VZT's hooks in it — fire identically for both.
**There is no extra setup to make routing work in VS Code.** If `vzt-agent
doctor --global` is green in a terminal, it's green for the extension too.

### The honest caveat

The VS Code extension's chat webview is not the full Claude Code engine. It
surfaces a subset of skills/commands, and its subagent execution (the
`vzt-architect`/`vzt-planner` → `vzt-builder`/`vzt-mechanic`/`vzt-heavy-builder` fan-out the
whole protocol is built on) is more limited than what the standalone CLI
does. Routing decisions still get injected into the webview's context, but
you may not get the full agent-fleet experience described in the
[README](../README.md).

**Recommended primary surface:** run the standalone `claude` CLI in VS
Code's **integrated terminal** (`` Cmd+` ``). That's the full engine — every
hook, every `vzt-*` subagent, `ship-watch` — running exactly as it would in
any other terminal, just docked inside the editor. Use the extension's chat
webview alongside it for inline diff review and `@file` mentions, and from a
terminal session run `/ide` to connect it to VS Code's diff viewer so edits
made from the terminal CLI show up as native VS Code diffs.

## Part 2 — Dock existing Herdr in the integrated terminal (works today, zero build)

If you already use [Herdr](https://herdr.dev) as your agent multiplexer, it
docks into VS Code's integrated terminal with nothing new to build.

1. Open the integrated terminal (`` Cmd+` ``) and run `herdr` to attach the
   multiplexer.
2. Drive a long-horizon run against it:

```bash
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md --mux herdr
# or, if you'd rather not repeat --mux every time:
export VZT_MUX=herdr
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md
```

### Why this needs no VS Code-specific change

`~/.claude/hooks/herdr-agent-state.sh` (Herdr's Claude integration hook)
only does anything when three env vars are all set: `HERDR_ENV=1`,
`HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. Herdr sets those itself when it
spawns each `claude` process **inside a pane it controls** — that's true
whether the parent terminal Herdr is running in is Terminal.app, iTerm, an
SSH session, or VS Code's integrated terminal. The hook doesn't check what
kind of terminal it's in; it checks whether Herdr put it there. VS Code's
integrated terminal is a real terminal from Herdr's point of view, so the
existing `--mux herdr` path works unmodified.

### Optional: a VS Code task to launch Herdr

Drop this into `.vscode/tasks.json` to get a one-click "VZT: Herdr" task
that opens Herdr in its own dedicated integrated-terminal panel instead of
whichever terminal you happen to have focused:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "VZT: Herdr",
      "type": "shell",
      "command": "herdr",
      "presentation": {
        "panel": "dedicated",
        "reveal": "always"
      },
      "problemMatcher": []
    }
  ]
}
```

Run it from the Command Palette (`Tasks: Run Task` → `VZT: Herdr`), or bind
it to a keyboard shortcut.

You can also skip tasks entirely and add a **Terminal Profile** (VS Code
settings → `terminal.integrated.profiles.osx`) whose `path`/`args` launch
`herdr` directly, so a new terminal tab attaches to the multiplexer by
default.

## Part 3 — Native `--mux vscode` (companion extension)

The repo ships a companion VS Code extension under
[`vscode/`](../vscode/) that skips the external-multiplexer dependency
entirely: each ship unit gets its **own native VS Code integrated
terminal**, driven by

```bash
vzt-agent ship-watch .vzt/ship/<slug>/SPEC.md --mux vscode
```

How it works: the `vscode` backend creates one git worktree per unit, then
writes a launch record to a filesystem queue at `~/.vzt/vscode-mux/queue/`.
The extension watches that queue and opens one integrated terminal per unit,
running `claude --dangerously-skip-permissions "$(cat <promptfile>)"` in the
unit's worktree with `VZT_VSCODE_MUX=1` and `VZT_VSCODE_UNIT=<slug>-<id>` set.

### The agent lifecycle (three sentinels, not one)

One hook script (`hooks/vzt-vscode-agent-state.sh`) is wired to three events,
each passing an action. All three no-op instantly outside a ship unit, so they
cost nothing in your normal sessions:

| event | action | writes | means |
|---|---|---|---|
| `SessionStart` | `started` | `state/<unit>.started` | claude actually booted |
| `PermissionRequest` | `blocked` | `.blocked` (+ `.started`) | parked on a prompt, waiting for a human |
| `Stop` | `idle` | `.idle` (clears `.blocked`) | the turn finished |

`ship-watch` then waits in **two phases**, mirroring the herdr backend: first
for `started` *or* `blocked` within `VZT_START_GRACE_MS`, then for `idle`
within the unit budget.

**Why two phases.** Polling `.idle` alone cannot tell "the agent is still
working" from "the agent never launched at all". On 2026-07-28 two identical
units were dispatched together; one terminal's command was swallowed by a
still-initialising shell, so claude never ran, no `.idle` ever appeared, and
the run burned the **entire** unit timeout before grading that unit FAIL
against an empty worktree. The `started` sentinel is what makes those two
cases distinguishable — without it the failure is silent and slow. A unit that
never signals now bails at the start-grace with a diagnostic naming the cause.

### 🔴 Why the command is sent after a plain delay

`sendText()` immediately after `createTerminal()` is silently discarded by a
shell that is still initialising — that is the original swallow, and it cost a
unit its entire timeout.

The obvious fix is VS Code's shell-integration signal
(`onDidChangeTerminalShellIntegration`), which reports when the shell is ready.
**Do not use it here.** A unit runs `claude` as an interactive **TUI**, and
shell integration activates before the PTY has settled — the TUI then fails to
initialise and the unit does nothing at all: no session, no sentinel, silence
until the start-grace expires. It is a *worse* failure than the swallow,
because every unit fails rather than an occasional one.

Falsified directly: the same command queued twice through the extension, once
with stdout on the TTY and once redirected to a file. The redirected run
(claude in headless mode) completed; the TTY run never did. A bare `sendText`
sent immediately ran the TUI fine, which rules the TUI itself out.

So: a plain `VZT_VSCODE_SEND_DELAY_MS` delay (default 1200ms). Raise it on a
slow machine; do not replace it with a readiness event.

PASS/FAIL is written back to the same `state/` dir as `<unit>.status`.

### The Ship Run tree

The extension contributes a **VZT Ship** activity-bar view listing every unit
of the current run with live status, backed by a persistent record the CLI
writes to `~/.vzt/vscode-mux/units/` (the queue record is deleted on launch to
guarantee exactly-once, so it cannot also be the tree's source of truth).

Per unit: **Focus Terminal**, **Open Worktree Diff** — which adds the unit's
worktree as a workspace folder so you can read its diff *while it is still
being written* — and **Re-run Oracle**, which runs the unit's recorded
`machineCheck` verbatim, never a retyped approximation.

Reading a running agent's diff in the editor is the thing an external
multiplexer structurally cannot offer, because its panes live outside the
editor process.

### Environment

| variable | default | what it does |
|---|---|---|
| `VZT_MUX` | `orca` | default backend when `--mux` is omitted |
| `VZT_VSCODE_DIR` | `~/.vzt/vscode-mux` | root of the filesystem contract |
| `VZT_START_GRACE_MS` | `90000` | how long to wait for a unit to show life before giving up on it |
| `VZT_VSCODE_SEND_DELAY_MS` | `1200` | fallback delay before sending, when shell integration is unavailable |
| `VZT_VSCODE_DRAIN_GRACE_MS` | `8000` | how long dispatch waits for the extension to consume a queue record |
| `VZT_VSCODE_SKIP_PERMISSIONS` | `1` | set `0` to keep permission prompts in unit terminals |

### Backend parity

| | orca | herdr | vscode |
|---|---|---|---|
| two-phase wait (start → idle) | ❌ | ✅ | ✅ |
| `blocked` visible | ❌ | ✅ | ✅ |
| skip-permissions for unsupervised panes | ❌ ¹ | ✅ | ✅ |
| in-editor worktree diff / tree | ❌ | ❌ | ✅ |

¹ `orca worktree create` exposes only `--agent <id>` and `--prompt <text>`,
with no way to forward flags to the launched agent. The documented escape
hatch is `orca terminal create --command "<cmd>"`; moving dispatch onto it is
the real fix and is not yet done. Until then an orca unit that hits a
permission prompt will hang. Orca is also still the default when neither
`--mux` nor `VZT_MUX` is set — the CLI now says so out loud when it falls
through to it.

### Setup

```bash
cd vscode
npm install
npm run compile
```

Then load it either via the **Extension Development Host** (open the
`vscode/` folder in VS Code and press `F5`), or by packaging it and using
**"Developer: Install Extension from Location…"** from the Command
Palette. Keep a VS Code window open while a ship run is in flight — the
extension watches `~/.vzt/vscode-mux/queue/` globally, not per-workspace.

All three lifecycle hooks are wired automatically by `vzt-agent install`.
Verify with `vzt-agent doctor` — you should see the sentinel wired on
**`SessionStart`, `PermissionRequest` and `Stop`**. Seeing only `Stop` means an
install that predates the lifecycle sentinels: re-run `vzt-agent install`,
which now refreshes a managed hook whose command changed instead of leaving the
stale one in place.

### Known constraint (by design, not a bug)

VS Code doesn't let extensions rename a terminal tab after it's created, so
per-unit PASS/FAIL does **not** show up on the tab itself. Status lives in the
**Ship Run tree**, the **"VZT Ship" output channel**, and a **status-bar
tally** (`VZT ship: 2 ✓  1 ✗`) — check those, not the tab labels.

### Graceful degrade

If the extension isn't installed or isn't running, `--mux vscode` still
creates each unit's worktree and prints the per-unit `cd <worktree> &&
claude ...` command to the console (the same shape `ship-dispatch` prints for
its dry-run), so you can open one terminal per unit by hand. In that case
`ship-watch` bounds its idle-wait to a few seconds per unit instead of the
full unit timeout, then verifies against the worktree. `--mux herdr`
([Part 2](#part-2--dock-existing-herdr-in-the-integrated-terminal-works-today-zero-build))
remains available as the mature alternative.
