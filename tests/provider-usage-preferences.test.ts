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

test('only a true singleton fills the last responsive grid row', async () => {
  const preferences = await import('../src/lib/provider-usage-preferences.ts');
  assert.equal(typeof preferences.getProviderUsageGridTailSpan, 'function');
  for (const columns of [1, 2, 3] as const) {
    for (let count = 1; count <= 9; count++) {
      assert.equal(preferences.getProviderUsageGridTailSpan(count, columns), count % columns === 1 ? columns : 1, `${count} cards at ${columns} columns`);
    }
  }
  assert.equal(preferences.getProviderUsageGridTailSpan(3, 3), 1, 'a full three-card row must not be split');
  assert.equal(preferences.getProviderUsageGridTailSpan(4, 3), 3, 'an even-indexed singleton must span three columns');
  assert.equal(preferences.getProviderUsageGridTailSpan(5, 3), 1, 'a two-card partial row must not span');
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

test('malformed nested preferences survive load, migrate, apply and save without losing valid entries', () => {
  const providers = [{ provider: 'future', windows: [{ id: 'quota' }], balances: [{ id: 'cash' }], metrics: [{ id: 'spend' }] }];
  const malformed = [null, false, 7, 'bad', [], {}];
  for (const bad of malformed) {
    const values = new Map([[PROVIDER_USAGE_PREFERENCES_KEY, JSON.stringify({
      compactFields: { future: [bad, { group: 'windows', id: 'quota' }, { group: 'unknown', id: 'spend' }, { group: 'metrics', id: 7 }], broken: bad },
      hiddenFields: { future: { windows: bad, balances: [bad, 'cash', 'cash'], metrics: bad }, broken: bad },
      fieldVisibility: { future: { quota: bad, spend: 'detailed', invalid: 'sometimes' }, broken: bad },
      groupFieldVisibility: { future: { windows: bad, balances: bad, metrics: { invalid: bad } }, broken: bad },
    })]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const loaded = loadProviderUsagePreferences(storage);
    const migrated = migrateFieldVisibility(providers, loaded);
    assert.deepEqual(loaded.compactFields?.future, [{ group: 'windows', id: 'quota' }]);
    assert.deepEqual(loaded.hiddenFields?.future?.balances, typeof bad === 'string' ? [bad, 'cash'] : ['cash']);
    assert.deepEqual(loaded.fieldVisibility?.future, { spend: 'detailed' });
    assert.deepEqual(loaded.groupFieldVisibility?.future?.metrics, {});
    const applied = applyProviderUsagePreferences(providers, migrated)[0];
    assert.deepEqual(applied.windows, providers[0].windows);
    assert.deepEqual(applied.balances, []);
    assert.equal(getFieldVisibility(migrated, 'future', 'metrics', 'spend'), 'detailed');
    saveProviderUsagePreferences(migrated, storage);
    assert.deepEqual(loadProviderUsagePreferences(storage), migrated);
  }
  for (const bad of malformed) {
    const storage = { getItem: () => JSON.stringify({ compactFields: { future: bad }, hiddenFields: { future: { windows: bad } } }), setItem: () => {} };
    assert.doesNotThrow(() => {
      const migrated = migrateFieldVisibility(providers, loadProviderUsagePreferences(storage));
      applyProviderUsagePreferences(providers, migrated);
      saveProviderUsagePreferences(migrated, storage);
    });
  }
});

test('field visibility defaults to both and can be set', () => {
  const preferences = normalizeProviderUsagePreferences({});
  assert.equal(getFieldVisibility(preferences, 'future', 'windows', 'primary'), 'both');
  const updated = setFieldVisibility(preferences, 'future', 'windows', 'primary', 'detailed');
  assert.equal(getFieldVisibility(updated, 'future', 'windows', 'primary'), 'detailed');
  assert.equal(getFieldVisibility(preferences, 'future', 'windows', 'primary'), 'both', 'immutable');
});

test('legacy visibility survives load, early save, group-aware alias migration and reload', () => {
  const values = new Map([[PROVIDER_USAGE_PREFERENCES_KEY, JSON.stringify({
    hiddenFields: { future: { windows: ['old-hidden'] } },
    compactFields: { future: [{ group: 'windows', id: 'old-shared' }] },
  })]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const providers = [{ provider: 'future',
    windows: [{ id: 'shared', legacyIds: ['old-shared'] }, { id: 'hidden', legacyIds: ['old-hidden'] }],
    balances: [{ id: 'shared', legacyIds: ['old-shared'] }], metrics: [],
  }];
  const loaded = loadProviderUsagePreferences(storage);
  saveProviderUsagePreferences(loaded, storage); // Panel persists before usage arrives.
  const migrated = migrateFieldVisibility(providers, loadProviderUsagePreferences(storage));
  assert.deepEqual(migrated.groupFieldVisibility?.future, {
    windows: { shared: 'both', hidden: 'hidden' }, balances: { shared: 'detailed' }, metrics: {},
  });
  saveProviderUsagePreferences(migrated, storage);
  const reloaded = loadProviderUsagePreferences(storage);
  assert.deepEqual(reloaded.groupFieldVisibility, migrated.groupFieldVisibility);
  assert.deepEqual(applyProviderUsagePreferences(providers, reloaded)[0].windows, [providers[0].windows[0]], 'migrated hidden aliases must actually hide the field after reload');
});

test('group-qualified visibility isolates equal field IDs and upgrades unqualified preferences', () => {
  const providers = [{ provider: 'future',
    windows: [{ id: 'shared', legacyIds: ['old'] }],
    balances: [{ id: 'shared', legacyIds: ['old'] }],
    metrics: [{ id: 'shared', legacyIds: ['old'] }],
  }];
  const legacy = normalizeProviderUsagePreferences({ fieldVisibility: { future: { old: 'detailed' } } });
  const migrated = migrateFieldVisibility(providers, legacy);
  assert.equal(getFieldVisibility(migrated, 'future', 'windows', 'shared'), 'detailed', 'unqualified alias survives migration');
  const updated = setFieldVisibility(migrated, 'future', 'windows', 'shared', 'hidden');
  assert.equal(getFieldVisibility(updated, 'future', 'windows', 'shared'), 'hidden');
  assert.equal(getFieldVisibility(updated, 'future', 'balances', 'shared'), 'detailed');
  assert.equal(getFieldVisibility(updated, 'future', 'metrics', 'shared'), 'detailed');
  assert.equal(getFieldVisibility(updated, 'other', 'windows', 'shared'), 'both');
  const displayed = applyProviderUsagePreferences(providers, updated)[0];
  assert.deepEqual(displayed.windows, []);
  assert.deepEqual(displayed.balances, providers[0].balances);
  assert.deepEqual(displayed.metrics, providers[0].metrics);
  assert.equal(getFieldVisibility(migrated, 'future', 'windows', 'shared'), 'detailed', 'editing remains immutable');
  const oldId = normalizeProviderUsagePreferences({ fieldVisibility: { future: { shared: 'hidden' } }, groupFieldVisibility: { future: { metrics: { shared: 'both' } } } });
  const upgraded = migrateFieldVisibility(providers, oldId);
  assert.equal(getFieldVisibility(upgraded, 'future', 'windows', 'shared'), 'hidden');
  assert.equal(getFieldVisibility(upgraded, 'future', 'balances', 'shared'), 'hidden');
  assert.equal(getFieldVisibility(upgraded, 'future', 'metrics', 'shared'), 'both', 'qualified settings override old unqualified values');
});

test('migrated group settings never become literal legacy IDs when fields arrive later', () => {
  const initial = [{ provider: 'future', windows: [{ id: 'shared' }], balances: [{ id: 'shared' }], metrics: [] }];
  const next = [{ ...initial[0], metrics: [{ id: 'windows:shared' }, { id: 'new-metric', legacyIds: ['windows:shared'] }] }];
  const values = new Map([[PROVIDER_USAGE_PREFERENCES_KEY, JSON.stringify({ hiddenFields: { future: { windows: ['shared'] } } })]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const migrated = migrateFieldVisibility(initial, loadProviderUsagePreferences(storage));
  saveProviderUsagePreferences(migrated, storage);
  const updated = migrateFieldVisibility(next, loadProviderUsagePreferences(storage));
  assert.equal(getFieldVisibility(updated, 'future', 'windows', 'shared'), 'hidden');
  assert.equal(getFieldVisibility(updated, 'future', 'balances', 'shared'), 'both');
  for (const metric of next[0].metrics) assert.equal(getFieldVisibility(updated, 'future', 'metrics', metric.id), 'both', 'a qualified window key is not a metric ID or alias');
  assert.deepEqual(applyProviderUsagePreferences(next, updated)[0].metrics, next[0].metrics);
  const edited = setFieldVisibility(updated, 'future', 'metrics', 'windows:shared', 'detailed');
  saveProviderUsagePreferences(edited, storage);
  assert.equal(getFieldVisibility(loadProviderUsagePreferences(storage), 'future', 'metrics', 'windows:shared'), 'detailed');
  assert.equal(getFieldVisibility(loadProviderUsagePreferences(storage), 'future', 'windows', 'shared'), 'hidden');

  // In old unmarked storage, every key is a literal ID, including colon IDs.
  const legacy = normalizeProviderUsagePreferences({ fieldVisibility: { future: { 'windows:shared': 'hidden', shared: 'detailed' } } });
  const preserved = migrateFieldVisibility(next, legacy);
  assert.equal(getFieldVisibility(preserved, 'future', 'windows', 'shared'), 'detailed');
  assert.equal(getFieldVisibility(preserved, 'future', 'balances', 'shared'), 'detailed');
  for (const metric of next[0].metrics) assert.equal(getFieldVisibility(preserved, 'future', 'metrics', metric.id), 'hidden', 'literal legacy IDs and aliases must survive');
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
  assert.deepEqual(migrated.groupFieldVisibility?.future, {
    windows: { primary: 'both', secondary: 'hidden' }, balances: { balance: 'detailed' },
    metrics: { cost_used: 'both', reset: 'detailed' },
  });
});
