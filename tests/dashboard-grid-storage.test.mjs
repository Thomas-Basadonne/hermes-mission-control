import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// MC-FIX-9: real DashboardGrid + real React DOM. Storage failures are simulated
// on the JSDOM Storage prototype only; no real browser storage is touched.
const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = browser.window;
globalThis.document = browser.window.document;
globalThis.HTMLElement = browser.window.HTMLElement;
globalThis.MouseEvent = browser.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.window.navigator });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  configFile: false,
  cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'silent',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
});
const [{ DashboardGrid }, { I18nProvider }] = await Promise.all([
  vite.ssrLoadModule('/src/components/overview/DashboardGrid.tsx'),
  vite.ssrLoadModule('/src/lib/i18n.tsx'),
]);

const STORAGE_KEY = 'mission-control-dashboard-layout:v1';
const StorageProto = browser.window.Storage.prototype;
const originalSetItem = StorageProto.setItem;
const originalRemoveItem = StorageProto.removeItem;

const widget = (id) => ({ id, label: id.toUpperCase(), content: React.createElement('p', null, `widget-${id}`) });

function breakStorage() {
  const quota = () => { throw new browser.window.DOMException('quota', 'QuotaExceededError'); };
  StorageProto.setItem = quota;
  StorageProto.removeItem = quota;
}

function restoreStorage() {
  StorageProto.setItem = originalSetItem;
  StorageProto.removeItem = originalRemoveItem;
  browser.window.localStorage.clear();
}

async function mount(ids) {
  const container = document.createElement('div');
  document.body.append(container);
  const uncaught = [];
  const root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
  const render = async (nextIds) => act(async () => {
    root.render(React.createElement(I18nProvider, null,
      React.createElement(DashboardGrid, { widgets: nextIds.map(widget) })));
  });
  await render(ids);
  return {
    container,
    uncaught,
    render,
    order: () => [...container.querySelectorAll('[data-dashboard-widget]')].map((el) => el.dataset.dashboardWidget),
    click: async (button) => act(async () => { button.click(); }),
    button: (label) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

try {
  await test('unwritable storage does not crash mount, reorder or reset', async () => {
    breakStorage();
    let ui;
    try {
      ui = await mount(['a', 'b', 'c']);
      assert.deepEqual(ui.uncaught, []);
      assert.deepEqual(ui.order(), ['a', 'b', 'c']);
      await ui.click(ui.button('Arrange'));
      await ui.click(ui.button('Move B up'));
      assert.deepEqual(ui.uncaught, []);
      assert.deepEqual(ui.order(), ['b', 'a', 'c']);
      assert.doesNotMatch(ui.container.textContent, /Auto-saved/);
      assert.match(ui.container.textContent, /Not saved on this device/);
      await ui.click(ui.button('Reset'));
      assert.deepEqual(ui.uncaught, []);
      assert.deepEqual(ui.order(), ['a', 'b', 'c']);
    } finally {
      await ui?.unmount();
      restoreStorage();
    }
  });

  await test('writable storage persists the order and reports it as saved', async () => {
    const ui = await mount(['a', 'b', 'c']);
    try {
      await ui.click(ui.button('Arrange'));
      await ui.click(ui.button('Move C up'));
      assert.deepEqual(JSON.parse(browser.window.localStorage.getItem(STORAGE_KEY)), ['a', 'c', 'b']);
      assert.match(ui.container.textContent, /Auto-saved/);
      assert.doesNotMatch(ui.container.textContent, /Not saved on this device/);
    } finally {
      await ui.unmount();
      restoreStorage();
    }
  });

  await test('readable-but-full storage never replaces the in-memory order when a widget appears', async () => {
    // Quota case: the old order is still readable, new writes are rejected.
    browser.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']));
    StorageProto.setItem = () => { throw new browser.window.DOMException('quota', 'QuotaExceededError'); };
    let ui;
    try {
      ui = await mount(['a', 'b', 'c']);
      await ui.click(ui.button('Arrange'));
      await ui.click(ui.button('Move C up'));
      assert.deepEqual(ui.order(), ['a', 'c', 'b']);
      await ui.render(['a', 'b', 'c', 'cron']);
      assert.deepEqual(ui.order(), ['a', 'c', 'b', 'cron'], 'stale stored order must not win');
      assert.deepEqual(ui.uncaught, []);
    } finally {
      await ui?.unmount();
      restoreStorage();
    }
  });

  await test('arrow moves skip saved ids of widgets that are not rendered', async () => {
    browser.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'cron', 'b']));
    const ui = await mount(['a', 'b']);
    try {
      await ui.click(ui.button('Arrange'));
      await ui.click(ui.button('Move B up'));
      assert.deepEqual(ui.order(), ['b', 'a'], 'one click moves one visible position');
      await ui.render(['a', 'b', 'cron']);
      assert.ok(ui.order().includes('cron'), 'hidden id kept for when the widget appears');
    } finally {
      await ui.unmount();
      restoreStorage();
    }
  });

  await test('saved ids of widgets that mount later are preserved', async () => {
    browser.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['cron', 'b', 'a']));
    const ui = await mount(['a', 'b']);
    try {
      assert.deepEqual(ui.order(), ['b', 'a']);
      assert.deepEqual(JSON.parse(browser.window.localStorage.getItem(STORAGE_KEY)), ['cron', 'b', 'a']);
      await ui.render(['a', 'b', 'cron']);
      assert.deepEqual(ui.order(), ['cron', 'b', 'a']);
    } finally {
      await ui.unmount();
      restoreStorage();
    }
  });
} finally {
  await vite.close();
}
