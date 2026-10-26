#!/usr/bin/env node
// Builds vscode/out before `npm test`. Many suites import the COMPILED
// extension (vscode/out is gitignored), so a fresh checkout or worktree failed
// them with "vscode/out/... missing".
//
// Runs plain `tsc -p vscode`, not `npm --prefix vscode run compile`: that
// script first regenerates src/herdr/types.gen.ts from the installed herdr
// binary. The generated file is checked in, so tests build against it and need
// no herdr. Installs vscode's own deps from its lockfile when they are missing,
// because the root install never does.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VSCODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vscode');
const TSC = path.join(VSCODE, 'node_modules', 'typescript', 'bin', 'tsc');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: VSCODE, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!fs.existsSync(TSC)) {
  run('npm', ['ci', '--no-audit', '--no-fund']);
}
run(process.execPath, [TSC, '-p', './']);
