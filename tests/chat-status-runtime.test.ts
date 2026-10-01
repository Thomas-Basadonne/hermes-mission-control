import assert from 'node:assert/strict';
import { modelRows, rememberModel, parseReasoningChoices, setSessionReasoning } from '../src/lib/chat-status-runtime.ts';

const providers = [
  { slug: 'one', name: 'Provider One', models: ['shared', 'other'], total_models: 2, authenticated: true },
  { slug: 'two', name: 'Provider Two', models: ['shared'], total_models: 1, authenticated: true },
  { slug: 'locked', name: 'Locked', models: ['shared'], total_models: 1, authenticated: false },
];
assert.deepEqual(modelRows(providers, 'two', []).map((r) => [r.provider, r.model]), [['two', 'shared']]);
assert.equal(modelRows(providers, 'shared', []).length, 3);
assert.deepEqual(modelRows(providers, '', [], 'two').map((r) => [r.provider, r.model]), [['two', 'shared']]);
assert.deepEqual(modelRows(providers, 'shared', [{ provider: 'one', model: 'shared' }], 'two').map((r) => r.provider), ['two']);
assert.deepEqual(modelRows(providers, '', [], 'missing'), []);
assert.equal(modelRows(providers, 'shared', []).find((r) => r.provider === 'locked')?.disabled, true);
const recents = rememberModel([{ provider: 'one', model: 'other' }], { provider: 'two', model: 'shared' });
assert.deepEqual(modelRows(providers, '', recents).slice(0, 2).map((r) => [r.provider, r.model, r.recent]), [['two', 'shared', true], ['one', 'other', true]]);
assert.equal(rememberModel(recents, { provider: 'two', model: 'shared' }).length, 2);
assert.deepEqual(modelRows(providers, 'missing', recents), []);
assert.equal(modelRows(providers, '', [{ provider: 'missing', model: 'missing' }]).length, 4);
assert.deepEqual(parseReasoningChoices({ items: [{ text: 'low', meta: 'Low effort' }, { text: 'high', meta: 'High effort' }, { text: 'show' }, { text: 'hide' }, { text: 'high' }] }), [{ value: 'low', label: 'Low effort' }, { value: 'high', label: 'High effort' }]);
const calls: unknown[] = [];
assert.equal(await setSessionReasoning('high', 'qa-session', async (method, params) => { calls.push({ method, params }); return { value: 'high' }; }), 'high');
assert.deepEqual(calls, [{ method: 'config.set', params: { key: 'reasoning', value: 'high', scope: 'session', session_id: 'qa-session' } }, { method: 'config.get', params: { key: 'reasoning', session_id: 'qa-session' } }]);
await assert.rejects(() => setSessionReasoning('show', 'qa-session', async () => ({})), /Invalid/);
await assert.rejects(() => setSessionReasoning('high', '', async () => ({})), /Session/);
await assert.rejects(() => setSessionReasoning('high', 'qa-session', async () => ({ value: 'low' })), /not confirmed/);
console.log('chat status runtime tests passed');
