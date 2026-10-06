export class ProviderUsageHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Provider usage request failed (HTTP ${status})`); this.name = 'ProviderUsageHttpError'; this.status = status;
  }
}

export class ProviderUsageTimeoutError extends Error {
  constructor() { super('Provider usage request timed out'); this.name = 'ProviderUsageTimeoutError'; }
}

export async function withProviderUsageDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  let rejectStop: (reason: unknown) => void = () => undefined;
  const stop = new Promise<never>((_, reject) => { rejectStop = reject; });
  const abort = () => {
    const reason = caller?.reason ?? new DOMException('Request cancelled', 'AbortError');
    controller.abort(reason); rejectStop(reason);
  };
  if (caller?.aborted) throw caller.reason ?? new DOMException('Request cancelled', 'AbortError');
  caller?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const reason = new ProviderUsageTimeoutError();
    controller.abort(reason); rejectStop(reason);
  }, timeoutMs);
  try { return await Promise.race([operation(controller.signal), stop]); }
  finally { clearTimeout(timer); caller?.removeEventListener('abort', abort); }
}
