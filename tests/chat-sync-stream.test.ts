import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createChatSyncRelay, createSseParser, openChatSyncStream } from '../src/lib/chat-sync-stream.ts';
import { chatSyncStreamUrl } from '../src/lib/chat-sync.ts';

// MC-FIX-4: the chat sync stream authenticates with an Authorization header
// over fetch streaming; the bearer token never appears in the request URL.
const TOKEN = 'synthetic-token-not-real';

type Frame = { name: string; data: string };

function collect() {
  const frames: Frame[] = [];
  const parser = createSseParser((name, data) => frames.push({ name, data }));
  return { frames, parser };
}

test('parser reassembles frames split at arbitrary chunk boundaries', () => {
  const { frames, parser } = collect();
  const wire = 'event: chat-sync-ready\ndata: {"latest_seq":3}\n\n: keep-alive\n\nevent: chat-sync\ndata: {"relay_seq":4,"text":"caffè ☕"}\n\n';
  const bytes = new TextEncoder().encode(wire);
  const decoder = new TextDecoder();
  for (let i = 0; i < bytes.length; i += 1) parser.push(decoder.decode(bytes.subarray(i, i + 1), { stream: true }));
  assert.deepEqual(frames, [
    { name: 'chat-sync-ready', data: '{"latest_seq":3}' },
    { name: 'chat-sync', data: '{"relay_seq":4,"text":"caffè ☕"}' },
  ]);
});

test('parser handles CRLF, multi-line data and default event names', () => {
  const { frames, parser } = collect();
  parser.push('data: line1\r\ndata: line2\r\n\r\nevent: chat-sync\r\ndata:x\r\n\r\n');
  assert.deepEqual(frames, [
    { name: 'message', data: 'line1\nline2' },
    { name: 'chat-sync', data: 'x' },
  ]);
});

test('stream URL carries session, client and since but never the token', () => {
  const url = chatSyncStreamUrl('session-1', 7);
  const params = new URL(url, 'http://localhost').searchParams;
  assert.equal(params.get('session_id'), 'session-1');
  assert.ok(params.get('client_id'));
  assert.equal(params.get('since'), '7');
  assert.equal(params.has('access_token'), false);
  assert.ok(!url.includes(TOKEN));
});

type FakeStream = { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal; url: string; headers: Headers };

function fakeFetch(status = 200) {
  const opened: FakeStream[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal as AbortSignal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    opened.push({ controller, signal, url: String(input), headers: new Headers(init?.headers) });
    if (status !== 200) return new Response('{}', { status });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { opened, fetchImpl: fetchImpl as typeof fetch };
}
const encode = (text: string) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('stream sends Authorization header, keeps the token out of the URL and delivers events in order', async () => {
  const { opened, fetchImpl } = fakeFetch();
  const frames: Frame[] = [];
  const errors: unknown[] = [];
  const handle = openChatSyncStream({ url: chatSyncStreamUrl('s1', 2), accessToken: TOKEN, fetchImpl, onEvent: (name, data) => frames.push({ name, data }), onError: (e) => errors.push(e) });
  await tick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].headers.get('Authorization'), `Bearer ${TOKEN}`);
  assert.ok(!opened[0].url.includes(TOKEN));
  opened[0].controller.enqueue(encode('event: chat-sync\ndata: {"relay_seq":3}\n\nevent: chat-'));
  opened[0].controller.enqueue(encode('sync\ndata: {"relay_seq":4}\n\n'));
  await tick();
  assert.deepEqual(frames.map((f) => f.data), ['{"relay_seq":3}', '{"relay_seq":4}']);
  handle.close();
  await tick();
  assert.equal(opened[0].signal.aborted, true);
  assert.deepEqual(errors, [], 'close() is not reported as an error');
});

test('a 401 is reported with its status and delivers no events', async () => {
  const { fetchImpl } = fakeFetch(401);
  const frames: Frame[] = [];
  const errors: Array<{ status?: number }> = [];
  openChatSyncStream({ url: chatSyncStreamUrl('s1'), accessToken: TOKEN, fetchImpl, onEvent: (name, data) => frames.push({ name, data }), onError: (e) => errors.push(e) });
  await tick();
  assert.deepEqual(frames, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 401);
});

function manualTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => { id += 1; pending.set(id, fn); return id; },
    clearTimer: (timer: number) => { pending.delete(timer); },
    runAll: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
    size: () => pending.size,
  };
}

test('relay reconnects after the stream ends and resumes from the latest seq', async () => {
  const { opened, fetchImpl } = fakeFetch();
  const timers = manualTimers();
  let since: number | undefined;
  const seen: Array<{ name: string; since: number | undefined }> = [];
  const relay = createChatSyncRelay({
    sessionId: 's1', accessToken: TOKEN, fetchImpl, getSince: () => since,
    onEvent: (name, _data, connectedSince) => seen.push({ name, since: connectedSince }),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  await tick();
  assert.equal(new URL(opened[0].url, 'http://localhost').searchParams.has('since'), false);
  opened[0].controller.enqueue(encode('event: chat-sync\ndata: {"relay_seq":9}\n\n'));
  await tick();
  since = 9;
  opened[0].controller.close();
  await tick();
  assert.equal(timers.size(), 1, 'reconnect scheduled');
  timers.runAll();
  await tick();
  assert.equal(opened.length, 2);
  assert.equal(new URL(opened[1].url, 'http://localhost').searchParams.get('since'), '9');
  assert.equal(opened[1].headers.get('Authorization'), `Bearer ${TOKEN}`);
  opened[1].controller.enqueue(encode('event: chat-sync-ready\ndata: {}\n\n'));
  await tick();
  assert.deepEqual(seen, [{ name: 'chat-sync', since: undefined }, { name: 'chat-sync-ready', since: 9 }]);
  relay.close();
});

test('closing the relay aborts the open stream and cancels a pending reconnect', async () => {
  const { opened, fetchImpl } = fakeFetch();
  const timers = manualTimers();
  const relay = createChatSyncRelay({ sessionId: 's1', accessToken: TOKEN, fetchImpl, getSince: () => undefined, onEvent: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await tick();
  opened[0].controller.close();
  await tick();
  assert.equal(timers.size(), 1);
  relay.close();
  assert.equal(timers.size(), 0, 'pending reconnect cancelled');
  timers.runAll();
  await tick();
  assert.equal(opened.length, 1, 'no connection after close');

  const second = fakeFetch();
  const relay2 = createChatSyncRelay({ sessionId: 's2', accessToken: TOKEN, fetchImpl: second.fetchImpl, getSince: () => undefined, onEvent: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await tick();
  relay2.close();
  await tick();
  assert.equal(second.opened[0].signal.aborted, true, 'open stream aborted on close');
  assert.equal(timers.size(), 0, 'no reconnect after an intentional close');
});
