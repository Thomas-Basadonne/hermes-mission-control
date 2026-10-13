import type { MissionControlAgentSessionItem, MissionControlAgentSessionStatus, MissionControlAgentsSessionsSnapshot, MissionControlAgentSessionFilters } from './hermes-api';

export interface LoadOptions {
  accessToken: string;
  limit: number;
  offset: number;
  filters: MissionControlAgentSessionFilters;
  profile: string | null;
  includeRecentMessages: false;
  signal: AbortSignal;
}

export interface SessionPickerState {
  items: MissionControlAgentSessionItem[];
  pagination: MissionControlAgentsSessionsSnapshot['pagination'];
  stats: MissionControlAgentsSessionsSnapshot['stats'];
  facets: MissionControlAgentsSessionsSnapshot['facets'];
  query: string;
  profile: string | null;
  origin: string | null;
  status: MissionControlAgentSessionStatus | null;
  loading: boolean;
  stale: boolean;
  refreshError: string | null;
  error: string | null;
}

type RetryableError = Error & { status?: number; retryAfterMs?: number | null };

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const MAX_RETRY_AFTER_MS = 30_000;

export function createSessionPickerController(init: {
  loadService: (options: LoadOptions) => Promise<MissionControlAgentsSessionsSnapshot>;
  storedToken: string;
}) {
  let state: SessionPickerState = {
    items: [], pagination: { total: 0, offset: 0, limit: 25, hasMore: false },
    stats: { totalSessions: 0, liveSessions: 0, activeAgents: 0 },
    facets: { status: { live: 0, idle: 0, ended: 0 }, category: {conversation:0,automation:0,system:0,unknown:0}, origin: {}, model: {} },
    query: '', profile: null, origin: null, status: 'live', loading: false, stale: false, refreshError: null, error: null,
  };
  let generation = 0;
  let active: { generation: number; controller: AbortController; promise?: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  const update = (next: SessionPickerState) => { state = next; listeners.forEach(listener => listener()); };
  const invalidate = () => {
    generation++;
    active?.controller.abort();
    active = null;
  };
  const changeFilter = <K extends 'query' | 'profile' | 'origin' | 'status'>(key: K, value: SessionPickerState[K]) => {
    if (state[key] === value) return;
    invalidate();
    update({ ...state, [key]: value, items: [], pagination: { ...state.pagination, total: 0, offset: 0, hasMore: false }, loading: false, stale: false, refreshError: null, error: null });
  };
  const load = (loadOptions: { silent?: boolean } = {}): Promise<void> => {
    if (active) return active.promise ?? Promise.resolve();
    const request = { generation: ++generation, controller: new AbortController(), promise: undefined as Promise<void> | undefined };
    active = request;
    const filters: MissionControlAgentSessionFilters = {};
    if (state.query.trim()) filters.query = state.query.trim();
    if (state.origin) filters.origin = state.origin;
    if (state.status) filters.status = state.status;
    const options: LoadOptions = {
      accessToken: init.storedToken, limit: state.pagination.limit, offset: state.pagination.offset,
      profile: state.profile, filters, includeRecentMessages: false, signal: request.controller.signal,
    };
    if (!loadOptions.silent) update({ ...state, loading: true, stale: state.items.length > 0, refreshError: null, error: null });
    request.promise = (async () => {
      try {
        let payload: MissionControlAgentsSessionsSnapshot | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            payload = await init.loadService(options);
            break;
          } catch (error) {
            const retryable = error as RetryableError;
            if (retryable.status !== 503 || attempt === 2 || options.signal.aborted) throw error;
            await abortableDelay(Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryable.retryAfterMs ?? 250)), options.signal);
          }
        }
        if (!payload) throw new Error('Session list unavailable.');
        if (generation !== request.generation || options.signal.aborted) return;
        if (!payload.available || !payload.success) throw new Error('Session list unavailable.');
        // A deletion can empty the last page between polls. Return to its predecessor.
        if (payload.items.length === 0 && payload.pagination.total > 0 && options.offset >= payload.pagination.total) {
          active = null;
          update({ ...state, pagination: { ...payload.pagination, offset: Math.floor((payload.pagination.total - 1) / options.limit) * options.limit }, loading: false, stale: false, refreshError: null });
          await load();
          return;
        }
        update({ ...state, items: payload.items, pagination: payload.pagination, stats: payload.stats, facets: payload.facets, loading: false, stale: payload.catalogFreshness.state === 'stale', refreshError: payload.catalogFreshness.refreshError, error: null });
      } catch (error) {
        if (generation === request.generation && !options.signal.aborted) update({ ...state, loading: false, stale: state.items.length > 0, error: error instanceof Error ? error.message : 'Unable to load sessions.' });
      } finally {
        if (active === request) active = null;
      }
    })();
    return request.promise;
  };
  const page = (offset: number) => {
    if (state.loading) return Promise.resolve();
    invalidate();
    update({ ...state, items: [], pagination: { ...state.pagination, offset }, stale: false, refreshError: null, error: null });
    return load();
  };
  return {
    get state() { return state; },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setQuery(query: string) { changeFilter('query', query); },
    setProfile(profile: string | null) { changeFilter('profile', profile); },
    setOrigin(origin: string | null) { changeFilter('origin', origin); },
    setStatus(status: MissionControlAgentSessionStatus | null) { changeFilter('status', status); },
    load,
    loadNext: () => state.pagination.hasMore ? page(state.pagination.offset + state.pagination.limit) : Promise.resolve(),
    loadPrev: () => state.pagination.offset > 0 ? page(Math.max(0, state.pagination.offset - state.pagination.limit)) : Promise.resolve(),
    select: (index: number) => state.items[index]?.isResumable ? state.items[index].sessionId : null,
    close() { invalidate(); update({ ...state, loading: false }); },
  };
}
