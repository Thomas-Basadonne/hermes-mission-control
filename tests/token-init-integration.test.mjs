import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const token = 'mission-control-token-init-regression';
const previousEnv = {
  token: process.env.VITE_MISSION_CONTROL_TOKEN,
  baseUrl: process.env.VITE_MISSION_CONTROL_LOCAL_API_BASE_URL,
};
process.env.VITE_MISSION_CONTROL_TOKEN = token;
process.env.VITE_MISSION_CONTROL_LOCAL_API_BASE_URL = 'http://127.0.0.1:8765/api/local';

const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  fetch: globalThis.fetch,
};
const storage = new Map();
const makeStorage = () => ({
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
});
globalThis.window = {
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  location: { href: 'http://127.0.0.1:5174/' },
};
globalThis.document = { visibilityState: 'visible' };

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), authorization: new Headers(init.headers).get('Authorization'), body: init.body });
  const body = String(url).includes('client-diagnostics') ? { success: true } : { available: false, providers: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'silent',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
});

try {
  const [{ MissionControlProvider, useMissionControl }, { loadProviderUsage }, { recordReloadDiagnostic }] = await Promise.all([
    server.ssrLoadModule('/src/lib/mission-control-store.tsx'),
    server.ssrLoadModule('/src/lib/hermes-api.ts'),
    server.ssrLoadModule('/src/lib/reload-diagnostics.ts'),
  ]);

  let usageRequest;
  let initializedToken = '';
  function Probe() {
    initializedToken = useMissionControl().storedToken;
    usageRequest = loadProviderUsage(initializedToken);
    return createElement('output', null, initializedToken ? 'authenticated' : 'missing-token');
  }

  const markup = renderToStaticMarkup(createElement(MissionControlProvider, null, createElement(Probe)));
  await usageRequest;
  assert.match(markup, /authenticated/);
  assert.equal(initializedToken, token);
  assert.equal(requests[0]?.authorization, `Bearer ${token}`);

  recordReloadDiagnostic('token-init-integration-test');
  await new Promise((resolve) => setImmediate(resolve));
  const diagnosticRequest = requests.find((request) => String(request.url).includes('client-diagnostics'));
  assert.ok(diagnosticRequest, 'diagnostics endpoint should receive the boot event');
  assert.equal(JSON.parse(diagnosticRequest.body)._accessToken, token);

  console.log('token initialization integration passed: provider request and diagnostics use the env token');
} finally {
  await server.close();
  if (previousEnv.token === undefined) delete process.env.VITE_MISSION_CONTROL_TOKEN;
  else process.env.VITE_MISSION_CONTROL_TOKEN = previousEnv.token;
  if (previousEnv.baseUrl === undefined) delete process.env.VITE_MISSION_CONTROL_LOCAL_API_BASE_URL;
  else process.env.VITE_MISSION_CONTROL_LOCAL_API_BASE_URL = previousEnv.baseUrl;
  if (previousGlobals.window === undefined) delete globalThis.window;
  else globalThis.window = previousGlobals.window;
  if (previousGlobals.document === undefined) delete globalThis.document;
  else globalThis.document = previousGlobals.document;
  globalThis.fetch = previousGlobals.fetch;
}
