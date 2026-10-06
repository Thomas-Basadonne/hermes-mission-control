// Sacrificial mounted-panel fixture: real components, synthetic API, no live proxy.
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

const require = createRequire(import.meta.url);
const [fixtureFile, runtime, sourceArgument] = process.argv.slice(2);
const root = resolve(sourceArgument || process.cwd());
const state = JSON.parse(readFileSync(fixtureFile, 'utf8'));
const requests = [];
const entryId = '\0provider-browser-entry.tsx';
const storeId = '\0provider-browser-store';
const aliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'lucide-react']
  .map((name) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: require.resolve(name) }));
aliases.push({ find: /^tailwindcss$/, replacement: require.resolve('tailwindcss/index.css') });
const vite = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: resolve(runtime, 'vite-cache'),
  resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
  optimizeDeps: { noDiscovery: true, entries: [], include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'lucide-react'] },
  css: { postcss: { plugins: [tailwind(), autoprefixer()] } },
  plugins: [{
    name: 'provider-browser-fixture', enforce: 'pre',
    resolveId(id) {
      if (id === '/provider-browser-entry.tsx') return entryId;
      if (id.includes('mission-control-store')) return storeId;
    },
    load(id) {
      if (id === storeId) return 'export const useMissionControl = () => ({ storedToken: "fixture-only" });';
      if (id === entryId) return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { I18nProvider } from ${JSON.stringify(resolve(root, 'src/lib/i18n.tsx'))};
        import { ProviderUsagePanel } from ${JSON.stringify(resolve(root, 'src/components/overview/ProviderUsagePanel.tsx'))};
        import ${JSON.stringify(resolve(root, 'src/styles.css'))};
        let tree; window.mountPanel = () => {
          tree = createRoot(document.getElementById('root'));
          tree.render(React.createElement(I18nProvider, null, React.createElement(ProviderUsagePanel)));
        };
        window.unmountPanel = () => tree.unmount(); window.mountPanel();
      `;
    },
  }, react()],
  server: { middlewareMode: true, hmr: false, cors: false, fs: { allow: [root, process.cwd()] } },
});
const injection = `
  window.failures = []; window.requests = []; window.holds = {}; window.holdNext = {};
  window.fixtureNow = Date.now(); Date.now = () => window.fixtureNow;
  const interval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => interval(fn, ms === 15000 ? 50 : ms, ...args);
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 10000 ? 2000 : ms, ...args);
  addEventListener('error', event => window.failures.push(String(event.message)));
  addEventListener('unhandledrejection', event => window.failures.push(String(event.reason)));
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) throw new Error('Fixture forbids external requests');
    const path = url.pathname + url.search;
    const held = window.holdNext[path]; delete window.holdNext[path];
    const response = await fetchOriginal(input, held ? { ...options, signal: undefined } : options);
    window.requests.push({ path, method: options.method || 'GET', status: response.status });
    if (!held) return response;
    const captured = await response.json();
    return { ok: response.ok, status: response.status, json: () => new Promise(resolve => {
      window.holds[held] = () => resolve(captured);
    }) };
  };
`;
const server = createHttpServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  if (path.startsWith('/api/')) {
    requests.push({ path, method: req.method });
    if (req.headers.authorization !== 'Bearer fixture-only') return json(401, { error: 'Unauthorized' });
    if (path === '/api/local/provider-usage/catalog') return json(200, state.catalog);
    if (path === '/api/local/provider-usage') return json(200, state.snapshot);
    if (path === '/api/local/provider-usage/selection' && req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { selectedProviders } = JSON.parse(body);
      if (!Array.isArray(selectedProviders) || selectedProviders.some(id => !state.catalog.providers.some(p => p.provider === id))) return json(400, { error: 'Invalid selection' });
      state.catalog.selectedProviders = selectedProviders;
      writeFileSync(resolve(runtime, 'selection.json'), JSON.stringify({ selectedProviders }), { mode: 0o600 });
      return json(200, { selectedProviders });
    }
    return json(404, { error: 'Unknown fixture route' });
  }
  if (path === '/fixture/control' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    Object.assign(state, JSON.parse(body)); return json(200, { accepted: true });
  }
  if (path === '/fixture/state') return json(200, { ...state, requests });
  if (path === '/' || path === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'");
    const html = `<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="padding:16px"><div id="root"></div><script>${injection}</script><script type="module" src="/provider-browser-entry.tsx"></script></body></html>`;
    res.end(await vite.transformIndexHtml('/', html)); return;
  }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
server.listen(0, '127.0.0.1', () => writeFileSync(resolve(runtime, 'port'), String(server.address().port)));
process.on('SIGTERM', async () => { server.close(); await vite.close(); process.exit(0); });
