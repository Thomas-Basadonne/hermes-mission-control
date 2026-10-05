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
