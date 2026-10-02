import { strict as assert } from 'node:assert';
import * as persistence from '../src/lib/chat-persistence.ts';
assert.equal(typeof persistence.createChatPersistenceScheduler, 'function', 'stream persistence must be throttled');
const pending = new Map<number, () => void>(); let id = 0; let writes: string[] = [];
const scheduler = persistence.createChatPersistenceScheduler(
  (callback, delay) => { assert.equal(delay, 1000); pending.set(++id, callback); return id; },
  handle => { pending.delete(handle); },
);
for (let i = 0; i < 100; i++) scheduler.schedule(() => writes.push(`delta-${i}`));
assert.equal(writes.length, 0, 'stream deltas must not serialize synchronously');
assert.equal(pending.size, 1, 'continuous streaming must not postpone the timer forever');
pending.get(1)!(); pending.delete(1);
assert.deepEqual(writes, ['delta-99']);
scheduler.schedule(() => writes.push('pagehide'));
scheduler.flush();
assert.deepEqual(writes, ['delta-99', 'pagehide']);
assert.equal(pending.size, 0);
scheduler.schedule(() => writes.push('old-chat'));
scheduler.cancel(); scheduler.flush();
assert.deepEqual(writes, ['delta-99', 'pagehide'], 'New Chat must never flush an old snapshot over its new pointer');
assert.equal(pending.size, 0);
scheduler.flush();
assert.equal(writes.length, 2);
console.log('chat persistence scheduler tests passed');
