import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({
  configFile: false,
  cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'silent',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
});

try {
  const {
    normalizeProviderUsageCatalog,
    normalizeProviderUsageSelection,
    normalizeProviderUsageSnapshot,
  } = await server.ssrLoadModule('/src/lib/hermes-api.ts');
  const { ProviderCard } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
  const { I18nProvider } = await server.ssrLoadModule('/src/lib/i18n.tsx');

  assert.deepEqual(normalizeProviderUsageCatalog({
    available: true,
    providers: [],
    selectedProviders: [],
  }), {
    available: true,
    providers: [],
    selectedProviders: [],
  });
  assert.deepEqual(normalizeProviderUsageCatalog({
    available: false,
    refreshing: true,
    providers: [{
      provider: 'nous', displayName: 'Nous Portal', enabled: true,
      defaultEnabled: true, source: 'mission-control', selectable: true,
    }],
    selectedProviders: ['nous'],
  }), {
    available: false,
    refreshing: true,
    providers: [{
      provider: 'nous', displayName: 'Nous Portal', enabled: true,
      defaultEnabled: true, source: 'mission-control', selectable: true,
    }],
    selectedProviders: ['nous'],
  });

  assert.equal(normalizeProviderUsageCatalog({
    available: true,
    providers: 'not-an-array',
    selectedProviders: [],
  }), null);
  assert.equal(normalizeProviderUsageCatalog({
    available: true,
    providers: [{ provider: 'codex', displayName: 'Codex', enabled: 'yes', defaultEnabled: false, source: 'codexbar', selectable: true }],
    selectedProviders: ['codex'],
  }), null);
  assert.equal(normalizeProviderUsageCatalog({
    available: true,
    providers: [],
    selectedProviders: ['codex', 1],
  }), null);

  assert.deepEqual(normalizeProviderUsageSelection({ selectedProviders: ['codex', 'codex'] }), {
    selectedProviders: ['codex'],
  });
  assert.equal(normalizeProviderUsageSelection({ selectedProviders: ['codex', null] }), null);

  assert.deepEqual(normalizeProviderUsageSnapshot({
    schemaVersion: 1,
    success: true,
    available: true,
    updatedAt: '2026-10-05T00:00:00Z',
    refreshing: true,
    providers: [{ provider: 'deepseek', available: true, windows: [], balances: [], metrics: [] }],
  }), {
    schemaVersion: 1,
    success: true,
    available: true,
    updatedAt: '2026-10-05T00:00:00Z',
    refreshing: true,
    providers: [{ provider: 'deepseek', available: true, windows: [], balances: [], metrics: [] }],
  });
  assert.equal(normalizeProviderUsageSnapshot({ success: true, available: true, providers: {} }), null);
  assert.deepEqual(normalizeProviderUsageSnapshot({ success: true, available: true, providers: [null] }).warnings, ['invalid_provider']);
  const malformed = normalizeProviderUsageSnapshot({
    success: true,
    available: true,
    providers: [{ provider: 'deepseek', available: true, windows: [null], balances: [], metrics: [] }],
  });
  assert.equal(malformed.providers[0].available, false);
  assert.ok(malformed.providers[0].warnings.includes('invalid_field'));

  const staleCard = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ProviderCard, {
      provider: { provider: 'codex', available: true, stale: false, windows: [], balances: [], metrics: [] },
      locale: 'en-US',
      nowMs: Date.parse('2026-10-06T01:00:00Z'),
    }),
  ));
  assert.match(staleCard, /codex: stale/);

  const freshLabeledCard = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ProviderCard, {
      provider: {
        provider: 'deepseek', available: true, windows: [{
          id: 'primary', label: 'Five-hour quota', usedPercent: 25,
        }], balances: [], metrics: [],
      },
      locale: 'en-US',
    }),
  ));
  assert.match(freshLabeledCard, /Five-hour quota/);
  assert.doesNotMatch(freshLabeledCard, />Session</);

  console.log('provider catalog validation and stale card rendering contracts passed');
} finally {
  await server.close();
}
