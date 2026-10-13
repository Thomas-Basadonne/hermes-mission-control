import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

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
const { ToastProvider, useToast } = await vite.ssrLoadModule('/src/components/ui/ToastProvider.tsx');

let now = 0;
let timerId = 0;
let timers = new Map();
const originalSetTimeout = browser.window.setTimeout;
const originalClearTimeout = browser.window.clearTimeout;

function useFakeTimers() {
  now = 0;
  timerId = 0;
  timers = new Map();
  browser.window.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + Number(delay) });
    return id;
  };
  browser.window.clearTimeout = (id) => timers.delete(id);
}

async function advanceTimers(ms) {
  now += ms;
  const due = [...timers.entries()].filter(([, timer]) => timer.at <= now);
  for (const [id, timer] of due) {
    timers.delete(id);
    await act(async () => timer.callback());
  }
}

function Consumer({ onReady }) {
  const { showToast } = useToast();
  React.useEffect(() => onReady(showToast), [onReady, showToast]);
  return React.createElement('button', { type: 'button' }, 'Toast consumer');
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let showToast;
  await act(async () => {
    root.render(React.createElement(ToastProvider, { dismissLabel: 'Dismiss notification' },
      React.createElement(Consumer, { onReady: (callback) => { showToast = callback; } })));
  });
  return {
    container,
    showToast: (...args) => showToast(...args),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

try {
  await test('toasts announce success and errors with the appropriate live roles', async () => {
    const ui = await mount();
    try {
      await act(async () => ui.showToast('Dashboard refreshed.', { tone: 'success' }));
      assert.equal(ui.container.querySelector('[data-toast-message][role="status"]')?.textContent, 'Dashboard refreshed.');
      await act(async () => ui.showToast('Refresh failed.', { tone: 'error' }));
      assert.equal(ui.container.querySelector('[data-toast-message][role="alert"]')?.textContent, 'Refresh failed.');
    } finally {
      await ui.unmount();
    }
  });

  await test('alerts persist until dismissed while routine status toasts expire', async () => {
    useFakeTimers();
    const ui = await mount();
    try {
      await act(async () => {
        ui.showToast('Refresh failed.', { tone: 'error', durationMs: 500 });
        ui.showToast('Restart outcome unknown.', { tone: 'warning', durationMs: 500 });
        ui.showToast('Dashboard refreshed.', { tone: 'success' });
      });
      assert.equal(timers.size, 1, 'only the routine success toast should be timed');
      assert.equal(ui.container.querySelector('[data-toast-message][role="alert"]')?.textContent, 'Refresh failed.');
      await advanceTimers(3200);
      assert.equal(ui.container.querySelector('[role="status"]'), null, 'routine success feedback should expire');
      const dismiss = ui.container.querySelector('[data-toast-item][data-toast-tone="error"] button[aria-label^=Dismiss]');
      const dismissWarning = ui.container.querySelector('[data-toast-item][data-toast-tone="warning"] button[aria-label^=Dismiss]');
      assert.ok(dismiss && dismissWarning, 'persistent alerts need keyboard-accessible dismiss controls');
      await act(async () => { dismiss.click(); dismissWarning.click(); });
      assert.equal(ui.container.querySelector('[role="alert"]'), null, 'dismiss should remove the alerts');
    } finally {
      await ui.unmount();
    }
  });

  await test('a new status toast survives eviction when persistent alerts fill the viewport', async () => {
    useFakeTimers();
    const ui = await mount();
    try {
      await act(async () => {
        ui.showToast('Alert one', { tone: 'error' });
        ui.showToast('Alert two', { tone: 'error' });
        ui.showToast('Alert three', { tone: 'warning' });
        ui.showToast('Action accepted.', { tone: 'success' });
      });
      assert.deepEqual(
        [...ui.container.querySelectorAll('[data-toast-item] [data-toast-message]')].map((item) => item.textContent),
        ['Alert one', 'Alert two', 'Alert three', 'Action accepted.'],
      );
      assert.equal(timers.size, 1, 'the new transient toast should retain its expiry timer');
    } finally {
      await ui.unmount();
    }
  });

  await test('toasts expire independently and the viewport keeps only the newest three', async () => {
    useFakeTimers();
    const ui = await mount();
    try {
      await act(async () => {
        ui.showToast('One', { tone: 'info', durationMs: 1000 });
        ui.showToast('Two', { tone: 'info', durationMs: 2000 });
        ui.showToast('Three', { tone: 'info', durationMs: 3000 });
        ui.showToast('Four', { tone: 'success', durationMs: 4000 });
      });
      assert.deepEqual([...ui.container.querySelectorAll('[data-toast-item] [data-toast-message]')].map((item) => item.textContent), ['Two', 'Three', 'Four']);
      await advanceTimers(2000);
      assert.deepEqual([...ui.container.querySelectorAll('[data-toast-item] [data-toast-message]')].map((item) => item.textContent), ['Three', 'Four']);
      await advanceTimers(1000);
      assert.deepEqual([...ui.container.querySelectorAll('[data-toast-item] [data-toast-message]')].map((item) => item.textContent), ['Four']);
    } finally {
      await ui.unmount();
    }
  });

  await test('a timed toast stays present while its dismiss control has focus', async () => {
    useFakeTimers();
    const ui = await mount();
    const consumerButton = ui.container.querySelector('button');
    try {
      consumerButton.focus();
      await act(async () => ui.showToast('You may dismiss this.', { tone: 'success', durationMs: 1000 }));
      const dismiss = ui.container.querySelector('[data-toast-item] button[aria-label^=Dismiss]');
      dismiss.focus();
      await advanceTimers(1000);
      assert.ok(ui.container.querySelector('[data-toast-item]'), 'a timeout must not remove a toast while its control has focus');
      consumerButton.focus();
      await advanceTimers(1000);
      assert.equal(ui.container.querySelector('[data-toast-item]'), null, 'the toast should expire after focus leaves');
    } finally {
      await ui.unmount();
    }
  });

  await test('eviction preserves keyboard focus on an older transient toast', async () => {
    useFakeTimers();
    const ui = await mount();
    try {
      await act(async () => {
        ui.showToast('Focused toast', { tone: 'success', durationMs: 5000 });
        ui.showToast('Older eligible toast', { tone: 'info', durationMs: 5000 });
        ui.showToast('Persistent alert', { tone: 'error' });
      });
      ui.container.querySelector('[data-toast-item] button[aria-label^=Dismiss]').focus();
      await act(async () => ui.showToast('Newest toast', { tone: 'success', durationMs: 5000 }));
      const messages = [...ui.container.querySelectorAll('[data-toast-message]')].map((item) => item.textContent);
      assert.deepEqual(messages, ['Focused toast', 'Persistent alert', 'Newest toast']);
    } finally {
      await ui.unmount();
    }
  });

  await test('unmount clears pending timers and does not move focus', async () => {
    useFakeTimers();
    const ui = await mount();
    const button = ui.container.querySelector('button');
    button.focus();
    try {
      await act(async () => ui.showToast('Still focused.', { tone: 'success', durationMs: 1000 }));
      assert.equal(document.activeElement, button);
      assert.equal(timers.size, 1);
    } finally {
      await ui.unmount();
      assert.equal(timers.size, 0);
    }
  });
} finally {
  browser.window.setTimeout = originalSetTimeout;
  browser.window.clearTimeout = originalClearTimeout;
  await vite.close();
  browser.window.close();
}
