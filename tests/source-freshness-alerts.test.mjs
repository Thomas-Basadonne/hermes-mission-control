import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

/**
 * `loadMissionControlAlerts` reports a per-source provenance and an error so the
 * dashboard can say "live" or "previous data" honestly. An HTTP error response is
 * not a successful sync: `maybeFetchLocalJson` returns the `Response` for a 503 and
 * a null payload, so testing the response object alone marks the alerts source live
 * while the request actually failed.
 */
const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(), appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false } });
const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

try {
  const api = await server.ssrLoadModule('/src/lib/hermes-api.ts');

  const stubFetch = (statusFor) => {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url), 'http://localhost').pathname;
      const result = statusFor(path);
      if (result instanceof Response) return result;
      return json(result ?? {});
    };
  };

  const healthy = (path) => {
    if (path.endsWith('/system')) return { health: 'healthy', source: 'local-psutil', summary: 'live', host: 'h', platform: 'p' };
    if (path.endsWith('/cron/jobs')) return [];
    if (path.endsWith('/status')) return { gateway_running: true };
    return {};
  };

  await test('a failed /status is not reported as a live alerts source', async () => {
    stubFetch((path) => (path.endsWith('/status') ? json({}, 503) : healthy(path)));
    const alerts = await api.loadMissionControlAlerts(undefined);

    assert.equal(alerts.dataSource, 'fallback', 'an HTTP error response must not be reported as mission-control-alerts');
    assert.ok(alerts.dataError, 'a failed dependency must set dataError so the source renders as previous/unavailable');
  });

  await test('a healthy /status still reports the alerts source as live', async () => {
    stubFetch(healthy);
    const alerts = await api.loadMissionControlAlerts(undefined);

    assert.equal(alerts.dataSource, 'mission-control-alerts');
    assert.equal(alerts.dataError, undefined, 'a fully healthy load is not an error');
  });

  await test('an unavailable dependency still sets dataError even when /status answers', async () => {
    stubFetch((path) => (path.endsWith('/cron/jobs') ? json({}, 503) : healthy(path)));
    const alerts = await api.loadMissionControlAlerts(undefined);

    assert.ok(alerts.dataError, 'a failed cron dependency must still be surfaced');
  });
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
