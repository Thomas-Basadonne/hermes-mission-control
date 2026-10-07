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
  return [tree, ...nodes(tree.props.children), ...nodes(tree.props.footer)];
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
    async flush(force = false) {
      if (force) dirty = true;
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
    elements: () => nodes(tree),
    dialogElement: () => nodes(tree).find(node => node.type?.name === 'ProviderUsageCustomizeDialog'),
    dialog: () => nodes(tree).find(node => node.type?.name === 'ProviderUsageCustomizeDialog').props,
    customize: () => nodes(tree).find(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog').props.onClick(),
    cards: () => nodes(tree).filter(node => node.type?.name === 'ProviderCard').map(node => node.props.provider),
    hasText: text => nodes(tree).some(node => node.props.children === text),
    checkButton: () => nodes(tree).find(node => node.type === 'button' && node.props.title === 'provider.refreshHelp').props,
    unmount: () => { for (const slot of slots) slot.cleanup?.(); timers.clear(); },
  };
}
const descriptor = provider => ({ provider, displayName: provider, enabled: true, defaultEnabled: true, source: 'codexbar', selectable: true });
const usage = provider => ({ provider, available: true, updatedAt: '2026-10-06T01:00:00Z', windows: [{ id: 'primary', label: 'Quota', usedPercent: 12 }], balances: [], metrics: [] });
try {
  const { ProviderUsagePanel } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
  mock.timers.enable({ apis: ['setTimeout'] });
  storage.set('mission-control-provider-usage-preferences:v1', JSON.stringify({
    hiddenFields: { a: { windows: ['old-primary', null], balances: 'malformed' } },
    compactFields: { a: [null, { group: 'windows', id: 'old-primary' }, { group: 'invalid', id: 7 }] },
    fieldVisibility: { a: { invalid: null, another: 'sometimes' } },
  }));
  globalThis.fetch = async url => ({ status: 200, ok: true, json: async () => String(url).includes('/catalog')
    ? { available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }
    : { success: true, available: true, providers: [{ ...usage('a'), windows: [{ ...usage('a').windows[0], legacyIds: ['old-primary'] }] }] } });
  harness = mount(ProviderUsagePanel);
  await harness.flush();
  assert.equal(harness.dialog().preferences.groupFieldVisibility?.a?.windows?.primary, 'hidden', 'Panel must migrate loaded malformed legacy preferences after usage arrives');
  assert.equal(JSON.parse(storage.get('mission-control-provider-usage-preferences:v1')).groupFieldVisibility.a.windows.primary, 'hidden', 'Panel must persist the migrated preference');
  harness.unmount(); harness = null;
  // Remount with saved group settings and newly discovered literal IDs / aliases.
  const arrivingMetrics = [{ id: 'windows:primary', label: 'Literal metric', value: 2 }, { id: 'renamed', label: 'Alias metric', value: 3, legacyIds: ['windows:primary'] }];
  globalThis.fetch = async url => ({ status: 200, ok: true, json: async () => String(url).includes('/catalog')
    ? { available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }
    : { success: true, available: true, providers: [{ ...usage('a'), metrics: arrivingMetrics }] } });
  harness = mount(ProviderUsagePanel); await harness.flush();
  assert.deepEqual(harness.cards()[0].windows, [], 'saved window remains hidden');
  assert.deepEqual(harness.cards()[0].metrics.map(field => field.id), arrivingMetrics.map(field => field.id), 'new metrics must not inherit the window hide');
  const savedGroups = JSON.parse(storage.get('mission-control-provider-usage-preferences:v1')).groupFieldVisibility.a;
  assert.equal(savedGroups.windows.primary, 'hidden');
  assert.equal(savedGroups.metrics['windows:primary'], 'detailed', 'legacy compact selection still applies independently');
  assert.equal(savedGroups.metrics.renamed, 'detailed');
  harness.unmount(); harness = null; storage.clear();
  // Render the actual Customize child to test field controls, not source names.
  {
    globalThis.fetch = async url => ({ status: 200, ok: true, json: async () => String(url).includes('/catalog')
      ? { available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }
      : { success: true, available: true, providers: [{ ...usage('a'),
        windows: [{ id: 'shared', label: 'Quota', usedPercent: 12 }],
        balances: [{ id: 'shared', label: 'Balance', value: 5 }],
        metrics: [{ id: 'shared', label: 'Spend', value: 2 }],
      }] } });
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    const dialog = mount(() => {
      const element = harness.dialogElement();
      return element.type(element.props);
    });
    await dialog.flush();
    dialog.elements().find(node => node.type === 'button' && node.props.children === 'provider.customize.display').props.onClick();
    await dialog.flush();
    assert.equal(dialog.elements().some(node => node.type === 'input' && node.props.name === 'provider-usage-columns'), false, 'Display must not expose an obsolete column setting');
    const views = dialog.elements().filter(node => node.type === 'input' && node.props.name === 'provider-usage-view');
    assert.equal(views.length, 2, 'compact and detailed view controls remain available');
    views.find(node => !node.props.checked).props.onChange();
    await harness.flush(); await dialog.flush(true);
    assert.equal(harness.dialog().preferences.view, 'detailed');
    const radios = () => dialog.elements().filter(node => node.type === 'input' && node.props.name?.startsWith('visibility-'));
    assert.equal(new Set(radios().map(node => node.props.name)).size, 3, 'each group needs an independent native radio identity even with equal IDs');
    radios().find(node => node.props.name === 'visibility-a-windows-shared' && !node.props.checked).props.onChange();
    await harness.flush(); await dialog.flush(true);
    assert.equal(harness.dialog().preferences.groupFieldVisibility.a.windows.shared, 'detailed');
    assert.equal(harness.dialog().preferences.groupFieldVisibility.a.balances.shared, 'both');
    assert.equal(harness.dialog().preferences.groupFieldVisibility.a.metrics.shared, 'both');
    assert.equal(radios().filter(node => node.props.checked).length, 3);
    dialog.unmount(); harness.unmount(); harness = null; storage.clear();
  }
  // Lifecycle coverage only: actual wrapping is measured in the browser acceptance.
  for (const count of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const order = Array.from({ length: count }, (_, i) => `p${count - i - 1}`);
    storage.set('mission-control-provider-usage-preferences:v1', JSON.stringify({ providerOrder: order, columns: 1 }));
    globalThis.fetch = async url => ({ status: 200, ok: true, json: async () => String(url).includes('/catalog')
      ? { available: true, providers: Array.from({ length: count }, (_, i) => descriptor(`p${i}`)), selectedProviders: Array.from({ length: count }, (_, i) => `p${i}`), selectionRevision: 'a'.repeat(64) }
      : { success: true, available: true, providers: Array.from({ length: count }, (_, i) => usage(`p${i}`)) } });
    harness = mount(ProviderUsagePanel); await harness.flush();
    const cards = harness.elements().find(node => node.props.className === 'provider-usage-cards gap-3');
    assert.ok(cards, 'ready panels use the automatic card container');
    assert.equal(cards.props.style, undefined, 'no JavaScript-calculated layout');
    assert.equal(Object.hasOwn(cards.props, 'data-max-columns'), false);
    assert.deepEqual(harness.cards().map(({ provider }) => provider), order, 'visible cards retain preference order');
    assert.equal(harness.hasText('provider.noneSelected'), count === 0);
    assert.equal(Object.hasOwn(JSON.parse(storage.get('mission-control-provider-usage-preferences:v1')), 'columns'), false, 'mount strips the obsolete preference');
    harness.unmount(); harness = null; storage.clear();
  }
  let manualReads = 0, finishManual;
  const catalogResponse = () => ({ status: 200, ok: true, json: async () => ({ available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }) });
  globalThis.fetch = async url => {
    if (String(url).includes('/catalog')) return catalogResponse();
    manualReads++;
    if (manualReads === 1) return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: [usage('a')] }) };
    return { status: 200, ok: true, json: () => new Promise(resolve => { finishManual = resolve; }) };
  };
  harness = mount(ProviderUsagePanel);
  await harness.flush();
  const clickCheck = harness.checkButton().onClick;
  clickCheck(); clickCheck();
  await harness.flush();
  assert.equal(manualReads, 2, 'double click must start only one manual usage read');
  assert.equal(harness.checkButton().disabled, true);
  assert.equal(harness.checkButton()['aria-busy'], true, 'manual check must expose its busy state');
  assert.deepEqual(harness.cards().map(provider => provider.provider), ['a'], 'manual check must retain cards');
  finishManual({ success: true, available: true, providers: [usage('a')] });
  await harness.flush();
  assert.equal(harness.hasText('provider.checkComplete'), true, 'manual check must acknowledge completion even when data is cached');
  assert.equal(harness.checkButton().disabled, false);
  harness.unmount(); harness = null;
  for (const outcome of ['ready', 'provider-error', 'malformed-fields', 'unavailable-last-good', 'transport-error', 'expired']) {
    let reads = 0;
    globalThis.fetch = async url => {
      if (String(url).includes('/catalog')) return catalogResponse();
      reads++;
      if (reads === 3 && outcome === 'transport-error') throw new TypeError('Network unavailable');
      const provider = reads === 2 ? { ...usage('a'), refreshState: 'running', refreshStartedAt: new Date(Date.now() - 1_000).toISOString(), refreshDeadlineAt: new Date(Date.now() + 5_000).toISOString() }
        : reads === 3 && outcome === 'provider-error' ? { ...usage('a'), refreshState: 'failed', error: 'Collector failed' }
          : reads === 3 && outcome === 'expired' ? { ...usage('a'), refreshState: 'running', refreshStartedAt: new Date(Date.now() - 10_000).toISOString(), refreshDeadlineAt: new Date(Date.now() - 1_000).toISOString() }
            : reads === 3 && outcome === 'malformed-fields' ? { ...usage('a'), windows: [{ id: 'primary', label: 'Quota', usedPercent: 'broken' }] }
              : reads === 3 && outcome === 'unavailable-last-good' ? { ...usage('a'), available: false, windows: [] }
                : usage('a');
      return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: [provider] }) };
    };
    harness = mount(ProviderUsagePanel);
    await harness.flush();
    harness.checkButton().onClick();
    await harness.flush();
    assert.equal(harness.checkButton().disabled, true, 'Check now must remain disabled between background collection polls');
    assert.equal(harness.hasText('provider.updating'), true);
    assert.equal(harness.hasText('provider.checkComplete'), false);
    harness.checkButton().onClick();
    await harness.flush();
    assert.equal(reads, 2, 'clicks during collection must not restart the request');
    const poll = [...timers.entries()].find(([, timer]) => timer.delay === 1_500);
    assert.ok(poll);
    timers.delete(poll[0]); poll[1].fn();
    await harness.flush();
    assert.equal(harness.checkButton().disabled, false);
    assert.equal(harness.hasText(outcome === 'ready' ? 'provider.checkComplete' : 'provider.checkFailed'), true, `${outcome}: manual check must report its actual outcome`);
    assert.deepEqual(harness.cards().map(provider => provider.provider), ['a']);
    harness.unmount(); harness = null;
  }
  let initialReads = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('/catalog')) return { status: 200, ok: true, json: async () => ({ available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }) };
    if (++initialReads === 1) return { status: 503, ok: false };
    return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: [usage('a')] }) };
  };
  harness = mount(ProviderUsagePanel);
  await harness.flush();
  assert.equal(harness.hasText('provider.loading'), true, 'initial transient failure must keep loading while the automatic retry is pending');
  assert.equal(harness.hasText('provider.unavailable'), false);
  assert.equal(harness.hasText('provider.refreshFailed'), false, 'do not show an error banner during bounded initialization recovery');
  const initialRetry = [...timers.values()].find(timer => timer.delay === 5_000);
  assert.ok(initialRetry, 'initial failure must schedule a retry');
  initialRetry.fn();
  await harness.flush();
  assert.deepEqual(harness.cards().map(provider => provider.provider), ['a']);
  assert.equal(harness.hasText('provider.loading'), false);
  globalThis.fetch = async () => ({ status: 503, ok: false });
  const backgroundPoll = [...timers.entries()].filter(([, timer]) => timer.delay === 60_000).at(-1);
  assert.ok(backgroundPoll);
  timers.delete(backgroundPoll[0]); backgroundPoll[1].fn();
  await harness.flush();
  assert.deepEqual(harness.cards().map(provider => provider.provider), ['a'], 'background failure must retain the last good cards');
  assert.equal(harness.hasText('provider.loading'), false);
  assert.equal(harness.hasText('provider.refreshFailed'), true, 'background failure must remain visible without blocking cached cards');
  harness.unmount(); harness = null;
  for (const failure of ['503', '408', '429', 'network', 'timeout', '401', '403', '400', 'malformed', 'invalid-json']) {
    globalThis.fetch = async url => {
      if (String(url).includes('/catalog')) return { status: 200, ok: true, json: async () => ({ available: true, providers: [descriptor('a')], selectedProviders: ['a'], selectionRevision: 'a'.repeat(64) }) };
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'malformed') return { status: 200, ok: true, json: async () => ({}) };
      if (failure === 'invalid-json') return { status: 200, ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } };
      return { status: Number(failure), ok: false };
    };
    harness = mount(ProviderUsagePanel);
    await harness.flush();
    const transient = ['503', '408', '429', 'network', 'timeout'].includes(failure);
    if (failure === 'timeout') { mock.timers.tick(10_000); await harness.flush(); }
    assert.equal(harness.hasText('provider.loading'), transient, `${failure}: only transient failures may keep initial loading`);
    if (transient) {
      for (const delay of [5_000, 15_000]) {
        const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `${failure}: expected retry after ${delay}`);
        timers.delete(entry[0]); entry[1].fn();
        await harness.flush();
        if (failure === 'timeout') { mock.timers.tick(10_000); await harness.flush(); }
      }
    }
    assert.equal(harness.hasText('provider.unavailable'), true, `${failure}: terminal failure must not leave an infinite spinner`);
    assert.equal(harness.hasText('provider.loading'), false);
    if (!transient) {
      globalThis.fetch = async () => ({ status: 503, ok: false });
      const delay = failure === 'malformed' ? 60_000 : 5_000;
      const entry = [...timers.entries()].filter(([, timer]) => timer.delay === delay).at(-1);
      assert.ok(entry);
      timers.delete(entry[0]); entry[1].fn();
      await harness.flush();
      assert.equal(harness.hasText('provider.loading'), false, 'a terminal initialization error must not restart loading on a later transient failure');
    }
    harness.unmount(); harness = null;
  }
  // A draft belongs to the revision visible when Customize opened, not a later poll.
  {
    let selected = ['a'], revision = 'a'.repeat(64);
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body); writes.push(body);
        if (body.expectedRevision !== revision) return { status: 409, ok: false };
        selected = body.selectedProviders; revision = 'c'.repeat(64);
        return { status: 200, ok: true, json: async () => ({ selectedProviders: selected, selectionRevision: revision }) };
      }
      return { status: 200, ok: true, json: async () => String(url).includes('/catalog')
        ? { available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: selected, selectionRevision: revision }
        : { success: true, available: true, providers: selected.map(usage) } };
    };
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    harness.dialog().onToggle('b'); await harness.flush();
    selected = ['c']; revision = 'b'.repeat(64); // Another client saves.
    const poll = [...timers.entries()].find(([, timer]) => timer.delay === 60_000);
    assert.ok(poll); timers.delete(poll[0]); poll[1].fn(); await harness.flush();
    assert.deepEqual(harness.dialog().catalog.selectedProviders, ['c']);
    assert.deepEqual(harness.dialog().draftSelection, ['a', 'b'], 'poll must not overwrite the open draft');
    harness.dialog().onSave(); await harness.flush();
    assert.equal(writes[0].expectedRevision, 'a'.repeat(64), 'old draft must retain its starting revision');
    assert.deepEqual(selected, ['c'], 'a stale draft cannot overwrite the external save');
    assert.ok(harness.dialog().error);
    assert.equal(harness.dialog().open, true, 'conflict keeps Customize open');
    assert.deepEqual(harness.dialog().draftSelection, ['a', 'b'], 'conflict keeps the stale draft visible');
    assert.equal(harness.dialog().error, 'provider.selectionConflict', 'conflict reports the canonical revision changed');
    assert.equal(harness.dialog().saving, false);
    assert.equal(writes.length, 1, 'reconciliation must never retry the stale write automatically');
    harness.dialog().onReconcileSelection(); await harness.flush();
    assert.deepEqual(harness.dialog().draftSelection, ['c'], 'conflict must reconcile to a fresh canonical draft in the same dialog');
    assert.equal(harness.dialog().catalog.selectionRevision, 'b'.repeat(64), 'reconcile must adopt the canonical revision, not the stale one');
    assert.equal(harness.dialog().error, 'provider.selectionConflictResolved', 'discarding a stale draft must be explicit');
    harness.dialog().onToggle('b'); await harness.flush();
    harness.dialog().onSave(); await harness.flush();
    assert.equal(writes[1].expectedRevision, 'b'.repeat(64));
    assert.deepEqual(selected, ['c', 'b']);
    assert.equal(harness.dialog().open, false, 'reviewed choices save without closing and reopening after a conflict');
    harness.unmount(); harness = null;
  }
  // Review changes must serialize its recovery read and fence its response.
  {
    let selected = ['a'], revision = 'a'.repeat(64), catalogReads = 0, held = null;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        if (body.expectedRevision !== revision) return { status: 409, ok: false, json: async () => ({ error: 'selection_conflict' }) };
        selected = body.selectedProviders; revision = 'b'.repeat(64);
        return { status: 200, ok: true, json: async () => ({ selectedProviders: selected, selectionRevision: revision }) };
      }
      if (String(url).includes('/catalog')) {
        catalogReads++;
        if (held && !held.started) {
          held.started = true;
          return { status: 200, ok: true, json: () => held.promise };
        }
        return { status: 200, ok: true, json: async () => ({ available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: selected, selectionRevision: revision }) };
      }
      return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: selected.map(usage) }) };
    };
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    harness.dialog().onToggle('b'); await harness.flush();
    // Another client commits, so the next save conflicts.
    selected = ['c', 'b']; revision = 'b'.repeat(64);
    harness.dialog().onSave(); await harness.flush();
    assert.equal(harness.dialog().error, 'provider.selectionConflict');
    // The first recovery read is held; its response lands later.
    held = {}; held.promise = new Promise(resolve => { held.release = () => resolve({ available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: ['c', 'b'], selectionRevision: 'b'.repeat(64) }); });
    const readsBefore = catalogReads;
    harness.dialog().onReconcileSelection();
    await harness.flush();
    assert.equal(catalogReads, readsBefore + 1, 'the first recovery read must start');
    assert.equal(harness.dialog().saving, true, 'the rendered Review changes / save controls disable while the recovery read is pending');
    // A duplicate click while the recovery is pending must not start a second GET.
    harness.dialog().onReconcileSelection();
    await harness.flush();
    assert.equal(catalogReads, readsBefore + 1, 'a duplicate Review changes click must not start a concurrent recovery read');
    // A normal catalog poll may finish while the explicit recovery is pending.
    // It must not release loading state that belongs to the recovery request.
    for (const [id, timer] of [...timers.entries()].filter(([, timer]) => timer.delay === 60_000)) {
      timers.delete(id); timer.fn();
    }
    await harness.flush();
    assert.equal(catalogReads, readsBefore + 2, 'an independent catalog poll completes during recovery');
    assert.equal(harness.dialog().saving, true, 'a catalog poll must not unlock controls owned by the pending recovery');
    // End the dialog cycle, then let the stale response arrive.
    harness.dialog().onClose();
    await harness.flush();
    const draftBefore = harness.dialog().draftSelection;
    held.release();
    await harness.flush();
    assert.deepEqual(harness.dialog().draftSelection, draftBefore, 'a recovery response landing after the dialog cycle must not rewrite the draft');
    assert.equal(harness.dialog().open, false, 'a fenced response must not reopen the dialog');
    assert.equal(harness.dialog().error, 'provider.selectionConflict', 'a fenced response must not overwrite the pending error');
    // The cancelled request must release the collection controls for the next
    // dialog cycle, without a poll, Check now or remount rescuing the state.
    held = null;
    harness.customize(); await harness.flush();
    const dialog = mount(() => {
      const element = harness.dialogElement();
      return element.type(element.props);
    });
    await dialog.flush();
    const collection = provider => dialog.elements().find(node => node.type === 'input'
      && node.props['aria-label'] === `provider.collectUsage: ${provider}`).props;
    assert.equal(collection('a').disabled, false, 'Close → late recovery → reopen must leave collection controls usable');
    assert.equal(collection('b').disabled, false);
    assert.equal(collection('c').disabled, false);
    assert.deepEqual(harness.dialog().draftSelection, ['c', 'b'], 'reopening must start from the canonical selection');
    assert.equal(harness.dialog().error, null, 'reopening clears the previous dialog error');
    collection('a').onChange();
    await harness.flush(); await dialog.flush(true);
    const save = dialog.elements().find(node => node.type === 'button' && node.props.children === 'provider.saveSelection').props;
    assert.equal(save.disabled, false, 'an edit after cancellation must be saveable');
    save.onClick(); await harness.flush();
    assert.deepEqual(selected, ['c', 'b', 'a'], 'the next dialog cycle can persist a reviewed edit');
    assert.equal(harness.dialog().open, false);
    dialog.unmount(); harness.unmount(); harness = null;
  }
  // Recovery failures must release their controls without accepting an unusable
  // canonical draft; a retry in the same dialog remains an explicit user action.
  for (const outcome of ['success', '503', 'network', 'invalid-json', 'unavailable', 'unversioned', 'timeout']) {
    let selected = ['a'], revision = 'a'.repeat(64), recovery = false, writes = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        writes++;
        const body = JSON.parse(options.body);
        if (body.expectedRevision !== revision) return { status: 409, ok: false };
        selected = body.selectedProviders;
        revision = 'c'.repeat(64);
        return { status: 200, ok: true, json: async () => ({ selectedProviders: selected, selectionRevision: revision }) };
      }
      if (!String(url).includes('/catalog')) return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: selected.map(usage) }) };
      const canonical = { available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: selected, selectionRevision: revision };
      if (!recovery || outcome === 'success') return { status: 200, ok: true, json: async () => canonical };
      if (outcome === '503') return { status: 503, ok: false };
      if (outcome === 'network') throw new TypeError('Network unavailable');
      if (outcome === 'timeout') return new Promise(() => {});
      if (outcome === 'invalid-json') return { status: 200, ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } };
      return { status: 200, ok: true, json: async () => outcome === 'unavailable'
        ? { ...canonical, available: false, selectedProviders: [], error: 'Catalog unavailable' }
        : { ...canonical, selectionRevision: undefined } };
    };
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    const dialog = mount(() => { const element = harness.dialogElement(); return element.type(element.props); });
    const flush = async () => { await harness.flush(); await dialog.flush(true); };
    const button = label => dialog.elements().find(node => node.type === 'button' && node.props.children === label).props;
    const collection = provider => dialog.elements().find(node => node.type === 'input' && node.props['aria-label'] === `provider.collectUsage: ${provider}`).props;
    await flush();
    collection('b').onChange(); await flush();
    selected = ['c']; revision = 'b'.repeat(64);
    button('provider.saveSelection').onClick(); await flush();
    assert.equal(harness.dialog().selectionConflict, true);
    recovery = true;
    button('provider.reviewChanges').onClick(); await flush();
    if (outcome === 'timeout') {
      assert.equal(button('provider.reviewChanges').disabled, true);
      mock.timers.tick(10_000); await flush();
    }
    assert.equal(collection('a').disabled, false, `${outcome}: recovery must release its loading state`);
    assert.equal(writes, 1, `${outcome}: recovery must never perform an automatic write`);
    if (outcome !== 'success') {
      assert.deepEqual(harness.dialog().draftSelection, ['a', 'b'], `${outcome}: failed recovery must retain the draft`);
      assert.equal(harness.dialog().catalog.selectionRevision, 'b'.repeat(64), `${outcome}: retain the last usable canonical revision`);
      assert.equal(harness.dialog().selectionConflict, true, `${outcome}: recovery remains explicit and retryable`);
      assert.equal(button('provider.reviewChanges').disabled, false);
      recovery = false;
      button('provider.reviewChanges').onClick(); await flush();
    }
    assert.deepEqual(harness.dialog().draftSelection, ['c']);
    assert.equal(harness.dialog().selectionConflict, false);
    collection('a').onChange(); await flush();
    button('provider.saveSelection').onClick(); await flush();
    assert.deepEqual(selected, ['c', 'a'], `${outcome}: reviewed edit must persist after recovery/retry`);
    assert.equal(harness.dialog().open, false);
    dialog.unmount(); harness.unmount(); harness = null;
  }
  // A cancelled body's late completion cannot release a newer recovery owner.
  {
    let selected = ['a'], revision = 'a'.repeat(64), holdNext = false;
    const bodies = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') return { status: 409, ok: false };
      if (!String(url).includes('/catalog')) return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: selected.map(usage) }) };
      const canonical = { available: true, providers: ['a', 'b', 'c'].map(descriptor), selectedProviders: [...selected], selectionRevision: revision };
      if (!holdNext) return { status: 200, ok: true, json: async () => canonical };
      holdNext = false;
      return { status: 200, ok: true, json: () => new Promise(resolve => bodies.push(() => resolve(canonical))) };
    };
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    const dialog = mount(() => { const element = harness.dialogElement(); return element.type(element.props); });
    const flush = async () => { await harness.flush(); await dialog.flush(true); };
    const button = label => dialog.elements().find(node => node.type === 'button' && node.props.children === label).props;
    const collection = provider => dialog.elements().find(node => node.type === 'input' && node.props['aria-label'] === `provider.collectUsage: ${provider}`).props;
    await flush();
    collection('b').onChange(); await flush();
    selected = ['c']; revision = 'b'.repeat(64);
    button('provider.saveSelection').onClick(); await flush();
    holdNext = true;
    button('provider.reviewChanges').onClick(); await flush();
    assert.equal(bodies.length, 1);
    harness.dialog().onClose(); await flush();
    harness.customize(); await flush();
    assert.equal(collection('a').disabled, false);
    collection('b').onChange(); await flush();
    selected = ['a']; revision = 'c'.repeat(64);
    button('provider.saveSelection').onClick(); await flush();
    holdNext = true;
    button('provider.reviewChanges').onClick(); await flush();
    assert.equal(bodies.length, 2);
    bodies[0](); await flush();
    assert.equal(button('provider.reviewChanges').disabled, true, 'late cancelled body must not release the newer recovery owner');
    assert.equal(collection('a').disabled, true);
    assert.deepEqual(harness.dialog().draftSelection, ['c', 'b'], 'late old recovery must not change the newer dialog draft');
    assert.equal(harness.dialog().error, 'provider.selectionConflict');
    bodies[1](); await flush();
    assert.equal(collection('a').disabled, false);
    assert.deepEqual(harness.dialog().draftSelection, ['a'], 'only the current owner may adopt the canonical selection');
    assert.equal(harness.dialog().error, 'provider.selectionConflictResolved');
    dialog.unmount(); harness.unmount(); harness = null;
  }
  // Closing an explicit recovery releases only its own busy state, never the
  // safety lock of a PUT whose durable outcome is still unknown.
  for (const outage of ['503', 'unavailable', 'unversioned']) {
    let selected = ['a'], revision = 'a'.repeat(64), catalogOutage = false, pendingPut;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body); writes.push(body);
        assert.equal(body.expectedRevision, revision);
        selected = body.selectedProviders; revision = 'b'.repeat(64);
        catalogOutage = true;
        return { status: 200, ok: true, json: () => new Promise(resolve => { pendingPut = resolve; }) };
      }
      if (!String(url).includes('/catalog')) return { status: 200, ok: true, json: async () => ({ success: true, available: true, providers: selected.map(usage) }) };
      const catalog = { available: true, providers: ['a', 'b'].map(descriptor), selectedProviders: selected, selectionRevision: revision };
      if (catalogOutage && outage === '503') return { status: 503, ok: false };
      return { status: 200, ok: true, json: async () => catalogOutage
        ? { ...catalog, available: outage !== 'unavailable', selectionRevision: undefined }
        : catalog };
    };
    harness = mount(ProviderUsagePanel); await harness.flush();
    harness.customize(); await harness.flush();
    harness.dialog().onToggle('b'); await harness.flush();
    harness.dialog().onSave(); await harness.flush();
    mock.timers.tick(10_000); await harness.flush();
    assert.equal(harness.dialog().saving, true, `${outage}: an unusable read cannot unlock an uncertain write`);
    harness.dialog().onClose(); await harness.flush();
    harness.customize(); await harness.flush();
    assert.equal(harness.dialog().saving, true, `${outage}: closing/reopening must not reset the uncertain-write fence`);
    assert.equal(writes.length, 1);
    catalogOutage = false;
    harness.checkButton().onClick(); await harness.flush();
    assert.equal(harness.dialog().saving, false, `${outage}: Check now provides an explicit canonical-read retry`);
    assert.deepEqual(harness.dialog().draftSelection, ['a', 'b']);
    assert.equal(harness.dialog().catalog.selectionRevision, 'b'.repeat(64));
    assert.equal(writes.length, 1, 'canonical retry must never duplicate an uncertain PUT');
    pendingPut({ selectedProviders: ['a', 'b'], selectionRevision: 'b'.repeat(64) }); await harness.flush();
    assert.equal(harness.dialog().saving, false);
    harness.unmount(); harness = null;
  }
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
