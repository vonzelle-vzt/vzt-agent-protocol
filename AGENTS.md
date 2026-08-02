# VZT Agent Protocol - Agent Instructions

This repo ships the execution-layer protocol for Claude Code routing, worker
briefs, ship orchestration, and the VS Code mux. Treat changes here as protocol
changes, not ordinary app edits.

## Commands

- Run the full local gate with `npm run verify`.
- Run the main test suite with `npm test`.
- Run the VS Code extension compile gate with `npm run compile:vscode`.
- Run audits with `npm run audit:root` and `npm run audit:vscode`.
- Check package contents with `npm run pack:dry`; local state, tests, and
  generated scratch data must not appear in the root package.

## Editing Rules

- Preserve the existing routing doctrine unless the change is backed by current
  official Claude Code or Codex docs, a failing test, or explicit user direction.
- Keep CLI behavior backward compatible for `install`, `doctor`, `stats`,
  `matrix`, and `ship-*` commands.
- Use the repo's existing Node ESM style and `node:test` coverage.
- Do not commit, push, publish, deploy, or mutate the sibling VZT protocol repo
  unless the user explicitly asks for that action.

## Claude And Codex Collaboration

- Claude Code owns product interpretation, orchestration, and user-facing
  synthesis.
- Codex owns bounded implementation, mechanical refactors, focused review, and
  local verification.
- Both agents review disk state, not each other's narrative: use `git diff`,
  targeted file reads, and the relevant command output.
- For substantial cross-agent work, write handoff state under `.vzt/team/`:
  `handoff.md`, `decisions.md`, `verification.md`, and dated review notes.

## Sibling Protocol Sync

The sibling checkout `../VZT-Tech-Consulting-Protocol` is the broader VZT
protocol source. When this repo changes routing doctrine, model tiers, worker
brief contracts, hook wiring, VS Code mux behavior, or ship orchestration,
mirror the corresponding docs/templates there in the same update pass.

The sibling repo may already have unrelated dirty work. Patch only the files
needed for sync, never overwrite local deletions or unrelated changes, and
summarize both repos' final `git status --short`.
