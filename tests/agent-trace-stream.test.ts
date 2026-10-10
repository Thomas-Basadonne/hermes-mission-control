import { strict as assert } from 'node:assert';
import test from 'node:test';
import { connectAgentTraceStream, traceStreamCandidates } from '../src/lib/agent-trace-stream.ts';

// MC-FIX-10: the live agent trace stream authenticates with an Authorization
// header over fetch streaming; the bearer token never appears in a URL.
const TOKEN = 'synthetic-token-not-real';
const params = { sessionId: 's1', profile: 'p1', handoffId: 'h1', limit: 50, interval: 1.5, compact: true };

type Opened = { url: string; headers: Headers; credentials?: RequestCredentials; signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> };

function fakeFetch(statuses: number[]) {
  const opened: Opened[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal as AbortSignal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    opened.push({ url: String(input), headers: new Headers(init?.headers), credentials: init?.credentials, signal, controller });
    const status = statuses[opened.length - 1] ?? 200;
    if (status !== 200) return new Response('{}', { status });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { opened, fetchImpl: fetchImpl as typeof fetch };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const encode = (text: string) => new TextEncoder().encode(text);

test('candidate URLs carry the trace params but never the token', () => {
  const candidates = traceStreamCandidates({ localBase: '/api/local', officialBase: '/api', accessToken: TOKEN, ...params });
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.ok(!candidate.url.includes(TOKEN));
    assert.ok(!candidate.url.includes('access_token'));
    const search = new URL(candidate.url, 'http://localhost').searchParams;
    assert.equal(search.get('session_id'), 's1');
    assert.equal(search.get('profile'), 'p1');
    assert.equal(search.get('handoff_id'), 'h1');
    assert.equal(search.get('limit'), '50');
    assert.equal(search.get('interval'), '1.5');
    assert.equal(search.get('compact'), '1');
  }
  assert.equal(candidates[0].accessToken, TOKEN, 'local sidecar gets the bearer header');
  assert.equal(candidates[1].accessToken, undefined, 'official API keeps cookie auth, no MC token');
});

test('identical bases collapse to one candidate', () => {
  const candidates = traceStreamCandidates({ localBase: '/api', officialBase: '/api', accessToken: TOKEN, ...params });
  assert.equal(candidates.length, 1);
});

test('local stream sends Authorization and delivers trace and default frames', async () => {
  const { opened, fetchImpl } = fakeFetch([200]);
  const frames: string[] = [];
  let exhausted = 0;
  const handle = connectAgentTraceStream({
    candidates: traceStreamCandidates({ localBase: '/api/local', officialBase: '/api', accessToken: TOKEN, ...params }),
    acceptNamedTrace: true, fetchImpl, onFrame: (data) => frames.push(data), onExhausted: () => { exhausted += 1; },
  });
  await tick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].headers.get('Authorization'), `Bearer ${TOKEN}`);
  opened[0].controller.enqueue(encode('event: trace\ndata: {"n":1}\n\ndata: {"n":2}\n\nevent: other\ndata: x\n\n'));
  await tick();
  assert.deepEqual(frames, ['{"n":1}', '{"n":2}']);
  handle.close();
  await tick();
  assert.equal(opened[0].signal.aborted, true);
  assert.equal(exhausted, 0, 'close is not a failure');
});

test('named trace frames are ignored when the capability is off', async () => {
  const { opened, fetchImpl } = fakeFetch([200]);
  const frames: string[] = [];
  const handle = connectAgentTraceStream({
    candidates: traceStreamCandidates({ localBase: '/api/local', officialBase: '/api', accessToken: TOKEN, ...params }),
    acceptNamedTrace: false, fetchImpl, onFrame: (data) => frames.push(data), onExhausted: () => {},
  });
  await tick();
  opened[0].controller.enqueue(encode('event: trace\ndata: {"n":1}\n\ndata: {"n":2}\n\n'));
  await tick();
  assert.deepEqual(frames, ['{"n":2}']);
  handle.close();
});

test('failure falls back to the official candidate with cookies only, then to polling', async () => {
  const { opened, fetchImpl } = fakeFetch([401, 503]);
  let exhausted = 0;
  connectAgentTraceStream({
    candidates: traceStreamCandidates({ localBase: '/api/local', officialBase: '/api', accessToken: TOKEN, ...params }),
    acceptNamedTrace: true, fetchImpl, onFrame: () => {}, onExhausted: () => { exhausted += 1; },
  });
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(opened.length, 2);
  assert.ok(opened[1].url.startsWith('/api/mission-control/agents/trace/stream?'));
  assert.equal(opened[1].headers.has('Authorization'), false);
  assert.equal(opened[1].credentials, 'include');
  assert.equal(exhausted, 1);
});
