import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { MemoryRouter, Routes, Route, Outlet, useOutletContext } from 'react-router-dom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const cacheDir = mkdtempSync(path.join(tmpdir(), 'mc-overview-context-'));
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  cacheDir,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  plugins: [react()],
});
let root;
try {
  const { createRoot } = await import('react-dom/client');
  const { OverviewLayout } = await server.ssrLoadModule('/src/routes/OverviewRoute.tsx');

  function Shell() {
    return React.createElement(Outlet, { context: { refreshRegistration: 'available' } });
  }
  function DashboardProbe() {
    const context = useOutletContext();
    return React.createElement('output', { 'data-refresh-registration': context?.refreshRegistration ?? 'missing' }, 'overview');
  }

  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ['/'] },
      React.createElement(Routes, null,
        React.createElement(Route, { element: React.createElement(Shell) },
          React.createElement(Route, { element: React.createElement(OverviewLayout) },
            React.createElement(Route, { index: true, element: React.createElement(DashboardProbe) }),
          ),
        ),
      ),
    ));
  });

  assert.equal(
    document.querySelector('output')?.getAttribute('data-refresh-registration'),
    'available',
    'the nested overview route must receive the shell refresh-registration context',
  );
} finally {
  if (root) await act(async () => root.unmount());
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
  dom.window.close();
}

console.log('overview route forwards the shell refresh-registration context');
