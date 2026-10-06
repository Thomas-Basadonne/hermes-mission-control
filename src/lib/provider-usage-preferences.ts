export const PROVIDER_USAGE_PREFERENCES_KEY = 'mission-control-provider-usage-preferences:v1';

export type ProviderUsageFieldGroup = 'windows' | 'balances' | 'metrics';
export const MAX_PROVIDER_USAGE_COMPACT_FIELDS = 5;
export interface ProviderUsageFieldRef {
  group: ProviderUsageFieldGroup;
  id: string;
}
export type ProviderUsageView = 'compact' | 'detailed';
export type ProviderUsagePreferences = {
  hiddenProviders: string[];
  hiddenFields: Record<string, Record<ProviderUsageFieldGroup, string[]>>;
  compactFields?: Record<string, ProviderUsageFieldRef[]>;
  providerOrder: string[];
  columns: 1 | 2 | 3;
  view: ProviderUsageView;
};

export type ProviderUsageStorage = Pick<Storage, 'getItem' | 'setItem'>;

type ProviderUsageEntry = {
  provider: string;
  windows?: Array<{ id: string; legacyIds?: string[] }>;
  balances?: Array<{ id: string; legacyIds?: string[] }>;
  metrics?: Array<{ id: string; legacyIds?: string[] }>;
};

type ProviderUsageCatalogEntry = {
  provider: string;
  displayName: string;
  enabled: boolean;
  selectable: boolean;
};

export type ProviderUsageCatalogRow = {
  provider: string;
  displayName: string;
  collectUsage: boolean;
  showCard: boolean;
  showCardDisabled: boolean;
  canReorder: boolean;
};

export function getCodexBarEnableCommand(provider: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) return null;
  return `codexbar config enable --provider ${provider}`;
}

export function needsCodexBarSetupAlert(source: string | undefined, enabled: boolean | undefined): boolean {
  return source === 'codexbar' && enabled === false;
}

export function isProviderUsageCollectionCheckboxDisabled({
  source,
  enabled,
  selectable,
  saving,
  catalogLoading,
}: {
  source: string | undefined;
  enabled: boolean | undefined;
  selectable: boolean | undefined;
  saving: boolean;
  catalogLoading: boolean;
}): boolean {
  if (saving || catalogLoading) return true;
  return !selectable && !needsCodexBarSetupAlert(source, enabled);
}

export const DEFAULT_PROVIDER_USAGE_PREFERENCES: ProviderUsagePreferences = {
  hiddenProviders: [],
  hiddenFields: {},
  providerOrder: [],
  columns: 3,
  view: 'compact',
};

const FIELD_GROUPS: ProviderUsageFieldGroup[] = ['windows', 'balances', 'metrics'];

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function normalizeCompactFields(value: unknown): ProviderUsageFieldRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const fields: ProviderUsageFieldRef[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { group, id } = candidate;
    if (!FIELD_GROUPS.includes(group) || typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) continue;
    const key = `${group}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({ group, id });
    if (fields.length === MAX_PROVIDER_USAGE_COMPACT_FIELDS) break;
  }
  return fields;
}

function browserStorage(): ProviderUsageStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeProviderUsagePreferences(value: unknown): ProviderUsagePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PROVIDER_USAGE_PREFERENCES };
  }

  const candidate = value as Record<string, unknown>;
  const hiddenFields: ProviderUsagePreferences['hiddenFields'] = {};
  if (candidate.hiddenFields && typeof candidate.hiddenFields === 'object' && !Array.isArray(candidate.hiddenFields)) {
    for (const [provider, groups] of Object.entries(candidate.hiddenFields)) {
      if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
      hiddenFields[provider] = Object.fromEntries(
        FIELD_GROUPS.map((group) => [group, uniqueStrings((groups as Record<string, unknown>)[group])]),
      ) as Record<ProviderUsageFieldGroup, string[]>;
    }
  }

  const columns = candidate.columns === 1 || candidate.columns === 2 ? candidate.columns : 3;
  return {
    hiddenProviders: uniqueStrings(candidate.hiddenProviders),
    hiddenFields,
    ...(candidate.compactFields && typeof candidate.compactFields === 'object' && !Array.isArray(candidate.compactFields)
      ? { compactFields: Object.fromEntries(Object.entries(candidate.compactFields)
        .filter(([, fields]) => Array.isArray(fields))
        .map(([provider, fields]) => [provider, normalizeCompactFields(fields)])) }
      : {}),
    providerOrder: uniqueStrings(candidate.providerOrder),
    columns,
    view: candidate.view === 'detailed' ? 'detailed' : 'compact',
  };
}

export function loadProviderUsagePreferences(
  storage: ProviderUsageStorage | null = browserStorage(),
): ProviderUsagePreferences {
  try {
    const raw = storage?.getItem(PROVIDER_USAGE_PREFERENCES_KEY);
    return raw ? normalizeProviderUsagePreferences(JSON.parse(raw)) : { ...DEFAULT_PROVIDER_USAGE_PREFERENCES };
  } catch {
    return { ...DEFAULT_PROVIDER_USAGE_PREFERENCES };
  }
}

export function saveProviderUsagePreferences(
  preferences: ProviderUsagePreferences,
  storage: ProviderUsageStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(PROVIDER_USAGE_PREFERENCES_KEY, JSON.stringify(normalizeProviderUsagePreferences(preferences)));
  } catch {
    // Browser storage can be disabled or full; the in-memory preferences still work.
  }
}

export function orderProviderUsage<T extends ProviderUsageEntry>(
  providers: T[],
  preferences: ProviderUsagePreferences,
): T[] {
  const rank = new Map(preferences.providerOrder.map((provider, index) => [provider, index]));
  return providers
    .map((provider, index) => ({ provider, index, rank: rank.get(provider.provider) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ provider }) => provider);
}

export function migrateProviderUsagePreferences<T extends ProviderUsageEntry>(providers: T[], preferences: ProviderUsagePreferences): ProviderUsagePreferences {
  let next = preferences;
  for (const provider of providers) {
    const hidden = Object.hasOwn(preferences.hiddenFields, provider.provider) ? preferences.hiddenFields[provider.provider] : undefined;
    const compact = preferences.compactFields && Object.hasOwn(preferences.compactFields, provider.provider)
      ? preferences.compactFields[provider.provider] : undefined;
    if (!hidden && compact === undefined) continue;
    const resolvers = Object.fromEntries(FIELD_GROUPS.map((group) => {
      const fields = provider[group] ?? [];
      const canonicalIds = new Set(fields.map((field) => field.id));
      const aliases = new Map<string, Set<string>>();
      for (const field of fields) for (const alias of field.legacyIds ?? []) {
        const targets = aliases.get(alias) ?? new Set<string>();
        targets.add(field.id);
        aliases.set(alias, targets);
      }
      return [group, (id: string): string => {
        const targets = aliases.get(id);
        return !canonicalIds.has(id) && targets?.size === 1 ? [...targets][0] : id;
      }];
    })) as Record<ProviderUsageFieldGroup, (id: string) => string>;
    if (hidden) {
      const groups = Object.fromEntries(FIELD_GROUPS.map((group) => [group, [...new Set(hidden[group].map(resolvers[group]))]])) as typeof hidden;
      if (FIELD_GROUPS.some((group) => groups[group].some((id, index) => id !== hidden[group][index]) || groups[group].length !== hidden[group].length)) {
        next = { ...next, hiddenFields: { ...next.hiddenFields, [provider.provider]: groups } };
      }
    }
    if (compact !== undefined) {
      const migrated = normalizeCompactFields(compact.map(({ group, id }) => ({ group, id: resolvers[group](id) })));
      if (migrated.length !== compact.length || migrated.some((field, index) => field.id !== compact[index].id || field.group !== compact[index].group)) {
        next = { ...next, compactFields: { ...next.compactFields, [provider.provider]: migrated } };
      }
    }
  }
  return next;
}

export function applyProviderUsagePreferences<T extends ProviderUsageEntry>(
  providers: T[],
  preferences: ProviderUsagePreferences,
): T[] {
  preferences = migrateProviderUsagePreferences(providers, preferences);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  return orderProviderUsage(providers, preferences)
    .filter((provider) => !hiddenProviders.has(provider.provider))
    .map((provider) => {
      const hidden = preferences.hiddenFields[provider.provider];
      if (!hidden) return provider;
      return {
        ...provider,
        windows: provider.windows?.filter(({ id }) => !hidden.windows.includes(id)),
        balances: provider.balances?.filter(({ id }) => !hidden.balances.includes(id)),
        metrics: provider.metrics?.filter(({ id }) => !hidden.metrics.includes(id)),
      };
    });
}

export function getProviderUsageCatalogRows<T extends ProviderUsageCatalogEntry>(
  catalog: T[],
  draftSelection: string[],
  preferences: ProviderUsagePreferences,
): ProviderUsageCatalogRow[] {
  const selected = new Set(draftSelection);
  const order = new Map(preferences.providerOrder.map((provider, index) => [provider, index]));
  const seen = new Set<string>();
  return catalog
    .map((provider, index) => ({ provider, index }))
    .filter(({ provider }) => {
      if (!provider.provider || seen.has(provider.provider)) return false;
      seen.add(provider.provider);
      return true;
    })
    .sort((a, b) => {
      const aSelected = selected.has(a.provider.provider);
      const bSelected = selected.has(b.provider.provider);
      const aReady = a.provider.selectable && a.provider.enabled;
      const bReady = b.provider.selectable && b.provider.enabled;
      const aGroup = aSelected ? 0 : aReady ? 1 : 2;
      const bGroup = bSelected ? 0 : bReady ? 1 : 2;
      if (aGroup !== bGroup) return aGroup - bGroup;
      if (aGroup === 0) {
        return (order.get(a.provider.provider) ?? Number.MAX_SAFE_INTEGER)
          - (order.get(b.provider.provider) ?? Number.MAX_SAFE_INTEGER)
          || a.index - b.index;
      }
      return a.index - b.index;
    })
    .map(({ provider }) => {
      const collectUsage = selected.has(provider.provider);
      return {
        provider: provider.provider,
        displayName: provider.displayName,
        collectUsage,
        showCard: !preferences.hiddenProviders.includes(provider.provider),
        showCardDisabled: !collectUsage,
        canReorder: collectUsage && selected.size > 1,
      };
    });
}

export function getProviderUsageGridColumns(
  providerCount: number,
  columns: ProviderUsagePreferences['columns'],
): ProviderUsagePreferences['columns'] {
  return Math.max(1, Math.min(providerCount, columns)) as ProviderUsagePreferences['columns'];
}

export function hasProviderUsageSelectionChanges(draft: string[], saved: string[]): boolean {
  const draftSet = new Set(draft);
  const savedSet = new Set(saved);
  return draftSet.size !== savedSet.size || [...draftSet].some((provider) => !savedSet.has(provider));
}

export function getProviderUsageSelectionForDisplay<T extends ProviderUsageEntry>(
  providers: T[],
  selectedProviders: string[] | null,
  catalogAvailable = true,
): string[] {
  return catalogAvailable && selectedProviders !== null
    ? selectedProviders
    : providers.map(({ provider }) => provider);
}

export function getVisibleProviderUsageCards<T extends ProviderUsageEntry>(
  providers: T[],
  selectedProviders: string[],
  preferences: ProviderUsagePreferences,
): T[] {
  const selected = new Set(selectedProviders);
  return applyProviderUsagePreferences(
    providers.filter((provider) => selected.has(provider.provider)),
    preferences,
  );
}

export function moveProviderUsagePreference(
  orderedProviderIds: string[],
  provider: string,
  direction: -1 | 1,
): string[] {
  const currentIndex = orderedProviderIds.indexOf(provider);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= orderedProviderIds.length) return orderedProviderIds;
  const next = [...orderedProviderIds];
  [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
  return next;
}

export function setProviderUsageProviderVisible(
  preferences: ProviderUsagePreferences,
  provider: string,
  visible: boolean,
): ProviderUsagePreferences {
  const hiddenProviders = visible
    ? preferences.hiddenProviders.filter((item) => item !== provider)
    : [...new Set([...preferences.hiddenProviders, provider])];
  return { ...preferences, hiddenProviders };
}

export function setProviderUsageCompactFields(
  preferences: ProviderUsagePreferences,
  providerId: string,
  fields: ProviderUsageFieldRef[] | null,
): ProviderUsagePreferences {
  const entries = Object.entries(preferences.compactFields ?? {}).filter(([provider]) => provider !== providerId);
  if (fields !== null) entries.push([providerId, normalizeCompactFields(fields)]);
  return { ...preferences, compactFields: Object.fromEntries(entries) };
}

export function setProviderUsageFieldVisible(
  preferences: ProviderUsagePreferences,
  provider: string,
  group: ProviderUsageFieldGroup,
  field: string,
  visible: boolean,
): ProviderUsagePreferences {
  const existing = preferences.hiddenFields[provider] ?? { windows: [], balances: [], metrics: [] };
  const hiddenFields = visible
    ? existing[group].filter((item) => item !== field)
    : [...new Set([...existing[group], field])];
  return {
    ...preferences,
    hiddenFields: {
      ...preferences.hiddenFields,
      [provider]: { ...existing, [group]: hiddenFields },
    },
  };
}
