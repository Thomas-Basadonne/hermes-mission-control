import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyProviderUsagePreferences,
  getCodexBarEnableCommand,
  isProviderUsageCollectionCheckboxDisabled,
  needsCodexBarSetupAlert,
  normalizeProviderUsagePreferences,
  getProviderUsageCatalogRows,
  getProviderUsageSelectionForDisplay,
  getVisibleProviderUsageCards,
  hasProviderUsageSelectionChanges,
  loadProviderUsagePreferences,
  moveProviderUsagePreference,
  migrateFieldVisibility,
  PROVIDER_USAGE_PREFERENCES_KEY,
  saveProviderUsagePreferences,
  setProviderUsageProviderVisible,
  getFieldVisibility,
  setFieldVisibility,
} from '../src/lib/provider-usage-preferences.ts';

test('moves provider order without crossing its bounds or mutating the source', () => {
  const order = ['codex', 'nous', 'ollama'];

  assert.deepEqual(moveProviderUsagePreference(order, 'nous', -1), ['nous', 'codex', 'ollama']);
  assert.deepEqual(moveProviderUsagePreference(order, 'codex', -1), order);
  assert.deepEqual(order, ['codex', 'nous', 'ollama']);
});

test('keeps collection, presentation, and overview eligibility separate for catalog providers', () => {
  const preferences = {
    hiddenProviders: ['nous'],
    fieldVisibility: {},
    providerOrder: ['nous', 'codex'],
    columns: 3 as const,
    view: 'compact' as const,
  };
  const catalog = [
    { provider: 'codex', displayName: 'Codex', enabled: true, selectable: true, source: 'codexbar' },
    { provider: 'nous', displayName: 'Nous Portal', enabled: true, selectable: true, source: 'mission-control' },
    { provider: 'ollama', displayName: 'Ollama Cloud', enabled: false, selectable: true, source: 'codexbar' },
  ];
  const usage = [
    { provider: 'codex', available: true, windows: [], balances: [], metrics: [] },
    { provider: 'nous', available: true, windows: [], balances: [], metrics: [] },
    { provider: 'ollama', available: false, windows: [], balances: [], metrics: [] },
  ];

  assert.deepEqual(getProviderUsageCatalogRows(catalog, ['codex'], preferences), [
    { provider: 'codex', displayName: 'Codex', collectUsage: true, showCard: true, showCardDisabled: false, canReorder: false },
    { provider: 'nous', displayName: 'Nous Portal', collectUsage: false, showCard: false, showCardDisabled: true, canReorder: false },
    { provider: 'ollama', displayName: 'Ollama Cloud', collectUsage: false, showCard: true, showCardDisabled: true, canReorder: false },
  ]);
  assert.deepEqual(getVisibleProviderUsageCards(usage, ['codex', 'nous', 'ollama'], preferences).map(({ provider }) => provider), ['codex', 'ollama']);
});

test('catalog rows keep selected providers first, then enabled providers, and reorder only selected cards', () => {
  const catalog = [
    { provider: 'disabled', displayName: 'Disabled', enabled: false, selectable: true, source: 'codexbar' },
    { provider: 'ready-b', displayName: 'Ready B', enabled: true, selectable: true, source: 'codexbar' },
    { provider: 'selected-disabled', displayName: 'Selected disabled', enabled: false, selectable: true, source: 'codexbar' },
    { provider: 'ready-a', displayName: 'Ready A', enabled: true, selectable: true, source: 'codexbar' },
    { provider: 'selected-ready', displayName: 'Selected ready', enabled: true, selectable: true, source: 'codexbar' },
  ];
  const preferences = {
    hiddenProviders: [], fieldVisibility: {}, providerOrder: ['selected-ready', 'selected-disabled'],
    columns: 3 as const, view: 'compact' as const,
  };

  const rows = getProviderUsageCatalogRows(catalog, ['selected-disabled', 'selected-ready'], preferences);

  assert.deepEqual(rows.map(({ provider }) => provider), [
    'selected-ready', 'selected-disabled', 'ready-b', 'ready-a', 'disabled',
  ]);
  assert.deepEqual(rows.map(({ canReorder }) => canReorder), [true, true, false, false, false]);
});

test('builds a copyable CodexBar enable command only for safe provider IDs', () => {
  assert.equal(getCodexBarEnableCommand('ollama'), 'codexbar config enable --provider ollama');
  assert.equal(getCodexBarEnableCommand('openrouter'), 'codexbar config enable --provider openrouter');
  assert.equal(getCodexBarEnableCommand('bad;echo-pwned'), null);
  assert.equal(getCodexBarEnableCommand(''), null);
});

test('requests setup guidance only for disabled CodexBar providers', () => {
  assert.equal(needsCodexBarSetupAlert('codexbar', false), true);
  assert.equal(needsCodexBarSetupAlert('codexbar', true), false);
  assert.equal(needsCodexBarSetupAlert('mission-control', false), false);
});

test('keeps disabled CodexBar providers clickable for setup guidance, but not collectable', () => {
  assert.equal(isProviderUsageCollectionCheckboxDisabled({
    source: 'codexbar', enabled: false, selectable: false, saving: false, catalogLoading: false,
  }), false);
  assert.equal(isProviderUsageCollectionCheckboxDisabled({
    source: 'mission-control', enabled: false, selectable: false, saving: false, catalogLoading: false,
  }), true);
  assert.equal(isProviderUsageCollectionCheckboxDisabled({
    source: 'codexbar', enabled: false, selectable: false, saving: false, catalogLoading: true,
  }), true);
});

test('a single visible provider always gets a full-width one-column layout', async () => {
  const preferences = await import('../src/lib/provider-usage-preferences.ts');
  assert.equal(typeof preferences.getProviderUsageGridColumns, 'function');
  assert.equal(preferences.getProviderUsageGridColumns?.(1, 3), 1);
  assert.equal(preferences.getProviderUsageGridColumns?.(1, 2), 1);
});

test('uses no more grid columns than visible cards or the saved maximum', async () => {
  const { getProviderUsageGridColumns } = await import('../src/lib/provider-usage-preferences.ts');
  assert.equal(getProviderUsageGridColumns?.(2, 3), 2);
  assert.equal(getProviderUsageGridColumns?.(3, 2), 2);
  assert.equal(getProviderUsageGridColumns?.(3, 3), 3);
});

test('preserves a card preference while its collection draft is deselected', () => {
  const preferences = {
    hiddenProviders: [],
    fieldVisibility: {},
    providerOrder: [],
    columns: 3 as const,
    view: 'compact' as const,
  };
  const catalog = [{ provider: 'codex', displayName: 'Codex', enabled: true, selectable: true }];

  assert.deepEqual(getProviderUsageCatalogRows(catalog, [], preferences), [
    { provider: 'codex', displayName: 'Codex', collectUsage: false, showCard: true, showCardDisabled: true, canReorder: false },
  ]);
  assert.deepEqual(preferences.hiddenProviders, []);
});

test('marks collection settings dirty only when the selected provider set changes', () => {
  assert.equal(hasProviderUsageSelectionChanges(['codex', 'nous'], ['nous', 'codex']), false);
  assert.equal(hasProviderUsageSelectionChanges(['codex', 'nous'], ['codex']), true);
  assert.equal(hasProviderUsageSelectionChanges(['codex'], ['codex', 'nous']), true);
});

test('keeps snapshot cards visible when the catalog selection is unavailable', () => {
  const providers = [
    { provider: 'codex', windows: [], balances: [], metrics: [] },
    { provider: 'deepseek', windows: [], balances: [], metrics: [] },
  ];
  assert.deepEqual(getProviderUsageSelectionForDisplay(providers, null), ['codex', 'deepseek']);
  assert.deepEqual(getProviderUsageSelectionForDisplay(providers, ['nous'], false), ['codex', 'deepseek']);
  assert.deepEqual(getProviderUsageSelectionForDisplay(providers, ['deepseek']), ['deepseek']);
});

test('persists normalized preferences without failing when browser storage is unavailable', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const preferences = {
    hiddenProviders: ['codex', 'codex'],
    fieldVisibility: {},
    providerOrder: ['nous'],
    columns: 2 as const,
    view: 'compact' as const,
  };

  saveProviderUsagePreferences(preferences, storage);
  assert.deepEqual(JSON.parse(values.get(PROVIDER_USAGE_PREFERENCES_KEY) ?? 'null'), {
    hiddenProviders: ['codex'],
    fieldVisibility: {},
    providerOrder: ['nous'],
    columns: 2,
    view: 'compact',
  });
  assert.doesNotThrow(() => saveProviderUsagePreferences(preferences, {
    getItem: () => null,
    setItem: () => { throw new Error('storage denied'); },
  }));
});

test('field visibility defaults to both and can be set', () => {
  const preferences = normalizeProviderUsagePreferences({});
  assert.equal(getFieldVisibility(preferences, 'future', 'primary'), 'both');
  const updated = setFieldVisibility(preferences, 'future', 'primary', 'detailed');
  assert.equal(getFieldVisibility(updated, 'future', 'primary'), 'detailed');
  assert.equal(getFieldVisibility(preferences, 'future', 'primary'), 'both', 'immutable');
});

test('migrateFieldVisibility converts hiddenFields and compactFields', () => {
  const providers = [{
    provider: 'future',
    windows: [{ id: 'primary' }, { id: 'secondary' }],
    balances: [{ id: 'balance' }],
    metrics: [{ id: 'cost_used' }, { id: 'reset' }],
  }];
  const legacy = {
    hiddenProviders: [],
    hiddenFields: { future: { windows: ['secondary'], balances: [], metrics: [] } },
    compactFields: { future: [{ group: 'windows', id: 'primary' }, { group: 'metrics', id: 'cost_used' }] },
    providerOrder: [],
    columns: 3 as const,
    view: 'compact' as const,
  };
  const migrated = migrateFieldVisibility(providers, legacy);
  assert.equal(getFieldVisibility(migrated, 'future', 'primary'), 'both');
  assert.equal(getFieldVisibility(migrated, 'future', 'secondary'), 'hidden');
  assert.equal(getFieldVisibility(migrated, 'future', 'balance'), 'detailed');
  assert.equal(getFieldVisibility(migrated, 'future', 'cost_used'), 'both');
  assert.equal(getFieldVisibility(migrated, 'future', 'reset'), 'detailed');
});
