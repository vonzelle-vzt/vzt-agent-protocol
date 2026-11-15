// Agent-spawned workers: the VS Code counterpart of Orca's `orchestration
// worker-start`. An agent asks for a worker (`bus spawn`); the VS Code window
// that holds the requester claims the request (`bus spawn-claim`), starts the
// worker in a pane beside it, and reports back (`bus spawn-done`), which queues
// the task as a bus `task` message from the requester to the worker. The
// worker finishes with `bus complete`, and the requester is woken with the
// report — Orca's worker_done.
//
// Requests are small JSON files under <busDir>/spawn so the extension needs no
// schema of its own: queued `<id>.json` -> claimed `<id>.claimed.json` (an
// atomic rename, so two windows never start the same worker) -> settled with
// status started|failed.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { busDir, BusError, KINDS } from './store.mjs';

export const SPAWN_MAX_DEFAULT = 4; // live workers per requester (VZT_PANE_MAX)
export const SPAWN_DEPTH_MAX = 2; // a worker may start workers; theirs may not
export const SPAWN_CLAIM_TTL_MS = 120_000; // an unclaimed request is dropped after this

const usage = (msg) => new BusError(2, msg);

export function spawnDir(env = process.env) {
  return path.join(busDir(env), 'spawn');
}

function readAll(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    try { out.push({ name, req: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }); } catch { /* half-written */ }
  }
  return out;
}

function write(dir, name, req) {
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(req), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

/** Queue a worker for `me` (the requester's agent row). Enforces the per-requester and depth bounds. */
export function requestSpawn(store, me, { kind, task, subject, workspace }, { env = process.env, nowMs = Date.now() } = {}) {
  if (!me) throw usage('spawn is an agent verb: run it from a claude/codex on the bus');
  if (!KINDS.includes(kind)) throw usage(`--kind must be one of ${KINDS.join('|')}`);
  if (!task || !task.trim()) throw usage('--task is required: the worker\'s brief');
  if (!me.window_id) throw new BusError(4, `${me.alias} has no window to open a worker in`);
  const dir = spawnDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = readAll(dir).map((r) => r.req);
  // Depth: the requester's own request (if a worker) sets it.
  const mine = all.find((r) => r.worker === me.agent_id);
  const depth = (mine ? mine.depth : 0) + 1;
  if (depth > SPAWN_DEPTH_MAX) throw new BusError(4, `spawn depth ${depth} is over ${SPAWN_DEPTH_MAX}: a worker's worker may not start more workers`);
  const max = Number(env.VZT_PANE_MAX) > 0 ? Number(env.VZT_PANE_MAX) : SPAWN_MAX_DEFAULT;
  const open = all.filter((r) => r.requester === me.agent_id && (r.status === 'queued' || r.status === 'claimed' ||
    (r.status === 'started' && r.worker && store.agent(r.worker) && store.liveness(store.agent(r.worker)) === 'live')));
  if (open.length >= max) throw new BusError(4, `${me.alias} already has ${open.length} live worker(s) (max ${max}, VZT_PANE_MAX)`);
  const id = randomUUID();
  const req = {
    id,
    window: me.window_id,
    requester: me.agent_id,
    requester_alias: me.alias,
    kind,
    cwd: workspace || me.workspace,
    subject: (subject || task.split('\n')[0]).slice(0, 200),
    task,
    depth,
    created_ms: nowMs,
    status: 'queued',
  };
  write(dir, `${id}.json`, req);
  return req;
}

/** Claim this window's queued requests (atomic rename); drops ones nobody claimed in time. */
export function claimSpawns(window, { env = process.env, nowMs = Date.now() } = {}) {
  if (!window) throw usage('--window is required');
  const dir = spawnDir(env);
  const claimed = [];
  for (const { name, req } of readAll(dir)) {
    if (req.status !== 'queued' || name !== `${req.id}.json`) continue;
    if (nowMs - req.created_ms > SPAWN_CLAIM_TTL_MS) {
      write(dir, name, { ...req, status: 'failed', error: 'no VS Code window claimed it (is the requester\'s window open?)' });
      continue;
    }
    if (req.window !== window) continue;
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, `${req.id}.claimed.json`));
    } catch {
      continue; // another poll took it
    }
    const mine = { ...req, status: 'claimed', claimed_ms: nowMs };
    write(dir, `${req.id}.claimed.json`, mine);
    claimed.push(mine);
  }
  return claimed;
}

/**
 * Settle a claimed request: the worker started (queue its task from the
 * requester) or it failed. Returns the settled request.
 */
export function settleSpawn(store, id, { worker, error }, { env = process.env, nowMs = Date.now() } = {}) {
  const dir = spawnDir(env);
  const file = path.join(dir, `${id}.claimed.json`);
  let req;
  try { req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw usage(`no claimed spawn request ${id}`); }
  let done;
  if (error || !worker) {
    done = { ...req, status: 'failed', error: error || 'no worker', settled_ms: nowMs };
  } else {
    const w = store.agent(worker);
    if (!w) throw usage(`unknown worker agent ${worker}`);
    const msg = store.send({
      fromId: req.requester, toAlias: w.alias, type: 'task', subject: req.subject, body: req.task,
      workspace: w.workspace, key: `spawn:${req.id}`,
    });
    done = { ...req, status: 'started', worker, worker_alias: w.alias, message: msg.id, settled_ms: nowMs };
  }
  write(dir, `${id}.json`, done);
  fs.rmSync(file, { force: true });
  return done;
}

/** A request by id, wherever it is in its life. */
export function spawnStatus(id, { env = process.env } = {}) {
  const dir = spawnDir(env);
  for (const name of [`${id}.json`, `${id}.claimed.json`]) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* next */ }
  }
  return undefined;
}
