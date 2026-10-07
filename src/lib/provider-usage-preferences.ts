export const PROVIDER_USAGE_PREFERENCES_KEY = 'mission-control-provider-usage-preferences:v1';

export type ProviderUsageFieldGroup = 'windows' | 'balances' | 'metrics';
export type FieldVisibility = 'both' | 'detailed' | 'hidden';
export type ProviderUsageView = 'compact' | 'detailed';
export type ProviderUsagePreferences = {
  hiddenProviders: string[];
  fieldVisibility?: Record<string, Record<string, FieldVisibility>>;
  // Legacy fieldVisibility keys are literal IDs; never parse their colons as namespaces.
  groupFieldVisibility?: Record<string, Partial<Record<ProviderUsageFieldGroup, Record<string, FieldVisibility>>>>;
  hiddenFields?: Record<string, Partial<Record<ProviderUsageFieldGroup, string[]>>>;
  compactFields?: Record<string, Array<{ group: ProviderUsageFieldGroup; id: string }>>;
  providerOrder: string[];
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
  providerOrder: [],
  view: 'compact',
};

const FIELD_GROUPS: ProviderUsageFieldGroup[] = ['windows', 'balances', 'metrics'];

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecord<T>(value: unknown, normalize: (item: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = normalize(item);
    return normalized === undefined ? [] : [[key, normalized]];
  }));
}

function normalizeVisibility(value: unknown): FieldVisibility | undefined {
  return value === 'both' || value === 'detailed' || value === 'hidden' ? value : undefined;
}

function normalizeGroupedVisibility(value: unknown): Partial<Record<ProviderUsageFieldGroup, Record<string, FieldVisibility>>> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(FIELD_GROUPS.flatMap((group) => {
    const fields = normalizeRecord(value[group], normalizeVisibility);
    return fields === undefined ? [] : [[group, fields]];
  }));
}

function normalizeHiddenFields(value: unknown): Partial<Record<ProviderUsageFieldGroup, string[]>> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(FIELD_GROUPS.flatMap((group) =>
    Array.isArray(value[group]) ? [[group, uniqueStrings(value[group])]] : []));
}

function normalizeCompactFields(value: unknown): Array<{ group: ProviderUsageFieldGroup; id: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((ref) => {
    if (!isRecord(ref) || typeof ref.id !== 'string' || !ref.id) return [];
    const group = FIELD_GROUPS.find((group) => group === ref.group);
    return group ? [{ group, id: ref.id }] : [];
  });
}

function browserStorage(): ProviderUsageStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeProviderUsagePreferences(value: unknown): ProviderUsagePreferences {
  if (!isRecord(value)) {
    return { ...DEFAULT_PROVIDER_USAGE_PREFERENCES };
  }

  const candidate = value;
  const hiddenFields = normalizeRecord(candidate.hiddenFields, normalizeHiddenFields);
  const compactFields = normalizeRecord(candidate.compactFields, normalizeCompactFields);
  const fieldVisibility = normalizeRecord(candidate.fieldVisibility, (fields) => normalizeRecord(fields, normalizeVisibility));
  const groupFieldVisibility = normalizeRecord(candidate.groupFieldVisibility, normalizeGroupedVisibility);
  return {
    hiddenProviders: uniqueStrings(candidate.hiddenProviders),
    ...(hiddenFields !== undefined ? { hiddenFields } : {}),
    ...(compactFields !== undefined ? { compactFields } : {}),
    ...(fieldVisibility !== undefined ? { fieldVisibility } : {}),
    ...(groupFieldVisibility !== undefined ? { groupFieldVisibility } : {}),
    providerOrder: uniqueStrings(candidate.providerOrder),
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

export function getFieldVisibility(
  preferences: Pick<ProviderUsagePreferences, 'fieldVisibility' | 'groupFieldVisibility'>,
  provider: string,
  group: ProviderUsageFieldGroup,
  fieldId: string,
): FieldVisibility {
  return preferences.groupFieldVisibility?.[provider]?.[group]?.[fieldId]
    ?? preferences.fieldVisibility?.[provider]?.[fieldId] ?? 'both';
}

export function setFieldVisibility(
  preferences: ProviderUsagePreferences,
  provider: string,
  group: ProviderUsageFieldGroup,
  fieldId: string,
  visibility: FieldVisibility,
): ProviderUsagePreferences {
  const existing = preferences.groupFieldVisibility?.[provider] ?? {};
  return {
    ...preferences,
    groupFieldVisibility: {
      ...preferences.groupFieldVisibility,
      [provider]: { ...existing, [group]: { ...existing[group], [fieldId]: visibility } },
    },
  };
}

export function migrateFieldVisibility<T extends ProviderUsageEntry>(
  providers: T[],
  preferences: ProviderUsagePreferences,
): ProviderUsagePreferences {
  const groupFieldVisibility = { ...preferences.groupFieldVisibility };
  for (const provider of providers) {
    const visibility = { ...groupFieldVisibility[provider.provider] };
    const legacy = preferences.fieldVisibility?.[provider.provider];
    const compact = preferences.compactFields?.[provider.provider];
    const hidden = preferences.hiddenFields?.[provider.provider];
    for (const group of FIELD_GROUPS) {
      const fields = { ...visibility[group] };
      for (const field of provider[group] ?? []) {
        const ids = [field.id, ...(field.legacyIds ?? [])];
        fields[field.id] ??= ids.map((id) => visibility[group]?.[id] ?? legacy?.[id]).find((value) => value !== undefined)
          ?? (hidden?.[group]?.some((id) => ids.includes(id)) ? 'hidden'
            : compact && !compact.some((ref) => ref.group === group && ids.includes(ref.id)) ? 'detailed' : 'both');
      }
      visibility[group] = fields;
    }
    groupFieldVisibility[provider.provider] = visibility;
  }
  return { ...preferences, groupFieldVisibility };
}

export function applyProviderUsagePreferences<T extends ProviderUsageEntry>(
  providers: T[],
  preferences: ProviderUsagePreferences,
): T[] {
  preferences = migrateFieldVisibility(providers, preferences);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  return orderProviderUsage(providers, preferences)
    .filter((provider) => !hiddenProviders.has(provider.provider))
    .map((provider) => {
      return {
        ...provider,
        windows: provider.windows?.filter(({ id }) => getFieldVisibility(preferences, provider.provider, 'windows', id) !== 'hidden'),
        balances: provider.balances?.filter(({ id }) => getFieldVisibility(preferences, provider.provider, 'balances', id) !== 'hidden'),
        metrics: provider.metrics?.filter(({ id }) => getFieldVisibility(preferences, provider.provider, 'metrics', id) !== 'hidden'),
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
