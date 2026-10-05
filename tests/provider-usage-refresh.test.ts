import assert from 'node:assert/strict';
import { createSerializedRefresh } from '../src/lib/provider-usage-refresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const requests = [deferred<string>(), deferred<string>()];
const values: string[] = [];
const loading: boolean[] = [];
let calls = 0;
const refresh = createSerializedRefresh(
  async () => requests[calls++].promise,
  (value) => values.push(value),
  (value) => loading.push(value),
);

const first = refresh.run();
await refresh.run();
assert.equal(calls, 1, 'a timer tick must not overlap an active request');
requests[0].resolve('first');
await first;
const second = refresh.run();
assert.equal(calls, 2);
requests[1].resolve('second');
await second;
assert.deepEqual(values, ['first', 'second']);
assert.deepEqual(loading, [true, false, true, false]);

const pending = deferred<string>();
let acceptedAfterCancel = false;
let signal: AbortSignal | undefined;
const cancellable = createSerializedRefresh(
  (requestSignal) => {
    signal = requestSignal;
    return pending.promise;
  },
  () => { acceptedAfterCancel = true; },
  () => undefined,
);
const inFlight = cancellable.run();
cancellable.cancel();
assert.equal(signal?.aborted, true);
pending.resolve('obsolete');
await inFlight;
assert.equal(acceptedAfterCancel, false, 'cancelled requests must not publish stale results');

console.log('provider usage refresh tests passed');
