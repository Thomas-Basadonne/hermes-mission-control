import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE, root: process.cwd(), appType: 'custom', logLevel: 'silent', plugins: [react()], server: { middlewareMode: true, hmr: false } });
try {
  const { ProviderCard } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
  const { I18nProvider } = await server.ssrLoadModule('/src/lib/i18n.tsx');
  const { normalizeProviderUsagePreferences, loadProviderUsagePreferences, saveProviderUsagePreferences, DEFAULT_PROVIDER_USAGE_PREFERENCES } = await server.ssrLoadModule('/src/lib/provider-usage-preferences.ts');
  const provider = { provider: 'codex', available: true, source: 'oauth', updatedAt: '2026-10-07T17:00:00Z', lastAttemptAt: '2026-10-07T17:00:00Z', warnings: ['unknown_currency'], error: 'Retained safe error', windows: [{ id: 'quota', label: 'Quota', usedPercent: 12 }], balances: [], metrics: [] };
  const render = (view, visibility, id = 'codex') => renderToStaticMarkup(createElement(I18nProvider, null, createElement(ProviderCard, { provider: { ...provider, provider: id }, view, locale: 'en-US', nowMs: Date.parse(provider.updatedAt), preferences: { ...DEFAULT_PROVIDER_USAGE_PREFERENCES, diagnosticsVisibility: visibility ? { codex: visibility } : undefined } })));
  for (const view of ['compact', 'detailed']) {
    const hidden = render(view, 'hidden');
    assert.doesNotMatch(hidden, /Diagnostics|Last attempt|Source:|Last success/, 'hidden diagnostics must disappear in both views');
    assert.match(hidden, /Retained safe error/, 'hiding diagnostics must not hide collection errors');
    assert.match(hidden, /12%/, 'usage fields must remain visible');
    if (view === 'compact') assert.match(hidden, /Some details are unavailable/, 'the partial-data warning remains visible');
    else assert.match(hidden, /unknown_currency/, 'detailed warnings remain visible outside hidden diagnostics');
    assert.match(render(view, 'both'), /Last attempt/);
    assert.match(render(view, undefined), /Last attempt/, 'legacy preferences default to visible diagnostics');
    assert.match(render(view, 'hidden', 'nous'), /Last attempt/, 'preferences are independent per provider');
  }
  assert.doesNotMatch(render('compact', 'detailed'), /Diagnostics|Last attempt/);
  assert.match(render('detailed', 'detailed'), /Last attempt/);
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const preferences = { ...DEFAULT_PROVIDER_USAGE_PREFERENCES, hiddenProviders: ['ollama'], diagnosticsVisibility: { codex: 'hidden', nous: 'detailed', invalid: 'sometimes', wrong: false } };
  saveProviderUsagePreferences(preferences, storage);
  const loaded = loadProviderUsagePreferences(storage);
  assert.deepEqual(loaded.diagnosticsVisibility, { codex: 'hidden', nous: 'detailed' });
  assert.deepEqual(loaded.hiddenProviders, ['ollama']);
  assert.equal(normalizeProviderUsagePreferences({ diagnosticsVisibility: 'hidden' }).diagnosticsVisibility, undefined);
  const zeroSpend = { ...provider, error: undefined, windows: provider.windows, metrics: [{ id: 'cost_used', label: 'Spend', value: 0, role: 'spend' }] };
  const renderWarnings = entry => renderToStaticMarkup(createElement(I18nProvider, null, createElement(ProviderCard, { provider: entry, view: 'compact', locale: 'en-US', nowMs: Date.parse(provider.updatedAt) })));
  assert.doesNotMatch(renderWarnings(zeroSpend), /Some details are unavailable|unknown_currency/, 'unknown currency on zero Spend must not raise a warning label');
  assert.match(renderWarnings({ ...zeroSpend, metrics: [{ ...zeroSpend.metrics[0], value: 1 }] }), /Some details are unavailable/, 'nonzero Spend without currency must keep its warning');
  assert.match(renderWarnings({ ...zeroSpend, warnings: ['unknown_currency', 'balance_unavailable'] }), /Some details are unavailable/, 'other warnings must remain');
  assert.match(renderWarnings({ ...zeroSpend, balances: [{ id: 'balance', label: 'Balance', value: 5 }] }), /Some details are unavailable/, 'unknown currency on a nonzero balance must remain');
  assert.match(renderWarnings({ ...zeroSpend, metrics: [] }), /Some details are unavailable/, 'missing Spend is not proof of zero');
  console.log('diagnostics visibility, provider isolation, warnings, legacy defaults and persistence passed');
} finally { await server.close(); }
