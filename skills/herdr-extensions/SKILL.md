---
name: herdr-extensions
description: Work on anything that talks to herdr — the herdr-extensions package, the herdr-edit editor fork (the "tiny VS Code for herdr" stack), or a herdr API client such as the Herdr Fleet view in vzt-agent-protocol/vscode. Loads the invariants that fail SILENTLY across this stack (launchd PATH, quoted templated paths, keybinding collisions, bash 3.2, tail-like and hard-wrapped pane reads, agent.prompt not submitting multi-line text) plus the required verification gate. Use whenever touching ~/github-projects/herdr-extensions, ~/github-projects/herdr-edit or vzt-agent-protocol/vscode/src/herdr, adding or changing a panel, editing keybindings, calling the herdr socket API, or debugging a herdr plugin action or prompt that "does nothing".
---

# herdr-extensions / herdr-edit

Two PUBLIC repos under `vonzelle-vzt`, MIT, dogfooded on this machine:

| repo | what it owns |
| --- | --- |
| `~/github-projects/herdr-extensions` | the installer, 12 panels, keybindings, skins, geometry |
| `~/github-projects/herdr-edit` | the editor itself (fork of `cloudmanic/spice-edit`) — LSP, tree, wrap |

Both have a `CLAUDE.md` at their root. **Read it before editing** — it carries the full detail; this
skill is the short list of things that will bite you within the first hour.

A third consumer speaks the same daemon from outside the terminal:
`vzt-agent-protocol/vscode/src/herdr` — the Herdr Fleet view and its review loop, a pure API client
over the unix socket. It shares no code with the two repos above, but it shares the daemon, so the
API traps below (#6 especially) apply to it verbatim. Its own hard-won notes live in
`.claude/docs/VSCODE.md` — `docs/` at the root of the vzt-agent-protocol checkout itself — plus the
live review gate (`npm run test:live`) and the module headers.

## Before anything else

- Edit the package, then re-run `herdr-extensions install`. **NEVER** hand-edit
  `~/.config/herdr/plugins/local/herdr-extensions/` — it is regenerated from `plugin/` and `libexec/`.
- `herdr-extensions doctor` after every change. It names the specific failure and exits non-zero.
- The gate is `./tests/live-check.sh` — its own live oracles plus **six** delegated offline suites
  (`check-panels`, `check-viability`, `check-project-resolve`, `check-image-paste`, `check-preview`,
  `check-deps`, `check-review`, `check-runtime-diagnostics`) and `check-sizing.py`. It delegates rather than reimplements, so there is one
  definition of every check; it once ran none of them and was green anyway.
  **Without a live herdr server the live oracles cannot run** — say so rather than reporting the
  gate as passed. The offline suites (96 oracles across EIGHT suites — add check-review and check-runtime-diagnostics) still run standalone.
- herdr-edit uses `make test` (14 packages, `-race`).

## 🔴 Failures with no error message

These have each shipped broken. None of them logs anything.

1. **launchd PATH.** The herdr server execs plugin panes/actions with
   `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. No Homebrew, no `~/.local/bin`. A bare `spiceedit`, `lazygit`,
   `chafa`, `pngpaste` or `rg` **never resolves and the action does nothing**. Use `@@TEMPLATE@@`
   placeholders rendered to absolute paths at install time. (`rg` is often a *shell function* too.)
2. **Quote templated paths.** `@@CHROME@@` → `/Applications/Google Chrome.app/...` has **spaces**.
   `CHROME=@@CHROME@@` assigns `/Applications/Google` and tries to execute the rest; the panel then
   claims "Chrome not found" forever. Always `CHROME="@@CHROME@@"`.
3. **Keybindings silently override herdr built-ins.** herdr reserves ~39 prefix keys and a
   `[[keys.command]]` just kills the built-in. `prefix+r` is the **only** resize binding herdr ships —
   taking it removes pane resizing entirely, which presents as "the divider won't move", not as a
   keybinding problem. `install` refuses on a clash; trust it when it does.
4. **`/bin/bash` is 3.2.57** and mis-parses an apostrophe inside a heredoc nested in `$( )`. The script
   silently fails to parse. Write "does not" not "doesn't" inside heredocs.
5. **Tab is IFS whitespace.** `IFS=$'\t' read` drops empty fields and shifts every value left. Use
   `\x1f` for the `active.json` contract.
6. **`agent.prompt` does not SUBMIT multi-line text, and returns ok anyway.** Measured on herdr
   0.7.5 against a live Claude Code agent: a single line submits (`idle` → `working` within 2s), but
   multi-line text arrives in the composer as `[Pasted text #1 +13 lines]` and **sits there** — still
   idle 30s later, while the call returned `ok` in 153ms. Follow every `agent.prompt` with
   `agent.send_keys {keys:["enter"]}`; sending `enter` to a pane holding exactly that stuck paste
   submits it at once. Unconditionally, not only-if-still-idle: polling races a fast agent, and a
   spare `enter` hits an empty composer and does nothing. 🔴 **Single-line probes all pass**, so this
   survives every cheap test and breaks only the multi-line shape a real feature sends. A byte-level
   test against a fake daemon cannot see it either — the bytes are correct. Only firing one at a real
   agent and then **reading the pane** shows it.
   Also: **`target` is a `pane_id` and nothing else.** Probe it read-only with `agent.get`, which
   takes the same target string — `w5G:p1` resolves, while the workspace label, the workspace id and
   the terminal title each answer `agent_not_found`. Never resolve a display name into a target; a
   miss sends the payload to the wrong agent.

## Testing traps specific to herdr

- **`herdr pane read --lines N` is tail-like.** The file tree draws at the *top*, so `--lines` reads
  blank rows. One oracle reported "no icon glyphs (expected if no Nerd Font)" while 11 glyphs were on
  screen — a false negative with a plausible excuse is worse than a failure. Omit `--lines`.
- 🔴 **A pane read is a RENDERING, so its text is HARD-WRAPPED at the pane width** — a multi-word
  regex can straddle a newline and silently never match. A trust-prompt matcher written from how the
  dialog *looks* (`Is this a project you created or one you trust`) never fired, because the pane
  holds `…you created or\none you trust?`; the dialog was never dismissed and the run died 90s later
  blaming an unrelated stage. Match SHORT fragments that cannot wrap (`Yes, I trust this folder`),
  and never grep a pane for a sentence you only saw rendered. Same family as `--lines`: what is on
  screen is not the string you had in mind.
- 🔴 **Readiness must be POSITIVE ("X is on screen"), never an ABSENCE ("no dialog is on screen").**
  A fresh `claude` draws a startup screen *before* its trust dialog, so an absence check passes in
  the gap and the next `agent.prompt` fails `agent_not_ready: not an active named agent`. herdr
  reports `idle` the whole time and `agent.wait --until idle` returns happily — from the daemon's
  side nothing is running, the dialog is just a program drawing characters. **No daemon-side signal
  can see a modal; only the pane can.** Wait for the composer footer, not for the dialog to go.
- **A freshly split pane is not yet at a shell prompt.** `agent.start` answers `agent_pane_busy`,
  which reads as "pane in use" rather than "not ready yet". Retry against a deadline — shell startup
  time depends on the user's rc files, so a slept constant is a guess that fails on someone else's
  machine. Tear down staging in a `finally`, including the failure path: record the pane the moment
  it is created, or a throw between the split and the agent leaks a pane and a temp dir.
- 🔴 **`pane.read` over the SOCKET needs `source` and answers `result.read.text`** — the CLI hides
  both. `herdr pane read <id>` prints rendered text, while the same call over the socket without
  `source` is rejected outright. Read a guessed field and you get `undefined`, which contains no
  marker you are searching for, so the assertion **passes while looking at nothing**.
- **`plugin action invoke` has no `--pane`** — it always resolves the *globally* focused pane.
  `pane zoom` cannot cross workspaces; use `workspace focus`. A harness that steals focus must restore it.
- **`pane send-keys` cannot test herdr keybindings.** It writes to the pane's PTY, while herdr
  intercepts `ctrl+b` from the terminal input stream first. It *can* test keys the pane app owns.
- **Bound any oracle that guards a hang.** macOS has no `timeout`; background-and-poll. An unbounded
  oracle hangs the gate instead of failing it, and a hanging gate is no better than one never run.
- **Confirm a new oracle goes RED** against the unfixed code before trusting it green.
- 🔴 **An oracle that restates a list cannot police that list.** Oracle 23d hardcoded the panel
  labels image-paste must exclude. It named a `Files` panel that no longer existed and never named
  `Preview`, which did — so the Preview pane was a legal target for a pasted path and the gate was
  structurally blind to it. Derive the list from `plugin/herdr-plugin.toml` (`[[panes]]` titles).
  Same rule as the geometry constants: parse the source of truth, never restate it.
- 🔴 **`timeout` DOES NOT EXIST on macOS.** `timeout 8 herdr pane list && echo up || echo down`
  always reports "down" — *command not found*, not a dead server. This produced a false "no herdr
  mux is live" reading and sent a whole ship run to the headless driver when panes were available.
  Background-and-poll instead, and never let a liveness probe conflate "tool missing" with "no".

## New spaces: the editor resolves the project from the LABEL

A new space starts in `$HOME` (herdr's `new_cwd`), so `open-panel.sh` cannot use the cwd and matches
the **workspace label** against `PROJECTS_ROOT`. Rules run exact → unique prefix → unique suffix →
unique delimited-substring, and every one is **unique-or-nothing**: two candidates means we do not
know, and opening the wrong checkout is worse than opening none.
🔴 A prefix-only matcher silently fails on owner-namespaced directories ("Prop Trading Tech" vs
`vzt-prop-trading-tech`) — the editor simply never appears, which reads as a broken extension.
⚠️ Do NOT make auto-open fall back to `PROJECTS_ROOT` when nothing resolves. It was tried, live
ORACLE 5 caught it, and it was reverted: a scratch or remote space would sprout an unwanted editor.

## Geometry (herdr-extensions)

One `GEOMETRY POLICY` block in `plugin/open-panel.sh` is the source of truth; both suites parse the
constants out of it. Strict split of duties:

- **viability guard** → "is a split possible at all?" `MIN_COLS + MIN_PEER`, a pure floor test.
  🔴 It must **never** test the requested width — doing so refused working splits across a 32-column band.
- **width clamp** → "how wide?" owns `MAX_FRAC`, the peer ceiling, and the request (a *preference*).

## The two contracts between the repos

- `active.json` (`internal/state/state.go`) — **editor → panels**. `{file,line,col,root}`, debounced
  150 ms, atomic rename. Read with `IFS=$'\x1f'`, never a tab.
- `open-request.json` (`internal/state/openreq.go`) — **panels → editor**. Written by
  `herdr-edit --open-at path:line[:col]`, consumed at the same single polled call site as
  `publishActive`. Guarded by a monotonic `seq`: without it the editor reopens the file on every
  event-loop tick and the cursor can never leave it.
  🏆 This is the competitive differentiator — every rival plugin is read-only, so jumping from a
  line in the agent's diff into a real editor is the thing none of them can do.

## Images: local herdr CANNOT take a Finder drop — do not try to fix it

herdr's own default config says `remote_image_paste = "ctrl+v"` is **"only active in
herdr --remote"**, and there is no local equivalent. The shipped answer inverts the problem: the
**Images panel** (`ctrl+b shift+i` → `image-paste.sh --watch`) polls the screenshot folder,
`~/Desktop` and `~/Downloads` and types each NEW image's path to the agent. Works in any terminal
and over SSH, because it depends on no terminal behaviour at all.
⚠️ It is deliberately **not** in `libexec/` — everything there is held to the active-file panel
contract and expected to terminate, and a watcher that terminates is not a watcher.

## The action menu scrolls — keep the offset shared

`menuModalRect` once took `menuLayout`'s natural height **unclamped**. Fine while the menu was
short; silently broken at 33 rows, where it wanted 43 lines and drew past the bottom of a 40-row
pane, taking Quit off screen with no indication. The menu is the PRIMARY surface (Terminal + tmux
swallow right-click), so it must work at the pane sizes this project targets.
🔴 ONE `menuScroll` offset drives the renderer AND both hit-tests. Add a third consumer and a click
will land on a different row than the one under the pointer. It opens at the top on purpose.

## LSP wire shapes: a try-then-fallback silently picks the wrong one

Three requests in this fork accept TWO payload shapes, and in each case the wrong one decodes
*without error*, so "unmarshal A, else unmarshal B" never reaches B:

- **documentSymbol** — a flat `SymbolInformation[]` unmarshals cleanly into the nested
  `DocumentSymbol` struct (name and kind match, `location` is ignored), leaving every symbol at
  line 0. The whole outline then points at the top of the file. **Probe for the discriminating
  `location` key.**
- **completion** — bare `CompletionItem[]` vs `CompletionList{items}`.
- **rename** — `changes` vs `documentChanges`.

Also: a `signatureHelp` parameter label is EITHER a string OR a `[start,end]` offset pair; and a
code action may answer with a **command** rather than edits — drop those, because executing one
needs `workspace/executeCommand` and an entry that silently does nothing is worse than none.

## Cmd+C types a literal "c" — not a bug in this stack

herdr defaults to `mouse_capture = true`, so a drag-select belongs to **herdr**, not to the host
terminal. Terminal.app therefore has no selection of its own, its Edit▸Copy is disabled, and macOS
falls the disabled shortcut through to the terminal view — which types `c`. herdr also defaults to
`copy_on_select = true`, so the drag already put the text on the clipboard and Cmd+C was never
needed. Ghostty binds `super+c` explicitly and does not show this. Fixes, in order of preference:
just select (already copied) · use Ghostty · set `mouse_capture = false` (costs herdr's mouse UI).

## Verify by RENDERING, not only by unit test

🔴 `ScreenPos` shipped computing `dx = gutter + col`, treating a rune index as a screen cell. A hard
tab is not one cell, so on any tab-indented line every overlay (diagnostics underline, Error Lens
message, inline blame) landed left of its text and overwrote the end of the line. **Every unit test
passed** — they used unindented fixtures where the two coincide. Rendering the editor through a
`tcell.NewSimulationScreen` and reading the dump is what found it. Do that for anything visual.
Overlay column math must go through `LineVisualCol`/`RuneVisualWidth`, the same helpers `Render`
uses for the cursor — the cursor is what users verify by eye, so disagreeing with it is wrong.

`internal/lsp/live_gopls_test.go` drives all eight LSP requests against a REAL gopls and skips when
absent (`go install golang.org/x/tools/gopls@latest`). A decoder test proves the decoder handles the
JSON you wrote, not that a server sends it.

## Editor notes (herdr-edit)

- **Generated views are SYNTHETIC TABS, never temp files.** `internal/editor/synthetic.go`:
  `Synthetic=true` + `Label`, `Save()` refuses, `HighlightKey()` returns Label so a `.diff` suffix
  gets diff highlighting. A temp file would give the tab a real `Path`, and `Save()` would then
  write the user's edits into `/tmp`. This is also why the diff view is a tab and not a render
  mode — see the wrap lesson below.
- 🔴 **`c`, `x` and `v` MUST stay unbound in the leader table.** CLAUDE.md reserves them so the host
  terminal's Cmd+C/V is the only clipboard channel. Completion was briefly bound to `c` in
  violation of this and moved to `Esc SPACE` (VS Code's Ctrl+Space). A test asserts
  `leaderActionFor('c') == nil`. Leader taken: s u r w q n t / f p h d z g a k b o SPACE.

- Word wrap is a **separate geometry path** behind `Tab.Wrap` (`internal/editor/wrap.go`). Render,
  HitTest, EnsureVisible, clampScroll and 21 uses of `ScrollX` all assume one line == one row. Never
  thread wrapping through them.
- `lineSegments` must never emit a zero-width segment — that is an infinite loop, not a glitch.
- `segmentOfCol` ↔ `colAtSegmentVisual` must round-trip or clicks land on the wrong character.
- LSP counts **UTF-16 code units**; the buffer counts **runes**. Identical for ASCII, so a mistake
  survives testing until a line has an emoji. Convert at the boundary only.
- 🔴 **A tested engine is not a shipped feature, and this has happened twice.** `hover` and
  `definition` sat complete, tested and advertised in `initialize` with **zero call sites** for
  months. Then `Tab.Replace` / `ReplaceAll` / `SetFindOptions` were found the same way — fully
  unit-tested, named as a headline feature in README.md *and* FORK.md, every caller a `_test.go`.
  The find bar had no replace field, so `findOptions()` always returned the zero value and the
  editor silently behaved exactly like upstream. `FindErr` was set by the engine and read by nobody,
  so a bad regex reported "no results". Before believing any feature here works:
  `grep -rn "\.Method(" --include="*.go" . | grep -v _test.go` must return a real call site.
  A row in a feature table is a claim about the **UI**; only a non-test caller substantiates it.
- Merging `main` **cuts a release** (tag → GoReleaser → brew formula). Set `internal/version/version.go`
  explicitly for a minor/major, or CI auto-bumps the patch. A locally built binary then goes stale
  silently while staying first on `PATH`; `doctor` compares it against the tapped formula.
- 🔴 **Never write the CI-skip marker in a commit message you want CI to run on.** GitHub scans the
  whole message, body included, so explaining it in prose opts the commit out — producing no
  workflow runs at all, which reads as a broken trigger. Describe it, never spell it.
- 🔴 **`gh pr create` bypasses both push guards**, because it runs no git operation at all. In a repo
  GitHub knows is a fork it defaults its *base* to the parent, opening the PR against
  `cloudmanic/spice-edit`. `scripts/install-guards.sh` now pins gh's default repo; re-run it after a
  fresh clone (hooks and local config are not cloned), or pass `--repo vonzelle-vzt/herdr-edit`.

## Supervising a ship run in these repos

- 🔴 **A worker's PASS is a claim, and one has already been false here.** A unit returned
  `filesWritten: [tests/check-runtime-diagnostics.sh]` and pasted 11 passing assertions *from that
  file*. The file was never on disk — not in a worktree, not stashed. Its two **modified** files
  landed; the **new** one did not. `ls` every `"op": "new"` path in the manifest before believing a
  verdict, and re-run the load-bearing oracle yourself.
- **Per-unit oracles are local and cannot see the house rules.** Units passed their own checks while
  breaking oracle 16b (apostrophes in a heredoc) — only the whole-repo integration gate caught it.
  Never let a run end on per-unit green.
- **Brief the repo's rule, not your paraphrase of it.** A brief saying "no apostrophe inside a
  heredoc *nested in `$( )`*" is narrower than oracle 16b, which forbids them in **any** heredoc —
  so a worker complied with the brief and failed the gate. Quote the invariant verbatim.
- **Check a new keybinding against the USER's own `[[keys.command]]` entries, not just herdr's 39.**
  `prefix+shift+c` is free in herdr and taken here by `persiyanov.reviewr`; `doctor --keymap` is what
  catches that. Compute the free set rather than guessing it.

## Deploying — a release is not a shipped fix

Releasing the editor does **not** update the editor herdr launches, and nothing warns you:

1. `render_plugin()` bakes an **absolute path** into the manifest at install time. Here that
   resolved to `~/.local/bin/herdr-edit` — a *source build*, first on `PATH`, which brew never
   touches. Observed live: tap and brew at 0.6.0, manifest pointing at a 0.5.7 source build, so the
   panel opened an editor without the feature that had just shipped.
2. So after releasing: `go build -o ~/.local/bin/herdr-edit .`, re-run `herdr-extensions install`,
   then `doctor` — it compares the binary on `PATH` against the tapped formula and says "is current".
3. Verify the **artifact**, not the tree: resolve the binary out of the installed manifest and check
   it, e.g. `strings "$BIN" | grep 'bad pattern'`.
- 🔴 **Current Homebrew refuses untrusted third-party taps** — *"Refusing to load formula … from
  untrusted tap"*. Needs `brew trust <tap>`. It reads like a broken formula and is not one.
- herdr-extensions releases are **hand-cut**: bump `VERSION` + `plugin/herdr-plugin.toml`, push, tag,
  *then* recompute the formula `sha256` from the tag tarball (it cannot exist before the tag). Oracle
  25e pins the three version strings; nothing pins the checksum, which fails at `brew install` time.

## Do not

- Patch or fork herdr. Work around missing herdr features from outside.
- Send herdr feature requests — its tracker takes reproducible bugs on a template only and auto-closes
  everything else. Absorb the gap here instead.
- Add a plugin system, a TOML library, or anything that belongs inside the editor.
