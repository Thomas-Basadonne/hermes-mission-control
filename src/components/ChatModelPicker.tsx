import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChatModelProviderOption, ChatModelSwitchResult } from '../lib/chat-protocol';
import { isCoarsePointer } from '../lib/device';
import { modelRows, rememberModel, type ModelSelection } from '../lib/chat-status-runtime';

type Props = {
  request: <T,>(method: string, params?: Record<string, unknown>) => Promise<T>;
  sessionId: string | null;
  currentModel?: string;
  currentProvider?: string;
  profile?: string;
  initialRefresh?: boolean;
  onClose: () => void;
  onSelect: (model: string, provider: string, confirm?: boolean) => Promise<ChatModelSwitchResult>;
};

function normalizeProviders(raw: unknown): ChatModelProviderOption[] {
  if (!raw || typeof raw !== 'object') return [];
  const payload = 'result' in raw && raw.result && typeof raw.result === 'object' ? raw.result : raw;
  if (!('providers' in payload) || !Array.isArray(payload.providers)) return [];
  return payload.providers.flatMap((provider) => {
    if (typeof provider?.slug !== 'string' || !provider.slug) return [];
    const models = Array.isArray(provider.models) ? provider.models.filter((model: unknown): model is string => typeof model === 'string' && !!model.trim()) : [];
    return [{ slug: provider.slug, name: provider.name || provider.slug, models, total_models: provider.total_models ?? models.length, authenticated: provider.authenticated !== false, warning: provider.warning }];
  });
}

export function ChatModelPicker({ request, sessionId, currentModel, currentProvider, profile = 'default', initialRefresh = false, onClose, onSelect }: Props) {
  const key = `mission-control-model-recents:${profile}`;
  const [recent, setRecent] = useState<ModelSelection[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.filter((item) => typeof item?.provider === 'string' && typeof item?.model === 'string').slice(0, 5) : [];
    } catch { return []; }
  });
  const [providers, setProviders] = useState<ChatModelProviderOption[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<(ModelSelection & { message: string }) | null>(null);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => modelRows(providers, filter, recent, selectedProvider), [providers, filter, recent, selectedProvider]);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await request('model.options', { ...(sessionId ? { session_id: sessionId } : {}), include_unconfigured: true, ...(refresh ? { refresh: true } : {}) });
      setProviders(normalizeProviders(payload));
      setHighlight(0);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load models.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(initialRefresh); }, [request, sessionId]);
  useEffect(() => { listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [highlight]);

  const choose = async (selection: ModelSelection, confirm = false) => {
    setSwitching(true);
    setError(null);
    try {
      const result = await onSelect(selection.model, selection.provider, confirm);
      if (result.confirmRequired) {
        setConfirmation({ ...selection, message: result.confirmMessage || result.warning || 'This model has unusually high pricing.' });
        return;
      }
      if (!result.ok) throw new Error(result.error || 'Could not switch model.');
      const next = rememberModel(recent, selection);
      setRecent(next);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage can be blocked */ }
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not switch model.'); }
    finally { setSwitching(false); }
  };

  return (
    <section className="chat-model-picker" aria-label="Choose provider and model" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if ((event.target as HTMLElement).tagName === 'SELECT' || switching || confirmation || !rows.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        let next = highlight;
        for (let count = 0; count < rows.length; count++) { next = (next + step + rows.length) % rows.length; if (!rows[next].disabled) break; }
        setHighlight(next);
      } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
        event.preventDefault();
        if (rows[highlight] && !rows[highlight].disabled) void choose(rows[highlight]);
      }
    }}>
      <header className="chat-model-picker-head">
        <strong>Choose model</strong>
        <div className="chat-model-picker-actions">
          <button type="button" disabled={loading || switching} onClick={() => void load(true)}>Refresh</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </header>
      <label className="chat-model-provider-select">
        <span>Provider</span>
        <select aria-label="Provider" value={selectedProvider} disabled={loading || switching || !!confirmation} onChange={(event) => { setSelectedProvider(event.target.value); setFilter(''); setHighlight(0); setError(null); }}>
          <option value="">All providers</option>
          {providers.map((provider) => <option key={provider.slug} value={provider.slug} disabled={provider.authenticated === false || !provider.models.length}>{provider.name} ({provider.models.length}){provider.authenticated === false ? ' · not configured' : !provider.models.length ? ' · no models' : ''}</option>)}
        </select>
      </label>
      <label className="chat-model-search">
        <input role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={rows[highlight] ? `${listId}-${highlight}` : undefined} aria-autocomplete="list" aria-label="Search provider or model" placeholder="Search provider or model…" value={filter} onChange={(event) => { setFilter(event.target.value); setHighlight(0); }} autoFocus={!isCoarsePointer()} />
      </label>
      {confirmation ? <div className="chat-model-confirm" role="alert">
        <strong>Confirm model switch</strong><p>{confirmation.message}</p>
        <div className="chat-model-confirm-actions"><button type="button" disabled={switching} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" disabled={switching} onClick={() => void choose(confirmation, true)}>Switch anyway</button></div>
      </div> : null}
      <div className="chat-model-list" role="listbox" id={listId} ref={listRef} aria-label="Available models" aria-busy={loading || switching}>
        {loading ? <p className="chat-model-picker-state">Loading models…</p> : !rows.length ? <p className="chat-model-picker-state">No matching models.</p> : rows.map((row, index) => {
          const active = row.model === currentModel && row.provider === currentProvider;
          return <div key={`${row.provider}:${row.model}`}>
            {row.recent && index === 0 ? <p className="chat-model-picker-section-label">Recent</p> : null}
            {!row.recent && (index === 0 || rows[index - 1].recent || rows[index - 1].provider !== row.provider) ? <p className="chat-model-picker-section-label">{row.providerName}</p> : null}
            <button type="button" id={`${listId}-${index}`} role="option" aria-selected={active} data-highlighted={index === highlight} className={`chat-model-option ${active ? 'is-current' : ''}`} disabled={row.disabled || switching || !!confirmation} title={row.warning || `${row.providerName} · ${row.model}`} onClick={() => void choose(row)}>
              <span className="chat-model-option-name">{row.model}</span>
              <small>{row.providerName}{active ? ' · current' : row.disabled ? ' · not configured' : ''}</small>
            </button>
          </div>;
        })}
      </div>
      {error ? <p className="chat-model-picker-error" role="alert">{error}</p> : null}
    </section>
  );
}
