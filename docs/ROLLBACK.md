# Rollback

This repo ships as an npm package (`vzt-agent`) and a VS Code extension
(`vzt-mux`). It has no hosted deployment and no database migrations.

## npm package

- Do not unpublish. Publish a fixed patch release, or move the dist-tag back:
  `npm dist-tag add vzt-agent@<previous-version> latest`.
- Deprecate the bad version: `npm deprecate vzt-agent@<bad> "use <previous>"`.

## VS Code extension

- Revert the offending commit on `main`, bump `vscode/package.json`, and
  re-run `npm run package:vscode`; install the previous `.vsix` locally with
  `code --install-extension vzt-mux-<previous>.vsix --force`.

## Installed protocol files in user projects

- `vzt-agent install` writes tracked files (see `.vzt-manifest.json`). Roll back
  by checking out the previous package version and re-running `vzt-agent install`.

## Database migrations

- None. The agent bus uses a local WAL SQLite file (`$VZT_BUS_DIR`, default
  `~/.vzt/bus`); to reset it, stop agents and move that directory aside.
