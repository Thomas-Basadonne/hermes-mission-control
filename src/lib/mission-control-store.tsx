import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getFallbackConfig,
  getFallbackSkills,
  getFallbackSnapshot,
  getFallbackTools,
  loadMissionControlAlerts,
  loadMissionControlConfig,
  loadMissionControlMachineStatus,
  loadMissionControlCron,
  loadMissionControlSessions,
  loadMissionControlSkills,
  loadMissionControlSnapshot,
  loadMissionControlTools,
  saveMissionControlConfig,
  MissionControlAuthError,
  MISSION_CONTROL_TOKEN_STORAGE_KEY,
  type MissionControlConfigSnapshot,
  type MissionControlSessionsSnapshot,
  type MissionControlSkillsSnapshot,
  type MissionControlSnapshot,
  type MissionControlToolsSnapshot,
} from './hermes-api';
import { recordReloadDiagnostic } from './reload-diagnostics';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export type MissionControlGatewayAction = {
  id: 'refresh' | 'reload-config' | 'restart-gateway' | 'probe-health';
  label: string;
  hint: string;
  endpoint: string;
  method: 'GET' | 'POST';
};

type MissionControlActionResult = {
  label: string;
  endpoint: string;
  payload: string;
};

export type MissionControlSourceStatus = {
  state: 'loading' | 'live' | 'fallback' | 'error';
  source: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
};

export type MissionControlSourceName = 'machine' | 'sessions' | 'cron' | 'alerts' | 'snapshot' | 'tools' | 'skills';
export type MissionControlSources = Partial<Record<MissionControlSourceName, MissionControlSourceStatus>>;

type MissionControlContextValue = {
  snapshot: MissionControlSnapshot;
  tools: MissionControlToolsSnapshot;
  skills: MissionControlSkillsSnapshot;
  config: MissionControlConfigSnapshot;
  loading: boolean;
  authRequired: boolean;
  authError: string | null;
  storedToken: string;
  tokenDraft: string;
  setTokenDraft: (value: string) => void;
  refreshAll: (token?: string, options?: { silent?: boolean; includeReference?: boolean; includeSnapshot?: boolean; includeSessions?: boolean; includeCron?: boolean }) => Promise<void>;
  /** Reload only the Tools catalog (pull-to-refresh). Resolves with the outcome; never rejects. */
  refreshTools: () => Promise<{ ok: boolean; error: string | null }>;
  unlock: (token: string) => Promise<void>;
  logout: () => void;
  actionResult: MissionControlActionResult | null;
  actionLoading: string | null;
  gatewayActions: MissionControlGatewayAction[];
  runGatewayAction: (action: MissionControlGatewayAction) => Promise<void>;
  reloadConfig: () => Promise<MissionControlConfigSnapshot>;
  saveConfig: (content: string, expectedHash?: string | null) => Promise<MissionControlConfigSnapshot>;
  linkStatus: string | null;
  setLinkStatus: (value: string | null) => void;
  lastUpdatedAt: string | null;
  /** Per-endpoint freshness and provenance; missing entries have not been requested. */
  sources: MissionControlSources;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  resolvedTheme: ResolvedTheme;
};

const MissionControlContext = createContext<MissionControlContextValue | null>(null);

function readStoredValue(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function persistStoredValue(key: string, value: string) {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures; browsers are allowed to be dramatic.
  }
}

function getApiBaseUrl() {
  return import.meta.env.VITE_MISSION_CONTROL_LOCAL_API_BASE_URL || '/api/local';
}

function buildHeaders(token?: string) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function resolveTheme(theme: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  return theme === 'system' ? systemTheme : theme;
}

function readJsonPayload<T>(payload: unknown): T {
  if (typeof payload === 'string') {
    return JSON.parse(payload) as T;
  }
  return payload as T;
}

export function MissionControlProvider({ children }: { children: ReactNode }) {
  const envToken = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_MISSION_CONTROL_TOKEN) || '';
  const initialToken = typeof window === 'undefined' ? '' : readStoredValue(MISSION_CONTROL_TOKEN_STORAGE_KEY, envToken);
  const initialTheme = typeof window === 'undefined' ? 'system' : (readStoredValue('mission-control-theme', 'system') as ThemeMode);

  const [snapshot, setSnapshot] = useState<MissionControlSnapshot>(getFallbackSnapshot());
  const [tools, setTools] = useState<MissionControlToolsSnapshot>(getFallbackTools());
  const [skills, setSkills] = useState<MissionControlSkillsSnapshot>(getFallbackSkills());
  const [config, setConfig] = useState<MissionControlConfigSnapshot>(getFallbackConfig());
  const configRequestIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [storedToken, setStoredToken] = useState(initialToken);
  const [tokenDraft, setTokenDraft] = useState(initialToken);
  const [actionResult, setActionResult] = useState<MissionControlActionResult | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [sources, setSources] = useState<MissionControlSources>({});
  const refreshSequence = useRef(0);
  const sourceSequences = useRef<Partial<Record<MissionControlSourceName, number>>>({});
  const referenceSequence = useRef(0);
  // Shared by refreshReferenceData and refreshTools so an older poll cannot
  // overwrite a newer targeted Tools refresh (and vice versa).
  const toolsSequence = useRef(0);
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    recordReloadDiagnostic('mission-control-provider-mounted');
    return () => recordReloadDiagnostic('mission-control-provider-unmounted');
  }, []);

  const gatewayActions = useMemo<MissionControlGatewayAction[]>(
    () => [
      { id: 'refresh', label: 'Refresh snapshot', hint: 'Reload all live Mission Control data.', endpoint: '/status', method: 'GET' },
      { id: 'reload-config', label: 'Reload config', hint: 'Re-read config.yaml from disk.', endpoint: '/config', method: 'GET' },
      { id: 'probe-health', label: 'Probe gateway', hint: 'Hit /api/local/status to verify the telemetry backend.', endpoint: '/status', method: 'GET' },
      { id: 'restart-gateway', label: 'Restart gateway', hint: 'Request a safe process restart.', endpoint: '/gateway/restart', method: 'POST' },
    ],
    [],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setSystemTheme(media.matches ? 'dark' : 'light');
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    persistStoredValue('mission-control-theme', theme);
  }, [theme]);

  const resolvedTheme = useMemo(() => resolveTheme(theme, systemTheme), [systemTheme, theme]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const refreshConfig = useCallback(async (token?: string) => {
    const requestId = ++configRequestIdRef.current;
    const updated = await loadMissionControlConfig(token);
    if (requestId === configRequestIdRef.current) setConfig(updated);
    return updated;
  }, []);

  const refreshReferenceData = useCallback(async (token?: string) => {
    const requestId = ++referenceSequence.current;
    const toolsRequestId = ++toolsSequence.current;
    const attemptedAt = new Date().toISOString();
    setSources((previous) => ({
      ...previous,
      tools: { state: 'loading', source: previous.tools?.source ?? null, lastAttemptAt: attemptedAt, lastSuccessAt: previous.tools?.lastSuccessAt ?? null, error: null },
      skills: { state: 'loading', source: previous.skills?.source ?? null, lastAttemptAt: attemptedAt, lastSuccessAt: previous.skills?.lastSuccessAt ?? null, error: null },
    }));
    const [toolsRes, skillsRes] = await Promise.allSettled([
      loadMissionControlTools(token),
      loadMissionControlSkills(token),
    ]);

    const recordReference = (name: 'tools' | 'skills', result: PromiseSettledResult<MissionControlToolsSnapshot | MissionControlSkillsSnapshot>) => {
      if (referenceSequence.current !== requestId) return;
      if (name === 'tools' && toolsSequence.current !== toolsRequestId) return;
      const completedAt = new Date().toISOString();
      setSources((previous) => {
        const old = previous[name];
        const dataSource = result.status === 'fulfilled' ? result.value.dataSource ?? 'fallback' : null;
        const dataError = result.status === 'fulfilled' ? result.value.dataError : undefined;
        const fallback = dataSource === 'fallback';
        return { ...previous, [name]: {
          state: result.status === 'rejected' || dataError ? 'error' : fallback ? 'fallback' : 'live',
          source: dataSource,
          lastAttemptAt: attemptedAt,
          lastSuccessAt: result.status === 'fulfilled' && !fallback && !dataError ? completedAt : old?.lastSuccessAt ?? null,
          error: dataError ?? (result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : 'Request failed') : null),
        } };
      });
    };
    recordReference('tools', toolsRes);
    recordReference('skills', skillsRes);

    if (toolsRes.status === 'fulfilled') {
      const nextTools = toolsRes.value;
      if (nextTools.dataSource !== 'fallback' && referenceSequence.current === requestId && toolsSequence.current === toolsRequestId) setTools(nextTools);
    }

    if (skillsRes.status === 'fulfilled') {
      const nextSkills = skillsRes.value;
      if (nextSkills.dataSource !== 'fallback' && referenceSequence.current === requestId) setSkills(nextSkills);
    }
  }, []);

  const refreshTools = useCallback(async (): Promise<{ ok: boolean; error: string | null }> => {
    const requestId = ++toolsSequence.current;
    const attemptedAt = new Date().toISOString();
    setSources((previous) => ({
      ...previous,
      tools: { state: 'loading', source: previous.tools?.source ?? null, lastAttemptAt: attemptedAt, lastSuccessAt: previous.tools?.lastSuccessAt ?? null, error: null },
    }));
    let next: MissionControlToolsSnapshot | null = null;
    let error: string | null = null;
    try {
      next = await loadMissionControlTools(storedToken || undefined);
      error = next.dataError ?? null;
    } catch (failure) {
      error = failure instanceof MissionControlAuthError
        ? 'Authentication required.'
        : failure instanceof Error ? failure.message : 'Request failed';
    }
    if (toolsSequence.current !== requestId) return { ok: error === null, error };
    const fallback = next?.dataSource === 'fallback';
    const completedAt = new Date().toISOString();
    setSources((previous) => ({
      ...previous,
      tools: {
        state: error ? 'error' : fallback ? 'fallback' : 'live',
        source: next?.dataSource ?? null,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: !error && !fallback ? completedAt : previous.tools?.lastSuccessAt ?? null,
        error,
      },
    }));
    // Same rule as the reference poll: never replace live data with fallback.
    if (next && !fallback && !error) setTools(next);
    return { ok: error === null, error };
  }, [storedToken]);

  const refreshAll = useCallback(async (token?: string, options?: { silent?: boolean; includeReference?: boolean; includeSnapshot?: boolean; includeSessions?: boolean; includeCron?: boolean }) => {
    const silent = options?.silent ?? false;
    const includeReference = options?.includeReference ?? true;
    const includeSnapshot = options?.includeSnapshot ?? !silent;
    const includeSessions = options?.includeSessions ?? !silent;
    const includeCron = options?.includeCron ?? true;
    const refreshId = ++refreshSequence.current;
    const attemptedAt = new Date().toISOString();
    const sourceNames: MissionControlSourceName[] = ['machine', 'alerts'];
    if (includeSessions) sourceNames.push('sessions');
    if (includeCron) sourceNames.push('cron');
    if (includeSnapshot) sourceNames.push('snapshot');
    const sourceRequestIds = Object.fromEntries(sourceNames.map((name) => {
      const requestId = (sourceSequences.current[name] ?? 0) + 1;
      sourceSequences.current[name] = requestId;
      return [name, requestId];
    })) as Partial<Record<MissionControlSourceName, number>>;

    setSources((previous) => ({
      ...previous,
      ...Object.fromEntries(sourceNames.map((name) => [name, {
        state: 'loading', source: previous[name]?.source ?? null,
        lastAttemptAt: attemptedAt, lastSuccessAt: previous[name]?.lastSuccessAt ?? null, error: null,
      }])),
    }));
    const isCurrentRefresh = () => refreshSequence.current === refreshId;
    const isCurrentSourceRequest = (name: MissionControlSourceName) =>
      sourceSequences.current[name] === sourceRequestIds[name];
    let hasLiveSource = false;
    const finishSource = (name: MissionControlSourceName, source: string | null, error?: unknown) => {
      if (!isCurrentSourceRequest(name)) return;
      const completedAt = new Date().toISOString();
      const failed = error !== undefined;
      const fallback = source === 'fallback' || source === 'gateway-status-fallback';
      if (!failed && !fallback) hasLiveSource = true;
      setSources((previous) => {
        const old = previous[name];
        return { ...previous, [name]: {
          state: failed ? 'error' : fallback ? 'fallback' : 'live', source,
          lastAttemptAt: attemptedAt,
          lastSuccessAt: !failed && !fallback ? completedAt : old?.lastSuccessAt ?? null,
          error: failed ? (error instanceof Error ? error.message : 'Request failed') : null,
        } };
      });
    };
    if (!silent) {
      setLoading(true);
    }

    if (includeReference) {
      void refreshReferenceData(token);
    }

    try {
      const updateMachine = loadMissionControlMachineStatus(token).then((machine) => {
        finishSource('machine', machine.source ?? 'fallback');
        if (!isCurrentSourceRequest('machine') || machine.source === 'fallback') return;
        setSnapshot((previous) => {
          const nextMachine = machine as MissionControlSnapshot['machine'];
          return { ...previous, machine: nextMachine };
        });
      }).catch((error) => { finishSource('machine', null, error); throw error; });

      const updateSessions = includeSessions
        ? loadMissionControlSessions(token).then((sessions) => {
            finishSource('sessions', sessions.dataSource ?? 'fallback', sessions.dataError ? new Error(sessions.dataError) : undefined);
            if (!isCurrentSourceRequest('sessions') || sessions.dataSource === 'fallback' || sessions.dataSource === 'gateway-status-fallback') return;
            setSnapshot((previous) => {
              const nextSessions = sessions as MissionControlSnapshot['sessions'];
              const sessionsValue = nextSessions;
              return {
                ...previous,
                sessions: sessionsValue,
                activeAgents: sessionsValue.activeAgents,
              };
            });
          }).catch((error) => { finishSource('sessions', null, error); throw error; })
        : Promise.resolve();

      const updateCron = includeCron
        ? loadMissionControlCron(token).then((cron) => {
            finishSource('cron', cron.dataSource ?? 'fallback', cron.dataError ? new Error(cron.dataError) : undefined);
            if (!isCurrentSourceRequest('cron') || cron.dataSource === 'fallback') return;
            setSnapshot((previous) => {
              const nextCron = cron as MissionControlSnapshot['cron'];
              const cronValue = nextCron;
              return {
                ...previous,
                cron: cronValue,
                queuedJobs: cronValue.queuedJobs,
              };
            });
          }).catch((error) => { finishSource('cron', null, error); throw error; })
        : Promise.resolve();

      const updateAlerts = loadMissionControlAlerts(token).then((alerts) => {
        finishSource('alerts', alerts.dataSource ?? 'fallback', alerts.dataError ? new Error(alerts.dataError) : undefined);
        if (!isCurrentSourceRequest('alerts') || alerts.dataSource === 'fallback') return;
        setSnapshot((previous) => {
          const nextAlerts = alerts as MissionControlSnapshot['alerts'];
          return { ...previous, alerts: nextAlerts };
        });
      }).catch((error) => { finishSource('alerts', null, error); throw error; });

      const liveResults = await Promise.allSettled([updateMachine, updateSessions, updateCron, updateAlerts]);
      const authFailure = liveResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected' && result.reason instanceof MissionControlAuthError,
      );
      if (authFailure) {
        throw authFailure.reason;
      }

      if (includeSnapshot) {
        try {
          const dashboard = await loadMissionControlSnapshot(token);
          finishSource('snapshot', dashboard.dataSource ?? 'fallback', dashboard.dataError ? new Error(dashboard.dataError) : undefined);
          if (isCurrentSourceRequest('snapshot') && dashboard.dataSource !== 'fallback' && !dashboard.dataError) setSnapshot((previous) => ({
            ...previous,
            backendHealth: dashboard.backendHealth,
            activeModel: dashboard.activeModel,
            fallbackModel: dashboard.fallbackModel,
            gatewayStatus: dashboard.gatewayStatus,
            // Session data comes from the dedicated sessions endpoint above.
            // The lightweight dashboard snapshot intentionally does not load
            // sessions and would otherwise overwrite a live count with 0.
            candidatesEnabled: dashboard.candidatesEnabled,
            queuedJobs: dashboard.queuedJobs,
            toolCallsToday: dashboard.toolCallsToday,
            recentSignals: dashboard.recentSignals,
          }));
        } catch (error) {
          finishSource('snapshot', null, error);
          if (error instanceof MissionControlAuthError) {
            throw error;
          }
        }
      }

      setAuthRequired(false);
      setAuthError(null);
      if (isCurrentRefresh() && hasLiveSource) {
        setLastUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      }
    } catch (error) {
      if (!isCurrentRefresh()) return;
      if (error instanceof MissionControlAuthError) {
        setAuthRequired(true);
        setAuthError('Access token required to enter the cockpit.');
        setSources((previous) => Object.fromEntries(Object.entries(previous).map(([name, status]) => [name, status ? {
          ...status,
          state: 'error',
          source: 'fallback',
          lastSuccessAt: null,
          error: 'Authentication required.',
        } : [name, status]])) as MissionControlSources);

        // Auth failures should lock the UI and scrub live state.
        setSnapshot(getFallbackSnapshot());
        if (includeReference) {
          setTools(getFallbackTools());
          setSkills(getFallbackSkills());
        }
      } else {
        // Transient network/backend hiccups should NOT clobber already-live data.
        setAuthRequired(false);
        setAuthError(null);
      }
    } finally {
      if (!silent && isCurrentRefresh()) {
        setLoading(false);
      }
    }
  }, [refreshReferenceData]);

  useEffect(() => {
    void refreshAll(initialToken || undefined);
    void refreshConfig(initialToken || undefined).catch((error) => {
      if (error instanceof MissionControlAuthError) {
        // Config is optional. Keep the cockpit live even if the config surface rejects auth.
        setAuthRequired(false);
        setAuthError(null);
        setConfig(getFallbackConfig());
      }
    });
    // Initial boot only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authRequired) {
      return;
    }

    let ticks = 0;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ticks += 1;
      const includeReference = ticks % 4 === 0 || !tools.available || !skills.available;
      const includeSnapshot = ticks % 4 === 0 || snapshot.activeModel === 'gpt-5.4-mini';
      const includeConfig = ticks % 4 === 0 || !config.available;
      recordReloadDiagnostic('mc-refresh-poll', { ticks, includeReference, includeSnapshot, includeConfig, includeCron: false });
      void refreshAll(storedToken || undefined, {
        silent: true,
        includeReference,
        includeSnapshot,
        includeSessions: true,
        includeCron: false,
      });
      if (includeConfig) {
        void refreshConfig(storedToken || undefined).catch(() => {});
      }
    }, 15000);

    return () => window.clearInterval(interval);
  }, [authRequired, config.available, refreshAll, refreshConfig, skills.available, snapshot.activeModel, storedToken, tools.available]);


  const unlock = useCallback(async (token: string) => {
    const nextToken = token.trim();
    setStoredToken(nextToken);
    setTokenDraft(nextToken);
    persistStoredValue(MISSION_CONTROL_TOKEN_STORAGE_KEY, nextToken);
    await refreshAll(nextToken || undefined);
    await refreshConfig(nextToken || undefined).catch((error) => {
      if (error instanceof MissionControlAuthError) {
        setConfig(getFallbackConfig());
        return;
      }
      throw error;
    });
  }, [refreshAll, refreshConfig]);

  const logout = useCallback(() => {
    setTokenDraft('');
    setStoredToken('');
    persistStoredValue(MISSION_CONTROL_TOKEN_STORAGE_KEY, '');
    setAuthRequired(true);
    setAuthError('Logged out. Re-enter the access token to unlock the cockpit.');
    setSnapshot(getFallbackSnapshot());
    setTools(getFallbackTools());
    setSkills(getFallbackSkills());
    setConfig(getFallbackConfig());
    setActionResult(null);
    setLinkStatus(null);
  }, []);

  const reloadConfig = useCallback(async () => {
    return refreshConfig(storedToken || undefined);
  }, [refreshConfig, storedToken]);

  const saveConfig = useCallback(async (content: string, expectedHash?: string | null) => {
    // A pre-save read, or a poll started during the write, cannot roll back the
    // canonical post-save readback when its response eventually arrives.
    ++configRequestIdRef.current;
    const updated = await saveMissionControlConfig(storedToken || undefined, content, expectedHash ?? config.hash ?? undefined);
    ++configRequestIdRef.current;
    setConfig(updated);
    return updated;
  }, [config.hash, storedToken]);

  const runGatewayAction = useCallback(async (action: MissionControlGatewayAction) => {
    const token = storedToken.trim();
    const baseUrl = getApiBaseUrl().replace(/\/$/, '');

    setActionLoading(action.id);
    setActionResult(null);

    try {
      if (action.id === 'refresh') {
        await refreshAll(token || undefined);
        setActionResult({
          label: action.label,
          endpoint: action.endpoint,
          payload: 'Dashboard refreshed from live endpoints.',
        });
        return;
      }

      if (action.id === 'reload-config') {
        const updated = await refreshConfig(token || undefined);
        setActionResult({
          label: action.label,
          endpoint: action.endpoint,
          payload: `Reloaded config.yaml (${updated.path}).`,
        });
        return;
      }

      const response = await fetch(`${baseUrl}${action.endpoint}`, {
        method: action.method,
        headers: buildHeaders(token || undefined),
      });

      if (response.status === 401) {
        throw new MissionControlAuthError();
      }

      if (!response.ok) {
        throw new Error(`${action.endpoint} returned ${response.status}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const payload = contentType.includes('application/json') ? await response.json() : await response.text();
      const result = readJsonPayload<unknown>(payload);
      setActionResult({
        label: action.label,
        endpoint: action.endpoint,
        payload: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown action failure';
      setActionResult({
        label: action.label,
        endpoint: action.endpoint,
        payload: message,
      });

      if (error instanceof MissionControlAuthError) {
        setAuthRequired(true);
        setAuthError('Access token required to keep using Mission Control.');
      }

      // QuickActions owns restart-specific success/error feedback. Preserve the
      // rejection so a failed restart cannot be reported as completed.
      if (action.id === 'restart-gateway') {
        throw error;
      }
    } finally {
      setActionLoading(null);
    }
  }, [refreshAll, refreshConfig, storedToken]);

  const value = useMemo<MissionControlContextValue>(() => ({
    snapshot,
    tools,
    skills,
    config,
    loading,
    authRequired,
    authError,
    storedToken,
    tokenDraft,
    setTokenDraft,
    refreshAll,
    refreshTools,
    unlock,
    logout,
    actionResult,
    actionLoading,
    gatewayActions,
    runGatewayAction,
    reloadConfig,
    saveConfig,
    linkStatus,
    setLinkStatus,
    lastUpdatedAt,
    sources,
    theme,
    setTheme: setThemeState,
    resolvedTheme,
  }), [
    actionLoading,
    actionResult,
    authError,
    authRequired,
    config,
    gatewayActions,
    lastUpdatedAt,
    linkStatus,
    loading,
    logout,
    refreshAll,
    refreshTools,
    reloadConfig,
    resolvedTheme,
    runGatewayAction,
    saveConfig,
    snapshot,
    sources,
    skills,
    storedToken,
    theme,
    tokenDraft,
    tools,
    unlock,
  ]);

  return <MissionControlContext.Provider value={value}>{children}</MissionControlContext.Provider>;
}

export function useMissionControl() {
  const context = useContext(MissionControlContext);
  if (!context) {
    throw new Error('useMissionControl must be used inside MissionControlProvider');
  }
  return context;
}

export function useMissionControlSelection<T extends { id: string }>(items: T[], paramName: string) {
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(paramName);
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePopState = () => {
      setSelectedId(new URLSearchParams(window.location.search).get(paramName));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [paramName]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    if (selectedId) {
      url.searchParams.set(paramName, selectedId);
    } else {
      url.searchParams.delete(paramName);
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [paramName, selectedId]);

  useEffect(() => {
    if (selectedId && items.length > 0 && !items.some((item) => item.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null);
    }
  }, [items, selectedId]);

  return {
    selectedId,
    setSelectedId,
    selectedItem: items.find((item) => item.id === selectedId) ?? items[0] ?? null,
  };
}
