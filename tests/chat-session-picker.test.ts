import { strict as assert } from 'node:assert';
import { createSessionPickerController } from '../src/lib/chat-session-picker.ts';

const payload = (offset = 0, id = 'history-row', live = 1) => ({
  success: true, schemaVersion: 'test', available: true,
  catalogFreshness: {state:'fresh',ageSeconds:0,refreshError:null},
  items: [{ sessionId: id, sessionKey: 'newest-rotation-key', profile:'default', isResumable:true, status:live ? 'live' : 'idle', title:id }],
  pagination: { total: 51, offset, limit:25, hasMore:offset < 50 },
  stats: { totalSessions: 51, liveSessions:live, activeAgents:live },
  facets: { status:{live,idle:50,ended:0}, category:{}, origin:{cli:50,telegram:1}, model:{} }, tabCounts:{}
});
const calls = [];
const ctrl = createSessionPickerController({storedToken:'local-test-token', loadService:async opts => { calls.push(opts); return payload(opts.offset); }});
assert.equal(ctrl.state.status, 'live', 'the picker opens on live sessions by default');
assert.equal(typeof ctrl.subscribe,'function','the React picker must subscribe to state changes, not read a silent mutable object');
let notifications = 0;
const unsubscribe = ctrl.subscribe(() => { notifications++; });
await ctrl.load();
assert.equal(ctrl.state.items[0].sessionId, 'history-row');
assert.equal(ctrl.state.pagination.offset, 0, 'offset describes this page, not the next one');
assert.equal(calls[0].accessToken, 'local-test-token');
assert.equal(calls[0].includeRecentMessages, false);
assert.ok(calls[0].signal instanceof AbortSignal);
assert.ok(notifications >= 2, 'loading and result both re-render the UI');
await ctrl.loadNext();
assert.equal(calls.at(-1).offset, 25);
await ctrl.loadPrev();
assert.equal(calls.at(-1).offset, 0);
ctrl.setQuery('older session');
ctrl.setProfile('client-bot');
ctrl.setOrigin('telegram');
ctrl.setStatus('live');
await ctrl.load();
assert.equal(calls.at(-1).offset, 0);
assert.equal(calls.at(-1).profile, 'client-bot');
assert.deepEqual(calls.at(-1).filters, {query:'older session',origin:'telegram',status:'live'});
assert.equal(ctrl.select(0), 'history-row');
unsubscribe();
ctrl.close();
const cachedRows = ctrl.state.items;
const cachedFilters = {query:ctrl.state.query,profile:ctrl.state.profile,origin:ctrl.state.origin,status:ctrl.state.status};
const reopening = ctrl.load();
assert.equal(ctrl.state.items, cachedRows, 'revalidation paints the existing page while the request is pending');
assert.equal(ctrl.state.stale, true, 'preserved rows are explicitly marked stale while revalidating');
assert.deepEqual({query:ctrl.state.query,profile:ctrl.state.profile,origin:ctrl.state.origin,status:ctrl.state.status}, cachedFilters, 'close/reopen preserves the selected filters');
await reopening;
assert.equal(ctrl.state.items[0].sessionId, 'history-row');
ctrl.close();

let resolveOld;
let resolveNew;
const raceCalls = [];
const race = createSessionPickerController({storedToken:'test', loadService:opts => {
 raceCalls.push(opts);
 return new Promise(resolve => { if (raceCalls.length === 1) resolveOld=resolve; else resolveNew=resolve; });
}});
const oldLoad = race.load();
const overlappingPoll = race.load();
assert.equal(raceCalls.length, 1, 'polling must not overlap the same request');
race.setQuery('new');
assert.equal(raceCalls[0].signal.aborted, true, 'changed filters abort old fetch');
const newLoad = race.load();
assert.equal(raceCalls.length, 2);
resolveNew(payload(0,'new-match',0));
await newLoad;
resolveOld(payload(0,'stale-match',1));
await oldLoad; await overlappingPoll;
assert.equal(race.state.items[0].sessionId,'new-match','late responses cannot replace the new filter results');
assert.equal(race.state.stats.liveSessions,0,'live status updates on a refresh');
const finalLoad=race.load();
race.close();
assert.equal(raceCalls.at(-1).signal.aborted,true,'unmount aborts the in-flight request');
resolveNew(payload(0,'unmounted'));
await finalLoad;
assert.equal(race.state.items[0].sessionId,'new-match');

let retryAttempts = 0;
const retry = createSessionPickerController({storedToken:'test', loadService:async opts => {
  retryAttempts++;
  if (retryAttempts < 3) {
    const error = Object.assign(new Error('busy'), {status:503, retryAfterMs:0});
    throw error;
  }
  return payload(opts.offset, 'retried');
}});
await retry.load();
assert.equal(retryAttempts, 3, '503 responses receive a bounded retry');
assert.equal(retry.state.items[0].sessionId, 'retried');

const retryDelays = [];
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((callback, milliseconds) => {
  retryDelays.push(milliseconds);
  queueMicrotask(callback);
  return 1;
});
globalThis.clearTimeout = (() => {});
let longRetryAttempts = 0;
try {
  const longRetry = createSessionPickerController({storedToken:'test', loadService:async opts => {
    if (longRetryAttempts++ === 0) throw Object.assign(new Error('busy'), {status:503, retryAfterMs:5000});
    return payload(opts.offset, 'retry-after-respected');
  }});
  await longRetry.load();
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}
assert.deepEqual(retryDelays, [5000], 'safe Retry-After values are not shortened to two seconds');

let abortAttempts = 0;
const abortRetry = createSessionPickerController({storedToken:'test', loadService:async () => {
  abortAttempts++;
  throw Object.assign(new Error('busy'), {status:503, retryAfterMs:1000});
}});
const aborting = abortRetry.load();
abortRetry.close();
await aborting;
assert.equal(abortAttempts, 1, 'closing aborts a pending Retry-After delay');
assert.equal(abortRetry.state.error, null, 'an aborted retry is not reported as a failure');

let shouldFail = false;
const staleFailure = createSessionPickerController({storedToken:'test', loadService:async opts => {
  if (shouldFail) throw new Error('refresh failed');
  return payload(opts.offset, 'preserved');
}});
await staleFailure.load();
shouldFail = true;
await staleFailure.load();
assert.equal(staleFailure.state.items[0].sessionId, 'preserved', 'a refresh failure preserves the last usable page');
assert.equal(staleFailure.state.stale, true, 'preserved data is identified as stale after refresh failure');
assert.equal(staleFailure.state.error, 'refresh failed');

const stalePayload = payload(0, 'stale-success');
stalePayload.catalogFreshness = {state:'stale',ageSeconds:4,refreshError:'OSError'};
const staleSuccess = createSessionPickerController({storedToken:'test', loadService:async () => stalePayload});
await staleSuccess.load();
assert.equal(staleSuccess.state.stale, true, 'successful stale catalog responses remain marked stale');
assert.equal(staleSuccess.state.refreshError, 'OSError');

let rejectSwitched;
const switched = createSessionPickerController({storedToken:'test', loadService:opts => {
  if (opts.profile === null && opts.offset === 0) return Promise.resolve(payload(0, 'old-scope'));
  return new Promise((_resolve, reject) => { rejectSwitched = reject; });
}});
await switched.load();
switched.setProfile('research');
const switchedProfileLoad = switched.load();
assert.equal(switched.state.items.length, 0, 'profile changes do not expose rows from the previous scope');
rejectSwitched(new Error('profile refresh failed'));
await switchedProfileLoad;
assert.equal(switched.state.items.length, 0);
assert.equal(switched.state.pagination.offset, 0);

const pageFailure = createSessionPickerController({storedToken:'test', loadService:opts => opts.offset === 0
  ? Promise.resolve(payload(0, 'page-zero'))
  : Promise.reject(new Error('page failed'))});
await pageFailure.load();
await pageFailure.loadNext();
assert.equal(pageFailure.state.items.length, 0, 'page changes do not leave the previous page selectable');
assert.equal(pageFailure.state.pagination.offset, 25, 'failed page retains the requested range identity');
assert.equal(pageFailure.select(0), null);

let resolveFreshness;
let freshnessCalls = 0;
const silentReconcile = createSessionPickerController({storedToken:'test', loadService:opts => {
  freshnessCalls++;
  if (freshnessCalls === 1) {
    const stale = payload(opts.offset, 'cached-during-reconcile');
    stale.catalogFreshness = {state:'stale',ageSeconds:5,refreshError:null};
    return Promise.resolve(stale);
  }
  return new Promise(resolve => { resolveFreshness = resolve; });
}});
await silentReconcile.load();
const preserved = silentReconcile.state.items;
const silentLoad = silentReconcile.load({silent:true});
const overlappingSilentLoad = silentReconcile.load({silent:true});
assert.equal(silentReconcile.state.loading, false, 'freshness reconciliation does not show a foreground spinner');
assert.equal(silentReconcile.state.items, preserved, 'freshness reconciliation preserves displayed rows');
assert.equal(freshnessCalls, 2, 'overlapping reconciliation requests coalesce');
resolveFreshness(payload(0, 'fresh-after-reconcile'));
await silentLoad; await overlappingSilentLoad;
assert.equal(silentReconcile.state.stale, false);
assert.equal(silentReconcile.state.items[0].sessionId, 'fresh-after-reconcile');
console.log('chat-session-picker: pagination, subscriptions, filters, live refresh, cancellation and stale responses OK');
