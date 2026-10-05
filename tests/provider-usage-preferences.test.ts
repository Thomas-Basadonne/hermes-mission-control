import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyProviderUsagePreferences,
  loadProviderUsagePreferences,
  moveProviderUsagePreference,
  PROVIDER_USAGE_PREFERENCES_KEY,
  saveProviderUsagePreferences,
  setProviderUsageFieldVisible,
  setProviderUsageProviderVisible,
} from '../src/lib/provider-usage-preferences.ts';

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
