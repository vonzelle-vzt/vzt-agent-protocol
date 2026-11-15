// The Agent Bus view's Tasks group (vscode/src/bus/tasks.ts): where every
// handed-off task stands, its report matched by reply_to, open work first.
// Imported from the COMPILED extension — run `npm --prefix vscode run compile` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vscode', 'out', 'bus', 'tasks.js');

test('taskRows: status from message state, report matched, open first then newest', async () => {
  const { taskRows, taskStatus } = await import(pathToFileURL(OUT).href);
  assert.deepEqual(['queued', 'delivered', 'seen', 'acknowledged', 'completed', 'failed'].map(taskStatus),
    ['waiting', 'waiting', 'waiting', 'working', 'done', 'failed']);
  const m = (seq, type, state, extra = {}) => ({ id: `m${seq}`, seq, type, from: 'lead', to: 'codex-worker', subject: `s${seq}`, state, ...extra });
  const rows = taskRows([
    { messages: [m(1, 'task', 'completed'), m(2, 'report', 'queued', { reply_to: 'm1', subject: 'succeeded: s1', from: 'codex-worker', to: 'lead' })] },
    { messages: [m(3, 'task', 'acknowledged'), m(4, 'message', 'seen')] },
    { messages: [m(5, 'task', 'queued')] },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['m5', 'waiting'], ['m3', 'working'], ['m1', 'done']]);
  assert.equal(rows[2].report, 'succeeded: s1');
  assert.equal(rows[0].report, undefined);
});
