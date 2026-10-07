import { strict as assert } from 'node:assert';
import { createSessionPickerController } from '../src/lib/chat-session-picker.ts';

const payload = (offset = 0, id = 'history-row', live = 1) => ({
  success: true, schemaVersion: 'test', available: true,
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
console.log('chat-session-picker: pagination, subscriptions, filters, live refresh, cancellation and stale responses OK');
