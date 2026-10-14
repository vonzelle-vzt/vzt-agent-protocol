# SHIP SPEC — vscode-agent-bus

> Written before code. Prose is for humans; the fenced JSON block is machine
> truth (`vzt-agent ship-check` validates it). Origin: 2026-10-14 session —
> "can Claude and Codex sit in two VS Code panes and talk like they do in
> Orca?", plus a 12-requirement architecture review. Every open question from
> that review is resolved below with its evidence; nothing is left to a builder's
> judgement.

## Contract

Two real CLI agents (Claude Code and Codex) run side by side in split VS Code
integrated terminals and exchange structured messages through a durable local
bus. Terminals are presentation and process hosts; they are never the message
bus. The only bytes ever typed into an agent terminal are one fixed ASCII wake
line and a bare Enter.

Done-state a stranger can check: every unit oracle passes offline;
`npm run compile:vscode && npm test` is green; and the live gate
`node test/live/bus-roundtrip-live.mjs` completes a real Claude → Codex → Claude
round trip with both wake-ups confirmed.

## Ownership (resolved)

- Repo: `vzt-agent-protocol` — it owns the VS Code extension (`vscode/`, vzt-mux
  0.6.0), `ship-watch --mux vscode`, the hook installer, and `test/`.
- NOT `vzt-orca-flow`: its CLAUDE.md forbids copying dispatch logic and forbids
  `pane` from growing a ledger. The only touch on that repo is READ-ONLY: a test
  here asserts our agent argv equals its `AGENT_ARGV`.
- No prior spec covers this. `vzt-orca-flow/.vzt/ship/vscode-parity` is VS Code
  *workflow* parity hosted in Orca (debugger, replace, format) — unrelated.

## Baseline (resolved before this spec was frozen)

- `npm test` was RED on main (4 failures): doctor read the real
  `~/.vscode/extensions`, where vzt-mux **0.6.2** — built from the unmerged
  branch `fix/mux-pane-layout` (d39c016, 2026-08-09) — is installed while main
  said 0.6.0; and a stale `hooks: 3 installed` assertion.
- That branch also edits `extension.ts`, `vscode/package.json` and
  `test/cli.test.mjs` — files this spec's units own. Probe: merged cleanly onto
  main in a scratch worktree, 230/231 green after compile.
- Resolved: merged into local main (`8057fbb`) and fixed the stale count
  (`0c6cb3c`). Baseline now: `npm run compile:vscode && npm test` → 231/231 pass.
  Not pushed. The merged tests run doctor under a temp HOME with a fake extension
  at the repo's version, so u3's version bump cannot redden them.
- NOTE: tests import `vscode/out/`, so compile BEFORE `npm test` (the
  integration gate does).

## Resolved questions (evidence)

| Question | Resolution | Evidence |
|---|---|---|
| SQLite from Node? | `node:sqlite` `DatabaseSync`. Installed Node 24.16 → SQLite 3.53.0, **no ExperimentalWarning** on stderr. Package `engines` stays `>=18`; `bus` refuses on Node without `node:sqlite` (exit 70, message names Node ≥ 22.13). | ran `node -e 'require("node:sqlite")…'`, empty stderr |
| Can the VS Code extension open the DB? | **It does not.** Electron's embedded Node is not guaranteed to ship `node:sqlite`. The extension only shells out to `vzt-agent bus … --json` (system Node). This also keeps the extension thin (req 1). | design decision; removes an unverifiable dependency |
| Do hooks see env vars set on the agent's terminal? | Yes, for both. Claude: existing `hooks/vzt-vscode-agent-state.sh` gates on `VZT_VSCODE_MUX`/`VZT_VSCODE_UNIT` and worked live 2026-07-28. Codex: Orca's own codex hook in `~/.codex/hooks.json` gates on `ORCA_PANE_KEY`. | files on disk |
| Codex lifecycle signal? | Codex 0.159 has hooks: SessionStart, UserPromptSubmit, PermissionRequest, Stop (same names as Claude). Hook stdin carries `session_id`, `turn_id`, `cwd`, `stop_hook_active`. | `~/.codex/hooks.json`; codex `hooks/src/events/stop.rs` |
| Codex hook trust | New/changed Codex hooks are **skipped until trusted** via `/hooks`; trust is recorded in `~/.codex/config.toml` as `[hooks.state."<hooks.json path>:<event_snake>:<i>:<j>"]` with `trusted_hash`. ⇒ the hook command string is a **byte-stable constant** (trust survives reinstalls); `bus doctor` reports untrusted entries; pairing refuses to launch Codex while its hooks are untrusted. | config.toml + developers.openai.com/codex/hooks |
| Stop-hook delivery for Claude? | YES. Claude Stop accepts `{"decision":"block","reason":…}`; Claude receives the reason and continues. Input has `stop_hook_active`; we block only when it is false (plus Claude's built-in 8-continuation cap). | code.claude.com/docs/en/hooks.md |
| Stop-hook delivery for Codex? | **NO — never.** openai/codex#20783: a Stop `decision:block` persists a local-UUID message that the Responses API later rejects (`invalid_id_prefix`), permanently wedging the session (reported on 0.136 and 0.144, nondeterministic, not marked fixed). Codex Stop hook prints nothing and exits 0. Codex is reached only by the wake line. | github.com/openai/codex/issues/20783 |
| Claude survey/dialogs eating input | Paired Claude terminals get `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`. Permission dialogs: house argv bypasses them; a `PermissionRequest` beat still marks the agent `blocked` → never woken. | code.claude.com/docs/en/env-vars.md |
| Codex update prompt eating input | Already handled by house argv (`check_for_update_on_startup=false`). | vzt-orca-flow CLAUDE.md, 2026-09-29 |
| Codex paste-burst (fast text + Enter = newline, not submit) | Codex 0.159 has paste-burst detection (`disable_paste_burst` key exists in the binary). We do NOT add flags (argv stays the house standard): the wake is typed **without** newline, then after **400 ms** a separate bare `\r`. Confirmation (below) proves it worked; a failed confirm retries Enter once. | `grep -a disable_paste_burst` on the 0.159 binary |
| Folder-trust dialogs in the live test | Live test runs inside the `vzt-agent-protocol` checkout (Codex `trust_level = "trusted"` already). Any agent that never becomes ready within 90 s FAILS the live gate with the PTY screen tail printed — never a silent skip. | `~/.codex/config.toml` line 18 |
| Hook PATH / Node-version drift | Hook command calls `vzt-agent` by name (inherited terminal PATH). An absolute nvm path would change on Node upgrades, which would change the command string and silently revoke Codex trust. | `command -v vzt-agent` → nvm path |
| A daemon? | **No daemon in this run** (deliberate deviation from the review's "separate process"). Every CLI call is a short-lived process doing one `BEGIN IMMEDIATE` transaction on a WAL SQLite file; leases are evaluated lazily at read time. State survives window reloads because it is on disk, not because something stays alive. Only wake-ups need a live watcher (the extension); if it is gone they wait — messages are never lost. | design; fewer failure modes |
| Orca integration (req 12) | Seam only, this run: if `ORCA_TERMINAL_HANDLE` is set, every `bus` verb except `doctor` exits 3 with "inside Orca, use `orca orchestration send/check/reply`". A real adapter is a later spec. No half-bridge. | `orca agent-context --json` lists orchestration send/check/ask/reply |
| `ship-watch` sentinels (req 9) | The bus uses leases + beats. The `.started/.idle/.blocked` sentinels stay untouched because `ship-watch --mux vscode` depends on them; migrating it is a follow-up spec. | `cli/vzt-agent.js` HOOKS + waitOnSentinels |

## Interfaces (the barrier — pinned here; units implement, never redesign)

### Storage
- Dir `$VZT_BUS_DIR` else `~/.vzt/bus` (mode 0700); DB `bus.db` (0600),
  `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`; every write in
  `BEGIN IMMEDIATE`. Schema version in `PRAGMA user_version` (= 1).
- Tables: `agents`, `messages`, `events` (append-only; every state change and
  wake attempt writes one row), `wakes`.
- Workspace = `realpath(git rev-parse --show-toplevel)` of cwd (or `--workspace`).

### Identity (req 2)
- `agents(agent_id TEXT PK uuid, workspace, alias, kind ∈ {claude,codex},
  session_id NULL, window_id, terminal_pid NULL, lease_expires_ms,
  state ∈ {launching,working,idle,blocked}, state_ts_ms, last_stop_ts_ms,
  last_prompt_ts_ms, created_ms)`; `UNIQUE(workspace, alias)`.
- `agent_id` is stable per (workspace, alias): re-registering reuses it and
  rotates nothing but window/terminal/session. Queued mail survives restarts.
- Registering an alias whose lease is live in a DIFFERENT window → exit 4.
- Lease TTL 30 s, renewed by `bus lease` (extension, only for terminals whose
  pid is alive). Expired lease ⇒ agent reported `stale`; registered > 90 s with
  no SessionStart beat ⇒ `never-started` (a dispatch failure, shown red).

### Messages, types, states (reqs 3–6)
- `messages(id TEXT PK uuid, seq INTEGER UNIQUE autoincrement, workspace,
  from_agent, to_agent, type, thread_id, reply_to NULL, subject, body,
  payload_json NULL, idem_key NULL, state, delivery_count, visible_after_ms,
  created_ms, updated_ms)`; `UNIQUE(workspace, from_agent, idem_key)`.
- Types: `message`, `task`, `question`, `reply`, `gate`, `report`.
- States and the ONLY legal transitions (one function enforces them; anything
  else exits 2 "illegal transition X→Y for type T"):
  - all types: `queued→delivered`, `queued→seen`, `delivered→seen`,
    `seen→acknowledged`, `seen→queued` (visibility-timeout redelivery only,
    `delivery_count+1`)
  - `task`: `acknowledged→completed|failed` (via `complete`, which also inserts
    a `report` linked by `reply_to`)
  - `question`: `seen|acknowledged→answered` (via `reply`)
  - `gate`: `seen|acknowledged→approved|rejected` (via `gate-resolve`)
- `delivered` = a wake-up for this recipient was CONFIRMED while the message was
  queued. `seen` = returned by the recipient's `check`. Seen-but-unacked
  messages become visible again after 300 s.
- Idempotency (req 5): `--key` is REQUIRED for `task`, optional otherwise; a
  repeat send with the same (from, key) returns the original id, exit 0,
  `"duplicate": true`.
- One task in flight: `check` never returns a second `task` to an agent while
  one of its tasks is `seen|acknowledged` (FIFO by `seq`).
- Limits: subject ≤ 200 chars, single line; body ≤ 64 KiB; payload must parse
  to a JSON object. Violations exit 2. Bodies are stored via bound parameters
  and only ever emitted as JSON.

### CLI — `vzt-agent bus <verb>` (u1 = `cli/bus/cli.mjs`; u2 wires the case)
Agent identity for agent-side verbs comes from env `VZT_BUS_AGENT` (agent_id).
All verbs accept `--json`; stdout is JSON only when `--json`; diagnostics go to
stderr. Exit codes: 0 ok, 2 usage/validation, 3 inside Orca, 4 conflict,
70 no `node:sqlite`.
- `register --alias A --kind K --window W [--workspace D] --json` → `{agent_id, alias, workspace}`
- `argv --kind K --json` → the house argv array (from `cli/agent-argv.mjs`)
- `bootstrap-prompt --alias A --peer P` → the fixed first prompt (below)
- `send --to ALIAS --type T --subject S [--body B | --body-file F] [--thread ID] [--reply-to ID] [--key K] [--payload JSON] [--cross-workspace D]`
- `check [--peek] [--wait] [--timeout-ms N]` → `{messages:[…], redelivered:[ids]}`
- `ack --id ID` · `reply --id ID --body B` · `ask --to A --subject S --body B [--timeout-ms N]` (blocks until answered; exit 5 on timeout)
- `complete --id TASK --outcome succeeded|failed [--body B]` · `gate-resolve --id ID --decision approve|reject`
- `agents --json` → registry with derived `liveness ∈ {live,stale,never-started}`
- `inbox --json` → threads for the sidebar (workspace-scoped)
- `lease --window W --agents id:pid[,id:pid…]` (extension; renews live pids)
- `wake-plan --window W --json` → `[{agent_id, alias, action ∈ {wake,retry-enter}, line, attempt_id}]` (only agents owned by W)
- `wake-sent --attempt ID`
- `hook <SessionStart|UserPromptSubmit|Stop|PermissionRequest>` (reads hook JSON on stdin)
- `doctor --json` → `{node_sqlite, db, claude_hooks, codex_hooks:{wired, trusted:[…], untrusted:[…]}}`

Cross-workspace (req 10): `send` to an alias not in the sender's workspace exits
2 unless `--cross-workspace <dir>` names it explicitly.

### Hooks (u1 logic, u2 wiring)
- `bus hook` exits 0 ALWAYS, even on internal error (writes to stderr). A broken
  bus must never wedge an agent. Missing `VZT_BUS_AGENT` ⇒ exit 0 immediately,
  before opening the DB.
- SessionStart → `working` (not `idle`: the bootstrap prompt is already
  running; the first `idle` comes from its Stop). UserPromptSubmit → `working`, `last_prompt_ts_ms=now`, and
  confirms any pending wake attempt newer than the previous prompt.
  PermissionRequest → `blocked`. Stop → `idle`, `last_stop_ts_ms=now`.
- Claude Stop (`VZT_BUS_KIND=claude`) with `stop_hook_active=false` and ≥ 1
  visible unread message: stdout `{"decision":"block","reason":"VZT: <n> new bus message(s). Run: vzt-agent bus check --json"}`.
  Otherwise print nothing.
- Codex Stop: print nothing, never block (codex#20783).
- Installed command (byte-stable; identical for all 4 events × 2 agents except
  the event name):
  `: vzt-bus-hook-form=1; [ -n "${VZT_BUS_AGENT-}" ] && exec vzt-agent bus hook <Event> || :`
  Claude: `~/.claude/settings.json` hooks, `_managedBy: "vzt-agent-protocol"`.
  Codex: appended to `~/.codex/hooks.json` (`$CODEX_HOME` honoured), timeout 10.
  Uninstall removes exactly the entries whose command contains
  `vzt-bus-hook-form=1`; Orca's `orca-agent-hook-form` entries are untouched.

### Wake protocol (reqs 7–8; decision in u1, typing in u3)
- `WAKE_LINE = "vzt: new bus message - run: vzt-agent bus check --json"`
  (ASCII, fixed, returned in `wake-plan.line`; never contains message data).
- `wake` iff ALL: owned by the polling window; lease live; state `idle`;
  `last_stop_ts_ms > last_prompt_ts_ms`; ≥ 1 visible unread message queued
  after the last confirmed wake; no unconfirmed attempt in the last 20 s; agent
  not marked `wake_unconfirmed`.
- Extension executes `wake`: `sendText(line, false)`, wait 400 ms,
  `sendText("\r", false)`, then `wake-sent --attempt`.
- Confirmed iff a UserPromptSubmit beat arrives within 20 s of `wake-sent` ⇒
  queued messages for that agent → `delivered`. Unconfirmed after 20 s ⇒ ONE
  `retry-enter` (bare `\r` only). Unconfirmed again ⇒ agent flagged
  `wake_unconfirmed` (sidebar warning); cleared by the next Stop beat. Every
  attempt and outcome is an `events` row.

### Agent argv (req 11)
- `cli/agent-argv.mjs` exports `AGENT_ARGV` = exactly vzt-orca-flow's:
  `claude: ["claude","--dangerously-skip-permissions"]`,
  `codex: ["codex","--dangerously-bypass-approvals-and-sandbox","-c","check_for_update_on_startup=false"]`.
  A test parses `../vzt-orca-flow/lib/vzt_orca_flow/core.py` (python3 `ast`) and
  asserts equality (skips only if the sibling checkout is absent).
- Launch = argv + one positional bootstrap prompt. Messages never store argv.
- Bootstrap prompt (fixed text, `<A>`/`<P>` substituted):
  `You are "<A>", paired with "<P>" over the VZT bus in this workspace. Talk to <P> ONLY via: vzt-agent bus send --to <P> --type message|task|question --subject ... --body ... ; read with: vzt-agent bus check --json ; ack each id with: vzt-agent bus ack --id ID ; answer questions with: vzt-agent bus reply --id ID --body ... ; finish tasks with: vzt-agent bus complete --id ID --outcome succeeded|failed. When you see "vzt: new bus message", run the check command. Now run: vzt-agent bus check --json`

### VS Code (u3)
- Commands: `vzt-mux.bus.pair` ("VZT: Pair Claude + Codex"),
  `vzt-mux.bus.refresh`. View `vztBus` (in the existing VZT Ship container):
  agents (liveness, state, wake warning) and threads.
- Setting `vztMux.busCommand` (default empty = auto-resolve, order below;
  launchd PATH lesson).
- Pair: `bus doctor` first — refuse with the doctor message if Codex hooks are
  untrusted or `node_sqlite` false; `register` both; create terminal `claude`,
  then terminal `codex` split beside it (`location: { parentTerminal }`); env
  `VZT_BUS_AGENT`, `VZT_BUS_KIND`, `VZT_BUS_WINDOW=vscode.env.sessionId`
  (+ `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` for claude). Command line =
  shell-quoted `bus argv` + `bus bootstrap-prompt`, sent through the existing
  `sendWhenReady` in `extension.ts` — a plain delay (`VZT_VSCODE_SEND_DELAY_MS`,
  default 1200 ms), deliberately NOT the shell-integration event, which was
  falsified for interactive TUIs. Generalise it minimally to take a command and
  label; ship-unit behaviour and `test/vscode-mux.test.mjs` stay unchanged.
- busCommand resolution order: setting `vztMux.busCommand`; else
  `$SHELL -lc 'command -v vzt-agent'`; else the existing `cliPath(context)`
  (`node <repo>/cli/vzt-agent.js`); else refuse with an install hint.
- Poll every 1500 ms: `lease`, then `wake-plan`; execute actions; refresh tree.
  Never more than one poll in flight.

## Failure cases → handling

| Case | Handling |
|---|---|
| Slow start / never ready | `never-started` after 90 s without SessionStart; no wake before first Stop. |
| Permission dialog / survey | `blocked` state or no fresh Stop ⇒ no typing; survey disabled by env. |
| VS Code reload with queued mail | Mail on disk. Terminals (and agents) die with the window; leases expire in 30 s; re-pair reuses agent_ids and the queue. |
| Crash after seen, before ack | Redelivered after 300 s with `delivery_count+1`; tasks deduped by key. |
| Restart with new terminal | Same agent_id, new pid/session. |
| Two senders, conflicting work | Tasks FIFO, one in flight per agent; real conflicts go through `gate`. |
| Message while generating | Not typed. Claude: Stop hook delivers at turn end. Codex: wake after its Stop. |
| Malformed / shell-like content | Validation exit 2; bound params; JSON-only output; wake line is a constant. |
| Multiple windows, same worktree | Wake only by the owning window; a second window registering a live alias exits 4. |
| TUI behaviour changes | Wake confirmation detects it (`wake_unconfirmed`); live gate re-run after agent updates; Claude still covered by Stop hook. |

## Out of scope

- A daemon/socket server; an Orca orchestration adapter (seam only); migrating
  `ship-watch` sentinels; cross-machine bus; task conflict detection beyond
  FIFO + gates; any change to `vzt-orca-flow`; Codex Stop-hook blocking;
  adding flags to the house agent argv.

## Units

- **u1-bus-core** — store, state machine, CLI verbs, hook logic, wake planner, argv.
- **u2-bus-install** (after u1) — `case 'bus'`, install/uninstall/doctor wiring for both agents.
- **u3-vscode** (after u1) — pair command, poller, wake executor, sidebar.
- **u4-live-docs** (after u2, u3) — PTY live round-trip harness, READMEs, gitignore.

Post-gate (chair, live, not an offline oracle): `vzt-agent install`, trust the
4 Codex hooks via `/hooks`, then `node test/live/bus-roundtrip-live.mjs` → exit 0.

<!-- vzt-spec — machine-readable truth. `vzt-agent ship-check <this file>` validates it. -->
```json
{
  "specVersion": 1,
  "slug": "vscode-agent-bus",
  "title": "VS Code agent bus: Claude + Codex in split panes over a durable local message bus",
  "root": "/Users/vonzellebrown/github-projects/vzt-agent-protocol",
  "contract": "Claude Code and Codex run in split VS Code terminals and exchange typed messages (message/task/question/reply/gate/report) through a WAL SQLite bus driven by `vzt-agent bus` verbs; explicit state machine, idempotency keys, leases, visibility-timeout redelivery, workspace boundaries; agent hooks report lifecycle; terminals receive only a fixed wake line plus a separate Enter, confirmed by a UserPromptSubmit beat; Claude also receives mail via a Stop-hook block, Codex never (codex#20783). Every unit oracle passes offline and `npm run compile:vscode && npm test` is green.",
  "outOfScope": [
    "daemon or socket server",
    "Orca orchestration adapter beyond the exit-3 seam",
    "migrating ship-watch .started/.idle/.blocked sentinels",
    "cross-machine bus",
    "task conflict detection beyond FIFO + gates",
    "any change to vzt-orca-flow",
    "Codex Stop-hook blocking",
    "new flags on the house agent argv"
  ],
  "manifest": [
    { "path": ".vzt/ship/vscode-agent-bus/SPEC.md", "op": "new" },
    { "path": "cli/bus/store.mjs", "op": "new" },
    { "path": "cli/bus/cli.mjs", "op": "new" },
    { "path": "cli/agent-argv.mjs", "op": "new" },
    { "path": "test/bus-core.test.mjs", "op": "new" },
    { "path": "test/agent-argv.test.mjs", "op": "new" },
    { "path": "cli/vzt-agent.js", "op": "modify" },
    { "path": "test/bus-install.test.mjs", "op": "new" },
    { "path": "vscode/src/bus/busCli.ts", "op": "new" },
    { "path": "vscode/src/bus/pair.ts", "op": "new" },
    { "path": "vscode/src/bus/wake.ts", "op": "new" },
    { "path": "vscode/src/bus/busTree.ts", "op": "new" },
    { "path": "vscode/src/extension.ts", "op": "modify" },
    { "path": "vscode/package.json", "op": "modify" },
    { "path": "test/bus-vscode.test.mjs", "op": "new" },
    { "path": "test/live/bus-roundtrip-live.mjs", "op": "new" },
    { "path": "test/live/pty_host.py", "op": "new" },
    { "path": "README.md", "op": "modify" },
    { "path": "vscode/README.md", "op": "modify" },
    { "path": ".gitignore", "op": "modify" }
  ],
  "units": [
    {
      "id": "u1-bus-core",
      "title": "Bus store, state machine, CLI verbs, hook logic, wake planner, agent argv",
      "agentType": "vzt-builder",
      "filesInScope": [
        ".vzt/ship/vscode-agent-bus/SPEC.md",
        "cli/bus/store.mjs",
        "cli/bus/cli.mjs",
        "cli/agent-argv.mjs",
        "test/bus-core.test.mjs",
        "test/agent-argv.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-agent-bus/SPEC.md in full; the 'Interfaces' section pins every table, state, transition, verb, exit code, constant and hook behaviour — implement it exactly, never redesign. ESM, Node stdlib only (node:sqlite DatabaseSync, node:test). cli/bus/store.mjs: open/migrate (user_version=1, WAL, busy_timeout 5000, BEGIN IMMEDIATE writes, dir 0700/db 0600 under $VZT_BUS_DIR or ~/.vzt/bus), the single transition() function enforcing the legal-transition table and writing an events row per change, idempotent send, FIFO check with one-task-in-flight and 300 s visibility-timeout redelivery, leases (30 s) and derived liveness (live/stale/never-started at 90 s), wake planner + confirmation per the Wake protocol (20 s confirm window, one retry-enter, then wake_unconfirmed until next Stop). Make the clock injectable (store option nowMs) so tests never sleep for timeouts. cli/bus/cli.mjs: export main(argv) and also run when executed directly; implements every verb in the CLI list with the pinned exit codes; refuse with exit 3 when ORCA_TERMINAL_HANDLE is set (except doctor); exit 70 when node:sqlite cannot be imported; `hook` reads stdin JSON, exits 0 always, no-ops before opening the DB when VZT_BUS_AGENT is unset, emits the Claude Stop block JSON only when kind=claude, stop_hook_active is false and unread>0, never for codex. doctor reads Claude settings (~/.claude/settings.json) and Codex hooks.json + config.toml [hooks.state.\"<path>:<event_snake>:<i>:<j>\"] trusted_hash to report wired/trusted/untrusted vzt-bus hooks (marker vzt-bus-hook-form=1); honour HOME and CODEX_HOME. cli/agent-argv.mjs: export AGENT_ARGV exactly as pinned, plus BOOTSTRAP_PROMPT(alias, peer) and WAKE_LINE constants. Tests: test/bus-core.test.mjs must contain node:test cases whose titles include EXACTLY these strings: 'orders FIFO', 'idempotent task send', 'illegal transition refused', 'redelivers after visibility timeout', 'lease expires', 'never-started after 90s', 'cross-workspace refused', 'shell-like body round-trips', 'concurrent writers lose nothing' (two child processes x 200 sends, assert 400 unique ids and strictly increasing seq), 'claude stop hook blocks once', 'codex stop hook never blocks', 'hook never fails', 'wake plan requires fresh idle', 'wake retry then unconfirmed', 'second window refused', 'one task in flight', 'orca seam exits 3'. Use temp VZT_BUS_DIR and temp git repos; no network, no real agents. test/agent-argv.test.mjs: parse ../vzt-orca-flow/lib/vzt_orca_flow/core.py with python3 ast.literal_eval of the AGENT_ARGV assignment and deepEqual; t.skip only if that file is absent.",
      "machineCheck": "node --test test/bus-core.test.mjs test/agent-argv.test.mjs && for t in 'orders FIFO' 'idempotent task send' 'illegal transition refused' 'redelivers after visibility timeout' 'lease expires' 'never-started after 90s' 'cross-workspace refused' 'shell-like body round-trips' 'concurrent writers lose nothing' 'claude stop hook blocks once' 'codex stop hook never blocks' 'hook never fails' 'wake plan requires fresh idle' 'wake retry then unconfirmed' 'second window refused' 'one task in flight' 'orca seam exits 3'; do grep -qF \"$t\" test/bus-core.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && D=$(mktemp -d) && printf '{}' | env -u VZT_BUS_AGENT VZT_BUS_DIR=$D node cli/bus/cli.mjs hook Stop && [ ! -e $D/bus.db ] && node cli/bus/cli.mjs argv --kind codex --json | grep -q check_for_update_on_startup=false && rm -rf $D",
      "expect": "exit 0"
    },
    {
      "id": "u2-bus-install",
      "title": "vzt-agent bus subcommand + install/uninstall/doctor wiring for Claude and Codex hooks",
      "agentType": "vzt-builder",
      "dependsOn": ["u1-bus-core"],
      "filesInScope": [
        "cli/vzt-agent.js",
        "test/bus-install.test.mjs",
        "test/cli.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-agent-bus/SPEC.md (Hooks + Interfaces). In cli/vzt-agent.js: add `case 'bus'` that awaits main(process.argv.slice(3)) from ./bus/cli.mjs and exits with its code. Add a BUS_HOOKS list (SessionStart, UserPromptSubmit, Stop, PermissionRequest) whose command is the byte-stable string pinned in the spec. install(): wire them into Claude settings.json (separate from the existing HOOKS loop, matched by the marker 'vzt-bus-hook-form=1' AND event, _managedBy 'vzt-agent-protocol', idempotent) and into $CODEX_HOME/hooks.json (default ~/.codex/hooks.json; create {\"hooks\":{}} if absent; append one {hooks:[{type:'command',command,timeout:10}]} group per event if no handler with the marker exists for that event; never touch other entries). uninstall(): remove exactly the marked entries from both files, drop empty groups, leave everything else byte-for-byte equivalent JSON. doctor(): add a 'bus' section printing the result of `bus doctor --json` and a clear action line when Codex hooks are untrusted: 'open codex, run /hooks, trust the 4 vzt-bus hooks'. Do not modify the existing HOOKS array or ship-watch code. Print the bus hooks on their OWN install summary line ('bus hooks: 4 claude + 4 codex ...') so the existing 'hooks: 4 installed' line and its assertion in test/cli.test.mjs stay valid; touch test/cli.test.mjs only if an existing assertion genuinely changes. Tests run doctor/install under a temp HOME (copy the TEST_HOME pattern from test/cli.test.mjs). test/bus-install.test.mjs (temp HOME and CODEX_HOME, runs `node cli/vzt-agent.js install` / `uninstall` as child processes) must contain test titles with EXACTLY: 'install wires claude bus hooks', 'install wires codex hooks with marker', 'install is idempotent', 'uninstall removes only marked entries', 'preserves orca codex hooks' (seed hooks.json with an orca-agent-hook-form=1 entry and assert it survives install+uninstall unchanged), 'hook command is byte-stable' (two installs produce identical command strings), 'doctor reports untrusted codex hooks', 'bus subcommand dispatches'.",
      "machineCheck": "node --test test/bus-install.test.mjs && for t in 'install wires claude bus hooks' 'install wires codex hooks with marker' 'install is idempotent' 'uninstall removes only marked entries' 'preserves orca codex hooks' 'hook command is byte-stable' 'doctor reports untrusted codex hooks' 'bus subcommand dispatches'; do grep -qF \"$t\" test/bus-install.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && grep -q \"case 'bus'\" cli/vzt-agent.js && D=$(mktemp -d) && VZT_BUS_DIR=$D node cli/vzt-agent.js bus agents --json | python3 -c 'import json,sys; json.load(sys.stdin)' && rm -rf $D",
      "expect": "exit 0"
    },
    {
      "id": "u3-vscode",
      "title": "VS Code pair command, poller, wake executor, bus sidebar",
      "agentType": "vzt-builder",
      "dependsOn": ["u1-bus-core"],
      "filesInScope": [
        "vscode/src/bus/busCli.ts",
        "vscode/src/bus/pair.ts",
        "vscode/src/bus/wake.ts",
        "vscode/src/bus/busTree.ts",
        "vscode/src/extension.ts",
        "vscode/package.json",
        "test/bus-vscode.test.mjs"
      ],
      "brief": "Read .vzt/ship/vscode-agent-bus/SPEC.md ('VS Code (u3)', 'Wake protocol'). The extension NEVER opens the DB and never hard-codes an agent command or the wake line: busCli.ts runs `<busCommand> bus <verb> ... --json` via child_process.execFile (resolution order pinned in the spec: setting, then `$SHELL -lc 'command -v vzt-agent'`, then the existing cliPath(context)), parses JSON, surfaces stderr on failure. pair.ts: command vzt-mux.bus.pair — run `bus doctor --json` and refuse (showErrorMessage with the doctor text) if node_sqlite is false or codex_hooks.untrusted is non-empty; `bus register` claude then codex with --window vscode.env.sessionId; get argv via `bus argv` and prompt via `bus bootstrap-prompt`; create terminal 'claude' then 'codex' with location {parentTerminal: claudeTerminal}; env per spec (CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 on claude only); launch the shell-quoted command through the existing sendWhenReady in extension.ts (plain delay, NOT the shell-integration event — read its comment); generalise it minimally to (terminal, cmd, label) without changing ship-unit behaviour. wake.ts: export a pure async executeWakeAction(action, terminal, sleep) that for 'wake' calls terminal.sendText(action.line, false), await sleep(400), terminal.sendText('\\r', false); for 'retry-enter' only terminal.sendText('\\r', false); then the caller runs `bus wake-sent --attempt`. Poller: every 1500 ms, never overlapping: `bus lease` with live terminal pids, then `bus wake-plan`, execute actions on the matching terminals, refresh tree. busTree.ts: view vztBus listing agents (liveness, state, wake_unconfirmed warning) and threads from `bus inbox`. package.json: contribute commands vzt-mux.bus.pair (title 'VZT: Pair Claude + Codex') and vzt-mux.bus.refresh, view vztBus in the existing VZT Ship container, setting vztMux.busCommand; bump version 0.6.2 → 0.7.0. test/bus-vscode.test.mjs imports compiled vscode/out/bus/wake.js (no vscode module needed — keep wake.ts free of `import * as vscode`) and reads vscode/package.json; titles must include EXACTLY: 'wake types plan line then separate enter', 'never types message content', 'retry-enter sends only enter', 'contributes pair command', 'extension never opens the db' (assert no 'sqlite' string in vscode/src/**).",
      "machineCheck": "npm --prefix vscode run compile && node --test test/bus-vscode.test.mjs test/vscode-mux.test.mjs && for t in 'wake types plan line then separate enter' 'never types message content' 'retry-enter sends only enter' 'contributes pair command' 'extension never opens the db'; do grep -qF \"$t\" test/bus-vscode.test.mjs || { echo \"missing test: $t\"; exit 1; }; done && ! grep -rqi sqlite vscode/src && ! grep -rq 'dangerously' vscode/src",
      "expect": "exit 0"
    },
    {
      "id": "u4-live-docs",
      "title": "Live PTY round-trip harness, READMEs, gitignore",
      "agentType": "vzt-builder",
      "dependsOn": ["u2-bus-install", "u3-vscode"],
      "filesInScope": [
        "test/live/bus-roundtrip-live.mjs",
        "test/live/pty_host.py",
        "README.md",
        "vscode/README.md",
        ".gitignore"
      ],
      "brief": "Read .vzt/ship/vscode-agent-bus/SPEC.md. test/live/pty_host.py (python3 stdlib pty/os/select only): spawn one agent argv under a PTY in a given cwd/env, keep a rolling screen buffer, accept newline-delimited JSON commands on stdin ({type:'text',data} written raw with no newline; {type:'tail'} prints the last 3000 chars as JSON). test/live/bus-roundtrip-live.mjs plays the VS Code extension without VS Code: run `vzt-agent bus doctor --json` and FAIL (exit 1, print why) if codex hooks are untrusted or node_sqlite is false; use a fresh VZT_BUS_DIR; workspace = this repo root; register claude and codex; launch both via pty_host with argv from `bus argv` + `bus bootstrap-prompt`, env per spec (VZT_BUS_AGENT, VZT_BUS_KIND, VZT_BUS_WINDOW='live', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 for claude); every 1500 ms run `bus lease` and `bus wake-plan --window live` and execute actions exactly as the extension does (line, 400 ms, '\\r'; retry-enter = '\\r'), then `bus wake-sent`. Scenario: as a third registered alias 'harness', send claude a task (--key live-1) telling it to `bus ask` codex for the value of 6*7 and write only the answer to .vzt/live-bus/<run>/answer.txt, then complete the task. Pass iff within 10 min: answer.txt contains 42, the task is completed/succeeded, and events show >= 1 confirmed wake for codex. FAIL with each PTY's screen tail if any agent is never-started at 90 s or a wake ends wake_unconfirmed. Always kill both PTYs on exit. README.md: a 'VS Code agent bus' section (what it is, `vzt-agent bus` verbs, install + Codex /hooks trust step, the Codex Stop-hook limitation with the codex#20783 link, how to run the live gate). vscode/README.md: a 'Pair Claude + Codex' section (command, sidebar, the window-reload caveat). .gitignore: add `.vzt/live-bus/`.",
      "machineCheck": "node --check test/live/bus-roundtrip-live.mjs && python3 -m py_compile test/live/pty_host.py && grep -q 'vzt-agent bus' README.md && grep -q '20783' README.md && grep -q 'Pair Claude' vscode/README.md && grep -qx '.vzt/live-bus/' .gitignore",
      "expect": "exit 0"
    }
  ],
  "integration": {
    "machineCheck": "npm run compile:vscode && npm test",
    "expect": "exit 0"
  }
}
```
