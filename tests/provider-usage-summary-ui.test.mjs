import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(), appType: 'custom', logLevel: 'silent', plugins: [react()],
  server: { middlewareMode: true, hmr: false } });
const { ProviderCard } = await server.ssrLoadModule('/src/components/overview/ProviderUsagePanel.tsx');
const { I18nProvider } = await server.ssrLoadModule('/src/lib/i18n.tsx');
const nowMs = Date.parse('2026-10-06T16:00:00Z');
const base = { provider: 'future-cloud', available: true, updatedAt: '2026-10-06T15:59:00Z',
  source: 'api', dataConfidence: 'exact', windows: [], balances: [], metrics: [] };
const render = (provider, props = {}) => renderToStaticMarkup(createElement(I18nProvider, null,
  createElement(ProviderCard, { provider: { ...base, ...provider }, locale: 'en-US', nowMs, preferences: {}, ...props })));
// Native <details> markup is server-rendered too: assertions before it distinguish
// the operational summary from fields merely available in the expanded section.
const summary = html => html.split('<details')[0];

try {
  await test('compact quota includes localized reset and does not treat its window as a Hermes session', () => {
    const html = summary(render({ windows: [{ id: 'primary', label: 'Session', usedPercent: 79,
      windowMinutes: 300, resetsAt: '2026-10-06T18:12:53Z', resetDescription: 'upstream display' }] }));
    assert.match(html, /5-hour quota/);
    assert.match(html, /reset/);
    assert.match(html, /Oct 6, 2026/);
    assert.doesNotMatch(html, /upstream display/, 'authoritative reset timestamp must be localized, not raw upstream presentation');
    assert.match(html, /79%/);
  });
  await test('compact healthy data has one update indicator and defers collection diagnostics', () => {
    const html = render({ lastAttemptAt: '2026-10-06T15:59:02Z' });
    const collapsed = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
    assert.match(collapsed, /Data fresh/);
    assert.match(collapsed, /Updated/);
    assert.doesNotMatch(collapsed, /Last attempt|Last success|Source:|Data confidence:/);
    assert.match(html, /Last attempt/);
    assert.match(html, /Source/);
  });
  await test('unavailable provider has a single actionable explanation while retaining retry diagnostics', () => {
    const html = render({ available: false, error: 'Collector could not return limits.',
      refreshState: 'failed', nextRetryAt: '2026-10-06T16:01:00Z' });
    assert.equal(html.match(/Collector could not return limits\./g)?.length, 1);
    assert.doesNotMatch(summary(html), />Unavailable<\/p>/);
    assert.match(html, /Next check/);
  });
  await test('detailed metrics have one heading per section and keep raw numeric data and counts readable', () => {
    const html = render({ metrics: [
      { id: 'detail:a', label: 'Row A', value: '$0.00', usageValue: 0.0025, sectionLabel: 'Billing section' },
      { id: 'detail:b', label: 'Row B', value: 'Not provided', sectionLabel: 'Billing section' },
      { id: 'reset_credits_available', label: 'Reset credits available', value: 2, unit: 'count' },
    ] }, { view: 'detailed' });
    assert.equal(html.match(/>Billing section</g)?.length, 1);
    assert.match(html, /0.0025/);
    assert.doesNotMatch(html, />2 count</);
    for (const id of ['detail:a', 'detail:b', 'reset_credits_available']) assert.match(html, new RegExp(`data-field-id="${id}"`));
  });
  await test('compact summary shows top 5 by role priority when more fields exist', () => {
    const html = render({
      balances: [
        { id: 'total_spendable', label: 'Total spendable', value: 100, currency: 'USD' },
        { id: 'credits_remaining', label: 'Credits remaining', value: 50, unit: 'credits' },
        { id: 'subscription_remaining', label: 'Subscription remaining', value: 30, currency: 'USD' },
        { id: 'topup_remaining', label: 'Top-up remaining', value: 20, currency: 'USD' },
      ],
      metrics: [
        { id: 'cost_used', label: 'Spend', value: 10, currency: 'USD' },
        { id: 'reset_credits_available', label: 'Reset credits available', value: 2, unit: 'count' },
        { id: 'paid_access', label: 'Paid access', value: true },
        { id: 'detail:chart', label: 'Key spend', kind: 'chart', chart: { kind: 'line', points: [{ label: 'Day', value: 1 }] } },
      ],
    });
    assert.match(html, /Total spendable/);
    assert.match(html, /Credits remaining/);
    assert.match(html, /Spend/);
    assert.match(html, /Reset credits available/);
    assert.match(html, /Paid access/);
    const collapsed = summary(html);
    assert.doesNotMatch(collapsed, /Subscription remaining/);
    assert.doesNotMatch(collapsed, /Top-up remaining/);
    assert.doesNotMatch(collapsed, /Key spend/);
  });
  await test('detailed-only fields do not appear in compact summary', () => {
    const html = render({
      balances: [
        { id: 'total_spendable', label: 'Total spendable', value: 100, currency: 'USD' },
        { id: 'credits_remaining', label: 'Credits remaining', value: 50, unit: 'credits' },
      ],
    }, {
      preferences: {
        fieldVisibility: {
          'future-cloud': {
            total_spendable: 'both',
            credits_remaining: 'detailed',
          },
        },
      },
    });
    const collapsed = summary(html);
    assert.match(collapsed, /Total spendable/);
    assert.doesNotMatch(collapsed, /Credits remaining/);
  });
  await test('compact visibility uses group-qualified IDs with unqualified backwards compatibility', () => {
    const html = render({
      windows: [{ id: 'shared', label: 'Window quota', usedPercent: 12 }],
      balances: [{ id: 'shared', label: 'Cash balance', value: 5 }],
      metrics: [{ id: 'shared', label: 'Hidden metric', value: 2 }],
    }, { preferences: {
      fieldVisibility: { 'future-cloud': { shared: 'detailed' } },
      groupFieldVisibility: { 'future-cloud': { windows: { shared: 'both' }, metrics: { shared: 'hidden' } } },
    } });
    assert.match(summary(html), /Window quota/);
    assert.doesNotMatch(summary(html), /Cash balance/);
    assert.match(html, /Cash balance/);
    assert.doesNotMatch(html, /Hidden metric/);
  });
  await test('summary resolves literal colon IDs separately from persisted group visibility', async () => {
    const { normalizeProviderUsagePreferences, migrateFieldVisibility, setFieldVisibility, applyProviderUsagePreferences } = await server.ssrLoadModule('/src/lib/provider-usage-preferences.ts');
    const provider = { ...base,
      windows: [{ id: 'shared', label: 'Window quota', usedPercent: 12 }],
      metrics: [{ id: 'windows:shared', label: 'Literal metric', value: 2 }, { id: 'renamed', legacyIds: ['windows:shared'], label: 'Alias metric', value: 3 }],
    };
    const legacy = normalizeProviderUsagePreferences({ fieldVisibility: { 'future-cloud': { 'windows:shared': 'hidden', shared: 'detailed' } } });
    const oldHtml = render(provider, { preferences: legacy });
    assert.match(oldHtml, /Window quota/, 'colon legacy keys must not hide a different window');
    assert.doesNotMatch(summary(oldHtml), /Window quota|Literal metric/);

    const initial = { ...provider, metrics: [] };
    let preferences = migrateFieldVisibility([initial], normalizeProviderUsagePreferences({ hiddenFields: { 'future-cloud': { windows: ['shared'] } } }));
    preferences = migrateFieldVisibility([provider], normalizeProviderUsagePreferences(JSON.parse(JSON.stringify(preferences))));
    preferences = setFieldVisibility(preferences, 'future-cloud', 'metrics', 'windows:shared', 'detailed');
    const html = render(applyProviderUsagePreferences([provider], preferences)[0], { preferences });
    assert.match(summary(html), /Alias metric/, 'new metric aliases must not inherit window visibility');
    assert.doesNotMatch(summary(html), /Window quota|Literal metric/);
    assert.match(html, /Literal metric/, 'group-specific detailed setting stays in overflow');
  });
  await test('summary fallback ranks full semantic metadata without mistaking charts for balances', () => {
    const fields = [
      { id: 'chart', label: 'API key remaining', sectionLabel: 'API key', kind: 'chart', chart: { kind: 'line', points: [{ label: 'Day', value: 1 }] } },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `diagnostic-${i}`, label: `Diagnostic ${i}`, value: 'Ready' })),
      { id: 'limit', label: 'API key limit', sectionLabel: 'API key', value: '$100' },
      { id: 'remaining', label: 'API key remaining', sectionLabel: 'API key', value: '$90' },
      { id: 'today', label: 'Today', sectionLabel: 'API key', value: '$2' },
      { id: 'month', label: 'This month', sectionLabel: 'API key', value: '$10' },
      { id: 'credits', label: 'Remaining', sectionLabel: 'Credits', value: '$50' },
    ];
    const html = render({ metrics: fields });
    const collapsed = summary(html);
    for (const id of ['limit', 'remaining', 'today', 'month', 'credits']) assert.match(collapsed, new RegExp(`data-field-id="${id}"`));
    assert.doesNotMatch(collapsed, /data-field-id="chart"|Diagnostic/);
    assert.match(html, /data-field-id="chart"/, 'chart remains available in overflow');
  });
  await test('loading state shows when catalog is loading', async () => {
    const { getProviderUsagePanelState } = await server.ssrLoadModule('/src/lib/provider-usage-display.ts');
    assert.equal(getProviderUsagePanelState(null, false, true), 'loading');
    assert.equal(getProviderUsagePanelState(null, false, false), 'loading');
    assert.equal(getProviderUsagePanelState(null, true, false), 'unavailable');
    assert.equal(getProviderUsagePanelState({ available: true, providers: [] }, false, false), 'ready');
  });
  await test('loading state shows during full initialization', async () => {
    const { getProviderUsagePanelState } = await server.ssrLoadModule('/src/lib/provider-usage-display.ts');
    // Catalogo in caricamento, snapshot null
    assert.equal(getProviderUsagePanelState(null, false, true), 'loading');
    // Catalogo pronto, refresh in corso, snapshot null
    assert.equal(getProviderUsagePanelState(null, false, true), 'loading');
    // Catalogo pronto, refresh completato, snapshot presente
    assert.equal(getProviderUsagePanelState({ available: true, providers: [] }, false, false), 'ready');
    // Catalogo pronto, refresh fallito, snapshot null
    assert.equal(getProviderUsagePanelState(null, true, false), 'unavailable');
  });
} finally {
  await server.close();
}
