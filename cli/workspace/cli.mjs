#!/usr/bin/env node
// `vzt-agent projects|worktree <verb>` — project registry and agent worktrees.
// Contract: .vzt/ship/vscode-orca-workspaces/SPEC.md ("Workspace CLI (u2)").
// Exit codes: 0 ok, 2 usage/not found, 4 conflict. stdout is JSON only with --json.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  WorkspaceError, registryPath, addProject, removeProject, listProjects,
  createWorktree, removeWorktree,
} from './projects.mjs';

const USAGE = `usage:
  vzt-agent projects add <dir> [--name N] [--base REF] [--json]
  vzt-agent projects remove <name> [--json]
  vzt-agent projects list [--json]
  vzt-agent worktree create --project N --name SLUG [--base REF] [--json]
  vzt-agent worktree remove --project N --name SLUG [--force] [--json]`;

const OPTIONS = {
  name: { type: 'string' },
  base: { type: 'string' },
  project: { type: 'string' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
};

function usage(msg) {
  return new WorkspaceError(2, `${msg}\n${USAGE}`);
}

function req(values, name) {
  const v = values[name];
  if (v === undefined || v === '') throw usage(`--${name} is required`);
  return v;
}

function formatList(projects) {
  if (!projects.length) return 'no projects registered';
  const lines = [];
  for (const p of projects) {
    lines.push(`${p.name}  ${p.root}  base=${p.baseRef}${p.exists ? '' : '  (missing)'}`);
    for (const w of p.worktrees) {
      lines.push(`  ${w.main ? '*' : '-'} ${w.branch ?? '(detached)'}  ${w.path}`);
    }
  }
  return lines.join('\n');
}

function run(group, verb, positionals, values, file) {
  if (group === 'projects') {
    switch (verb) {
      case 'add': {
        if (positionals.length !== 1) throw usage('projects add takes exactly one <dir>');
        const p = addProject(file, positionals[0], { name: values.name, base: values.base });
        return [p, `added ${p.name}  ${p.root}  base=${p.baseRef}`];
      }
      case 'remove': {
        if (positionals.length !== 1) throw usage('projects remove takes exactly one <name>');
        const p = removeProject(file, positionals[0]);
        return [p, `removed ${p.name} from the registry (disk untouched)`];
      }
      case 'list': {
        if (positionals.length) throw usage('projects list takes no arguments');
        const list = listProjects(file);
        return [list, formatList(list)];
      }
      default:
        throw usage(`unknown projects verb "${verb ?? ''}"`);
    }
  }
  if (group === 'worktree') {
    if (positionals.length) throw usage(`worktree ${verb ?? ''} takes no positional arguments`);
    const opts = { project: req(values, 'project'), name: req(values, 'name') };
    switch (verb) {
      case 'create': {
        const wt = createWorktree(file, { ...opts, base: values.base });
        return [wt, `created ${wt.path} on branch ${wt.branch} from ${wt.base} (${wt.head})`];
      }
      case 'remove': {
        const wt = removeWorktree(file, { ...opts, force: Boolean(values.force) });
        return [wt, `removed ${wt.path} (branch ${wt.branch} kept)`];
      }
      default:
        throw usage(`unknown worktree verb "${verb ?? ''}"`);
    }
  }
  throw usage(`unknown command "${group ?? ''}"`);
}

export function main(argv, io = { out: process.stdout, err: process.stderr }) {
  try {
    const [group, verb, ...rest] = argv;
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      throw usage(err.message);
    }
    const [result, text] = run(group, verb, parsed.positionals, parsed.values, registryPath(process.env));
    io.out.write((parsed.values.json ? JSON.stringify(result) : text) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      io.err.write(`vzt-agent: ${err.message}\n`);
      return err.code;
    }
    io.err.write(`vzt-agent: ${err.stack || err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
