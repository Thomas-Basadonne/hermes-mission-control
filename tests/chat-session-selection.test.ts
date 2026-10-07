import { strict as assert } from 'node:assert';
import * as params from '../src/lib/chat-session-params.ts';

assert.equal(typeof params.selectChatSessionParams, 'function', 'picker selection must have a profile-safe navigation path');
const before = '?roomId=room-one&chatMode=room&botProfile=old-bot&chatSession=old&unrelated=keep';
const selected = new URLSearchParams(params.selectChatSessionParams(before, { sessionId: 'historic-id', sessionKey: 'agent:bot:telegram:dm:1', profile: 'client-bot' }));
assert.equal(selected.get('chatSession'), 'historic-id', 'select the exact historical row, not the newest rotation for its key');
assert.equal(selected.get('botProfile'), 'client-bot');
assert.equal(selected.get('chatMode'), 'canonical');
assert.equal(selected.has('roomId'), false);
assert.equal(selected.get('unrelated'), 'keep');
const defaultChat = new URLSearchParams(params.selectChatSessionParams(before, { sessionId: 'same-id', profile: null }));
assert.equal(defaultChat.get('botProfile'), 'default', 'an explicit default owner clears a carried bot profile on resume');
assert.equal(params.nextSessionProfile('old-bot', defaultChat.get('botProfile'), true), 'default');
assert.equal(params.shouldPreviewChatSession('same-id', null), false, 'opening a Chat session is ready-to-go, not a preview requiring Resume');
assert.equal(params.shouldPreviewChatSession('same-id', null, true), false, 'picker selection resumes through the ready connection instead of a second preview action');
console.log('chat-session-selection: ok');
