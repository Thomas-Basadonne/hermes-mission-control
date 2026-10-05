export function preserveLastAvailableSnapshot<T extends { available: boolean; refreshing?: boolean }>(
  current: T | null,
  next: T,
): T {
  if (next.available || !current?.available) return next;
  return { ...current, refreshing: next.refreshing };
}

export function canCustomizeProviderUsageCatalog(
  catalog: { available: boolean } | null,
  loading: boolean,
): boolean {
  return !loading && catalog?.available === true;
}

export function createSerializedRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
  onLoading: (loading: boolean) => void,
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
      } finally {
        inFlight = false;
        if (!cancelled) onLoading(false);
      }
    },
    cancel(): void {
      cancelled = true;
      controller.abort();
    },
  };
}
