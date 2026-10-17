// Project registry + git worktree logic behind `vzt-agent projects|worktree`.
// Contract: .vzt/ship/vscode-orca-workspaces/SPEC.md ("Workspace CLI (u2)").
// Every function takes the registry file path explicitly; git runs only via
// execFileSync('git', args), never a shell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProject } from '../bus/cli.mjs';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function gitStderr(err) {
  return String(err.stderr || err.message || '').trim();
}

export function registryPath(env = process.env) {
  if (env.VZT_PROJECTS_FILE) return path.resolve(env.VZT_PROJECTS_FILE);
  return path.join(env.HOME || os.homedir(), '.vzt', 'projects.json');
}

export function readRegistry(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, projects: [] };
    throw err;
  }
  let reg;
  try {
    reg = JSON.parse(raw);
  } catch {
    throw new WorkspaceError(2, `registry ${file} is not valid JSON`);
  }
  if (!reg || !Array.isArray(reg.projects)) {
    throw new WorkspaceError(2, `registry ${file} has no "projects" array`);
  }
  return { version: 1, projects: reg.projects };
}

export function writeRegistry(file, reg) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: reg.projects }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function isGitDir(dir) {
  return fs.existsSync(dir) && tryGit(['rev-parse', '--git-common-dir'], dir) !== null;
}

function defaultBaseRef(root) {
  const remote = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (remote) return remote;
  const branch = tryGit(['branch', '--show-current'], root);
  return branch || 'HEAD';
}

function findProject(reg, name) {
  const project = reg.projects.find((p) => p.name === name);
  if (!project) throw new WorkspaceError(2, `unknown project "${name}"`);
  return project;
}

export function addProject(file, dir, { name, base } = {}) {
  const start = path.resolve(dir || process.cwd());
  if (!isGitDir(start)) throw new WorkspaceError(2, `${start} is not a git repository`);
  const root = resolveProject(start);
  const projectName = name ?? path.basename(root);
  if (!NAME_RE.test(projectName)) {
    throw new WorkspaceError(2, `invalid project name "${projectName}" (must match ${NAME_RE})`);
  }
  const reg = readRegistry(file);
  const dup = reg.projects.find((p) => p.name === projectName || p.root === root);
  if (dup) throw new WorkspaceError(4, `project "${dup.name}" is already registered at ${dup.root}`);
  const project = { name: projectName, root, baseRef: base || defaultBaseRef(root) };
  reg.projects.push(project);
  writeRegistry(file, reg);
  return project;
}

function sanitizeName(raw, fallback) {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63);
  return cleaned || fallback;
}

// Register every git repo Orca lists, in order, with one atomic registry write.
// Idempotent: a root that is already registered is skipped silently.
export function importFromOrca(file, repos) {
  const reg = readRegistry(file);
  const added = [];
  const skipped = [];
  for (const repo of repos) {
    const p = repo && typeof repo.path === 'string' ? repo.path : '';
    if (!p || !fs.existsSync(p)) {
      skipped.push({ path: p, reason: 'path does not exist' });
      continue;
    }
    if (!isGitDir(p)) {
      skipped.push({ path: p, reason: 'not a git repository' });
      continue;
    }
    const root = resolveProject(p);
    if (reg.projects.some((x) => x.root === root)) continue;
    const base = sanitizeName(repo.displayName, sanitizeName(path.basename(root), 'project'));
    let name = base;
    for (let n = 2; reg.projects.some((x) => x.name === name); n++) {
      const suffix = `-${n}`;
      name = base.slice(0, 63 - suffix.length) + suffix;
    }
    reg.projects.push({ name, root, baseRef: defaultBaseRef(root) });
    added.push(name);
  }
  if (added.length) writeRegistry(file, reg);
  return { added, skipped };
}

export function removeProject(file, name) {
  const reg = readRegistry(file);
  const project = findProject(reg, name);
  reg.projects = reg.projects.filter((p) => p !== project);
  writeRegistry(file, reg);
  return project;
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function parseWorktreePorcelain(text) {
  const worktrees = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    const first = lines.find((l) => l.startsWith('worktree '));
    if (!first) continue;
    const wt = { path: realOrResolved(first.slice('worktree '.length)), branch: null, head: null, main: false };
    for (const line of lines) {
      if (line.startsWith('HEAD ')) wt.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) wt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    worktrees.push(wt);
  }
  // git always lists the main checkout first.
  if (worktrees.length) worktrees[0].main = true;
  return worktrees;
}

export function listProjects(file) {
  return readRegistry(file).projects.map((p) => {
    const exists = fs.existsSync(p.root);
    let worktrees = [];
    if (exists) {
      const out = tryGit(['worktree', 'list', '--porcelain'], p.root);
      if (out !== null) worktrees = parseWorktreePorcelain(out);
    }
    return { name: p.name, root: p.root, baseRef: p.baseRef, exists, worktrees };
  });
}

export function worktreePath(root, slug) {
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
}

function existingRoot(project) {
  if (!fs.existsSync(project.root)) {
    throw new WorkspaceError(2, `project "${project.name}" root ${project.root} does not exist`);
  }
  return project.root;
}

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new WorkspaceError(2, `invalid worktree name "${slug}" (must match ${SLUG_RE})`);
  }
}

function linkNodeModules(root, wtPath) {
  const dirs = [''];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') dirs.push(entry.name);
  }
  const linked = [];
  for (const rel of dirs) {
    const src = path.join(root, rel, 'node_modules');
    const dst = path.join(wtPath, rel, 'node_modules');
    if (!fs.existsSync(src) || !fs.existsSync(path.dirname(dst))) continue;
    try {
      fs.lstatSync(dst);
      continue;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // absent in the worktree — link it
    }
    fs.symlinkSync(src, dst);
    linked.push(dst);
  }
  return linked;
}

export function createWorktree(file, { project: name, name: slug, base } = {}) {
  checkSlug(slug);
  const project = findProject(readRegistry(file), name);
  const root = existingRoot(project);
  const wtPath = worktreePath(root, slug);
  if (fs.existsSync(wtPath)) throw new WorkspaceError(4, `${wtPath} already exists`);
  if (tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${slug}`], root) !== null) {
    throw new WorkspaceError(4, `branch "${slug}" already exists in project "${project.name}"`);
  }
  const baseRef = base || project.baseRef;
  // git would read a leading '-' as an option.
  if (baseRef.startsWith('-')) throw new WorkspaceError(2, `invalid base "${baseRef}"`);
  if (tryGit(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], root) === null) {
    throw new WorkspaceError(2, `base "${baseRef}" is not a commit in project "${project.name}"`);
  }
  try {
    git(['worktree', 'add', '-b', slug, wtPath, baseRef], root);
  } catch (err) {
    throw new WorkspaceError(4, `git worktree add failed: ${gitStderr(err)}`);
  }
  linkNodeModules(root, wtPath);
  return { path: wtPath, branch: slug, base: baseRef, head: git(['rev-parse', 'HEAD'], wtPath) };
}

export function removeWorktree(file, { project: name, name: slug, force = false } = {}) {
  checkSlug(slug);
  const project = findProject(readRegistry(file), name);
  const root = existingRoot(project);
  const wtPath = worktreePath(root, slug);
  if (!fs.existsSync(wtPath)) throw new WorkspaceError(2, `no worktree at ${wtPath}`);
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wtPath);
  try {
    git(args, root);
  } catch (err) {
    throw new WorkspaceError(4, `git worktree remove failed: ${gitStderr(err)}`);
  }
  return { path: wtPath, branch: slug, removed: true };
}
