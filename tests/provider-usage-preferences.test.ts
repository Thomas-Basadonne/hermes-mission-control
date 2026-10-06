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
  migrateProviderUsagePreferences,
  PROVIDER_USAGE_PREFERENCES_KEY,
  saveProviderUsagePreferences,
  setProviderUsageFieldVisible,
  setProviderUsageProviderVisible,
  setProviderUsageCompactFields,
} from '../src/lib/provider-usage-preferences.ts';

test('normalizes optional compact overrides into bounded ordered safe field references', () => {
  const compactFields = JSON.parse('{"future":[],"constructor":[{"group":"metrics","id":"safe:metric"}],"__proto__":[{"group":"windows","id":"primary"}]}');
  compactFields.other = [
    { group: 'windows', id: 'quota' }, { group: 'windows', id: 'quota' },
    { group: 'metrics', id: 'quota' }, { group: 'invalid', id: 'x' },
    { group: 'metrics', id: 'bad id' }, { group: 'metrics', id: '_bad' },
    { group: 'metrics', id: 'a'.repeat(161) }, null,
    { group: 'balances', id: 'USD.balance' }, { group: 'metrics', id: 'A_1-2:3' },
    { group: 'metrics', id: 'last' }, { group: 'metrics', id: 'sixth' },
  ];
  compactFields.invalid = 'not-an-array';
  const result = normalizeProviderUsagePreferences({ compactFields });
  assert.deepEqual(result.compactFields?.other, [
    { group: 'windows', id: 'quota' }, { group: 'metrics', id: 'quota' },
    { group: 'balances', id: 'USD.balance' }, { group: 'metrics', id: 'A_1-2:3' },
    { group: 'metrics', id: 'last' },
  ]);
  assert.deepEqual(result.compactFields?.future, []);
  assert.deepEqual(result.compactFields?.constructor, [{ group: 'metrics', id: 'safe:metric' }]);
  assert.deepEqual(result.compactFields?.['__proto__'], [{ group: 'windows', id: 'primary' }]);
  assert.equal(Object.getPrototypeOf(result.compactFields), Object.prototype);
  assert.equal(Object.hasOwn(result.compactFields!, 'invalid'), false);
  for (const invalid of [undefined, null, [], 'invalid']) {
    assert.equal(Object.hasOwn(normalizeProviderUsagePreferences({ compactFields: invalid }), 'compactFields'), false);
  }
});

test('sets compact selection immutably, persists empty override, and restores Auto with null', async () => {
  const api = await import('../src/lib/provider-usage-preferences.ts');
  assert.equal(typeof api.setProviderUsageCompactFields, 'function');
  assert.equal(api.MAX_PROVIDER_USAGE_COMPACT_FIELDS, 5);
  const preferences = normalizeProviderUsagePreferences({
    hiddenProviders: ['hidden'], hiddenFields: { future: { metrics: ['hidden-row'] } },
    providerOrder: ['future'], columns: 2, view: 'detailed',
  });
  const fields = [{ group: 'metrics' as const, id: 'row' }, { group: 'windows' as const, id: 'quota' }];
  const selected = api.setProviderUsageCompactFields(preferences, 'future', [...fields, fields[0]]);
  assert.deepEqual(selected, { ...preferences, compactFields: { future: fields } });
  fields[0].id = 'changed';
  assert.equal(selected.compactFields!.future[0].id, 'row');
  assert.equal(Object.hasOwn(preferences, 'compactFields'), false);
  const empty = api.setProviderUsageCompactFields(selected, 'future', []);
  assert.deepEqual(empty.compactFields!.future, []);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveProviderUsagePreferences(empty, storage);
  assert.deepEqual(loadProviderUsagePreferences(storage), empty);
  const other = api.setProviderUsageCompactFields(empty, 'constructor', [{ group: 'balances', id: 'balance' }]);
  const auto = api.setProviderUsageCompactFields(other, 'future', null);
  assert.equal(Object.hasOwn(auto.compactFields!, 'future'), false);
  assert.deepEqual(auto.compactFields!.constructor, [{ group: 'balances', id: 'balance' }]);
  const providers = [{ provider: 'future', windows: [{ id: 'quota' }], balances: [{ id: 'balance' }], metrics: [{ id: 'row' }, { id: 'hidden-row' }] }];
  assert.deepEqual(applyProviderUsagePreferences(providers, empty)[0], { ...providers[0], metrics: [{ id: 'row' }] });
});

test('migrates compact legacy references without deleting missing or ambiguous selections', () => {
  const prefs = normalizeProviderUsagePreferences({
    compactFields: { future: [
      { group: 'metrics', id: 'legacy' }, { group: 'windows', id: 'legacy' },
      { group: 'balances', id: 'missing' }, { group: 'metrics', id: 'ambiguous' },
      { group: 'metrics', id: 'stable' },
    ], offline: [], dropped: [{ group: 'metrics', id: 'remember-me' }] },
  });
  const providers = [{ provider: 'future', windows: [{ id: 'weekly', legacyIds: ['legacy'] }], balances: [], metrics: [
    { id: 'stable', legacyIds: ['legacy'] }, { id: 'other', legacyIds: ['stable'] },
    { id: 'a', legacyIds: ['ambiguous'] }, { id: 'b', legacyIds: ['ambiguous'] },
  ] }];
  const migrated = migrateProviderUsagePreferences(providers, prefs);
  assert.deepEqual(migrated.compactFields, {
    future: [{ group: 'metrics', id: 'stable' }, { group: 'windows', id: 'weekly' },
      { group: 'balances', id: 'missing' }, { group: 'metrics', id: 'ambiguous' }],
    offline: [], dropped: [{ group: 'metrics', id: 'remember-me' }],
  });
  assert.equal(prefs.compactFields!.future[0].id, 'legacy');
  assert.equal(migrateProviderUsagePreferences([], migrated), migrated);
  assert.equal(migrateProviderUsagePreferences([{ ...providers[0], windows: [], metrics: [] }], migrated), migrated);
  assert.equal(migrateProviderUsagePreferences(providers, migrated), migrated);
});

test('loads versioned browser preferences and removes malformed entries', () => {
  const values = new Map([[PROVIDER_USAGE_PREFERENCES_KEY, JSON.stringify({
    hiddenProviders: ['codex', 'codex', 7],
    hiddenFields: { codex: { windows: ['primary', null], metrics: ['reset'] } },
    providerOrder: ['nous', 'nous', false],
    columns: 2,
    view: 'detailed',
  })]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.deepEqual(loadProviderUsagePreferences(storage), {
    hiddenProviders: ['codex'],
    hiddenFields: { codex: { windows: ['primary'], balances: [], metrics: ['reset'] } },
    providerOrder: ['nous'],
    columns: 2,
    view: 'detailed',
  });
});

test('applies provider order and hides only user-selected providers and fields', () => {
  const providers = [
    { provider: 'codex', windows: [{ id: 'primary' }, { id: 'weekly' }], balances: [{ id: 'balance' }], metrics: [{ id: 'reset' }, { id: 'status' }] },
    { provider: 'ollama', windows: [{ id: 'primary' }], balances: [], metrics: [] },
    { provider: 'nous', windows: [{ id: 'session' }], balances: [], metrics: [] },
  ];
  const preferences = {
    hiddenProviders: ['ollama'],
    hiddenFields: { codex: { windows: ['primary'], balances: [], metrics: ['reset'] } },
    providerOrder: ['nous', 'codex'],
    columns: 3 as const,
    view: 'compact' as const,
  };

  assert.deepEqual(applyProviderUsagePreferences(providers, preferences), [
    { provider: 'nous', windows: [{ id: 'session' }], balances: [], metrics: [] },
    { provider: 'codex', windows: [{ id: 'weekly' }], balances: [{ id: 'balance' }], metrics: [{ id: 'status' }] },
  ]);
  assert.deepEqual(providers[0].windows.map(({ id }) => id), ['primary', 'weekly']);
});

test('moves provider order without crossing its bounds or mutating the source', () => {
  const order = ['codex', 'nous', 'ollama'];

  assert.deepEqual(moveProviderUsagePreference(order, 'nous', -1), ['nous', 'codex', 'ollama']);
  assert.deepEqual(moveProviderUsagePreference(order, 'codex', -1), order);
  assert.deepEqual(order, ['codex', 'nous', 'ollama']);
});

test('updates provider and field visibility immutably', () => {
  const preferences = {
    hiddenProviders: ['ollama'],
    hiddenFields: {},
    providerOrder: [],
    columns: 3 as const,
    view: 'compact' as const,
  };

  const providerVisible = setProviderUsageProviderVisible(preferences, 'ollama', true);
  const fieldHidden = setProviderUsageFieldVisible(providerVisible, 'codex', 'windows', 'primary', false);
  const fieldVisible = setProviderUsageFieldVisible(fieldHidden, 'codex', 'windows', 'primary', true);

  assert.deepEqual(providerVisible.hiddenProviders, []);
  assert.deepEqual(fieldHidden.hiddenFields.codex.windows, ['primary']);
  assert.deepEqual(fieldVisible.hiddenFields.codex.windows, []);
  assert.deepEqual(preferences.hiddenProviders, ['ollama']);
});

test('keeps collection, presentation, and overview eligibility separate for catalog providers', () => {
  const preferences = {
    hiddenProviders: ['nous'],
    hiddenFields: {},
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
    hiddenProviders: [], hiddenFields: {}, providerOrder: ['selected-ready', 'selected-disabled'],
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
    hiddenFields: {},
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

test('migrates an unambiguous legacy field preference through stable IDs and reorder', () => {
  const prefs = { hiddenProviders: [], hiddenFields: { future: { windows: [], balances: [], metrics: ['detail-0-0'] } }, providerOrder: [], columns: 3 as const, view: 'compact' as const };
  const providers = [{ provider: 'future', available: true, windows: [], balances: [], metrics: [
    { id: 'detail:stable', label: 'Row', value: 1, legacyIds: ['detail-0-0'] }, { id: 'detail:chart', kind: 'chart', value: null, legacyIds: ['detail-0-1'] },
  ] }];
  assert.deepEqual(applyProviderUsagePreferences(providers, prefs)[0].metrics.map(f => f.id), ['detail:chart']);
  const reordered = [{ ...providers[0], metrics: [{ ...providers[0].metrics[1] }, { ...providers[0].metrics[0], value: 99 }] }];
  assert.deepEqual(applyProviderUsagePreferences(reordered, prefs)[0].metrics.map(f => f.id), ['detail:chart']);
  assert.equal(providers[0].available, true, 'presentation filters must not change availability');
});

test('persists migrated stable IDs and leaves ambiguous aliases untouched', () => {
  const prefs = { hiddenProviders: [], hiddenFields: { future: { windows: [], balances: [], metrics: ['detail-0-0', 'chart-legacy', 'ambiguous'] } }, providerOrder: [], columns: 3 as const, view: 'compact' as const };
  const providers = [{ provider: 'future', windows: [], balances: [], metrics: [
    { id: 'detail:stable', value: 1, legacyIds: ['detail-0-0'] }, { id: 'detail:chart', value: null, kind: 'chart', legacyIds: ['chart-legacy'] },
    { id: 'detail:a', legacyIds: ['ambiguous'] }, { id: 'detail:b', legacyIds: ['ambiguous'] },
  ] }];
  const migrated = migrateProviderUsagePreferences(providers, prefs);
  assert.deepEqual(migrated.hiddenFields.future.metrics, ['detail:stable', 'detail:chart', 'ambiguous']);
  const changed = [{ ...providers[0], metrics: [
    { id: 'detail:new', value: 99, legacyIds: ['detail-0-0'] }, { id: 'detail:stable', value: 500, legacyIds: ['detail-2-4'] },
  ] }];
  assert.deepEqual(applyProviderUsagePreferences(changed, migrated)[0].metrics.map(field => field.id), ['detail:new']);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveProviderUsagePreferences(migrated, storage);
  assert.deepEqual(loadProviderUsagePreferences(storage), migrated);
  assert.equal(migrateProviderUsagePreferences(providers, migrated), migrated);
  assert.doesNotThrow(() => loadProviderUsagePreferences({ getItem: () => { throw new Error('denied'); }, setItem: () => {} }));
});

test('persists normalized preferences without failing when browser storage is unavailable', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const preferences = {
    hiddenProviders: ['codex', 'codex'],
    hiddenFields: {},
    providerOrder: ['nous'],
    columns: 2 as const,
    view: 'compact' as const,
  };

  saveProviderUsagePreferences(preferences, storage);
  assert.deepEqual(JSON.parse(values.get(PROVIDER_USAGE_PREFERENCES_KEY) ?? 'null'), {
    hiddenProviders: ['codex'],
    hiddenFields: {},
    providerOrder: ['nous'],
    columns: 2,
    view: 'compact',
  });
  assert.doesNotThrow(() => saveProviderUsagePreferences(preferences, {
    getItem: () => null,
    setItem: () => { throw new Error('storage denied'); },
  }));
});

test('compact pin override with empty array and null', () => {
  const preferences = normalizeProviderUsagePreferences({});
  const withPins = setProviderUsageCompactFields(preferences, 'future', [
    { group: 'metrics', id: 'row' },
  ]);
  assert.deepEqual(withPins.compactFields!.future, [{ group: 'metrics', id: 'row' }]);
  const withEmpty = setProviderUsageCompactFields(withPins, 'future', []);
  assert.deepEqual(withEmpty.compactFields!.future, []);
  const withNull = setProviderUsageCompactFields(withEmpty, 'future', null);
  assert.equal(Object.hasOwn(withNull.compactFields!, 'future'), false);
});
