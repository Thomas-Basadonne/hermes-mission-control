import assert from 'node:assert/strict';
import {
  canCustomizeProviderUsageCatalog,
  createSerializedRefresh,
  getProviderUsageCatalogPollDelay,
  preserveLastAvailableSnapshot,
} from '../src/lib/provider-usage-refresh.ts';

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

assert.deepEqual(
  preserveLastAvailableSnapshot(
    { available: true, refreshing: true, providers: ['last-good'] },
    { available: false, refreshing: false, providers: [] },
  ),
  { available: true, refreshing: false, providers: ['last-good'] },
  'a failed poll must preserve cached data without leaving the UI stuck in a refreshing state',
);

assert.equal(
  canCustomizeProviderUsageCatalog({ available: true, error: 'transient discovery failure' }, false),
  true,
  'a stale cached catalog must remain editable when background discovery fails',
);
assert.equal(canCustomizeProviderUsageCatalog({ available: false }, false), false);
assert.equal(canCustomizeProviderUsageCatalog({ available: true }, true), false);

assert.equal(
  getProviderUsageCatalogPollDelay({ available: true, refreshing: false }),
  60_000,
  'a settled catalog must be polled again so CodexBar changes become visible',
);
assert.equal(
  getProviderUsageCatalogPollDelay({ available: true, refreshing: true }),
  1_500,
  'an active catalog discovery should be polled promptly',
);

console.log('provider usage refresh tests passed');
