import type { MissionControlProviderUsageSnapshot } from './hermes-api';

export function mergeProviderUsageSnapshot(
  current: MissionControlProviderUsageSnapshot | null,
  next: MissionControlProviderUsageSnapshot,
): MissionControlProviderUsageSnapshot {
  if (!current) return next;
  if (!next.available && !next.providers.length) return { ...current, refreshing: next.refreshing, error: next.error, warnings: next.warnings };
  const previous = new Map(current.providers.map((provider) => [provider.provider, provider]));
  return { ...next, providers: next.providers.map((provider) => {
    const good = previous.get(provider.provider);
    const malformed = provider.warnings?.some((warning) => warning === 'invalid_field' || warning === 'invalid_provider') === true;
    if (!good?.available || (provider.dataState === 'no_data' && !malformed && !provider.malformedFields) || (provider.available && !provider.malformedFields)) return provider;
    if (provider.available) {
      const mergeFields = <T extends { id: string }>(group: 'windows' | 'balances' | 'metrics', fields: T[], previousFields: T[]): T[] => {
        const invalid = provider.malformedFields?.[group];
        if (!invalid?.length) return fields;
        const currentIds = new Set(fields.map((field) => field.id));
        // Fresh valid fields win; only damaged/missing fields borrow last-good values.
        return [...fields, ...previousFields.filter((field) => !currentIds.has(field.id) && (invalid.includes('*') || invalid.includes(field.id)))];
      };
      return { ...provider, stale: true, refreshState: 'failed',
        windows: mergeFields('windows', provider.windows, good.windows),
        balances: mergeFields('balances', provider.balances, good.balances),
        metrics: mergeFields('metrics', provider.metrics, good.metrics) };
    }
    return { ...good, stale: true, dataState: 'ready', refreshState: 'failed',
      error: provider.error ?? (malformed ? 'Some provider usage fields are malformed; showing the last successful data.' : undefined), warnings: provider.warnings, lastAttemptAt: provider.lastAttemptAt,
      nextRetryAt: provider.nextRetryAt };
  }) };
}

export function preserveLastAvailableSnapshot<T extends { available: boolean; refreshing?: boolean }>(
  current: T | null,
  next: T,
): T {
  if (next.available || !current?.available) return next;
  return { ...current, refreshing: next.refreshing };
}

export function canCustomizeProviderUsageCatalog(
  catalog: { available: boolean } | null,
  _loading: boolean,
): boolean {
  return catalog?.available === true;
}

export function getProviderUsageCatalogPollDelay(catalog: { refreshing?: boolean }): number {
  return catalog.refreshing ? 1_500 : 60_000;
}

export function createProviderUsageRetry() {
  let failures = 0;
  const delays = [5_000, 15_000, 30_000, 60_000];
  return { failure: () => delays[Math.min(failures++, delays.length - 1)], success: () => { failures = 0; } };
}

export function createSerializedRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
  onLoading: (loading: boolean) => void,
  onError: (error: unknown) => void = () => undefined,
) {
  const controller = new AbortController();
  let inFlight = false;
  let cancelled = false;

  return {
    async run(): Promise<void> {
      if (cancelled || inFlight) return;
      inFlight = true;
      onLoading(true);
      try {
        const value = await load(controller.signal);
        if (!cancelled) onValue(value);
      } catch (error) {
        if (!cancelled) onError(error);
      } finally {
        inFlight = false;
        if (!cancelled) onLoading(false);
      }
    },
    cancel(): void {
      cancelled = true;
      controller.abort();
      if (inFlight) onLoading(false);
    },
  };
}
