import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react';
import { loadMissionControlAgentSessions, type MissionControlAgentSessionItem, type MissionControlAgentSessionStatus } from '../../lib/hermes-api';
import { loadBotProfiles } from '../../lib/bot-gateway';
import { createSessionPickerController } from '../../lib/chat-session-picker';
import { useI18n } from '../../lib/i18n';
import { formatRelativeSchedule, formatTimestamp } from '../../lib/format';
import './SessionPicker.css';

export interface SessionPickerProps {
  open: boolean;
  storedToken: string;
  currentSessionId?: string | null;
  currentProfile?: string | null;
  onSelect: (session: MissionControlAgentSessionItem) => void;
  onClose: () => void;
}

export function SessionPicker({ open, storedToken, currentSessionId, currentProfile, onSelect, onClose }: SessionPickerProps) {
  const { t, locale } = useI18n();
  const pickerRef = useRef<HTMLDivElement>(null);

  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [profileNames, setProfileNames] = useState<string[]>(['default']);
  const [profileError, setProfileError] = useState(false);
  const [profileReload, setProfileReload] = useState(0);
  const profilesLoadedRef = useRef(false);
  const [origins, setOrigins] = useState<string[]>([]);
  const controller = useMemo(() => createSessionPickerController({
    storedToken,
    loadService: options => loadMissionControlAgentSessions(options.accessToken, options.limit, options.offset, options.filters, options.profile, { includeRecentMessages: false, signal: options.signal }),
  }), [storedToken]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    const cancellation = new AbortController();
    if (!open || profilesLoadedRef.current) return;
    setProfileError(false);
    void loadBotProfiles(storedToken).then(payload => {
      if (!cancellation.signal.aborted) {
        profilesLoadedRef.current = true;
        setProfileNames([...new Set(['default', ...payload.profiles.map(profile => profile.name)])].sort());
      }
    }).catch(() => { if (!cancellation.signal.aborted) setProfileError(true); });
    return () => cancellation.abort();
  }, [open, profileReload, storedToken]);

  useEffect(() => {
    const lifetime = new AbortController();
    if (!open) return;
    let timer: number | undefined;
    const refresh = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') await controller.load();
      window.clearTimeout(timer);
      if (!lifetime.signal.aborted) timer = window.setTimeout(() => void refresh(), 5000);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => { lifetime.abort(); controller.close(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [controller, open]);

  useEffect(() => {
    // Invalidate immediately; the fetch itself waits until typing pauses.
    if (!open) return;
    if (query === controller.state.query) return;
    controller.setQuery(query);
    const timer = window.setTimeout(() => void controller.load(), 250);
    return () => window.clearTimeout(timer);
  }, [controller, open, query]);

  useEffect(() => {
    setOrigins(previous => [...new Set([...previous, ...Object.keys(state.facets.origin)])].sort());
  }, [state.facets.origin]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || pickerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-session-picker-trigger]')) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    if (!open) return;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [onClose, open]);

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [state.pagination.offset, state.query, state.profile, state.origin, state.status]);

  const loading = state.loading || query !== state.query;

  const filterProfiles = [...new Set([...profileNames, ...state.items.map(session => session.profile || 'default')])].sort();
  return (
    <div ref={pickerRef} id="chat-session-picker" data-session-picker role="dialog" aria-modal="false" aria-label={t('sessionPicker.title')} hidden={!open} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="sp-header">
        <strong>{t('sessionPicker.title')}</strong>
        <span className="sp-count">{t('sessionPicker.activeCount', { count: state.stats.liveSessions })}</span>
        <button type="button" className="sp-icon-button" onClick={onClose} aria-label={t('sessionPicker.close')}><X size={16} /></button>
      </div>
      <div className="sp-search">
        <Search size={16} aria-hidden />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchPlaceholder')} />
      </div>
      <div className="sp-filters">
        <label>{t('sessionPicker.profile')}<select value={state.profile || ''} onChange={event => { controller.setProfile(event.target.value || null); void controller.load(); }} aria-label={t('sessionPicker.profile')}>
          <option value="">{t('sessionPicker.allProfiles')}</option>
          {filterProfiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}
        </select></label>
        <label>{t('sessionPicker.origin')}<select value={state.origin || ''} onChange={event => { controller.setOrigin(event.target.value || null); void controller.load(); }} aria-label={t('sessionPicker.origin')}>
          <option value="">{t('sessions.allOrigins')}</option>
          {origins.map(origin => <option key={origin} value={origin}>{origin}</option>)}
        </select></label>
        <label>{t('sessionPicker.status')}<select value={state.status || ''} onChange={event => { controller.setStatus(event.target.value as MissionControlAgentSessionStatus || null); void controller.load(); }} aria-label={t('sessionPicker.status')}>
          <option value="">{t('sessions.allStatuses')}</option>
          {(['live', 'idle', 'ended'] as const).map(status => <option key={status} value={status}>{t(`sessions.${status}Status`)}</option>)}
        </select></label>
      </div>
      {profileError ? <div className="sp-notice" role="status">{t('sessionPicker.profilesFailed')} <button type="button" onClick={() => { profilesLoadedRef.current = false; setProfileReload(value => value + 1); }}>{t('sessions.retry')}</button></div> : null}
      {state.error ? <div className="sp-notice sp-error" role="alert"><span>{t('sessions.unableToLoad')}: {state.error}</span><button type="button" onClick={() => void controller.load()}>{t('sessions.retry')}</button></div> : null}
      <ul ref={listRef} className="sp-list" aria-label={t('sessionPicker.title')} aria-busy={loading}>
        {loading && state.items.length === 0 ? <li className="sp-empty" role="status"><Loader2 size={16} className="chat-spin" />{t('sessions.loading')}</li> : null}
        {!loading && !state.error && state.items.length === 0 ? <li className="sp-empty">{t('sessions.noMatches')}</li> : null}
        {state.items.map(session => {
          const profile = session.profile || 'default';
          const selected = session.sessionId === currentSessionId && profile === (currentProfile || 'default');
          return <li key={`${profile}:${session.sessionId}`}>
            <button type="button" className={`sp-row ${selected ? 'sp-selected' : ''}`} disabled={!session.isResumable} aria-current={selected ? 'true' : undefined} data-session-id={session.sessionId} data-session-profile={profile} data-session-status={session.status} title={session.isResumable ? t('sessions.resumeAria', { title: session.title || session.sessionId }) : t('sessionPicker.notResumable')} onClick={() => onSelect(session)}>
              <span className={`sp-dot is-${session.status}`} aria-hidden />
              <span className="sp-row-body">
                <span className="sp-row-title">{session.title || session.sessionId}</span>
                <span className="sp-row-meta">{profile} · {session.originLabel || session.source}</span>
                <span className="sp-row-model">{session.model || session.sessionId}</span>
              </span>
              <span className="sp-row-status"><span className={session.status === 'live' ? 'sp-live' : ''}>{t(`sessions.${session.status}Status`)}</span><time title={formatTimestamp(session.lastActiveAt)} dateTime={session.lastActiveAt === null ? undefined : new Date(session.lastActiveAt * 1000).toISOString()}>{formatRelativeSchedule(session.lastActiveAt, locale) || ''}</time>{!session.isResumable ? <span>{t('sessionPicker.notResumable')}</span> : null}</span>
            </button>
          </li>;
        })}
      </ul>
      <div className="sp-footer">
        <span role="status">{t('sessionPicker.range', { from:state.items.length ? state.pagination.offset + 1 : 0, to:state.pagination.offset + state.items.length, total:state.pagination.total })}</span>
        {loading ? <Loader2 size={14} className="chat-spin" aria-label={t('sessions.loading')} /> : null}
        {state.pagination.offset > 0 || state.pagination.hasMore ? <div className="sp-pages">
          <button type="button" className="sp-icon-button" disabled={loading || state.pagination.offset === 0} onClick={() => void controller.loadPrev()} aria-label={t('sessionPicker.previous')}><ChevronLeft size={16} /></button>
          <button type="button" className="sp-icon-button" disabled={loading || !state.pagination.hasMore} onClick={() => void controller.loadNext()} aria-label={t('sessionPicker.next')}><ChevronRight size={16} /></button>
        </div> : null}
      </div>
    </div>
  );
}
