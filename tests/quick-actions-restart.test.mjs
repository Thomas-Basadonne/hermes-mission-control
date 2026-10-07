import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const browser = new Window({ url: 'http://localhost/' });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.MouseEvent = browser.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const vite = await createServer({
  configFile: false,
  cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'silent',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
});
const [{ QuickActions }, { I18nProvider }] = await Promise.all([
  vite.ssrLoadModule('/src/components/overview/QuickActions.tsx'),
  vite.ssrLoadModule('/src/lib/i18n.tsx'),
]);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function mount(runGatewayAction) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(I18nProvider, null,
        React.createElement(QuickActions, {
          gatewayActions: [{ id: 'restart-gateway' }],
          runGatewayAction,
          actionLoading: null,
        }))));
  });
  return {
    container,
    click: async (button) => act(async () => { button.click(); }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttonNamed = (container, name) => [...container.querySelectorAll('button')]
  .find((button) => button.textContent.trim() === name);
const confirmationButton = (container) => [...container.querySelector('[role="alertdialog"]').querySelectorAll('button')]
  .find((button) => button.textContent.trim() === 'Restart gateway');

try {
  await test('cancelling confirmation sends no restart request', async () => {
    let calls = 0;
    const ui = await mount(async () => { calls += 1; });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      assert.match(ui.container.querySelector('[role="alertdialog"]').textContent, /interrupt its current connections/);
      await ui.click(buttonNamed(ui.container, 'Cancel'));
      assert.equal(ui.container.querySelector('[role="alertdialog"]'), null);
      assert.equal(calls, 0);
    } finally {
      await ui.unmount();
    }
  });

  await test('confirming sends exactly one restart request and shows success', async () => {
    const action = deferred();
    const calls = [];
    const ui = await mount((value) => { calls.push(value); return action.promise; });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      await ui.click(confirmationButton(ui.container));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, 'restart-gateway');
      action.resolve();
      await act(async () => { await action.promise; });
      assert.match(ui.container.querySelector('[role="status"]').textContent, /restart request completed/i);
    } finally {
      await ui.unmount();
    }
  });

  await test('rapid repeated confirmation clicks are guarded while the request is pending', async () => {
    const action = deferred();
    let calls = 0;
    const ui = await mount(() => { calls += 1; return action.promise; });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      const confirm = confirmationButton(ui.container);
      await act(async () => { confirm.click(); confirm.click(); });
      assert.equal(calls, 1);
      assert.equal(buttonNamed(ui.container, 'Restart gateway').disabled, true);
      action.resolve();
      await act(async () => { await action.promise; });
      assert.equal(buttonNamed(ui.container, 'Restart gateway').disabled, false);
    } finally {
      await ui.unmount();
    }
  });

  await test('failed request displays an error and re-enables restart', async () => {
    const action = deferred();
    const ui = await mount(() => action.promise);
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      await ui.click(confirmationButton(ui.container));
      await act(async () => { action.reject(new Error('mock restart failure')); });
      assert.match(ui.container.querySelector('[role="alert"]').textContent, /restart failed/i);
      assert.equal(buttonNamed(ui.container, 'Restart gateway').disabled, false);
    } finally {
      await ui.unmount();
    }
  });
} finally {
  await vite.close();
  browser.happyDOM.abort();
}
