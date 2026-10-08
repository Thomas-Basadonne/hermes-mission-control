import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Event']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.setInterval = () => 1;
window.clearInterval = () => {};
const settle = () => new Promise(resolve => setImmediate(resolve));
async function flush(action = () => {}) {
  await act(async () => { await action(); for (let i = 0; i < 8; i++) await settle(); });
}
const waitFor = async predicate => {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('Timed out waiting for fixture state');
};
let mode = 'live';
let sessionItems = [];
let deferredSession = null;
let deferNextSession = false;
let fetchCalls = [];
globalThis.fetch = async url => {
  const parsed = new URL(String(url), 'http://localhost');
  const pathname = parsed.pathname;
  fetchCalls.push(pathname);
  if (mode === 'auth' && pathname.endsWith('/mission-control/sessions')) return new Response('{}', { status: 401 });
  if (pathname.endsWith('/mission-control/sessions')) {
    if (mode === 'timeout') throw new Error('synthetic timeout');

    if (deferNextSession) {
      deferNextSession = false;
      return await new Promise(resolve => { deferredSession = resolve; });
    }
    return Response.json({ success: true, available: true, items: sessionItems, stats: { totalSessions: sessionItems.length, activeAgents: sessionItems.length } });
  }
  if (pathname.endsWith('/cron/jobs')) return mode === 'offline' ? new Response('{}', { status: 503 }) : Response.json([]);
  if (pathname.endsWith('/tools') || pathname.endsWith('/skills')) return Response.json({ available: true, items: [], toolsets: [], toolCatalog: [], resolvedTools: [], skills: [], categories: [] });
  if (pathname.endsWith('/system')) return Response.json({ health: 'healthy', source: 'local-psutil', host: 'fixture', platform: 'test', cpuCores: 1, summary: 'live' });
  if (pathname.endsWith('/status')) return Response.json({ gateway_running: true, active_sessions: 0 });
  if (pathname.endsWith('/model/info')) return Response.json({ model: 'fixture-model', provider: 'fixture' });
  if (pathname.endsWith('/config')) return Response.json({ config: {} });
  if (pathname.endsWith('/alerts')) return Response.json({ items: [] });
  return Response.json({});
};
const cacheDir = mkdtempSync(path.join(tmpdir(), 'mc-freshness-'));
const server = await createServer({
  root: process.cwd(), configFile: false, cacheDir, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false }, plugins: [react(), {
    name: 'freshness-fixtures', enforce: 'pre',
    resolveId(id) {
      if (/\/i18n(?:\.tsx)?$/.test(id)) return '\0fixture-i18n';
      if (/\/reload-diagnostics(?:\.ts)?$/.test(id)) return '\0fixture-diagnostics';
    },
    load(id) {
      if (id === '\0fixture-i18n') return "export const useI18n = () => ({ locale: 'en', t: key => key });";
      if (id === '\0fixture-diagnostics') return 'export const recordReloadDiagnostic = () => {};';
    },
  }],
});
let root;
let context;
try {
  const { createRoot } = await import('react-dom/client');
  const { MissionControlProvider, useMissionControl } = await server.ssrLoadModule('/src/lib/mission-control-store.tsx');
  function Observe() { context = useMissionControl(); return null; }
  root = createRoot(document.getElementById('root'));
  await flush(() => root.render(React.createElement(MissionControlProvider, null, React.createElement(Observe))));
  await waitFor(() => context.sources.sessions?.state !== 'loading' && context.sources.cron?.state !== 'loading');
  assert.equal(context.sources.sessions.state, 'live');
  assert.equal(context.sources.sessions.source, 'mission-control-sessions');
  assert.ok(context.sources.sessions.lastSuccessAt);
  const firstSuccess = context.sources.sessions.lastSuccessAt;

  sessionItems = [{ sessionId: 'live-1', title: 'Live session', source: 'test', model: 'fixture', status: 'live', startedAt: 1, lastActiveAt: 2, messageCount: 1 }];
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: false }));
  assert.equal(context.snapshot.sessions.items.length, 1);
  const lastGood = context.snapshot.sessions;

  mode = 'offline';
  const cronLastSuccess = context.sources.cron.lastSuccessAt;
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: true }));
  assert.equal(context.snapshot.sessions.items[0].id, lastGood.items[0].id, 'a partial failure must retain successful session data');
  assert.equal(context.sources.sessions.state, 'live');
  assert.equal(context.sources.cron.state, 'error');
  assert.equal(context.sources.cron.lastSuccessAt, cronLastSuccess, 'failure must not advance the last-success timestamp');
  assert.ok(context.sources.cron.lastAttemptAt);

  mode = 'timeout';
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: false }));
  assert.equal(context.snapshot.sessions.items[0].id, 'live-1');
  assert.equal(context.sources.sessions.state, 'error');
  assert.match(context.sources.sessions.error, /unavailable/i);
  assert.ok(context.sources.sessions.lastSuccessAt, 'timeout must not erase the last successful timestamp');

  mode = 'live';
  sessionItems = [];
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: true }));
  assert.equal(context.snapshot.sessions.items.length, 0, 'a valid empty response replaces old data');
  assert.equal(context.sources.sessions.state, 'live');
  assert.ok(context.sources.sessions.lastAttemptAt >= firstSuccess);

  sessionItems = [{ sessionId: 'older', title: 'Older', source: 'test', model: 'fixture', status: 'live' }];
  deferNextSession = true;
  let olderRefresh;
  await flush(() => { olderRefresh = context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: false }); });
  assert.ok(deferredSession, 'older session request is in flight');
  sessionItems = [{ sessionId: 'newer', title: 'Newer', source: 'test', model: 'fixture', status: 'live' }];
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: false }));
  assert.equal(context.snapshot.sessions.items[0].id, 'newer');
  deferredSession(Response.json({ success: true, available: true, items: [{ sessionId: 'older', title: 'Older', source: 'test', model: 'fixture', status: 'live' }], stats: { totalSessions: 1, activeAgents: 1 } }));
  await flush(() => olderRefresh);
  assert.equal(context.snapshot.sessions.items[0].id, 'newer', 'late older response cannot overwrite the newer response');

  deferNextSession = true;
  let omittedRefresh;
  await flush(() => { omittedRefresh = context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: true }); });
  assert.ok(deferredSession);
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeSessions: false, includeCron: false }));
  deferredSession(Response.json({ success: true, available: true, items: [], stats: { totalSessions: 0, activeAgents: 0 } }));
  await flush(() => omittedRefresh);
  assert.equal(context.sources.sessions.state, 'live', 'a newer poll omitting sessions must not strand its in-flight status as loading');
  assert.equal(context.snapshot.sessions.items.length, 0);

  mode = 'auth';
  await flush(() => context.refreshAll(undefined, { includeReference: false, includeSnapshot: false, includeCron: false }));
  assert.equal(context.authRequired, true);
  assert.equal(context.sources.sessions.state, 'error');
  assert.equal(context.sources.sessions.lastSuccessAt, null, 'auth lock scrubs live session data and its freshness claim');
  assert.equal(context.snapshot.sessions.items.length, 0);

  mode = 'live';
  sessionItems = [];
  await flush(() => context.refreshAll('fixture-token', { includeReference: false, includeSnapshot: false, includeCron: false }));
  assert.equal(context.authRequired, false);
  assert.equal(context.sources.sessions.state, 'live', 'a successful response recovers after auth failure');
  console.log('Source freshness lifecycle: empty/live, fallback/error, recovery, auth, and ordering passed.');
} finally {
  if (root) await flush(() => root.unmount());
  await server.close();
  dom.window.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
