import assert from 'node:assert/strict';
import { mock } from 'node:test';
import React from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Exercise the actual Panel, API and effects in Node. No browser, sockets or real accounts.
// This hook dispatcher intentionally tests lifecycle wiring, not React DOM or visual acceptance.
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const timers = new Map();
let timerId = 0;
const storage = new Map();
globalThis.window = {
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  location: { origin: 'http://localhost', href: 'http://localhost/', protocol: 'http:', hostname: 'localhost' },
  setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout: id => timers.delete(id),
  setInterval: () => ++timerId, clearInterval: () => {},
  requestAnimationFrame: () => ++timerId, cancelAnimationFrame: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
};
globalThis.document = { querySelector: () => null };
const server = await createServer({
  configFile: false, cacheDir: process.env.MC_DEV_CACHE, root: process.cwd(),
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false },
  plugins: [react(), {
    name: 'provider-lifecycle-context',
    enforce: 'pre',
    resolveId(id) {
      if (/\/mission-control-store(?:\.tsx)?$/.test(id)) return '\0provider-test-store';
      if (/\/i18n(?:\.tsx)?$/.test(id)) return '\0provider-test-i18n';
    },
    load(id) {
      if (id === '\0provider-test-store') return "export const useMissionControl = () => ({ storedToken: '' });";
      if (id === '\0provider-test-i18n') return "export const useI18n = () => ({ locale: 'en', numberLocale: 'en-US', t: key => key });";
    },
  }],
});
let harness;
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}
function mount(Panel) {
  const slots = [];
  let index = 0, dirty = true, tree, effects;
  const dispatcher = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, next => {
        const value = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { ref: { current: initial } };
      return slots[i].ref;
    },
    useEffect(effect, deps) {
      const i = index++;
      if (!slots[i]) slots[i] = {};
      const old = slots[i];
      if (!old.deps || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) {
        effects.push(() => { old.cleanup?.(); old.deps = deps; old.cleanup = effect(); });
      }
    },
  };
  return {
    async flush() {
      for (let round = 0; round < 20; round++) {
        if (dirty) {
          dirty = false; index = 0; effects = [];
          const previous = internals.H;
          internals.H = dispatcher;
          try { tree = Panel(); } finally { internals.H = previous; }
          for (const effect of effects) effect();
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(dirty, false, 'the lifecycle harness must settle');
    },
    dialog: () => nodes(tree).find(node => node.type?.name === 'ProviderUsageCustomizeDialog').props,
    customize: () => nodes(tree).find(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog').props.onClick(),
    cards: () => nodes(tree).filter(node => node.type?.name === 'ProviderCard').map(node => node.props.provider),
    unmount: () => { for (const slot of slots) slot.cleanup?.(); timers.clear(); },
  };
}
const descriptor = provider => ({ provider, displayName: provider, enabled: true, defaultEnabled: true, source: 'codexbar', selectable: true });
const usage = provider => ({ provider, available: true, updatedAt: '2026-10-06T01:00:00Z', windows: [{ id: 'primary', label: 'Quota', usedPercent: 12 }], balances: [], metrics: [] });
try {
  const { ProviderUsagePanel } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
  mock.timers.enable({ apis: ['setTimeout'] });
  for (const commitBeforeTimeout of [true, false]) {
    let selected = ['a'], revision = 'a'.repeat(64), pendingPut;
    let usageReads = 0;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        writes.push(body);
        assert.equal(body.expectedRevision, revision, 'the real Panel must send its latest canonical revision');
        if (commitBeforeTimeout) { selected = body.selectedProviders; revision = 'b'.repeat(64); }
        return { status: 200, ok: true, json: () => new Promise(resolve => { pendingPut = { body, resolve }; }) };
      }
      if (String(url).includes('/catalog')) return {
        status: 200, ok: true, json: async () => ({ available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: selected, selectionRevision: revision }),
      };
      usageReads++;
      return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: selected.map(usage) }) };
    };
    harness = mount(ProviderUsagePanel);
    await harness.flush();
    assert.deepEqual(harness.cards().map(provider => provider.provider), ['a']);
    harness.customize();
    await harness.flush();
    harness.dialog().onToggle('a'); harness.dialog().onToggle('b');
    await harness.flush();
    harness.dialog().onSave();
    await harness.flush();
    assert.equal(harness.dialog().saving, true);
    const readsBeforeReconciliation = usageReads;
    mock.timers.tick(10_000);
    await harness.flush();
    assert.equal(harness.dialog().saving, false, 'only a versioned reconciliation may enable another save');
    assert.deepEqual(harness.dialog().catalog.selectedProviders, commitBeforeTimeout ? ['b'] : ['a']);
    assert.ok(usageReads > readsBeforeReconciliation, 'uncertain PUT reconciliation must reload usage immediately, without waiting for polling');
    assert.deepEqual(harness.cards().map(provider => provider.provider), commitBeforeTimeout ? ['b'] : ['a']);
    const oldPut = pendingPut;
    if (!commitBeforeTimeout) {
      harness.dialog().onToggle('a'); harness.dialog().onToggle('c');
      await harness.flush();
      // Model the backend CAS verified separately by the real concurrent HTTP test.
      globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body);
          writes.push(body);
          assert.equal(body.expectedRevision, revision);
          selected = body.selectedProviders; revision = 'c'.repeat(64);
          return { status: 200, ok: true, json: async () => ({ selectedProviders: selected, selectionRevision: revision }) };
        }
        return { status: 200, ok: true, json: async () => String(url).includes('/catalog')
          ? { available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: selected, selectionRevision: revision }
          : { success: true, available: true, providers: selected.map(usage) } };
      };
      harness.dialog().onSave();
      await harness.flush();
      assert.deepEqual(harness.dialog().catalog.selectedProviders, ['c']);
      assert.notEqual(oldPut.body.expectedRevision, revision, 'late B must be rejected by the backend fence');
      oldPut.resolve({ selectedProviders: ['b'], selectionRevision: 'b'.repeat(64) });
      await harness.flush();
      assert.deepEqual(harness.dialog().catalog.selectedProviders, ['c'], 'late B acknowledgement cannot replace C');
      assert.deepEqual(harness.cards().map(provider => provider.provider), ['c']);
    } else {
      oldPut.resolve({ selectedProviders: ['b'], selectionRevision: revision });
      await harness.flush();
      assert.deepEqual(harness.dialog().catalog.selectedProviders, ['b']);
    }
    harness.unmount(); harness = null;
  }
  console.log('real Panel lifecycle: fenced saves, late response isolation and immediate usage reconciliation passed (Node, no browser)');
} finally {
  harness?.unmount(); mock.timers.reset(); await server.close();
  for (const [key, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
