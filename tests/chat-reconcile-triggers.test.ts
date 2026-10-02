import { strict as assert } from 'node:assert';
import * as sync from '../src/lib/chat-sync.ts';
assert.equal(typeof sync.eventRequiresCanonicalReconcile, 'function', 'terminal events must reconcile without waiting for fallback polling');
for (const type of ['run.completed', 'run.finished', 'run.done', 'error', 'session.interrupted']) {
  assert.equal(sync.eventRequiresCanonicalReconcile({type}), true, type);
}
for (const type of ['message.delta', 'message.complete', 'tool.complete', 'run.started', 'todo.updated']) {
  assert.equal(sync.eventRequiresCanonicalReconcile({type}), false, 'do not full-fetch per token/tool/interim message');
}
console.log('chat reconcile trigger tests passed');
