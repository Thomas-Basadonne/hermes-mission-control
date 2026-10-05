import { useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Cloud, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
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
import {
  canCustomizeProviderUsageCatalog,
  createSerializedRefresh,
  getProviderUsageCatalogPollDelay,
  preserveLastAvailableSnapshot,
} from '../../lib/provider-usage-refresh';
import {
  formatCurrency as formatLocalizedCurrency,
  formatDateTime,
  formatNumber as formatLocalizedNumber,
  formatPercent,
} from '../../lib/format';
import {
  applyProviderUsagePreferences,
  DEFAULT_PROVIDER_USAGE_PREFERENCES,
  getProviderUsageCatalogRows,
  getProviderUsageGridColumns,
  getProviderUsageSelectionForDisplay,
  getVisibleProviderUsageCards,
  getCodexBarEnableCommand,
  needsCodexBarSetupAlert,
  hasProviderUsageSelectionChanges,
  loadProviderUsagePreferences,
  moveProviderUsagePreference,
  saveProviderUsagePreferences,
  setProviderUsageFieldVisible,
  setProviderUsageProviderVisible,
  type ProviderUsageCatalogRow,
  type ProviderUsageFieldGroup,
  type ProviderUsagePreferences,
  type ProviderUsageView,
} from '../../lib/provider-usage-preferences';

const FIELD_GROUPS: Array<{ id: ProviderUsageFieldGroup; label: string }> = [
  { id: 'windows', label: 'provider.fields.windows' },
  { id: 'balances', label: 'provider.fields.balances' },
  { id: 'metrics', label: 'provider.fields.metrics' },
];

type Translate = (key: string, values?: Record<string, string | number>) => string;

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  ollama: 'Ollama Cloud',
  openrouter: 'OpenRouter',
  nous: 'Nous Portal',
};

function formatNumber(value: number, locale: string): string {
  return formatLocalizedNumber(value, locale);
}

function formatValue(value: number | undefined, currency: string | undefined, unit: string | undefined, locale: string): string {
  if (typeof value !== 'number') return '—';
  if (currency) {
    try {
      return formatLocalizedCurrency(value, currency, locale);
    } catch {
      return `${formatNumber(value, locale)} ${currency}`;
    }
  }
  return `${formatNumber(value, locale)}${unit ? ` ${unit}` : ''}`;
}

function formatDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTime(date, locale);
}

function formatReset(value: string | undefined, locale: string, t: Translate): string {
  const date = formatDate(value, locale);
  return date ? t('provider.reset', { date }) : t('provider.resetUnknown');
}

function formatRenews(value: string | null | undefined, locale: string, t: Translate): string | null {
  const date = formatDate(value, locale);
  return date ? t('provider.renews', { date }) : null;
}

function windowLabel(window: MissionControlProviderUsageWindow, t: Translate): string {
  if (window.id === 'primary' && window.label === 'Session') return t('provider.session');
  if (window.id === 'secondary' && window.label === 'Weekly') return t('provider.weekly');
  if (window.id === 'subscription' && window.label === 'Subscription') return t('provider.subscription');
  return window.label;
}

function balanceLabel(balance: MissionControlProviderUsageBalance, t: Translate): string {
  const labels: Record<string, string> = {
    balance: t('provider.balance'),
    subscription_remaining: t('provider.subscriptionRemaining'),
    topup_remaining: t('provider.topupRemaining'),
    total_spendable: t('provider.totalSpendable'),
    credits_remaining: t('provider.creditsRemaining'),
  };
  return labels[balance.id] ?? balance.label;
}

function metricLabel(metric: { id: string; label: string }, t: Translate): string {
  if (metric.id === 'reset_credits_available') return t('provider.resetCredits');
  return metric.label;
}

function metricValue(value: number | string | boolean | null | undefined, unit: string | undefined, locale: string, t: Translate): string {
  if (typeof value === 'boolean') return value ? t('provider.enabled') : t('provider.disabled');
  if (typeof value === 'number') return `${formatNumber(value, locale)}${unit ? ` ${unit}` : ''}`;
  return value == null ? '—' : `${value}${unit ? ` ${unit}` : ''}`;
}

function gaugeTone(value: number): { className?: string; color: string } {
  if (value >= 85) return { className: 'bg-negative', color: '' };
  if (value >= 60) return { className: 'bg-warning', color: '' };
  return { color: 'var(--color-usage-session)' };
}

function MetricRow({ metric, locale, t }: {
  metric: MissionControlProviderUsage['metrics'][number];
  locale: string;
  t: Translate;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <dt className="text-sm text-text-muted">{metricLabel(metric, t)}</dt>
      <dd className="text-sm font-medium tabular-nums text-text text-right">{metricValue(metric.value, metric.unit, locale, t)}</dd>
    </div>
  );
}

function UsageGauge({
  label,
  window,
  locale,
  detailed,
  t,
}: {
  label: string;
  window: MissionControlProviderUsageWindow;
  locale: string;
  detailed: boolean;
  t: Translate;
}) {
  const value = typeof window.usedPercent === 'number'
    ? Math.max(0, Math.min(100, window.usedPercent))
    : null;
  const tone = value === null ? null : gaugeTone(value);
  const percent = value === null ? null : formatPercent(value / 100, locale);
  const currency = window.unit === 'USD' ? 'USD' : undefined;
  const remaining = typeof window.remaining === 'number' ? formatValue(window.remaining, currency, window.unit, locale) : null;
  const total = typeof window.total === 'number' ? formatValue(window.total, currency, window.unit, locale) : null;
  return (
    <div className={`flex flex-col ${detailed ? 'gap-2 rounded-lg border border-border-subtle p-3' : 'gap-1.5'}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-text">{label}</span>
        <span className="text-text tabular-nums font-semibold">{percent ?? '—'}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={percent ?? t('provider.unavailableShort')}>
        {tone ? <div className={`h-full rounded-full transition-[width] duration-300 ${tone.className ?? ''}`} style={{ width: `${value}%`, backgroundColor: tone.color || undefined }} /> : null}
      </div>
      {detailed ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
          {remaining !== null || total !== null ? <span>{t('provider.remainingOfTotal', { remaining: remaining ?? '—', total: total ?? '—' })}</span> : null}
          <span>{formatReset(window.resetsAt, locale, t)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ProviderCard({ provider, displayName, view = 'compact', locale }: {
  provider: MissionControlProviderUsage;
  displayName?: string;
  view?: ProviderUsageView;
  locale: string;
}) {
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
  const displayMetrics = metrics.filter((metric) => !resetCreditMetrics.includes(metric));
  const featuredMetrics = metrics.filter((metric) => metric.featured && !resetCreditMetrics.includes(metric));
  const regularMetrics = metrics.filter((metric) => !metric.featured && !resetCreditMetrics.includes(metric));
  const stale = provider.stale === true;
  const status = unavailable ? t('provider.unavailableShort') : stale ? t('provider.stale') : t('provider.available');
  const updated = formatDate(provider.updatedAt, locale);
  const renews = formatRenews(provider.renewsAt, locale, t);

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface/50 p-3 shadow-sm" role="group" aria-label={`${label}: ${status}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-text">{label}</h3>
          {provider.plan ? <p className="mt-0.5 truncate text-xs text-text-muted">{provider.plan}</p> : null}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${unavailable || stale ? 'border-warning/30 text-warning' : 'border-positive/30 text-positive'}`} role="status">
          {unavailable || stale ? <AlertCircle size={12} aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
          {status}
        </span>
      </header>
      {unavailable ? (
        <p className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-sm text-text-muted" role="status" aria-live="polite">
          {provider.error || t('provider.unavailableShort')}
        </p>
      ) : view === 'compact' ? (
        <div className="flex flex-col gap-3">
          {featuredMetrics[0] ? (
            <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2">
              <span className="text-xs text-text-muted">{metricLabel(featuredMetrics[0], t)}</span>
              <p className="mt-0.5 text-xl font-semibold tabular-nums text-text">{metricValue(featuredMetrics[0].value, featuredMetrics[0].unit, locale, t)}</p>
            </div>
          ) : null}
          {primaryBalance ? (
            <div className="flex items-end justify-between gap-3">
              <span className="text-xs text-text-muted">{balanceLabel(primaryBalance, t)}</span>
              <span className="text-lg font-semibold tabular-nums text-text">{formatValue(primaryBalance.value, primaryBalance.currency, primaryBalance.unit, locale)}</span>
            </div>
          ) : null}
          {windows.length > 0 ? (
            <div className="flex flex-col gap-3">
              {windows.map((window) => <UsageGauge key={window.id} label={windowLabel(window, t)} window={window} locale={locale} detailed={false} t={t} />)}
            </div>
          ) : null}
          {secondaryBalances.length > 0 ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border-subtle pt-2">
              {secondaryBalances.slice(0, 2).map((balance) => (
                <div key={balance.id} className="min-w-0">
                  <dt className="truncate text-[11px] text-text-muted">{balanceLabel(balance, t)}</dt>
                  <dd className="mt-0.5 truncate text-sm font-medium tabular-nums text-text">{formatValue(balance.value, balance.currency, balance.unit, locale)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {regularMetrics.length > 0 ? (
            <dl className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border-subtle pt-2">
              {regularMetrics.slice(0, 2).map((metric) => (
                <div key={metric.id} className="flex gap-1 text-xs text-text-muted">
                  <dt>{metricLabel(metric, t)}:</dt>
                  <dd className="font-medium text-text">{metricValue(metric.value, metric.unit, locale, t)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {renews ? <p className="text-xs text-text-muted">{renews}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {windows.length > 0 ? (
            <section aria-label={t('provider.fields.windows')} className="flex flex-col gap-2">
              {windows.map((window) => <UsageGauge key={window.id} label={windowLabel(window, t)} window={window} locale={locale} detailed t={t} />)}
            </section>
          ) : null}
          {balances.length > 0 ? (
            <dl aria-label={t('provider.fields.balances')} className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              {balances.map((balance) => (
                <div key={balance.id} className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
                  <dt className="text-sm text-text-muted">{balanceLabel(balance, t)}</dt>
                  <dd className="text-sm font-medium tabular-nums text-text text-right">{formatValue(balance.value, balance.currency, balance.unit, locale)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {displayMetrics.length > 0 ? (
            <dl aria-label={t('provider.fields.metrics')}>
              {displayMetrics.map((metric) => <MetricRow key={metric.id} metric={metric} locale={locale} t={t} />)}
            </dl>
          ) : null}
          {renews ? <p className="border-t border-border-subtle pt-2 text-xs text-text-muted">{renews}</p> : null}
          {windows.length === 0 && balances.length === 0 && metrics.length === 0 ? <p className="text-sm text-text-muted">{t('provider.noFields')}</p> : null}
        </div>
      )}
      {provider.source || updated || resetCreditMetrics.length > 0 ? (
        <footer className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-text-subtle">
          {resetCreditMetrics.length > 0 ? (
            <div className="provider-reset-footer flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={t('provider.resetCredits')}>
              {resetCreditMetrics.map((metric) => (
                <span key={metric.id}>{metricLabel(metric, t)}: <strong className="font-semibold text-text">{metricValue(metric.value, metric.unit, locale, t)}</strong></span>
              ))}
            </div>
          ) : null}
          {provider.source ? <span>{t('provider.source')}: {provider.source}</span> : null}
          {updated ? <time dateTime={provider.updatedAt ?? undefined}>{t('provider.lastUpdated', { time: updated })}</time> : null}
        </footer>
      ) : null}
    </article>
  );
}

export function ProviderUsagePanel() {
  const { t, locale } = useI18n();
  const { storedToken } = useMissionControl();
  const numberLocale = locale === 'it' ? 'it-IT' : 'en-US';
  const [snapshot, setSnapshot] = useState<MissionControlProviderUsageSnapshot | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<MissionControlProviderCatalogSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<string[]>([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [savingSelection, setSavingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [setupProvider, setSetupProvider] = useState<{ name: string; command: string | null } | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);
  const [commandCopyFailed, setCommandCopyFailed] = useState(false);
  const [preferences, setPreferences] = useState(loadProviderUsagePreferences);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const customizeWasOpen = useRef(false);
  const providerUsageRefreshingRef = useRef(false);
  const forceCatalogRefreshRef = useRef(false);

  useEffect(() => {
    saveProviderUsagePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const load = async (forceRefresh = false) => {
      let nextPollDelay = 60_000;
      setCatalogLoading(true);
      try {
        const catalog = await loadProviderUsageCatalog(storedToken || undefined, forceRefresh);
        if (cancelled) return;
        setProviderCatalog(catalog);
        setCatalogLoadFailed(!catalog.available || Boolean(catalog.error));
        nextPollDelay = getProviderUsageCatalogPollDelay(catalog);
      } catch {
        if (!cancelled) setCatalogLoadFailed(true);
      } finally {
        if (!cancelled) {
          setCatalogLoading(false);
          pollTimer = window.setTimeout(() => void load(), nextPollDelay);
        }
      }
    };
    const forceRefresh = forceCatalogRefreshRef.current;
    forceCatalogRefreshRef.current = false;
    void load(forceRefresh);
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [catalogRefreshKey, storedToken]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const refresh = createSerializedRefresh(
      (signal) => loadProviderUsage(storedToken || undefined, signal),
      (next) => {
        providerUsageRefreshingRef.current = next.refreshing === true;
        setSnapshot((current) => preserveLastAvailableSnapshot(current, next));
        setRefreshFailed(!next.available);
      },
      setRefreshing,
    );
    const run = async () => {
      await refresh.run();
      if (!cancelled) {
        pollTimer = window.setTimeout(
          () => void run(),
          providerUsageRefreshingRef.current ? 1_500 : 60_000,
        );
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      refresh.cancel();
    };
  }, [storedToken, refreshKey]);

  useEffect(() => {
    if (!customizeOpen) {
      if (customizeWasOpen.current) customizeButtonRef.current?.focus();
      customizeWasOpen.current = false;
      return;
    }

    customizeWasOpen.current = true;
    const focusDialog = () => {
      const dialog = document.querySelector<HTMLElement>('.provider-usage-customize-dialog');
      dialog?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
    };
    const frame = window.requestAnimationFrame(focusDialog);
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.provider-usage-customize-dialog');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const outsideDialog = !dialog.contains(document.activeElement);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || outsideDialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outsideDialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', trapTab, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', trapTab, true);
    };
  }, [customizeOpen]);

  const openCustomize = () => {
    setDraftSelection(providerCatalog?.selectedProviders ?? []);
    setProviderSearch('');
    setSelectionError(null);
    setCustomizeOpen(true);
  };

  const closeCustomize = () => {
    if (!savingSelection) setCustomizeOpen(false);
  };

  const toggleProvider = (provider: string) => {
    setDraftSelection((current) => current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider]);
  };

  const saveSelection = async () => {
    if (savingSelection) return;
    setSavingSelection(true);
    setSelectionError(null);
    try {
      const result = await saveProviderUsageSelection(draftSelection, storedToken || undefined);
      setProviderCatalog((current) => current ? { ...current, selectedProviders: result.selectedProviders } : current);
      setCustomizeOpen(false);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : t('provider.selectionSaveFailed'));
    } finally {
      setSavingSelection(false);
    }
  };

  const providerNames = new Map((providerCatalog?.providers ?? []).map((provider) => [provider.provider, provider.displayName]));
  const catalogRows = getProviderUsageCatalogRows(providerCatalog?.providers ?? [], draftSelection, preferences);
  const filteredCatalogRows = catalogRows.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.displayName} ${provider.provider}`.toLowerCase().includes(query);
  });
  const canCustomize = canCustomizeProviderUsageCatalog(providerCatalog, catalogLoading);
  const usageRefreshInProgress = refreshing || snapshot?.refreshing === true;
  const providers = snapshot?.providers ?? [];
  const visibleProviders = getVisibleProviderUsageCards(
    providers,
    getProviderUsageSelectionForDisplay(
      providers,
      providerCatalog?.selectedProviders ?? null,
      providerCatalog?.available === true,
    ),
    preferences,
  );
  const gridMaxColumns = getProviderUsageGridColumns(visibleProviders.length, preferences.columns);

  return (
    <Card padding="none" role="region" aria-labelledby="provider-usage-title" aria-busy={usageRefreshInProgress}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-3 py-3">
        <div className="flex items-center gap-2">
          <Cloud size={16} className="text-sky-400" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow">{t('overview.providerUsage')}</span>
            <h2 id="provider-usage-title" className="text-sm font-semibold text-text">{t('ui.cloudLimitsBalances')}</h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-text-subtle">{t('provider.autoRefresh')}</span>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={usageRefreshInProgress}
            title={t('provider.refreshHelp')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1.5 text-xs font-medium text-text-muted hover:text-text disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RefreshCw size={13} className={usageRefreshInProgress ? 'animate-spin' : ''} aria-hidden="true" />
            {snapshot?.refreshing ? t('provider.refreshing') : t('provider.refresh')}
          </button>
          {catalogLoadFailed ? (
            <button
              type="button"
              onClick={() => {
                forceCatalogRefreshRef.current = true;
                setCatalogRefreshKey((key) => key + 1);
              }}
              disabled={catalogLoading}
              className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 px-2 py-1.5 text-xs font-medium text-warning hover:text-text disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw size={13} className={catalogLoading ? 'animate-spin' : ''} aria-hidden="true" />
              {t('provider.retry')}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-accent/30 hover:bg-surface-hover hover:text-text disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={openCustomize}
            disabled={!canCustomize || savingSelection}
            aria-haspopup="dialog"
            aria-expanded={customizeOpen}
            ref={customizeButtonRef}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {t('provider.customize')}
          </button>
        </div>
      </header>
      {!snapshot?.available ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" role={snapshot ? 'alert' : 'status'} aria-live="polite">
          {snapshot ? <AlertCircle size={20} className="text-warning" aria-hidden="true" /> : <RefreshCw size={20} className="animate-spin text-text-subtle" aria-hidden="true" />}
          <p className="text-sm text-text-muted">{snapshot ? t('provider.unavailable') : t('provider.loading')}</p>
          {snapshot ? (
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={refreshing} className="text-xs font-medium text-accent hover:underline disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {t('provider.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {refreshFailed ? <p className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs text-warning" role="status" aria-live="polite"><AlertCircle size={13} aria-hidden="true" />{t('provider.refreshFailed')}</p> : null}
          <div className="provider-usage-grid-container p-3">
            <div className="provider-usage-grid gap-3" data-max-columns={gridMaxColumns}>
              {visibleProviders.length > 0 ? visibleProviders.map((provider) => (
                <ProviderCard key={provider.provider} provider={provider} displayName={providerNames.get(provider.provider)} view={preferences.view} locale={numberLocale} />
              )) : <p className="text-sm text-text-muted" role="status">{t('provider.noneSelected')}</p>}
            </div>
          </div>
        </>
      )}
      <ProviderUsageCustomizeDialog
        open={customizeOpen}
        onClose={closeCustomize}
        providers={providers}
        providerNames={providerNames}
        preferences={preferences}
        setPreferences={setPreferences}
        catalog={providerCatalog}
        catalogLoading={catalogLoading}
        draftSelection={draftSelection}
        filteredCatalogRows={filteredCatalogRows}
        search={providerSearch}
        saving={savingSelection}
        error={selectionError}
        onSearch={setProviderSearch}
        onToggle={toggleProvider}
        onRequestSetup={(name, command) => {
          setCustomizeOpen(false);
          setSetupProvider({ name, command });
          setCommandCopied(false);
          setCommandCopyFailed(false);
        }}
        onSave={() => void saveSelection()}
      />
      <Modal
        open={setupProvider !== null}
        title={t('provider.codexBarSetupTitle')}
        subtitle={setupProvider?.name}
        onClose={() => {
          setSetupProvider(null);
          setCustomizeOpen(true);
        }}
        className="sm:max-w-[520px]"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">{t('provider.codexBarSetupDescription', { provider: setupProvider?.name ?? '' })}</p>
          {setupProvider?.command ? (
            <>
              <pre className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-raised p-3 text-sm text-text"><code>{setupProvider.command}</code></pre>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(setupProvider.command!);
                    setCommandCopied(true);
                    setCommandCopyFailed(false);
                  } catch {
                    setCommandCopied(false);
                    setCommandCopyFailed(true);
                  }
                }}
                className="self-start rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >{t(commandCopied ? 'provider.codexBarCommandCopied' : 'provider.codexBarCopyCommand')}</button>
              {commandCopyFailed ? <p className="text-xs text-warning" role="status">{t('provider.codexBarCopyFailed')}</p> : null}
            </>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}

function ProviderUsageCustomizeDialog({
  open,
  onClose,
  providers,
  providerNames,
  preferences,
  setPreferences,
  catalog,
  catalogLoading,
  draftSelection,
  filteredCatalogRows,
  search,
  saving,
  error,
  onSearch,
  onToggle,
  onRequestSetup,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  providers: MissionControlProviderUsage[];
  providerNames: Map<string, string>;
  preferences: ProviderUsagePreferences;
  setPreferences: Dispatch<SetStateAction<ProviderUsagePreferences>>;
  catalog: MissionControlProviderCatalogSnapshot | null;
  catalogLoading: boolean;
  draftSelection: string[];
  filteredCatalogRows: ProviderUsageCatalogRow[];
  search: string;
  saving: boolean;
  error: string | null;
  onSearch: (value: string) => void;
  onToggle: (provider: string) => void;
  onRequestSetup: (name: string, command: string | null) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const providerCatalog = catalog ?? { available: false, providers: [], selectedProviders: [] };
  const catalogRows = getProviderUsageCatalogRows(providerCatalog.providers, draftSelection, preferences);
  const selectedRows = catalogRows.filter((row) => row.collectUsage);
  const displayRows = selectedRows;
  const [activeProviderId, setActiveProviderId] = useState(displayRows[0]?.provider ?? '');
  const [activeSection, setActiveSection] = useState<'providers' | 'display'>('providers');
  const activeDisplayRow = displayRows.find(({ provider }) => provider === activeProviderId) ?? displayRows[0];
  const activeProvider = activeDisplayRow
    ? providers.find(({ provider }) => provider === activeDisplayRow.provider)
    : undefined;
  const activeProviderLabel = activeProvider
    ? providerNames.get(activeProvider.provider) ?? PROVIDER_LABELS[activeProvider.provider] ?? activeProvider.provider
    : activeDisplayRow?.displayName ?? '';
  const activeFields = activeProvider
    ? FIELD_GROUPS.some(({ id }) => (activeProvider[id] ?? []).length > 0)
    : false;
  const selectionChanged = hasProviderUsageSelectionChanges(draftSelection, providerCatalog.selectedProviders);
  return (
    <Modal
      open={open}
      title={t('provider.customize')}
      eyebrow={t('overview.providerUsage')}
      subtitle={t('provider.customizeDescription')}
      onClose={onClose}
      className="provider-usage-customize-dialog sm:max-w-[680px]"
      fixedHeight
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-text-subtle">{t('provider.changesApplyImmediately')}</span>
            <button
              type="button"
              onClick={() => setPreferences({ ...DEFAULT_PROVIDER_USAGE_PREFERENCES })}
              className="text-xs font-medium text-text-muted underline decoration-border-subtle underline-offset-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >{t('provider.resetPreferences')}</button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-text-subtle">{t('provider.selectedCount', { count: draftSelection.length })}</span>
            {selectionChanged ? (
              <button
                type="button"
                onClick={onSave}
                disabled={saving || catalogLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >{saving ? t('provider.saving') : t('provider.saveSelection')}</button>
            ) : null}
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-5">
        <div role="group" aria-label={t('provider.customizeSection')} className="grid grid-cols-2 gap-1 rounded-xl border border-border-subtle bg-surface-raised/50 p-1">
          {(['providers', 'display'] as const).map((section) => (
            <button key={section} type="button" aria-pressed={activeSection === section} onClick={() => setActiveSection(section)}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${activeSection === section ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}>
              {section === 'providers' ? t('provider.providers') : t('provider.customize.display')}
            </button>
          ))}
        </div>

        {activeSection === 'providers' ? (
          <fieldset className="min-w-0">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.collectUsage')}</legend>
            <p className="mb-2 text-xs text-text-subtle">{t('provider.disabledNote')}</p>
            <p className="mb-2 text-xs text-text-subtle">{t('provider.collectionVisibilityHelp')}</p>
            <p className="mb-3 text-xs text-text-subtle">{t('provider.reorderSelectedHelp')}</p>
            <label className="relative mb-3 block">
              <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input
                type="search"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder={t('provider.searchProviders')}
                aria-label={t('provider.searchProviders')}
                className="w-full rounded-lg border border-border-subtle bg-surface-raised py-2 pl-9 pr-3 text-sm text-text placeholder:text-text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
            </label>
            {providerCatalog.error ? <p className="mb-2 text-xs text-warning" role="status">{providerCatalog.error}</p> : null}
            {error ? <p className="mb-2 text-xs text-negative" role="alert">{error}</p> : null}
            <div className="max-h-[28rem] divide-y divide-border-subtle overflow-y-auto rounded-xl border border-border-subtle">
              {catalogLoading ? <p className="p-3 text-sm text-text-muted">{t('provider.catalogLoading')}</p> : null}
              {filteredCatalogRows.map((row) => {
                const provider = providerCatalog.providers.find((entry) => entry.provider === row.provider);
                const rowIndex = selectedRows.findIndex(({ provider }) => provider === row.provider);
                const unavailableReason = provider && !provider.enabled && provider.source === 'codexbar'
                  ? t('provider.enableInCodexBar')
                  : provider && !provider.selectable ? t('provider.adminRestricted') : '';
                const showCardHelpId = `provider-show-card-disabled-${row.provider}`;
                return (
                  <div key={row.provider} className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 transition-colors hover:bg-surface-raised/60">
                    <div className="min-w-36 flex-1">
                      <p className="truncate text-sm font-medium text-text">{row.displayName}</p>
                      <p className="truncate text-[11px] text-text-subtle">{row.provider}{unavailableReason ? ` · ${unavailableReason}` : ''}</p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-text">
                      <input
                        type="checkbox"
                        checked={row.collectUsage}
                        disabled={!provider?.selectable || saving || catalogLoading}
                        onChange={() => {
                          if (needsCodexBarSetupAlert(provider?.source, provider?.enabled)) {
                            onRequestSetup(row.displayName, getCodexBarEnableCommand(row.provider));
                            return;
                          }
                          onToggle(row.provider);
                        }}
                        aria-label={`${t('provider.collectUsage')}: ${row.displayName}`}
                        className="h-4 w-4 shrink-0 accent-accent disabled:opacity-50"
                      />
                      {t('provider.collectUsage')}
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-text">
                      <input
                        type="checkbox"
                        checked={row.showCard}
                        disabled={row.showCardDisabled}
                        aria-describedby={row.showCardDisabled ? showCardHelpId : undefined}
                        onChange={(event) => setPreferences((current) => setProviderUsageProviderVisible(current, row.provider, event.target.checked))}
                        aria-label={`${t('provider.showCard')}: ${row.displayName}`}
                        className="h-4 w-4 shrink-0 accent-accent disabled:opacity-50"
                      />
                      {t('provider.showCard')}
                    </label>
                    {row.canReorder ? (
                      <div className="ml-auto flex shrink-0 gap-1">
                        {([-1, 1] as const).map((direction) => (
                          <button key={direction} type="button" aria-label={t(direction < 0 ? 'provider.moveUp' : 'provider.moveDown', { provider: row.displayName })}
                            disabled={direction < 0 ? rowIndex === 0 : rowIndex === selectedRows.length - 1}
                            onClick={() => setPreferences((current) => ({ ...current, providerOrder: moveProviderUsagePreference(getProviderUsageCatalogRows(providerCatalog.providers, draftSelection, current).filter((item) => item.collectUsage).map((item) => item.provider), row.provider, direction) }))}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-muted hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                            {direction < 0 ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {row.showCardDisabled ? <p id={showCardHelpId} className="basis-full text-[11px] text-text-subtle">{t('provider.showCardRequiresCollection')}</p> : null}
                  </div>
                );
              })}
              {!catalogLoading && filteredCatalogRows.length === 0 ? <p className="p-3 text-sm text-text-muted">{t('provider.noProvidersFound')}</p> : null}
            </div>
          </fieldset>
        ) : (
          <div className="flex flex-col gap-5">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.view')}</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(['compact', 'detailed'] as const).map((view) => <label key={view} className={`flex min-h-[4.5rem] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${preferences.view === view ? 'border-accent/40 bg-accent/5' : 'border-border-subtle hover:bg-surface-hover'}`}>
                  <input className="mt-0.5 shrink-0" type="radio" name="provider-usage-view" checked={preferences.view === view} onChange={() => setPreferences((current) => ({ ...current, view }))} />
                  <span className="min-w-0"><span className="block text-sm font-medium text-text">{t(`provider.view.${view}`)}</span><span className="mt-0.5 block text-xs text-text-subtle">{t(`provider.view.${view}Help`)}</span></span>
                </label>)}
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.layout')}</legend>
              <div className="grid grid-cols-3 gap-2">
                {([1, 2, 3] as const).map((columns) => <label key={columns} className={`relative flex min-h-[4.75rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border px-2 py-2 transition-colors ${preferences.columns === columns ? 'border-accent/40 bg-accent/5 text-text' : 'border-border-subtle text-text-muted hover:bg-surface-hover'}`}>
                  <input className="absolute left-3 top-3 accent-accent" type="radio" name="provider-usage-columns" checked={preferences.columns === columns} onChange={() => setPreferences((current) => ({ ...current, columns }))} />
                  <span aria-hidden="true" className="flex h-5 w-12 gap-1">
                    {Array.from({ length: columns }, (_, index) => <span key={index} className={`flex-1 rounded-sm border ${preferences.columns === columns ? 'border-accent/50 bg-accent/20' : 'border-border-subtle bg-surface-raised'}`} />)}
                  </span>
                  <span className="text-xs font-medium">{t('provider.columnsOption', { count: columns })}</span>
                </label>)}
              </div>
            </fieldset>
            <fieldset className="min-w-0 border-t border-border-subtle pt-4">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t('provider.fields')}{activeProviderLabel ? ` · ${activeProviderLabel}` : ''}
              </legend>
              <label className="mb-3 block max-w-sm text-xs font-medium text-text-muted">
                <span className="mb-1.5 block">{t('provider.displayProvider')}</span>
                <select
                  value={activeDisplayRow?.provider ?? ''}
                  onChange={(event) => setActiveProviderId(event.target.value)}
                  disabled={displayRows.length === 0}
                  className="w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-text disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {displayRows.map((row) => <option key={row.provider} value={row.provider}>{row.displayName}</option>)}
                </select>
              </label>
              {!activeDisplayRow ? <p className="text-sm text-text-muted">{t('provider.selectProviderForFields')}</p> : null}
              {activeDisplayRow && !activeProvider ? <p className="text-sm text-text-muted">{t('provider.noConfigurableFields')}</p> : null}
              {activeProvider && !activeFields ? <p className="text-sm text-text-muted">{t('provider.noConfigurableFields')}</p> : null}
              {activeProvider ? FIELD_GROUPS.map(({ id, label }) => {
                const fields = activeProvider[id] ?? [];
                if (fields.length === 0) return null;
                const hiddenFields = new Set(preferences.hiddenFields[activeProvider.provider]?.[id] ?? []);
                return (
                  <div key={id} className="mb-3 last:mb-0 rounded-xl border border-border-subtle bg-surface-raised/30 p-3">
                    <h3 className="mb-2 text-xs font-semibold text-text-muted">{t(label)}</h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {fields.map((field) => (
                        <label key={field.id} className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text">
                          <input
                            type="checkbox"
                            checked={!hiddenFields.has(field.id)}
                            onChange={(event) => setPreferences((current) => setProviderUsageFieldVisible(current, activeProvider.provider, id, field.id, event.target.checked))}
                            className="h-4 w-4 shrink-0 accent-accent"
                          />
                          <span className="truncate">{field.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              }) : null}
            </fieldset>
          </div>
        )}
      </div>
    </Modal>
  );
}
