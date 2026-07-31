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

### Queue records are scoped to a window (fixed in 1.13.0)

`~/.vzt/vscode-mux/queue/` is ONE directory, but **every open VS Code window runs
its own extension host**, and each polls it. Observed 2026-07-29: 2 windows,
3 plugin hosts, all watching the same queue. That was two bugs at once:

- **Wrong-window routing.** Whichever host won the poll opened the terminal —
  possibly in a window you were not looking at, possibly running a different
  build of the extension. It is the likeliest reason identical runs behaved
  differently, and why a reload could refresh one host while an older one kept
  serving the queue.
- **Duplicate processing.** The claim was `readFileSync` then `unlinkSync` — two
  steps, so two hosts could both read a record before either deleted it and both
  open a terminal for the same unit.

Both are closed:

1. The CLI stamps each record with `workspaceRoot` (the spec's `root`), and a
   host claims a record only when that root matches one of its open workspace
   folders — containment in either direction, so a window opened on a subfolder
   or a parent still counts. The unit lands in the window that has the project
   open.
2. The claim itself is an atomic `rename`. Exactly one host wins; the loser gets
   ENOENT and moves on. This still matters when two windows legitimately have the
   same folder open.

A record with no `workspaceRoot` came from a CLI older than 1.13.0 and is claimed
by any host — a version mismatch must degrade to the old behaviour, not to a dead
queue.

If NO open window owns the project, nobody claims the record. The CLI says so
explicitly instead of blaming the extension, and deletes the record rather than
leaving it for some later, unrelated window to launch long after the run ended.

### Backend parity

| | orca | herdr | vscode |
|---|---|---|---|
| two-phase wait (start → idle) | ✅ ¹ | ✅ | ✅ |
| `blocked` visible | ❌ | ✅ | ✅ |
| skip-permissions for unsupervised panes | ✅ ² | ✅ | ✅ |
| re-dispatch onto an existing worktree | ❌ | ❌ | ✅ |
| read a RUNNING agent's output | ✅ `terminal read` | ❌ | ❌ ³ |
| rename a unit's tab | ✅ | ✅ | ❌ (VS Code API) |
| worktree diff / tree inside the editor | ❌ | ❌ | ✅ |

¹ Orca exposes no agent status states, so the start phase watches `terminal read`'s
monotonic `latestCursor` — output is proof of life. Written from Orca's documented
CLI contract and **not exercised end-to-end**; it degrades to the previous
single-phase wait if a cursor cannot be read.

² Via the two-step dispatch Orca itself prescribes for a custom argv:
`worktree create` **without** `--agent`, then
`terminal create --command 'claude --dangerously-skip-permissions …'`.
`worktree create --agent claude` uses Orca's built-in launcher, which accepts no
agent-specific flags. 🔴 The trap: a bare `worktree create` opens a **fallback
shell** as the first terminal, so the agent handle is the one returned by
`terminal create` — waiting on the shell reports idle instantly and grades the
unit before it starts.

³ The VS Code extension API gives no read access to terminal contents. The
protocol closes this differently and backend-agnostically: on a unit FAIL,
`verifyAndRecord` prints the oracle command, the oracle's own output, the
worktree, and the path to the agent's Claude Code transcript — or states that
none exists, which means the agent never started. A transcript also outlives the
terminal, so it beats scrollback for post-mortems.

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

## Part 4 — The Herdr Fleet view (herdr as a headless daemon)

Part 2 docks Herdr *inside* VS Code so you can look at it. Part 4 inverts
that: Herdr stops being something you look at and becomes a background
service, like `dockerd` or the `git` binary. You don't work out of `git` —
you use the Source Control panel and `git` does the work underneath.

Herdr does two jobs today: it **runs** your agents (a long-lived server that
owns the PTYs) and it **is the thing you look at** (panes, tabs, layout). The
Fleet view takes the second job away. A sidebar lists the same agents Herdr
is running, badged `working` / `blocked` / `idle` / `done`, with
`N working · N blocked` in the status bar.

**The blocked count is the product.** A working agent needs nothing from you;
a blocked one is stopped dead waiting on a human and will stay stopped until
someone notices. This exists so noticing costs a glance.

### The one architectural rule

**The extension is a CLIENT. Herdr stays the daemon and keeps owning every
agent process.** VS Code windows reload on every extension update and die
with the app; an agent parented to the extension host would die with them.
If a design decision makes the extension the parent process, it is the wrong
decision. The only write the Fleet view makes to Herdr is `pane.focus`.

Three methods are ever invoked: `ping`, `session.snapshot`, `pane.focus`.

### The API, as measured — not as documented

Verified by direct socket calls against a live **herdr 0.7.5, protocol 17**.
Four things that are widely assumed and are wrong:

| Assumption | Reality |
|---|---|
| ~147 methods | **89** (`schemas.request.oneOf.length`) |
| `agent.attach` is a socket method | **It is not.** `herdr agent attach <TARGET> [--takeover]` is CLI-only. A per-agent pseudoterminal must spawn the binary. |
| request/response is multiplexed | **One request per connection.** The server closes after answering: a second write throws `EPIPE`, a second read returns empty. |
| subscribe to `pane_agent_status_changed` | That subscription **requires a `pane_id`** — there is no global form. Subscribing per pane races every `pane.created`. |

**The finding the whole view rests on:** the global `pane.updated`
subscription takes no `pane_id` and carries the complete `PaneInfo` on every
change, `agent_status` included. One subscription is the entire live-status
mechanism. `events.subscribe` acks with `subscription_started` and then holds
the connection open, streaming newline-delimited `{event, data}` frames.

So the client has two connection modes, and this is protocol, not preference:
a fresh connection per RPC, and one long-lived connection for events.

The socket is `$HERDR_SOCKET_PATH`, default `~/.config/herdr/herdr.sock`,
mode `srw-------`. Note Herdr also has `HERDR_CLIENT_SOCKET_PATH` /
`herdr-client.sock` — a **different** socket that answers none of these
methods.

### Types are generated, never hand-written

Herdr is pre-1.0 and the wire protocol moves. `scripts/gen-herdr-types.mjs`
runs as part of `npm run compile` and regenerates `src/herdr/types.gen.ts`
from `herdr api schema --json`, emitting a `HERDR_PROTOCOL` constant. The
client pings on connect and **refuses to run** against a daemon reporting a
different number, naming both. A protocol bump breaks the build, not your
Tuesday.

Two things make the generator non-trivial, both asserted on every build
rather than assumed:

1. `herdr api schema --json` is **not a JSON Schema** — it is a container of
   five sibling schemas with no top-level `type`, whose `$ref`s point at
   `#/schemas/<name>/$defs/X`. Each must be hoisted to its own root and its
   refs localised.
2. Those five sub-schemas **repeat 27 shared `$defs`** between them
   (`AgentStatus`, `PaneInfo`, `LayoutNode`, …). Emitting them separately
   yields ~40 `TS2300: Duplicate identifier` errors. At protocol 17 all 27
   repeats are structurally identical, so they collapse into one flat
   namespace — and the generator *proves* that each build instead of trusting
   it. If two same-named defs ever diverge it fails loudly with both
   sub-schemas named.

### Two bugs worth remembering

**`pane_created` is not authoritative about agents.** Herdr emits
`pane_created` for a pane that *already exists*, carrying `agent: null,
agent_status: "unknown"` — agent detection runs afterwards and arrives via
`pane_agent_detected` / `pane_updated`. A reducer that treats it like
`pane_updated` and replaces wholesale silently drops a live agent out of the
tree until its next status change. It failed on the same pane every run,
which is what identified it as ordering rather than a race. The rule:
`pane_created` may never downgrade an agent already seen; `pane_updated`
still may, so a finished agent doesn't linger forever.

**Herdr's snapshot and its event stream can disagree, persistently.**
Measured: seed said `idle`, the stream then pushed `working` twice, and
`session.snapshot` reported `idle` continuously for 12s afterwards with no
corrective event. The model follows the **stream**, which is right for a live
view, but a badge can sit `working` after the daemon considers the pane idle.
Two corrections exist that are not polling: hiding and re-showing the view
(disconnect/reconnect always re-seeds), and the explicit **Herdr: Refresh
Fleet** command. Do **not** "fix" this with a `setInterval` snapshot — that is
the polling the design exists to avoid.

### Laziness is load-bearing

The extension activates on `onStartupFinished` because the ship queue
requires it. The Fleet layer has no such excuse, so the tree provider is
registered at activation but **nothing touches the socket** until the view
first becomes visible; the held connection is dropped again when it is
hidden. A fleet panel nobody opened costs nothing.

### Settings

| Key | Default | Meaning |
|---|---|---|
| `vztMux.herdr.enabled` | `true` | When off, no connection to the daemon is made at all. |
| `vztMux.herdr.socketPath` | `""` | Empty = auto (`$HERDR_SOCKET_PATH`, else the default path). |

### Verifying it works

```bash
herdr api snapshot | python3 -c "
import sys,json; s=json.load(sys.stdin)['result']['snapshot']
ag=[a for a in s['agents'] if a.get('agent')]
print(len(s['workspaces']),'workspaces,',len(ag),'agents')
[print(' ',a['pane_id'],a['agent'],a['agent_status']) for a in ag]"
```

The tree must show the same workspaces and agents with the same badges, and a
state change must update a badge **with no manual refresh** — that is what
proves you are on events rather than a timer. The only timers in
`src/herdr/` are a 50 ms redraw coalescer, a request timeout, and reconnect
backoff; a `grep -rn setInterval src/herdr/` hit anywhere else means someone
reintroduced polling.

### 🔴 A reload is not always a reload

`code --install-extension …vsix --force` updates the registry but does **not**
hot-swap code in a running extension host. With several VS Code windows open
there are several hosts, and reloading one leaves the others serving the old
build from the main process's extension cache — so the version *on disk*
differs from the version *running*, with no outward sign.

`activate()` writes `~/.vzt/vscode-mux/host.json` with the running version and
pid for exactly this reason. If it disagrees with `vscode/package.json`,
**quit VS Code entirely (`Cmd+Q`) and reopen** — reloading a single window is
not enough.

```bash
cat ~/.vzt/vscode-mux/host.json    # what is actually running
```

### Reference material

- **[`herdr-api-schema.protocol-17.json`](herdr-api-schema.protocol-17.json)** —
  a pinned snapshot of `herdr api schema --json` at protocol 17 (89 methods).
  This is a **reference for diffing**, not a source: the generator always calls
  the installed binary, so the types track the daemon you actually talk to.
  When Herdr bumps the protocol, diff the new schema against this one to see
  exactly what moved.
- **[`herdr-fleet-vscode-PLAN.md`](herdr-fleet-vscode-PLAN.md)** — the original
  build plan, kept for its staging and its "what NOT to build" discipline, both
  of which held up.

  ⚠️ **It is wrong on four points of fact**, each corrected in the table above
  and each caught by measurement rather than review: it claims 147 methods
  (there are 89), claims `agent.attach` is a socket method (it is CLI-only),
  implies multiplexed request/response (the server closes after every answer),
  and recommends subscribing to `pane_agent_status_changed` (which cannot be
  subscribed globally). Read this doc's Part 4 first; treat the plan as
  historical.

### Not built, deliberately

No Problems panel, test runner, search, debugger, git UI or file tree. VS Code
wins all of those and rebuilding them is how a two-week project becomes a
two-month one that never ships. Also not built yet: the diff + Comments API
review loop, per-agent pseudoterminals, and the `spiceedit`
`active.json` / `open-request.json` interop.
