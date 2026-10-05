import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import base from './vite.config.ts';
import { mergeConfig } from 'vite';

const createdAt = Date.now();
const stamp = (hours = 0) => new Date(createdAt + hours * 60 * 60 * 1000).toISOString();
const snapshot = {
  schemaVersion: 1,
  success: true,
  available: true,
  updatedAt: stamp(),
  providers: [
    {
      provider: 'codex', available: true, source: 'Synthetic preview', updatedAt: stamp(), stale: false,
      plan: 'Plus · demo', status: 'available',
      windows: [
        { id: 'primary', label: 'Session', usedPercent: 42.5, remaining: 57.5, total: 100, unit: '%', resetsAt: stamp(3) },
        { id: 'secondary', label: 'Weekly', usedPercent: 78.2, remaining: 21.8, total: 100, unit: '%', resetsAt: stamp(38) },
      ],
      balances: [
        { id: 'total_spendable', label: 'Spendable', value: 18.42, currency: 'USD' },
        { id: 'subscription_remaining', label: 'Subscription', value: 12, currency: 'USD' },
        { id: 'topup_remaining', label: 'Top-up', value: 6.42, currency: 'USD' },
      ],
      metrics: [{ id: 'reset_credits_available', label: 'Reset credits', value: 2, unit: 'credits' }],
    },
    {
      provider: 'nous', available: true, source: 'Synthetic preview', updatedAt: stamp(-3), stale: true,
      plan: 'Trial · demo', status: 'stale',
      windows: [{ id: 'subscription', label: 'Subscription', usedPercent: 64.3, remaining: 35.7, total: 100, unit: '%', resetsAt: stamp(19) }],
      balances: [{ id: 'balance', label: 'Balance', value: 6.8, currency: 'USD' }],
      metrics: [{ id: 'requests_today', label: 'Requests today', value: 128, unit: 'requests' }],
    },
    {
      provider: 'ollama', available: false, source: 'Synthetic preview', updatedAt: stamp(), stale: false,
      status: 'unavailable', error: 'Preview-only unavailable provider state.',
      windows: [], balances: [], metrics: [],
    },
  ],
};

const apiPrefix = '/api/';
const usagePath = '/api/local/provider-usage';

export default (context) => {
  const hermesHome = process.env.HERMES_HOME ?? join(homedir(), '.hermes');
  const config = mergeConfig(base(context), {
    cacheDir: resolve(hermesHome, 'cache', 'scratch', 'provider-usage-preview', 'vite-cache'),
    server: {
      host: '127.0.0.1',
      port: 15174,
      strictPort: true,
      cors: false,
      allowedHosts: ['127.0.0.1', 'localhost'],
      proxy: {},
    },
    plugins: [{
      name: 'provider-usage-preview-isolation',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
          if (!pathname.startsWith(apiPrefix)) return next();

          delete req.headers.authorization;
          if (pathname === usagePath && req.method === 'GET') {
            const body = JSON.stringify(snapshot);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', Buffer.byteLength(body));
            res.end(body);
            return;
          }

          res.statusCode = pathname.startsWith('/api/local/') && req.method !== 'GET' ? 403 : 503;
          res.end('Preview isolation: only the synthetic provider-usage route is enabled.');
        });
      },
    }],
  });
  config.server.proxy = {};
  return config;
};
