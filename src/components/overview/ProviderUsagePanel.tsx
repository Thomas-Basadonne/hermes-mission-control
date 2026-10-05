import { useI18n } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import { Cloud, RefreshCw, Search, Settings2 } from 'lucide-react';
import { Card } from '../ui/Card';
import { Modal } from '../Modal';
import {
  loadProviderUsage,
  loadProviderUsageCatalog,
  saveProviderUsageSelection,
  type MissionControlProviderCatalogSnapshot,
  type MissionControlProviderUsage,
  type MissionControlProviderUsageBalance,
  type MissionControlProviderUsageSnapshot,
  type MissionControlProviderUsageWindow,
} from '../../lib/hermes-api';
import { useMissionControl } from '../../lib/mission-control-store';

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  ollama: 'Ollama Cloud',
  openrouter: 'OpenRouter',
  nous: 'Nous Portal',
};

function formatNumber(value?: number | null): string {
  return typeof value === 'number' ? value.toFixed(value % 1 === 0 ? 0 : 2) : '—';
}

function formatValue(value?: number | null, currency?: string, unit?: string): string {
  if (typeof value !== 'number') return '—';
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatReset(value: string | undefined, t: (key: string, values?: Record<string, string | number>) => string): string {
  const date = formatDate(value);
  return date ? t('provider.reset', { date }) : t('provider.resetUnknown');
}

function formatRenews(value: string | undefined, t: (key: string, values?: Record<string, string | number>) => string): string | null {
  const date = formatDate(value);
  return date ? t('provider.renews', { date }) : null;
}

function windowLabel(window: MissionControlProviderUsageWindow, t: (key: string) => string): string {
  if (window.id === 'primary') return t('provider.session');
  if (window.id === 'secondary') return t('provider.weekly');
  if (window.id === 'subscription') return t('provider.subscription');
  return window.label;
}

function balanceLabel(balance: MissionControlProviderUsageBalance, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    balance: t('provider.balance'),
    subscription_remaining: t('provider.subscriptionRemaining'),
    topup_remaining: t('provider.topupRemaining'),
    total_spendable: t('provider.totalSpendable'),
    credits_remaining: t('provider.creditsRemaining'),
  };
  return labels[balance.id] ?? balance.label;
}

function metricLabel(metric: { id: string; label: string }, t: (key: string) => string): string {
  if (metric.id === 'reset_credits_available') return t('provider.resetCredits');
  return metric.label;
}

function gaugeTone(value: number): { className?: string; color: string } {
  if (value >= 85) return { className: 'bg-negative', color: '' };
  if (value >= 60) return { className: 'bg-warning', color: '' };
  return { color: 'var(--color-usage-session)' };
}

function UsageGauge({
  label,
  window,
  t,
}: {
  label: string;
  window: MissionControlProviderUsageWindow;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const value = typeof window.usedPercent === 'number'
    ? Math.max(0, Math.min(100, window.usedPercent))
    : null;
  const tone = value === null ? null : gaugeTone(value);
  return (
    <div className="flex flex-col gap-1.5" title={value === null ? `${label}: ${t('provider.unavailableShort')}` : `${label}: ${formatNumber(value)}%`}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="text-text-muted uppercase tracking-wide">{label}</span>
        <span className="text-text tabular-nums font-medium">{value === null ? '—' : `${formatNumber(value)}%`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
        {tone ? <div className={`h-full rounded-full transition-[width] duration-300 ${tone.className ?? ''}`} style={{ width: `${value}%`, backgroundColor: tone.color || undefined }} /> : null}
      </div>
      <span className="text-[10px] text-text-subtle truncate">{formatReset(window.resetsAt, t)}</span>
    </div>
  );
}

export function ProviderCard({ provider, displayName }: { provider: MissionControlProviderUsage; displayName?: string }) {
  const { t } = useI18n();
  const label = displayName ?? PROVIDER_LABELS[provider.provider] ?? provider.provider;
  const unavailable = !provider.available;
  const balances = (Array.isArray(provider.balances) ? provider.balances : []).filter((balance) => typeof balance.value === 'number');
  const primaryBalance = balances.find((balance) => balance.id === 'total_spendable' || balance.id === 'balance') ?? balances[0];
  const secondaryBalances = balances.filter((balance) => balance !== primaryBalance);
  const metrics = (Array.isArray(provider.metrics) ? provider.metrics : []).filter((metric) => metric.value !== null && metric.value !== undefined);
  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  const resetCreditMetrics = provider.provider === 'codex'
    ? metrics.filter((metric) => metric.id === 'reset_credits_available')
    : [];
  const featuredMetrics = metrics.filter((metric) => metric.featured && !resetCreditMetrics.includes(metric));
  const regularMetrics = metrics.filter((metric) => !metric.featured);

  return (
    <div className="rounded-lg border border-border-subtle bg-surface/40 p-2.5 flex flex-col gap-2 min-w-0 min-h-[108px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold text-text truncate">{label}</span>
          {provider.plan ? <span className="text-[10px] text-text-subtle truncate">{provider.plan}</span> : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {provider.stale ? <span className="text-[10px] text-amber-400">{t('provider.stale')}</span> : null}
          <span className={`h-1.5 w-1.5 rounded-full ${unavailable ? 'bg-amber-400' : 'bg-emerald-400'}`} />
        </div>
      </div>
      {unavailable ? (
        <div className="flex flex-1 items-center">
          <span className="text-xs text-text-muted line-clamp-2">{provider.error || t('provider.unavailableShort')}</span>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2.5">
          {featuredMetrics.length > 0 ? (
            <div className="rounded-md border border-sky-400/20 bg-sky-400/5 px-2.5 py-2">
              {featuredMetrics.slice(0, 1).map((metric) => (
                <div key={metric.id}>
                  <span className="text-[10px] text-text-muted uppercase tracking-wide">{metricLabel(metric, t)}</span>
                  <div className="text-2xl font-semibold tabular-nums text-sky-400">
                    {typeof metric.value === 'boolean' ? (metric.value ? t('provider.enabled') : t('provider.disabled')) : String(metric.value)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {primaryBalance ? (
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wide">{balanceLabel(primaryBalance, t)}</span>
              <div className="text-lg font-semibold tabular-nums text-emerald-400">
                {formatValue(primaryBalance.value, primaryBalance.currency, primaryBalance.unit)}
              </div>
            </div>
          ) : null}
          {secondaryBalances.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {secondaryBalances.slice(0, 2).map((balance) => (
                <div key={balance.id} className="min-w-0">
                  <span className="text-[10px] text-text-muted uppercase tracking-wide truncate block">{balanceLabel(balance, t)}</span>
                  <span className="text-xs text-text tabular-nums">{formatValue(balance.value, balance.currency, balance.unit)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {windows.map((window) => (
            <UsageGauge key={window.id} label={windowLabel(window, t)} window={window} t={t} />
          ))}
          {provider.renewsAt && formatRenews(provider.renewsAt, t) ? <span className="text-[10px] text-text-subtle">{formatRenews(provider.renewsAt, t)}</span> : null}
          {regularMetrics.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-x-2 gap-y-1">
              {regularMetrics.slice(0, 2).map((metric) => (
                <span key={metric.id} className="text-[10px] text-text-subtle">
                  {metricLabel(metric, t)}: {typeof metric.value === 'boolean' ? (metric.value ? t('provider.enabled') : t('provider.disabled')) : String(metric.value)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {!unavailable && resetCreditMetrics.length > 0 ? (
        <div className="provider-reset-footer border-t border-border-subtle pt-2 flex items-center justify-between gap-2">
          {resetCreditMetrics.slice(0, 1).map((metric) => (
            <span key={metric.id} className="text-[10px] text-text-muted uppercase tracking-wide">
              {metricLabel(metric, t)}
            </span>
          ))}
          {resetCreditMetrics.slice(0, 1).map((metric) => (
            <span key={`${metric.id}-value`} className="text-sm font-semibold tabular-nums text-sky-400">
              {typeof metric.value === 'boolean' ? (metric.value ? t('provider.enabled') : t('provider.disabled')) : String(metric.value)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderUsagePanel() {
  const { t } = useI18n();
  const { storedToken } = useMissionControl();
  const [snapshot, setSnapshot] = useState<MissionControlProviderUsageSnapshot | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<MissionControlProviderCatalogSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<string[]>([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [savingSelection, setSavingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    void loadProviderUsageCatalog(storedToken || undefined).then((catalog) => {
      if (!cancelled) setProviderCatalog(catalog);
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => { cancelled = true; };
  }, [storedToken]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      setRefreshing(true);
      const next = await loadProviderUsage(storedToken || undefined);
      if (!cancelled) {
        setSnapshot(next);
        setRefreshing(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [storedToken]);

  const openCustomize = () => {
    setDraftSelection(providerCatalog?.selectedProviders ?? []);
    setProviderSearch('');
    setSelectionError(null);
    setCustomizeOpen(true);
  };

  const toggleProvider = (provider: string) => {
    setDraftSelection((current) => current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider]);
  };

  const saveSelection = async () => {
    setSavingSelection(true);
    setSelectionError(null);
    try {
      const result = await saveProviderUsageSelection(draftSelection, storedToken || undefined);
      setProviderCatalog((current) => current ? { ...current, selectedProviders: result.selectedProviders } : current);
      setCustomizeOpen(false);
      setSnapshot(await loadProviderUsage(storedToken || undefined));
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : t('provider.selectionSaveFailed'));
    } finally {
      setSavingSelection(false);
    }
  };

  const providerNames = new Map((providerCatalog?.providers ?? []).map((provider) => [provider.provider, provider.displayName]));
  const filteredCatalog = (providerCatalog?.providers ?? []).filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.displayName} ${provider.provider}`.toLowerCase().includes(query);
  });
  const canCustomize = !catalogLoading && providerCatalog !== null;

  return (
    <Card padding="none">
      <div className="px-3 pt-3 pb-2 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud size={15} className="text-sky-400" />
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow">{t('overview.providerUsage')}</span>
            <h2 className="text-sm font-semibold text-text">{t('ui.cloudLimitsBalances')}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {snapshot?.stale ? <span className="text-[10px] text-amber-400">{t('provider.stale')}</span> : null}
          {refreshing || snapshot?.refreshing ? <RefreshCw size={12} className="text-text-subtle animate-spin" /> : null}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-muted hover:text-text disabled:opacity-50"
            onClick={openCustomize}
            disabled={!canCustomize}
          >
            <Settings2 size={12} /> {t('provider.customize')}
          </button>
          <span className="text-[10px] text-text-subtle">{t('provider.live')}</span>
        </div>
      </div>
      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {!snapshot?.available ? (
          <p className="text-sm text-text-muted">{snapshot ? t('provider.unavailable') : t('provider.loading')}</p>
        ) : snapshot.providers.length > 0 ? (
          snapshot.providers.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} displayName={providerNames.get(provider.provider)} />
          ))
        ) : (
          <p className="text-sm text-text-muted">{t('provider.noneSelected')}</p>
        )}
      </div>
      <ProviderSelectionDialog
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        catalog={providerCatalog}
        catalogLoading={catalogLoading}
        draftSelection={draftSelection}
        filteredCatalog={filteredCatalog}
        search={providerSearch}
        saving={savingSelection}
        error={selectionError}
        onSearch={setProviderSearch}
        onToggle={toggleProvider}
        onSave={() => void saveSelection()}
      />
    </Card>
  );
}

function ProviderSelectionDialog({
  open,
  onClose,
  catalog,
  catalogLoading,
  draftSelection,
  filteredCatalog,
  search,
  saving,
  error,
  onSearch,
  onToggle,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  catalog: MissionControlProviderCatalogSnapshot | null;
  catalogLoading: boolean;
  draftSelection: string[];
  filteredCatalog: MissionControlProviderCatalogSnapshot['providers'];
  search: string;
  saving: boolean;
  error: string | null;
  onSearch: (value: string) => void;
  onToggle: (provider: string) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const providerCatalog = catalog ?? { available: false, providers: [], selectedProviders: [] };
  return (
    <Modal
      open={open}
      title={t('provider.customizeTitle')}
      subtitle={t('provider.customizeDescription')}
      onClose={onClose}
      fixedHeight
      footer={(
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-text-subtle">{t('provider.selectedCount', { count: draftSelection.length })}</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-border-subtle px-3 py-2 text-xs text-text-muted hover:text-text disabled:opacity-50">
              {t('provider.cancel')}
            </button>
            <button type="button" onClick={onSave} disabled={saving || catalogLoading} className="rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50">
              {saving ? t('provider.saving') : t('provider.saveSelection')}
            </button>
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t('provider.searchProviders')}
            className="w-full rounded-lg border border-border-subtle bg-surface-raised py-2 pl-9 pr-3 text-sm text-text placeholder:text-text-subtle"
          />
        </label>
        {providerCatalog.error ? <p className="text-xs text-amber-400">{providerCatalog.error}</p> : null}
        {error ? <p role="alert" className="text-xs text-negative">{error}</p> : null}
        <p className="text-xs text-text-subtle">{t('provider.disabledNote')}</p>
        <div className="min-h-0 divide-y divide-border-subtle overflow-y-auto rounded-lg border border-border-subtle">
          {catalogLoading ? <p className="p-3 text-sm text-text-muted">{t('provider.catalogLoading')}</p> : null}
          {filteredCatalog.map((provider) => {
            const unavailableReason = !provider.enabled && provider.source === 'codexbar'
              ? t('provider.enableInCodexBar')
              : !provider.selectable ? t('provider.adminRestricted') : '';
            return (
              <label key={provider.provider} className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-raised/60">
                <input
                  type="checkbox"
                  checked={draftSelection.includes(provider.provider)}
                  disabled={!provider.selectable || saving}
                  onChange={() => onToggle(provider.provider)}
                  aria-label={`${provider.displayName} (${provider.provider})`}
                  className="h-4 w-4 accent-sky-500 disabled:opacity-50"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{provider.displayName}</span>
                  <span className="block truncate text-[10px] text-text-subtle">{provider.provider}{unavailableReason ? ` · ${unavailableReason}` : ''}</span>
                </span>
                <span className={`shrink-0 text-[10px] ${provider.enabled || provider.source === 'mission-control' ? 'text-emerald-400' : 'text-text-subtle'}`}>
                  {provider.source === 'mission-control' ? t('provider.native') : provider.enabled ? t('provider.enabledInCodexBar') : t('provider.disabledInCodexBar')}
                </span>
              </label>
            );
          })}
          {!catalogLoading && filteredCatalog.length === 0 ? <p className="p-3 text-sm text-text-muted">{t('provider.noProvidersFound')}</p> : null}
        </div>
      </div>
    </Modal>
  );
}
