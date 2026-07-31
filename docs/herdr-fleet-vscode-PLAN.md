# Build plan — herdr agent fleet, as a VS Code extension

Hand this file to Claude inside VS Code. It is self-contained: everything below was verified against
a live herdr 0.7.5 on 2026-07-30, not inferred.

---

## What you are building, in one sentence

VS Code becomes the **only window you look at** while herdr keeps running your agents invisibly in
the background — a sidebar showing the fleet, a terminal per agent, and a review loop that sends
line comments back to an agent.

## The one architectural decision — do not get this wrong

**The extension is a CLIENT. herdr stays the daemon. The extension must NEVER own the agent
processes.**

VS Code windows close, reload on every extension update, and die with the app. If the extension
spawns the agents, they die too. herdr already solves session persistence: a long-lived server owns
the PTYs and clients attach and detach freely. Verified: killing the terminal client left the server
running with every pane intact, and reattaching from a different terminal restored the whole session.

So herdr keeps doing exactly what it does now. The extension is a second head on the same daemon,
sitting alongside (or instead of) the terminal client.

```
You look at  →  VS Code
                   ↓  extension speaks the socket API
              herdr server (headless, survives everything)
                   ↓
                agents
```

---

## The API — verified, not guessed

**Transport:** a unix socket at `$HERDR_SOCKET_PATH`, default `~/.config/herdr/herdr.sock`.
Request/response is JSON with an `id`, and responses come back as `{"id":…, "result":{…}}`.

**Generate types, do not hand-write them:**

```bash
herdr api schema --json > src/herdr/schema.json
# schema advertises: protocol 17, schema_version 1
# schemas: request · success_response · error_response · event · subscription_event
```

Generate TypeScript from that schema as a build step. herdr is pre-1.0 and the protocol WILL move;
generated types mean a protocol bump breaks your build instead of your runtime.

**147 methods exist.** The ones this extension needs:

| Purpose | Method |
| --- | --- |
| Whole-world state in one call | `session.snapshot` |
| Push events (no polling) | `events.subscribe` — params `{subscriptions:[…]}` |
| Blocking wait for a state | `events.wait` — `{match_event, timeout_ms}` |
| List / inspect agents | `agent.list`, `agent.get` |
| Send a prompt, optionally awaiting a state | `agent.prompt` — `{target, text, wait:{until:[…], timeout_ms}}` |
| Raw agent I/O | `agent.read`, `agent.send_keys` |
| Focus | `agent.focus`, `pane.focus`, `workspace.focus` |
| Type text into a pane | `pane.send_text` |
| Structure | `workspace.list`, `tab.list`, `pane.list` |

**Agent states (the enum you badge on):** `idle · working · blocked · done · unknown`

**Events worth subscribing to:**
- `pane_agent_status_changed` → `{pane_id, workspace_id, agent_status, agent, display_agent, title, state_labels}`
- `pane_output_matched` — pattern matching on pane output
- `workspace_created`, `pane_created`, `pane_closed`, `pane_focused`, `tab_created`

`session.snapshot` returns `{agents[], panes[], tabs[], layouts[], focused_pane_id,
focused_tab_id, focused_workspace_id, protocol}`.

**CLI fallback.** Every method has a CLI equivalent (`herdr agent list`, `herdr api snapshot`, …).
Shelling out is a legitimate way to ship Stage 1 fast; migrate the hot paths to the socket later.

---

## What to build — four surfaces, and nothing else

### 1. Fleet tree view (the reason this exists)

A `TreeDataProvider` in the sidebar: **workspaces → tabs → agents**. Seed from `session.snapshot`,
keep live from `events.subscribe`. Badge each agent with its status. Clicking focuses it.

This is the thing VS Code fundamentally cannot do today.

### 2. Status bar

`3 working · 1 blocked`. **The blocked count is the product** — it is the "who needs me right now"
signal, and it is the only reason to glance at a fleet at all. Clicking it reveals the first blocked
agent.

### 3. A terminal per agent

`vscode.window.createTerminal({ pty })` with a `Pseudoterminal` proxying to `herdr agent attach`.
Real interactivity, inside VS Code, on a session that outlives the window.

⚠️ **Prototype this one FIRST if you intend to build it at all.** Everything else is plain
request/response; this is the only part whose semantics inside a VS Code `Pseudoterminal` are
unproven. If it fights you, Stage 0 below already covers the need.

### 4. The review loop — where VS Code beats a terminal outright

Open the agent's diff in VS Code's **native diff editor** and use the **Comments API** — the same
one the GitHub PR extension uses — for line comments. One command collects them and ships them with
`agent.prompt`.

A terminal pane has no cursor, so terminal-based review tools make you type `path:line` by hand.
Here you get a world-class review UI for free. Build this second; it is the differentiator.

---

## What NOT to build — this is the discipline that keeps it shippable

**No Problems panel. No test runner. No search. No debugger. No git UI. No file tree.**

VS Code already does every one of those better. Rebuilding them is how a two-week project becomes a
two-month one that never ships. The extension is *only* the fleet layer and the review loop.

---

## Optional interop: two contracts that already exist

`herdr-edit` (the editor in the herdr-extensions stack) already speaks a two-way protocol. Implement
these two small JSON files and the extension interoperates with every existing herdr panel:

- **`$XDG_STATE_HOME/spiceedit/active.json`** — `{file, line, col, root}`, written debounced,
  temp-file + atomic rename. **Publish** it and the Blame / Markdown / Problems panels follow VS
  Code's cursor with no changes on their side.
- **`$XDG_STATE_HOME/spiceedit/open-request.json`** — `{file, line, col, seq}`, 1-based line/col.
  **Consume** it (poll, honour each `seq` exactly once) and a herdr panel can open a file in VS Code.
  Without the seq guard you will reopen the same file on every tick and the cursor can never leave.

Skip this if you are not running the herdr-extensions panels.

---

## Staging — ship each stage before starting the next

**Stage 0 — tonight, zero code.** Run `herdr` inside a VS Code integrated terminal. The fleet is now
inside VS Code. **Do this before writing anything.** A week of it tells you which of the stages below
you actually want, far more reliably than reasoning about it.

**Stage 1 — a weekend. Read-only.** Tree view + status bar over `session.snapshot` +
`events.subscribe`. No writes, nothing to break. This is the piece you will use hourly.

**Stage 2 — the differentiator.** Diff + Comments API → `agent.prompt`.

**Stage 3 — interop.** The two JSON contracts above.

**Stage 4 — only if Stage 0 left you wanting it.** Per-agent pseudoterminals via `agent attach`.

---

## Acceptance checks — pick these BEFORE writing each stage

A check invented after the code exists tests what was built, not what was asked.

- **Stage 1** — with three agents running, the tree shows exactly three, and changing one agent's
  state updates its badge **without a manual refresh** (proves you are on events, not polling).
  Killing and restarting the herdr server leaves the extension reconnecting rather than wedged.
- **Stage 2** — comments left on two different files arrive in the target agent as **one** message,
  and the target is the agent whose diff you reviewed, never a different one.
- **Stage 3** — writing an `open-request.json` with `seq` N opens the file once; polling again with
  the same `seq` does **not** reopen it.
- **Stage 4** — typing in the VS Code terminal reaches the agent, and closing the VS Code window
  leaves the agent still running (`herdr agent list` still shows it).

---

## Gotchas that will cost you a day each

1. **herdr is pre-1.0 at protocol 17.** Generate types from `herdr api schema --json` and check the
   `protocol` field at connect; refuse loudly on mismatch rather than failing subtly later.
2. **The socket is `srw-------`, user-only.** Fine locally; if you ever proxy it, that permission is
   the security boundary.
3. **Never let the extension spawn agents.** See the architecture note. If a design decision makes
   the extension the parent process, it is the wrong design.
4. **`session.snapshot` is a snapshot, not a subscription.** Use it once at connect, then rely on
   events. Polling it in a loop will work and will also be the thing you regret.
5. **Read the prior art first** — `ImArtisann/zed-herdr` (syncs herdr workspaces into Zed) and
   `nikok6/herdr-mirror` (mirrors herdr servers into a sidebar). Both have already hit whatever
   surprises this API holds.

---

## Adding to an existing extension

This is additive — no new extension host needed:

- `package.json` → `contributes.views` (one view container + tree view),
  `contributes.commands` (focus agent, open agent terminal, review diff, send comments),
  `contributes.configuration` (socket path override).
- `activationEvents` → activate on the view becoming visible, not `*`. A fleet panel nobody opened
  should cost nothing.
- Keep all herdr code under one `src/herdr/` folder with a single client module. One seam to the
  daemon means one place to fix when the protocol moves.
