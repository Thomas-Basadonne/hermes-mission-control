import { strict as assert } from 'node:assert';
import { createSessionFreshnessReconciler } from '../src/lib/session-freshness-reconciler.ts';

const scheduled: Array<() => void> = [];
const delays: number[] = [];
let allowed = true;
let calls = 0;
let resolveRefresh: (() => void) | undefined;
const reconciler = createSessionFreshnessReconciler({
  refresh: () => { calls++; return new Promise<void>(resolve => { resolveRefresh = resolve; }); },
  isAllowed: () => allowed,
  schedule: (callback, delay) => { scheduled.push(callback); delays.push(delay); return callback; },
  cancelSchedule: handle => { const index = scheduled.indexOf(handle as () => void); if (index >= 0) scheduled.splice(index, 1); },
  delays: [100, 200],
});

reconciler.observe({ stale: true, refreshError: null, scopeKey: 'a' });
assert.deepEqual(delays, [100]);
scheduled.shift()?.();
assert.equal(calls, 1);
reconciler.observe({ stale: false, refreshError: null, scopeKey: 'a' });
resolveRefresh?.();
await Promise.resolve();
assert.equal(scheduled.length, 0, 'fresh response cancels reconciliation');

reconciler.observe({ stale: true, refreshError: null, scopeKey: 'b' });
scheduled.shift()?.();
resolveRefresh?.();
await Promise.resolve();
reconciler.observe({ stale: true, refreshError: null, scopeKey: 'b' });
scheduled.shift()?.();
resolveRefresh?.();
await Promise.resolve();
assert.equal(calls, 3);
assert.equal(scheduled.length, 0, 'stale forever stops at the attempts budget');

reconciler.observe({ stale: true, refreshError: 'OSError', scopeKey: 'c' });
assert.equal(scheduled.length, 0, 'refresh failure remains stale and is terminal');

reconciler.observe({ stale: true, refreshError: null, scopeKey: 'd' });
allowed = false;
scheduled.shift()?.();
assert.equal(calls, 3, 'hidden or closed state cancels a scheduled refresh');
reconciler.cancel();

const failureTimers: Array<() => void> = [];
let failureCalls = 0;
const failureReconciler = createSessionFreshnessReconciler({
  refresh: async () => { failureCalls++; throw new Error('terminal'); },
  isAllowed: () => true,
  schedule: callback => { failureTimers.push(callback); return callback; },
  cancelSchedule: () => {},
  delays: [1, 1, 1],
});
failureReconciler.observe({ stale: true, refreshError: null, scopeKey: 'failure' });
failureTimers.shift()?.();
await Promise.resolve();
await Promise.resolve();
assert.equal(failureCalls, 1);
assert.equal(failureTimers.length, 0, 'terminal request failure stops short reconciliation');

const raceTimers: Array<() => void> = [];
let raceResolve: (() => void) | undefined;
const raceReconciler = createSessionFreshnessReconciler({
  refresh: () => new Promise<void>(resolve => { raceResolve = resolve; }),
  isAllowed: () => true,
  schedule: callback => { raceTimers.push(callback); return callback; },
  cancelSchedule: handle => { const index = raceTimers.indexOf(handle as () => void); if (index >= 0) raceTimers.splice(index, 1); },
  delays: [1, 1],
});
raceReconciler.observe({ stale: true, refreshError: null, scopeKey: 'old-token' });
raceTimers.shift()?.();
raceReconciler.observe({ stale: true, refreshError: null, scopeKey: 'new-token' });
raceResolve?.();
await Promise.resolve();
assert.equal(raceTimers.length, 1, 'old-scope completion cannot schedule work for the new scope');
raceReconciler.cancel();

console.log('session-freshness-reconciler: fresh, bounded stale, failure and cancellation OK');
