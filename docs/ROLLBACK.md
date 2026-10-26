# Rollback

This repo ships as an npm package (`vzt-agent-protocol`) and a VS Code
extension (`vzt-mux`). It has no hosted deploy, mobile app, or database
migrations.

## npm package

- Prefer shipping a fixed patch version. If a bad version was published, run
  `npm deprecate vzt-agent-protocol@<bad> "use <good>"`.
- Within 72 hours `npm unpublish` is possible but discouraged.
- Consumers pin back with `npm install -g vzt-agent-protocol@<good>`, then run
  `vzt-agent install` to restore hooks and agents from that version.

## VS Code extension

- Reinstall the previous VSIX: `code --install-extension vzt-mux-<good>.vsix --force`.
- Or republish the previous source with a higher version number.

## Local state

Router state lives in `~/.claude/vzt-router`, mux state in `~/.vzt/vscode-mux`,
and the bus in `~/.vzt/bus`. These are safe to delete to reset.

## Code

Revert the merge commit on `main` (`git revert -m 1 <merge-sha>`) and open a PR.

## Migrations

None. The bus SQLite schema is created by the CLI at runtime; roll back by
removing `$VZT_BUS_DIR` (messages are lost).
