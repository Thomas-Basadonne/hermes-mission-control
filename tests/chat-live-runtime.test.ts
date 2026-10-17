import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { canReuseLiveRuntime, isStaleRuntimeError } from '../src/lib/chat-live-runtime.ts';

const OPEN = 1;
const CLOSED = 3;
const socket = { readyState: OPEN };
const live = { socket, resumedOnSocket: socket, liveSessionId: 'rt-1', requestedSessionRef: null, liveSessionKey: 'agent:main:local:dm:x', preview: false };

// A runtime resumed on the currently open socket is reusable: no resume, no transcript fetch on send.
assert.equal(canReuseLiveRuntime(live), true, 'live runtime on the open socket is reused');

// The gateway reaps a runtime when its transport closes, so a new socket must never reuse the old id.
assert.equal(canReuseLiveRuntime({ ...live, socket: { readyState: OPEN } }), false, 'reconnected socket must resume again');
assert.equal(canReuseLiveRuntime({ ...live, socket: { readyState: CLOSED } }), false, 'closed socket is never reused');
assert.equal(canReuseLiveRuntime({ ...live, socket: null }), false, 'no socket means no reuse');
assert.equal(canReuseLiveRuntime({ ...live, resumedOnSocket: null }), false, 'runtime never resumed on this socket');

// Preview and missing runtime always take the full path.
assert.equal(canReuseLiveRuntime({ ...live, preview: true }), false, 'preview mode resumes explicitly');
assert.equal(canReuseLiveRuntime({ ...live, liveSessionId: null }), false, 'no live runtime id');

// An explicit reference to another session must not be redirected to the live one.
assert.equal(canReuseLiveRuntime({ ...live, requestedSessionRef: 'rt-other' }), false, 'different requested session');
assert.equal(canReuseLiveRuntime({ ...live, requestedSessionRef: 'rt-1' }), true, 'requested runtime id matches');
assert.equal(canReuseLiveRuntime({ ...live, requestedSessionRef: 'agent:main:local:dm:x' }), true, 'requested canonical key matches');

// Stale-runtime detection drives the single retry through the full resume.
assert.equal(isStaleRuntimeError('4007: session not found'), true);
assert.equal(isStaleRuntimeError('Session not found'), true);
assert.equal(isStaleRuntimeError('Gateway request timed out: prompt.submit'), false, 'timeouts are not stale runtimes');
assert.equal(isStaleRuntimeError('Message queued until the chat connection is restored.'), false);

// Contract: submitAgentPrompt shows the user bubble before any await on the resume path.
const source = readFileSync(new URL('../src/lib/chat-gateway.ts', import.meta.url), 'utf8');
const start = source.indexOf('const submitAgentPrompt = useCallback(');
const end = source.indexOf('const closeModelPicker', start);
assert.ok(start > 0 && end > start, 'submitAgentPrompt located');
const body = source.slice(start, end);
const bubbleAt = body.indexOf('setMessages((current) => [...current, optimisticMessage])');
const sessionAt = body.indexOf('ensureSession(undefined, { reuseLive: true })');
assert.ok(bubbleAt > 0, 'optimistic bubble is appended');
assert.ok(sessionAt > bubbleAt, 'bubble is appended before the session round trip');
assert.ok(body.indexOf('await claimLastChatPointer') > bubbleAt, 'pointer claim runs after the bubble');

console.log('chat live runtime tests passed');
