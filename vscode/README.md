# VZT Ship Mux

A thin VS Code companion extension for the VZT Agent Protocol. It lets
`vzt-agent ship-watch --mux vscode` open each ship unit as a native VS Code
integrated terminal instead of a tmux pane.

## What it does

- Polls `~/.vzt/vscode-mux/queue/` for JSON files the CLI writes, one per ship
  unit. For each new file it creates an integrated terminal (with the unit's
  `cwd` and `env`), runs the unit's command, then deletes the queue file so it
  is processed exactly once.
- Polls `~/.vzt/vscode-mux/state/` for `<unitKey>.status` files (`PASS` or
  `FAIL`) the CLI writes as units finish, and reflects them into:
  - the **"VZT Ship"** output channel (`[PASS] <unitKey>` / `[FAIL] <unitKey>`)
  - a status bar item showing a running tally, e.g. `VZT ship: 2 ✓  1 ✗`
- Ignores `~/.vzt/vscode-mux/idle/*` entirely — those sentinel files are
  written by a separate shell hook, not this extension.

### Known VS Code constraint

A terminal's tab title **cannot be renamed** after creation, so this
extension never attempts it. Status is surfaced only via the output channel
and status bar described above, not via tab renames.

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

## Command

- **VZT: Watch Ship Run** (`vzt-mux.watchShipRun`) — reveals all known ship
  unit terminals. If none are active, shows an info message instead.

## Pairing with the CLI

This extension is the receiving end of:

```bash
vzt-agent ship-watch --mux vscode
```

The CLI is responsible for writing queue and state files per the filesystem
contract in this repo's ship-watch mux code; this extension only reads and
reacts to them.
