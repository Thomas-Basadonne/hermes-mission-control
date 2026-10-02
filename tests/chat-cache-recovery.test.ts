import { strict as assert } from 'node:assert';
import * as persistence from '../src/lib/chat-persistence.ts';
import type { ChatMessage } from '../src/lib/chat-protocol.ts';

const cache = {
  sessionId: 'session-a', sessionKey: 'key-a', profile: null,
  sessionTitle: 'Cached chat', modelIdentity: null, updatedAt: 1, revision: 1,
  messages: [
    { id: 'db:1', role: 'user', kind: 'user', text: 'repeat', status: 'complete', source: 'canonical' },
    { id: 'db:2', role: 'user', kind: 'user', text: 'repeat', status: 'complete', source: 'canonical' },
  ] as ChatMessage[],
};
// Cache is display-only, never a source for outbox reconciliation or event watermarks.
assert.equal(typeof persistence.selectCachedChatMessages, 'function', 'cache-first restoration is missing');
assert.strictEqual(persistence.selectCachedChatMessages(cache, 'session-a', null), cache.messages);
assert.strictEqual(persistence.selectCachedChatMessages(cache, 'key-a', null), cache.messages);
assert.deepEqual(persistence.selectCachedChatMessages(cache, 'session-b', null), []);
assert.deepEqual(persistence.selectCachedChatMessages(cache, 'session-a', 'other-profile'), []);
assert.strictEqual(persistence.selectCachedChatMessages({ ...cache, profile: 'bot-a' }, 'session-a', 'bot-a'), cache.messages);
assert.deepEqual(persistence.selectCachedChatMessages({ ...cache, profile: 'bot-a' }, 'session-a', null), []);
assert.deepEqual(persistence.selectCachedChatMessages(cache, null, null), []);
assert.deepEqual(persistence.selectCachedChatMessages({ ...cache, messages: [null] as unknown as ChatMessage[] }, 'session-a', null), []);
assert.deepEqual(persistence.selectCachedChatMessages(cache, 'session-a', 'default'), cache.messages);
// A replayed start changes object identity/status but is not new content.
const stale = { id: 'stale', role: 'assistant', kind: 'assistant', text: 'old', status: 'streaming', source: 'live', createdAt: 2 } as ChatMessage;
const fresh = { ...stale, id: 'fresh', text: 'new' };
assert.equal(typeof persistence.dropUnchangedCachedMessages, 'function');
assert.deepEqual(persistence.dropUnchangedCachedMessages([{ ...stale, status: 'complete' }, fresh], [stale]), [fresh]);
const changedText = { ...stale, text: 'old plus live delta' };
const changedOutput = { ...stale, output: 'new tool output' };
assert.deepEqual(persistence.dropUnchangedCachedMessages([changedText, changedOutput], [stale]), [changedText, changedOutput]);
assert.deepEqual(persistence.dropUnchangedCachedMessages([fresh], []), [fresh]);
console.log('chat cache restoration tests passed');
