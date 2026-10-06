import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createServer } from 'vite';
const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE, root: process.cwd(), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
const originalFetch = globalThis.fetch;
const revision = 'a'.repeat(64);
try {
  const api = await server.ssrLoadModule('/src/lib/hermes-api.ts');
  mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return { ok: true, status: 200, json: () => new Promise(() => {}) }; };
  let result;
  const request = api.loadProviderUsage().then(value => { result = value; }, error => { result = error; });
  await Promise.resolve(); await Promise.resolve();
  mock.timers.tick(10_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(result?.name, 'ProviderUsageTimeoutError', 'the JSON body must share the request deadline');
  assert.equal(signal.aborted, true);
  await request;
  for (const load of [() => api.loadProviderUsage(), () => api.loadProviderUsageCatalog(), () => api.saveProviderUsageSelection(['future'], undefined, undefined, revision)]) {
    globalThis.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
    let error;
    const pending = load().catch(reason => { error = reason; });
    mock.timers.tick(10_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(error?.name, 'ProviderUsageTimeoutError');
    assert.equal(signal.aborted, true);
    await pending;
  }
  for (const load of [() => api.loadProviderUsageCatalog(), () => api.saveProviderUsageSelection(['future'], undefined, undefined, revision)]) {
    globalThis.fetch = async (_url, options) => { signal = options.signal; return { ok: true, status: 200, json: () => new Promise(() => {}) }; };
    let error;
    const pending = load().catch(reason => { error = reason; });
    await Promise.resolve(); await Promise.resolve();
    mock.timers.tick(10_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(error?.name, 'ProviderUsageTimeoutError');
    assert.equal(signal.aborted, true);
    await pending;
  }
  for (const status of [401, 500]) {
    globalThis.fetch = async () => ({ status, ok: false });
    await assert.rejects(api.loadProviderUsage(), error => status === 401 ? error instanceof api.MissionControlAuthError : /HTTP 500/.test(error.message));
  }
  const caller = new AbortController();
  globalThis.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
  const cancelled = api.loadProviderUsage(undefined, caller.signal);
  caller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  await assert.rejects(api.loadProviderUsage(undefined, caller.signal), { name: 'AbortError' });
  let requested;
  globalThis.fetch = async (url) => { requested = url; return { status: 200, ok: true, json: async () => ({ available: true, providers: [], selectedProviders: [] }) }; };
  await api.loadProviderUsageCatalog();
  assert.equal(requested.endsWith('/provider-usage/catalog'), true, 'Check now catalog read must not force discovery');
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ available: false, providers: [] }) });
  const malformed = await api.loadProviderUsage();
  assert.equal(malformed.available, false);
  assert.match(malformed.error, /malformed|unsupported/);
  let write;
  globalThis.fetch = async (_url, options) => {
    write = JSON.parse(options.body);
    return { status: 200, ok: true, json: async () => ({ selectedProviders: ['future'], selectionRevision: 'b'.repeat(64) }) };
  };
  const saved = await api.saveProviderUsageSelection(['future'], undefined, undefined, revision);
  assert.deepEqual(write, { selectedProviders: ['future'], expectedRevision: revision }, 'every PUT must carry its catalog revision');
  assert.equal(saved.selectionRevision, 'b'.repeat(64), 'retain the acknowledgement revision for the next save');
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(api.saveProviderUsageSelection(['future']), /HTTP 428/);
  assert.equal(calls, 0, 'do not issue mutations against an unversioned catalog');
  assert.equal(api.normalizeProviderUsageCatalog({ available: true, providers: [], selectedProviders: [], selectionRevision: 'bad' }), null);
  assert.equal(api.normalizeProviderUsageSelection({ selectedProviders: [], selectionRevision: null }), null);
  console.log('provider request/body deadline, auth, HTTP failure, caller cancellation and nonforced catalog passed');
} finally { mock.timers.reset(); globalThis.fetch = originalFetch; await server.close(); }
