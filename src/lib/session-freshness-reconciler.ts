export interface FreshnessObservation {
  stale: boolean;
  refreshError: string | null;
  scopeKey: string;
}

export function createSessionFreshnessReconciler(init: {
  refresh: () => Promise<void>;
  isAllowed: () => boolean;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  delays?: readonly number[];
}) {
  const delays = init.delays ?? [500, 1000, 2000, 4000];
  const schedule = init.schedule ?? ((callback, delay) => window.setTimeout(callback, delay));
  const cancelSchedule = init.cancelSchedule ?? ((handle) => window.clearTimeout(handle as number));
  let observation: FreshnessObservation = { stale: false, refreshError: null, scopeKey: '' };
  let attempts = 0;
  let timer: unknown;
  let pending = false;
  let generation = 0;

  const clearTimer = () => {
    if (timer !== undefined) cancelSchedule(timer);
    timer = undefined;
  };
  const queue = () => {
    if (timer !== undefined || pending || attempts >= delays.length) return;
    if (!observation.stale || observation.refreshError || !init.isAllowed()) return;
    const ownGeneration = generation;
    timer = schedule(() => {
      timer = undefined;
      if (ownGeneration !== generation || !init.isAllowed() || !observation.stale || observation.refreshError) return;
      attempts++;
      pending = true;
      void init.refresh().then(() => {
        pending = false;
        queue();
      }, () => {
        pending = false;
      });
    }, delays[attempts]);
  };

  return {
    observe(next: FreshnessObservation) {
      if (next.scopeKey !== observation.scopeKey) {
        generation++;
        attempts = 0;
        clearTimer();
      }
      observation = next;
      if (!next.stale || next.refreshError) {
        clearTimer();
        if (!next.stale) attempts = 0;
        return;
      }
      queue();
    },
    cancel() {
      generation++;
      attempts = 0;
      observation = { stale: false, refreshError: null, scopeKey: '' };
      clearTimer();
    },
  };
}
