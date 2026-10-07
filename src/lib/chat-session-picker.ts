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
  error: string | null;
}

export function createSessionPickerController(init: {
  loadService: (options: LoadOptions) => Promise<MissionControlAgentsSessionsSnapshot>;
  storedToken: string;
}) {
  let state: SessionPickerState = {
    items: [], pagination: { total: 0, offset: 0, limit: 25, hasMore: false },
    stats: { totalSessions: 0, liveSessions: 0, activeAgents: 0 },
    facets: { status: { live: 0, idle: 0, ended: 0 }, category: {conversation:0,automation:0,system:0,unknown:0}, origin: {}, model: {} },
    query: '', profile: null, origin: null, status: 'live', loading: false, error: null,
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
    update({ ...state, [key]: value, items: [], pagination: { ...state.pagination, total: 0, offset: 0, hasMore: false }, loading: false, error: null });
  };
  const load = (): Promise<void> => {
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
    update({ ...state, loading: true, error: null });
    request.promise = (async () => {
      try {
        const payload = await init.loadService(options);
        if (generation !== request.generation || options.signal.aborted) return;
        if (!payload.available || !payload.success) throw new Error('Session list unavailable.');
        // A deletion can empty the last page between polls. Return to its predecessor.
        if (payload.items.length === 0 && payload.pagination.total > 0 && options.offset >= payload.pagination.total) {
          active = null;
          update({ ...state, pagination: { ...payload.pagination, offset: Math.floor((payload.pagination.total - 1) / options.limit) * options.limit }, loading: false });
          await load();
          return;
        }
        update({ ...state, items: payload.items, pagination: payload.pagination, stats: payload.stats, facets: payload.facets, loading: false, error: null });
      } catch (error) {
        if (generation === request.generation && !options.signal.aborted) update({ ...state, loading: false, error: error instanceof Error ? error.message : 'Unable to load sessions.' });
      } finally {
        if (active === request) active = null;
      }
    })();
    return request.promise;
  };
  const page = (offset: number) => {
    if (state.loading) return Promise.resolve();
    invalidate();
    update({ ...state, items: [], pagination: { ...state.pagination, offset }, error: null });
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
