import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE, root: process.cwd(), appType: 'custom', logLevel: 'silent', plugins: [react()], server: { middlewareMode: true, hmr: false } });
try {
  const { ProviderCard } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
  const { I18nProvider } = await server.ssrLoadModule('/src/lib/i18n.tsx');
  const render = (provider, props = {}) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(ProviderCard, { provider, displayName: 'Future Cloud', locale: 'en-US', nowMs: Date.parse('2026-10-06T01:10:00Z'), ...props })));
  const good = { provider: 'future-provider', available: true, updatedAt: '2026-10-06T01:00:00Z', windows: [{ id: 'primary', label: 'Literal cap', usedPercent: 12 }], balances: [], metrics: [] };
  assert.match(render(good), /Future Cloud: stale/, 'old data must expire locally without a GET');
  const failed = render({ ...good, updatedAt: '2026-10-06T01:09:00Z', error: 'Retained safe failure', lastAttemptAt: '2026-10-06T01:10:00Z' });
  assert.match(failed, /Retained safe failure/);
  assert.match(failed, /Last success/);
  assert.match(failed, /Last attempt/);
  assert.match(render({ ...good, available: false, dataState: 'no_data' }), /No supported data/);
  assert.match(render({ ...good, refreshState: 'cooldown', nextRetryAt: '2026-10-06T01:11:00Z' }), /Next check/);
  assert.doesNotMatch(render({ ...good, refreshState: 'cooldown', nextRetryAt: '2026-10-06T01:01:00Z' }), /Next check/, 'expired cooldown must not claim a future scheduled check');
  const featured = render({ ...good, metrics: [
    { id: 'm1', label: 'Featured one', value: 1, featured: true },
    { id: 'm2', label: 'Featured two', value: 2, featured: true },
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'regular'+i, label: 'Regular '+i, value: i })),
  ], balances: [
    { id: 'b1', label: 'First balance', value: 1 }, { id: 'b2', label: 'Second balance', value: 2 },
    { id: 'b3', label: 'Third balance', value: 3 }, { id: 'b4', label: 'Featured balance', value: 4, featured: true },
  ], windows: Array.from({ length: 5 }, (_, i) => ({ id: 'w'+i, label: 'Quota '+i, usedPercent: i, featured: i === 4 })) });
  assert.match(featured, /Featured two/);
  assert.match(featured, /Featured balance/);
  assert.match(featured, /Quota 4/);
  assert.match(featured, /Show all fields \(4\)/);
  const percentCard = render({ ...good, windows: [
    { id: 'tiny', label: 'Tiny', usedPercent: 0.005 }, { id: 'overage', label: 'Overage', usedPercent: 125 },
  ] });
  assert.match(percentCard, /&lt;0.01%/);
  assert.match(percentCard, />125%</);
  assert.match(percentCard, /aria-valuetext="125%"/);
  assert.match(percentCard, /width:100%/);
  const details = render({ ...good, windows: [], balances: [{ id: 'balance', label: 'Literal workspace balance', value: -2, currency: 'EUR', scope: 'workspace', updatedAt: '2026-10-01T00:00:00Z' }], metrics: [
    { id: 'row', label: 'Literal row', value: '<safe text>', secondaryValue: 'Secondary context', sectionLabel: 'Billing section', progress: { used: 12, total: 10 } },
    { id: 'cost', label: 'Spend', value: 12, currency: 'EUR' },
    { id: 'expires', label: 'Expires', kind: 'timestamp', value: '2026-11-01T00:00:00Z' },
    { id: 'history', label: 'History field', value: null, kind: 'chart', chart: { kind: 'line', title: 'Daily usage', unit: 'requests', points: [{ label: 'Single point', value: 0 }] } },
  ] }, { view: 'detailed' });
  assert.match(details, /Secondary context/);
  assert.match(details, /Billing section/);
  assert.match(details, /120%/);
  assert.match(details, /€12/);
  assert.match(details, /Nov 1, 2026/);
  assert.match(details, /&lt;safe text&gt;/);
  assert.match(details, /Workspace balance/);
  assert.match(details, /Balance observed/);
  assert.match(details, /<svg[^>]+viewBox="0 0 300 100"/);
  assert.match(details, /<circle/);
  assert.match(details, /<table/);
  assert.match(details, /Single point/);
  assert.match(details, />0<\/td>/);
  for (const kind of ['line', 'bars']) for (const points of [
    [{ label: 'Only', value: 0 }], [{ label: 'Negative', value: -3 }, { label: 'Zero', value: 0 }, { label: 'Positive', value: 2 }],
  ]) {
    const chartOnly = render({ ...good, windows: [], metrics: [{ id: 'chart', label: 'Only chart', value: null, kind: 'chart', chart: { kind, title: 'Generic chart', points } }] });
    assert.match(chartOnly, /Generic chart/);
    assert.match(chartOnly, /<table/);
    assert.doesNotMatch(chartOnly, /NaN|Infinity/);
    for (const point of points) assert.match(chartOnly, new RegExp('>' + point.value + '<\\/td>'));
  }
  const { applyProviderUsagePreferences } = await server.ssrLoadModule('/src/lib/provider-usage-preferences.ts');
  const hidden = applyProviderUsagePreferences([{ ...good, metrics: [{ id: 'featured', label: 'Hidden featured', value: 1, featured: true }] }], { hiddenProviders: [], hiddenFields: { 'future-provider': { windows: [], balances: [], metrics: ['featured'] } }, providerOrder: [], columns: 3, view: 'compact' });
  assert.doesNotMatch(render(hidden[0]), /Hidden featured/);
  assert.match(render({ ...good, windows: [{ id: 'primary', label: 'Literal quota', usageKnown: false, usedPercent: 0 }] }), /aria-valuetext="Unavailable"/);
  const { default: en } = await server.ssrLoadModule('/src/locales/en.json');
  const { default: it } = await server.ssrLoadModule('/src/locales/it.json');
  assert.deepEqual(Object.keys(en).filter(key => key.startsWith('provider.')).sort(), Object.keys(it).filter(key => key.startsWith('provider.')).sort());
  console.log('generic chart, progress, currency, timestamp, hidden featured, translation parity and provenance passed');
} finally { await server.close(); }
