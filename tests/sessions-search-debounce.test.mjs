import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// MC-FIX-7: real SessionsRoute, real hermes-api loader, real React Router.
// Fixtures: fetch, window timers, translations, the store token and bot roster.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/sessions', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'Node', 'Element']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

// Controlled window timers; React itself keeps the real Node timers.
let now = 0;
let nextId = 0;
const timeouts = new Map();
window.setTimeout = (fn, delay = 0) => { const id = ++nextId; timeouts.set(id, { fn, at: now + delay }); return id; };
window.clearTimeout = (id) => { timeouts.delete(id); };
window.setInterval = () => ++nextId; // polling never fires in this suite
window.clearInterval = () => {};
async function advance(ms) {
  now += ms;
  const due = [...timeouts.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
  await flush(() => { for (const [id, t] of due) { timeouts.delete(id); t.fn(); } });
}

const sessionQueries = [];
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'http://localhost');
  if (parsed.pathname.endsWith('/mission-control/sessions')) {
    sessionQueries.push(parsed.searchParams.get('query') ?? parsed.searchParams.get('q') ?? '');
    return Response.json({ items: [], pagination: { total: 0, offset: 0, limit: 50, hasMore: false }, stats: { totalSessions: 0, liveSessions: 0, activeAgents: 0 }, facets: {}, tabCounts: {} });
  }
  return Response.json({});
};

const cacheDir = mkdtempSync(path.join(tmpdir(), 'mc-sessions-search-'));
const server = await createServer({
  root: process.cwd(), configFile: false, cacheDir, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  plugins: [react(), {
    name: 'sessions-search-fixtures', enforce: 'pre',
    resolveId(id) {
      if (/\/i18n(?:\.tsx)?$/.test(id)) return '\0fixture-i18n';
      if (/\/mission-control-store(?:\.tsx)?$/.test(id)) return '\0fixture-store';
      if (/\/bot-gateway(?:\.ts)?$/.test(id)) return '\0fixture-bots';
    },
    load(id) {
      if (id === '\0fixture-i18n') return "export const useI18n = () => ({ locale: 'en', t: key => key });";
      if (id === '\0fixture-store') return "export const useMissionControl = () => ({ storedToken: 'synthetic-token' });";
      if (id === '\0fixture-bots') return 'export const loadBotProfiles = async () => ({ profiles: [] });';
    },
  }],
});
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom');

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function flush(action = () => {}) {
  await act(async () => { await action(); for (let i = 0; i < 6; i++) await settle(); });
}

let root;
let location;
let navigate;
function Probe() { location = useLocation(); navigate = useNavigate(); return null; }
const searchInput = () => document.querySelector('input[aria-label="sessions.searchPlaceholder"]');
const urlQuery = () => new URLSearchParams(location.search).get('query');
async function type(value) {
  const input = searchInput();
  await flush(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function select(label, value) {
  const el = document.querySelector(`select[aria-label="${label}"]`);
  await flush(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

let SessionsRoute;
async function mount(entry = '/sessions') {
  sessionQueries.length = 0;
  timeouts.clear();
  root = createRoot(document.getElementById('root'));
  await flush(() => root.render(React.createElement(MemoryRouter, { initialEntries: [entry] },
    React.createElement(Probe), React.createElement(SessionsRoute))));
  await flush();
}
async function unmount() { await flush(() => root.unmount()); }

try {
  ({ SessionsRoute } = await server.ssrLoadModule('/src/routes/SessionsRoute.tsx'));
  const { SESSION_SEARCH_DEBOUNCE_MS: DEBOUNCE = 300 } = await server.ssrLoadModule('/src/routes/SessionsRoute.tsx');

  await test('typing fast sends one request for the final query, not one per character', async () => {
    await mount();
    try {
      assert.deepEqual(sessionQueries, ['']);
      for (const value of ['a', 'ab', 'abc']) {
        await type(value);
        assert.equal(searchInput().value, value, 'input reflects keystrokes immediately');
        await advance(50);
      }
      assert.deepEqual(sessionQueries, [''], 'no request for intermediate characters');
      assert.equal(urlQuery(), null);
      await advance(DEBOUNCE);
      assert.deepEqual(sessionQueries, ['', 'abc']);
      assert.equal(urlQuery(), 'abc');
    } finally { await unmount(); }
  });

  await test('Enter commits the query without waiting for the debounce', async () => {
    await mount();
    try {
      await type('xy');
      await flush(() => searchInput().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      assert.equal(urlQuery(), 'xy');
      assert.deepEqual(sessionQueries, ['', 'xy']);
      await advance(DEBOUNCE);
      assert.deepEqual(sessionQueries, ['', 'xy'], 'no duplicate request after Enter');
    } finally { await unmount(); }
  });

  await test('initial URL query fills the field and clearing it is debounced', async () => {
    await mount('/sessions?query=init');
    try {
      assert.equal(searchInput().value, 'init');
      assert.deepEqual(sessionQueries, ['init']);
      await type('');
      assert.equal(urlQuery(), 'init');
      await advance(DEBOUNCE);
      assert.equal(urlQuery(), null);
      assert.deepEqual(sessionQueries, ['init', '']);
    } finally { await unmount(); }
  });

  await test('an external URL change wins over a pending draft', async () => {
    await mount();
    try {
      await type('stale');
      await flush(() => navigate('/sessions?query=ext'));
      assert.equal(searchInput().value, 'ext');
      await advance(DEBOUNCE * 2);
      assert.equal(urlQuery(), 'ext');
      assert.ok(!sessionQueries.includes('stale'), `stale query requested: ${sessionQueries}`);
    } finally { await unmount(); }
  });

  await test('navigating back to the already-committed query cancels a pending draft', async () => {
    await mount('/sessions?query=a');
    try {
      await type('ab');
      await flush(() => navigate('/sessions?query=a'));
      assert.equal(searchInput().value, 'a', 'history wins over the draft');
      await advance(DEBOUNCE * 2);
      assert.equal(urlQuery(), 'a');
      assert.ok(!sessionQueries.includes('ab'), `stale draft requested: ${sessionQueries}`);
    } finally { await unmount(); }
  });

  await test('changing a filter while typing keeps both the filter and the query', async () => {
    await mount();
    try {
      await type('ab');
      await select('sessions.allStatuses', 'live');
      await advance(DEBOUNCE);
      const params = new URLSearchParams(location.search);
      assert.equal(params.get('status'), 'live');
      assert.equal(params.get('query'), 'ab');
      assert.equal(sessionQueries.at(-1), 'ab');
    } finally { await unmount(); }
  });

  await test('unmounting with a pending draft sends nothing', async () => {
    await mount();
    await type('gone');
    await unmount();
    await advance(DEBOUNCE * 2);
    assert.deepEqual(sessionQueries, ['']);
  });
} finally {
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
