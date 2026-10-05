import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';

const configFile = fileURLToPath(new URL('../.mc-preview.vite.config.mjs', import.meta.url));
const loaded = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  configFile,
  process.cwd(),
);
assert.deepEqual(loaded.config.server.proxy ?? {}, {}, 'preview must not proxy API or bearer headers');
assert.equal(
  loaded.config.cacheDir,
  resolve(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'cache', 'scratch', 'provider-usage-preview', 'vite-cache'),
  'preview cache path must follow the active Hermes home',
);

const server = await createServer({
  configFile,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/local/provider-usage`, {
    headers: { Authorization: 'Bearer [REDACTED]' },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.success, true);
  assert(snapshot.providers.some((provider) => provider.source === 'Synthetic preview'));

  const liveRoute = await fetch(`${base}/api/local/sessions`);
  assert.equal(liveRoute.status, 503, 'non-fixture API routes must fail closed');
  const mutation = await fetch(`${base}/api/local/provider-usage`, { method: 'POST' });
  assert.equal(mutation.status, 403, 'preview mutations must remain disabled');
} finally {
  await server.close();
}

console.log('provider usage preview isolation tests passed');
