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
const [{ QuickActions }, { I18nProvider }, missionControlStore, { ToastProvider }] = await Promise.all([
  vite.ssrLoadModule('/src/components/overview/QuickActions.tsx'),
  vite.ssrLoadModule('/src/lib/i18n.tsx'),
  vite.ssrLoadModule('/src/lib/mission-control-store.tsx'),
  vite.ssrLoadModule('/src/components/ui/ToastProvider.tsx'),
]);
const { withGatewayActionDeadline, sendGatewayRestartRequest, MissionControlProvider, useMissionControl } = missionControlStore;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function StoreProbe({ onReady }) {
  const context = useMissionControl();
  React.useEffect(() => onReady(context), [context, onReady]);
  return null;
}

async function mount(runGatewayAction, restartAvailable = true) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(I18nProvider, null,
        React.createElement(ToastProvider, null,
          React.createElement(QuickActions, {
            gatewayActions: [{ id: 'restart-gateway' }],
            runGatewayAction,
            actionLoading: null,
            restartAvailable,
          })))));
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
  await test('restart action is unavailable when authentication is missing', async () => {
    const ui = await mount(async () => {}, false);
    try {
      assert.equal(buttonNamed(ui.container, 'Restart gateway'), undefined);
    } finally { await ui.unmount(); }
  });

  await test('refresh action preserves auth failures so Quick Actions can report them', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = browser.window.fetch;
    const originalMatchMedia = browser.window.matchMedia;
    let context;
    const onReady = (value) => { context = value; };
    const fetchCalls = [];
    const unauthorizedFetch = async (input) => {
      fetchCalls.push(String(input));
      return new Response('{"detail":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    globalThis.fetch = unauthorizedFetch;
    browser.window.fetch = unauthorizedFetch;
    browser.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    browser.window.localStorage.clear();
    try {
      await act(async () => {
        root.render(React.createElement(MissionControlProvider,
          null,
          React.createElement(StoreProbe, { onReady }),
        ));
        for (let i = 0; i < 40 && !context?.authRequired; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      assert.equal(context?.authRequired, true, 'fixture 401 responses should put the real store in auth-required state');
      const refreshAction = context.gatewayActions.find((action) => action.id === 'refresh');
      let failure;
      await act(async () => {
        try {
          await context.runGatewayAction(refreshAction);
        } catch (error) {
          failure = error;
        }
      });
      assert.equal(failure?.name, 'MissionControlAuthError', `expected the real refresh action to reject; fetched ${JSON.stringify(fetchCalls)}`);
      assert.equal(context.actionLoading, null, 'the refresh action lock must be released after the auth failure');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
      browser.window.fetch = originalWindowFetch;
      browser.window.matchMedia = originalMatchMedia;
    }
  });

  await test('manual refresh rejects when a transient source request fails', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = browser.window.fetch;
    const originalMatchMedia = browser.window.matchMedia;
    let context;
    const onReady = (value) => { context = value; };
    let mode = 'unauthorized';
    const fetchCalls = [];
    const fixtureFetch = async (input) => {
      fetchCalls.push(String(input));
      if (mode === 'transient') {
        return new Response('{"detail":"temporarily unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"detail":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    globalThis.fetch = fixtureFetch;
    browser.window.fetch = fixtureFetch;
    browser.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    browser.window.localStorage.clear();
    try {
      await act(async () => {
        root.render(React.createElement(MissionControlProvider, null, React.createElement(StoreProbe, { onReady })));
        for (let i = 0; i < 40 && !context?.authRequired; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      assert.equal(context?.authRequired, true, 'initial 401 responses should put the real store in auth-required state');

      mode = 'transient';
      let failure;
      await act(async () => {
        try {
          await context.refreshAll('fixture-token', { rethrowRefreshFailure: true });
        } catch (error) {
          failure = error;
        }
      });
      assert.ok(failure, `expected transient refresh failure to reach the user action; fetched ${JSON.stringify(fetchCalls)}`);
      assert.match(failure.message, /Tools endpoint returned 503\./, 'the failed reference source should be part of the explicit refresh outcome');
      assert.notEqual(failure?.name, 'MissionControlAuthError');
      assert.equal(context.authRequired, false, 'a transient failure must not relock the store');

      let actionFailure;
      const refreshAction = context.gatewayActions.find((action) => action.id === 'refresh');
      await act(async () => {
        try {
          await context.runGatewayAction(refreshAction);
        } catch (error) {
          actionFailure = error;
        }
      });
      assert.match(actionFailure.message, /Tools endpoint returned 503\./, 'Quick Actions refresh must not resolve as success on a transient source failure');
      assert.equal(context.actionLoading, null, 'the action lock must be released after a transient refresh failure');

      await act(async () => {
        await assert.doesNotReject(
          context.refreshAll('fixture-token', { silent: true, rethrowRefreshFailure: false }),
          'background refreshes must continue to tolerate transient failures',
        );
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
      browser.window.fetch = originalWindowFetch;
      browser.window.matchMedia = originalMatchMedia;
    }
  });

  await test('refresh action preserves auth failures when a newer refresh supersedes it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = browser.window.fetch;
    const originalMatchMedia = browser.window.matchMedia;
    let context;
    const onReady = (value) => { context = value; };
    let mode = 'initial';
    const deferredResponses = [];
    const unauthorizedFetch = async () => {
      if (mode === 'defer') {
        const response = deferred();
        deferredResponses.push(response);
        return response.promise;
      }
      return new Response('{"detail":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    globalThis.fetch = unauthorizedFetch;
    browser.window.fetch = unauthorizedFetch;
    browser.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    browser.window.localStorage.clear();
    try {
      await act(async () => {
        root.render(React.createElement(MissionControlProvider, null, React.createElement(StoreProbe, { onReady })));
        for (let i = 0; i < 40 && !context?.authRequired; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      assert.equal(context?.authRequired, true, 'initial 401 responses should put the real store in auth-required state');

      mode = 'defer';
      const refreshAction = context.gatewayActions.find((action) => action.id === 'refresh');
      let actionFailure;
      let actionPromise;
      await act(async () => {
        actionPromise = context.runGatewayAction(refreshAction).catch((error) => { actionFailure = error; });
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.ok(deferredResponses.length > 0, 'the manual refresh should have pending fetches before it is superseded');

      mode = 'immediate';
      await act(async () => {
        await context.refreshAll(undefined, { silent: true, includeReference: false });
      });
      for (const response of deferredResponses) {
        response.resolve(new Response('{"detail":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }));
      }
      await act(async () => { await actionPromise; });

      assert.equal(actionFailure?.name, 'MissionControlAuthError', 'a superseded user-initiated auth failure must remain observable to its caller');
      assert.equal(context.actionLoading, null, 'the refresh action lock must be released after the stale auth failure');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
      browser.window.fetch = originalWindowFetch;
      browser.window.matchMedia = originalMatchMedia;
    }
  });

  for (const [failureStatus, phase] of [[401, 'reference'], [503, 'reference'], [503, 'live'], [503, 'snapshot']]) {
    await test(`explicit refresh preserves ${failureStatus} ${phase} failures when a newer refresh supersedes it`, async () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const originalFetch = globalThis.fetch;
      const originalWindowFetch = browser.window.fetch;
      const originalMatchMedia = browser.window.matchMedia;
      let context;
      const onReady = (value) => { context = value; };
      let mode = 'initial';
      const deferredResponses = [];
      let systemCalls = 0;
      const unauthorizedFetch = async (input) => {
        if (mode === 'defer' && phase === 'snapshot' && String(input).endsWith('/system')) systemCalls += 1;
        if (mode === 'defer' && (phase !== 'snapshot' || (String(input).endsWith('/system') && systemCalls === 3))) {
          const response = deferred();
          deferredResponses.push(response);
          return response.promise;
        }
        if (mode === 'defer') return new Response('{"jobs":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('{"detail":"unauthorized"}', {
          status: mode === 'transient' ? 503 : 401,
          headers: { 'content-type': 'application/json' },
        });
      };
      globalThis.fetch = unauthorizedFetch;
      browser.window.fetch = unauthorizedFetch;
      browser.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      browser.window.localStorage.clear();
      try {
        await act(async () => {
          root.render(React.createElement(MissionControlProvider, null, React.createElement(StoreProbe, { onReady })));
          for (let i = 0; i < 40 && !context?.authRequired; i++) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        });
        assert.equal(context?.authRequired, true, 'initial 401 responses should put the real store in auth-required state');

        mode = 'defer';
        let actionFailure;
        let actionPromise;
        await act(async () => {
          actionPromise = context.refreshAll('fixture-token', { rethrowRefreshFailure: true, includeReference: phase === 'reference', includeSessions: false, includeCron: false }).catch((error) => { actionFailure = error; });
          for (let i = 0; i < 40 && deferredResponses.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
        });
        assert.ok(deferredResponses.length > 0, 'the manual refresh should have pending fetches before it is superseded');

        mode = 'immediate';
        await act(async () => {
          await context.refreshAll('fixture-token', { silent: true, includeReference: true, includeSessions: true, includeCron: true, includeSnapshot: true });
        });
        const newerSources = context.sources;
        const newerSnapshot = context.snapshot;
        mode = failureStatus === 503 ? 'transient' : 'immediate';
        for (const response of deferredResponses) {
          response.resolve(new Response('{"detail":"older request failed"}', {
            status: failureStatus,
            headers: { 'content-type': 'application/json' },
          }));
        }
        await act(async () => { await actionPromise; });

        if (failureStatus === 401) {
          assert.equal(actionFailure?.name, 'MissionControlAuthError', 'a superseded user-initiated auth failure must remain observable to its caller');
        } else {
          const expected = phase === 'reference' ? /Tools endpoint returned 503\./ : phase === 'snapshot' ? /snapshot dependencies are unavailable/ : /Refresh returned fallback/;
          assert.match(actionFailure?.message ?? '', expected, 'a superseded transient failure must remain observable to its caller');
        }
        assert.equal(context.authRequired, true, 'the stale failure must not clear the newer auth state');
        assert.equal(context.sources, newerSources, 'stale completions must not overwrite newer source statuses');
        assert.equal(context.snapshot, newerSnapshot, 'stale completions must not overwrite newer data');
      } finally {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = originalFetch;
        browser.window.fetch = originalWindowFetch;
        browser.window.matchMedia = originalMatchMedia;
      }
    });
  }

  await test('client sends one authenticated restart request and accepts only HTTP 202', async () => {
    const calls = [];
    await sendGatewayRestartRequest(
      { id: 'restart-gateway', label: 'Restart gateway', hint: '', endpoint: '/api/local/gateway/restart', method: 'POST' },
      'fixture-token',
      async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ success: true }), { status: 202, headers: { 'content-type': 'application/json' } });
      },
      'http://fixture',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://fixture/api/local/gateway/restart');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  });

  await test('401 is an auth error and never reported as restart acceptance', async () => {
    await assert.rejects(
      sendGatewayRestartRequest(
        { id: 'restart-gateway', label: 'Restart gateway', hint: '', endpoint: '/api/local/gateway/restart', method: 'POST' },
        'bad-token',
        async () => new Response('{}', { status: 401 }),
        'http://fixture',
      ),
      (error) => error?.name === 'MissionControlAuthError',
    );
  });

  await test('gateway-style 502 is an unknown outcome, while the explicit local spawn failure is definite', async () => {
    const action = { id: 'restart-gateway', label: 'Restart gateway', hint: '', endpoint: '/api/local/gateway/restart', method: 'POST' };
    await assert.rejects(
      sendGatewayRestartRequest(action, 'fixture-token', async () => new Response('{}', { status: 502 }), 'http://fixture'),
      (error) => error?.name === 'GatewayActionOutcomeUnknownError',
    );
    await assert.rejects(
      sendGatewayRestartRequest(action, 'fixture-token', async () => new Response('{"success":false}', { status: 500, headers: { 'content-type': 'application/json' } }), 'http://fixture'),
      (error) => error?.name === 'GatewayActionOutcomeUnknownError',
    );
    await assert.rejects(
      sendGatewayRestartRequest(action, 'fixture-token', async () => new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } }), 'http://fixture'),
      (error) => error?.name === 'GatewayActionOutcomeUnknownError',
    );
    await assert.rejects(
      sendGatewayRestartRequest(action, 'fixture-token', async () => new Response(JSON.stringify({ success: false, manual: true, detail: 'gateway binary missing' }), { status: 500, headers: { 'content-type': 'application/json' } }), 'http://fixture'),
      (error) => error?.name === 'Error' && error?.message === 'gateway binary missing',
    );
  });

  await test('cancelling confirmation sends no restart request', async () => {
    let calls = 0;
    const ui = await mount(async () => { calls += 1; });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      const confirmation = ui.container.querySelector('[role="alertdialog"]').textContent;
      assert.match(confirmation, /configured Gateway service/i);
      assert.match(confirmation, /other clients/i);
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
      assert.match(ui.container.querySelector('[data-toast-tone="success"]')?.textContent ?? '', /restart request accepted/i);
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
      assert.match(ui.container.querySelector('[data-toast-tone="error"]')?.textContent ?? '', /restart failed/i);
      assert.equal(buttonNamed(ui.container, 'Restart gateway').disabled, false);
    } finally {
      await ui.unmount();
    }
  });
  await test('unknown transport outcome is reported as uncertain, not failed or accepted', async () => {
    const ui = await mount(async () => { throw new TypeError('Failed to fetch'); });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      await ui.click(confirmationButton(ui.container));
      for (let i = 0; i < 5 && !ui.container.querySelector('[data-toast-tone="warning"]'); i++) {
        await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
      }
      assert.match(ui.container.querySelector('[data-toast-tone="warning"]')?.textContent ?? '', /check gateway status before retrying/i);
    } finally { await ui.unmount(); }
  });

  await test('timeout outcome is reported as uncertain, not failed or accepted', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const ui = await mount(async () => { throw timeout; });
    try {
      await ui.click(buttonNamed(ui.container, 'Restart gateway'));
      await ui.click(confirmationButton(ui.container));
      for (let i = 0; i < 5 && !ui.container.querySelector('[data-toast-tone="warning"]'); i++) {
        await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
      }
      assert.match(ui.container.querySelector('[data-toast-tone="warning"]')?.textContent ?? '', /check gateway status before retrying/i);
    } finally { await ui.unmount(); }
  });

  await test('gateway request deadline aborts once and reports an unknown outcome', async () => {
    let calls = 0;
    let signal;
    await assert.rejects(
      withGatewayActionDeadline((requestSignal) => {
        calls += 1;
        signal = requestSignal;
        return new Promise(() => {});
      }, 20),
      (error) => error?.name === 'GatewayActionOutcomeUnknownError',
    );
    assert.equal(calls, 1, 'timeout must not retry the request');
    assert.equal(signal.aborted, true, 'the stalled fetch must be aborted at the deadline');
  });

  await test('connection loss is uncertain and is not retried', async () => {
    let calls = 0;
    await assert.rejects(
      withGatewayActionDeadline(async () => { calls += 1; throw new TypeError('Failed to fetch'); }, 100),
      (error) => error?.name === 'GatewayActionOutcomeUnknownError',
    );
    assert.equal(calls, 1, 'disconnect must not retry the request');
  });

} finally {
  await vite.close();
  browser.window.close();
}
