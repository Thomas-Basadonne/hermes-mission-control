import { selectProviderUsageSummary, formatProviderUsagePercent, getProviderUsagePanelState } from '../../lib/provider-usage-display';
import { createProviderUsageSelectionController, isProviderUsageSelectionUncertain, isProviderUsageSelectionConflict } from '../../lib/provider-usage-selection';
import { getProviderUsageStatus, isProviderUsageRunning } from '../../lib/provider-usage-freshness';
import { useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Cloud, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { ProviderUsageMetricRow } from './ProviderUsageDetails';
import { Card } from '../ui/Card';
import { Modal } from '../Modal';
import {
  loadProviderUsage,
  loadProviderUsageCatalog,
  saveProviderUsageSelection,
  type MissionControlProviderCatalogSnapshot,
  type MissionControlProviderUsage,
  type MissionControlProviderUsageBalance,
  type MissionControlProviderUsageMetric,
  type MissionControlProviderUsageSnapshot,
  type MissionControlProviderUsageWindow,
} from '../../lib/hermes-api';
import { useMissionControl } from '../../lib/mission-control-store';
import { ProviderUsageHttpError, ProviderUsageTimeoutError } from '../../lib/provider-usage-request';
import {
  canCustomizeProviderUsageCatalog,
  createSerializedRefresh,
  getProviderUsageCatalogPollDelay,
  mergeProviderUsageSnapshot,
  createProviderUsageRetry,
} from '../../lib/provider-usage-refresh';
import {
  formatCurrency as formatLocalizedCurrency,
  formatDateTime,
  formatNumber as formatLocalizedNumber,
} from '../../lib/format';
import {
  DEFAULT_PROVIDER_USAGE_PREFERENCES,
  getProviderUsageCatalogRows,
  getProviderUsageSelectionForDisplay,
  getVisibleProviderUsageCards,
  getCodexBarEnableCommand,
  isProviderUsageCollectionCheckboxDisabled,
  needsCodexBarSetupAlert,
  hasProviderUsageSelectionChanges,
  loadProviderUsagePreferences,
  migrateFieldVisibility,
  moveProviderUsagePreference,
  saveProviderUsagePreferences,
  setProviderUsageProviderVisible,
  getFieldVisibility,
  setFieldVisibility,
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
  if (window.label === 'Session' && typeof window.windowMinutes === 'number' && window.windowMinutes > 0 && window.windowMinutes % 60 === 0) return t('provider.hourQuota', { hours: window.windowMinutes / 60 });
  if (window.id === 'primary' && window.label === 'Session') return t('provider.session');
  if (window.id === 'secondary' && window.label === 'Weekly') return t('provider.weekly');
  if (window.id === 'subscription' && window.label === 'Subscription') return t('provider.subscription');
  return window.label;
}

function balanceLabel(balance: MissionControlProviderUsageBalance, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    balance: ['Balance', 'provider.balance'], subscription_remaining: ['Subscription remaining', 'provider.subscriptionRemaining'],
    topup_remaining: ['Top-up remaining', 'provider.topupRemaining'], total_spendable: ['Total spendable', 'provider.totalSpendable'],
    credits_remaining: ['Credits remaining', 'provider.creditsRemaining'],
  };
  const alias = labels[balance.id];
  return alias && balance.label === alias[0] ? t(alias[1]) : balance.label;
}

function metricLabel(metric: { id: string; label: string }, t: Translate): string {
  if (metric.id === 'reset_credits_available' && metric.label === 'Reset credits available') return t('provider.resetCredits');
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
  const value = window.usageKnown !== false && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : null;
  const barValue = value === null ? undefined : Math.max(0, Math.min(100, value));
  const tone = value === null ? null : gaugeTone(value);
  const percent = value === null ? null : formatProviderUsagePercent(value, locale);
  const currency = window.unit && /^[A-Z]{3}$/.test(window.unit) ? window.unit : undefined;
  const remaining = typeof window.remaining === 'number' ? formatValue(window.remaining, currency, window.unit, locale) : null;
  const total = typeof window.total === 'number' ? formatValue(window.total, currency, window.unit, locale) : null;
  return (
    <div className={`flex flex-col ${detailed ? 'gap-2 rounded-lg border border-border-subtle p-3' : 'gap-1.5'}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 break-words font-medium text-text">{label}</span>
        <span className="shrink-0 text-text tabular-nums font-semibold">{percent ?? '—'}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={barValue} aria-valuetext={percent ?? t('provider.unavailableShort')}>
        {tone ? <div className={`h-full rounded-full transition-[width] duration-300 ${tone.className ?? ''}`} style={{ width: `${barValue}%`, backgroundColor: tone.color || undefined }} /> : null}
      </div>
      {detailed || window.resetsAt || window.resetDescription || typeof window.nextRegenPercent === 'number' ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
          {remaining !== null || total !== null ? <span>{t('provider.remainingOfTotal', { remaining: remaining ?? '—', total: total ?? '—' })}</span> : null}
          {window.resetsAt || window.resetDescription ? <span>{window.resetsAt ? formatReset(window.resetsAt, locale, t) : t('provider.reset', { date: window.resetDescription! })}</span> : null}
          {typeof window.nextRegenPercent === 'number' ? <span>{t('provider.nextRegen', { percent: formatProviderUsagePercent(window.nextRegenPercent, locale) })}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderCard({ provider, displayName, view = 'compact', locale, nowMs = Date.now(), preferences }: {
  provider: MissionControlProviderUsage;
  displayName?: string;
  view?: ProviderUsageView;
  locale: string;
  nowMs?: number;
  preferences?: ProviderUsagePreferences;
}) {
  const { t } = useI18n();
  const label = displayName ?? provider.provider;
  const unavailable = !provider.available;
  const balances = (Array.isArray(provider.balances) ? provider.balances : []).filter((balance) => typeof balance.value === 'number');
  const metrics = Array.isArray(provider.metrics) ? provider.metrics : [];
  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  const summary = selectProviderUsageSummary(provider, preferences);
  const compactWindows = { visible: summary.visible.filter((item) => item.group === 'windows').map((item) => item.field as MissionControlProviderUsageWindow), overflow: summary.overflow.filter((item) => item.group === 'windows').map((item) => item.field as MissionControlProviderUsageWindow) };
  const compactBalances = { visible: summary.visible.filter((item) => item.group === 'balances').map((item) => item.field as MissionControlProviderUsageBalance), overflow: summary.overflow.filter((item) => item.group === 'balances').map((item) => item.field as MissionControlProviderUsageBalance) };
  const compactMetrics = { visible: summary.visible.filter((item) => item.group === 'metrics').map((item) => item.field as MissionControlProviderUsageMetric), overflow: summary.overflow.filter((item) => item.group === 'metrics').map((item) => item.field as MissionControlProviderUsageMetric) };
  const overflowCount = summary.overflow.length;
  const state = getProviderUsageStatus(provider, nowMs);
  const stale = state === 'stale';
  const status = t({ available: 'provider.available', stale: 'provider.stale', updating: 'provider.updating', no_data: 'provider.noData', unavailable: 'provider.unavailableShort' }[state]);
  const updated = formatDate(provider.updatedAt, locale);
  const attempted = formatDate(provider.lastAttemptAt, locale);
  const nextRetry = Date.parse(provider.nextRetryAt ?? '') > nowMs ? formatDate(provider.nextRetryAt, locale) : null;
  const renews = formatRenews(provider.renewsAt, locale, t);
  const diagnostics = <div className="flex flex-col gap-1.5 text-xs text-text-subtle">
    {attempted ? <time dateTime={provider.lastAttemptAt ?? undefined}>{t('provider.lastAttempt', { time: attempted })}</time> : null}
    {nextRetry ? <time dateTime={provider.nextRetryAt ?? undefined}>{t('provider.nextRetry', { time: nextRetry })}</time> : null}
    {provider.dataConfidence ? <span>{t('provider.confidence')}: {provider.dataConfidence}</span> : null}
    {provider.source ? <span>{t('provider.source')}: {provider.source}</span> : null}
    {updated ? <time dateTime={provider.updatedAt ?? undefined}>{t('provider.lastSuccess', { time: updated })}</time> : null}
    {provider.warnings?.length ? <p className="break-words text-warning">{t('provider.warning')}: {provider.warnings.join(', ')}</p> : null}
  </div>;

  const renderFields = (fieldWindows: typeof windows, fieldBalances: typeof balances, fieldMetrics: typeof metrics, detailed: boolean) => (
    <div className="flex min-w-0 flex-col gap-3">
      {fieldWindows.length ? <section aria-label={t('provider.fields.windows')} className="flex min-w-0 flex-col gap-3">
        {fieldWindows.map((window) => <div key={window.id} className={window.featured ? 'rounded-lg border border-accent/20 bg-accent/5 p-2' : undefined} data-field-id={window.id}>
          <UsageGauge label={windowLabel(window, t)} window={window} locale={locale} detailed={detailed} t={t} />
        </div>)}
      </section> : null}
      {fieldBalances.length ? <dl aria-label={t('provider.fields.balances')} className="min-w-0">
        {fieldBalances.map((balance) => <div key={balance.id} data-field-id={balance.id} className={`flex min-w-0 items-start justify-between gap-3 border-b border-border-subtle py-2 ${balance.featured ? 'rounded-lg border border-accent/20 bg-accent/5 p-2' : ''}`}>
          <dt className="min-w-0 break-words text-xs text-text-muted">{balanceLabel(balance, t)}
            {balance.scope ? <span className="mt-1 block text-[11px]">{t(balance.scope === 'workspace' ? 'provider.workspaceBalance' : 'provider.accountBalance')}</span> : null}
            {formatDate(balance.updatedAt, locale) ? <time className="mt-1 block text-[11px]" dateTime={balance.updatedAt ?? undefined}>{t('provider.balanceObserved', { time: formatDate(balance.updatedAt, locale)! })}</time> : null}
          </dt>
          <dd className="min-w-0 break-words text-right text-sm font-semibold tabular-nums text-text">{formatValue(balance.value, balance.currency, balance.unit, locale)}</dd>
        </div>)}
      </dl> : null}
      {[...new Set(fieldMetrics.map((metric) => metric.kind === 'chart' ? t('provider.charts') : metric.sectionLabel ?? t('provider.otherData')))].map((section) => <section key={section} aria-label={section} className="min-w-0">
        {detailed ? <h4 className="mb-2 text-xs font-semibold text-text-muted">{section}</h4> : null}
        <dl className="min-w-0">
          {fieldMetrics.filter((metric) => (metric.kind === 'chart' ? t('provider.charts') : metric.sectionLabel ?? t('provider.otherData')) === section).map((metric) => <ProviderUsageMetricRow key={metric.id} metric={metric} locale={locale} label={metricLabel(metric, t)}
            dataLabel={t('provider.chartData')} enabledLabel={t('provider.enabled')} disabledLabel={t('provider.disabled')} detailed={detailed} showSectionLabel={!detailed} numericLabel={t('provider.numericValue')} />)}
        </dl>
      </section>)}
    </div>
  );

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface/50 p-3 shadow-sm" role="group" aria-label={`${label}: ${status}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-text">{label}</h3>
          {provider.plan ? <p className="mt-0.5 break-words text-xs text-text-muted">{provider.plan}</p> : null}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${unavailable || stale ? 'border-warning/30 text-warning' : 'border-positive/30 text-positive'}`} role="status">
          {unavailable || stale ? <AlertCircle size={12} aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
          {status}
        </span>
      </header>
      {provider.error ? <p className="break-words rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning" role="status">{provider.error}</p> : null}
      {provider.warnings?.length && view === 'compact' ? <p className="text-[11px] text-warning" role="status">{t('provider.partialData')}</p> : null}
      {unavailable && !provider.error ? (
        <p className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-sm text-text-muted" role="status" aria-live="polite">
          {state === 'no_data' ? t('provider.noData') : state === 'updating' ? t('provider.updating') : t('provider.unavailableShort')}
        </p>
      ) : !unavailable ? (
        <div className="flex min-w-0 flex-col gap-3">
          {view === 'detailed'
            ? renderFields(windows, balances, metrics, true)
            : renderFields(compactWindows.visible, compactBalances.visible, compactMetrics.visible, false)}
          {view === 'compact' && overflowCount > 0 ? <details className="min-w-0 text-xs provider-fields-overflow">
            <summary className="cursor-pointer text-accent">{t('provider.showAllFields', { count: overflowCount })}</summary>
            <div className="mt-3">{renderFields(compactWindows.overflow, compactBalances.overflow, compactMetrics.overflow, true)}</div>
          </details> : null}
          {renews ? <p className="break-words text-xs text-text-muted">{renews}</p> : null}
          {!windows.length && !balances.length && !metrics.length ? <p className="text-sm text-text-muted">{t('provider.noFields')}</p> : null}
        </div>
      ) : null}
      {provider.source || updated || attempted || nextRetry || provider.dataConfidence || provider.warnings?.length ? (
        <footer className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-text-subtle">
          {view === 'detailed' ? diagnostics : <>
            {unavailable && nextRetry ? <time dateTime={provider.nextRetryAt ?? undefined}>{t('provider.nextRetry', { time: nextRetry })}</time>
              : updated ? <time dateTime={provider.updatedAt ?? undefined}>{t(stale ? 'provider.lastGoodData' : 'provider.lastUpdated', { time: updated })}</time>
              : null}
            <details className="w-full min-w-0"><summary className="cursor-pointer text-accent">{t('provider.diagnostics')}</summary><div className="mt-2">{diagnostics}</div></details>
          </>}
        </footer>
      ) : null}
    </article>
  );
}

export function ProviderUsagePanel() {
  const { t, locale } = useI18n();
  const { storedToken } = useMissionControl();
  const numberLocale = locale === 'it' ? 'it-IT' : 'en-US';
  const [nowMs, setNowMs] = useState(Date.now);
  const [reconcilingSelection, setReconcilingSelection] = useState(false);
  const [recoveringSelection, setRecoveringSelection] = useState(false);
  const [snapshot, setSnapshot] = useState<MissionControlProviderUsageSnapshot | null>(null);
  const snapshotRef = useRef<MissionControlProviderUsageSnapshot | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<MissionControlProviderCatalogSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [usageInitializing, setUsageInitializing] = useState(true);
  const [manualCheck, setManualCheck] = useState<'idle' | 'checking' | 'collecting' | 'complete' | 'failed'>('idle');
  const manualCheckPending = useRef(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<string[]>([]);
  const [draftRevision, setDraftRevision] = useState<string | undefined>();
  const [providerSearch, setProviderSearch] = useState('');
  const [savingSelection, setSavingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionConflict, setSelectionConflict] = useState(false);
  const [setupProvider, setSetupProvider] = useState<{ name: string; command: string | null } | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);
  const [commandCopyFailed, setCommandCopyFailed] = useState(false);
  const [preferences, setPreferences] = useState(loadProviderUsagePreferences);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const customizeWasOpen = useRef(false);
  const forceCatalogRefreshRef = useRef(false);
  const selectionController = useRef(createProviderUsageSelectionController());
  const catalogAbortRef = useRef<AbortController | null>(null);
  const selectionAbortRef = useRef<AbortController | null>(null);
  const reconcileAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const clock = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(clock);
      catalogAbortRef.current?.abort();
      selectionAbortRef.current?.abort();
      reconcileAbortRef.current?.abort();
      selectionController.current.invalidate();
    };
  }, []);

  useEffect(() => {
    saveProviderUsagePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (snapshot?.providers.length) {
      setPreferences((current) => migrateFieldVisibility(snapshot.providers, current));
    }
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    const retry = createProviderUsageRetry();
    const load = async (forceRefresh = false) => {
      const captured = selectionController.current.beginRead();
      if (captured === null) return;
      let nextPollDelay = 60_000;
      setCatalogLoading(true);
      try {
        const catalog = await loadProviderUsageCatalog(storedToken || undefined, forceRefresh, controller.signal);
        const reconciledSave = !selectionController.current.canSave();
        if (cancelled || controller.signal.aborted || !selectionController.current.acceptRead(captured, catalog.available, catalog.selectionRevision)) return;
        setProviderCatalog((current) => catalog.available || !current?.available ? catalog : { ...current, error: catalog.error, refreshing: catalog.refreshing });
        if (reconciledSave) {
          setDraftSelection(catalog.selectedProviders);
          setDraftRevision(catalog.selectionRevision);
          setSelectionError(null);
          setRefreshKey((key) => key + 1);
        }
        setReconcilingSelection(!selectionController.current.canSave());
        setCatalogLoadFailed(!catalog.available || Boolean(catalog.error));
        retry.success();
        nextPollDelay = getProviderUsageCatalogPollDelay(catalog);
      } catch {
        if (!cancelled && !controller.signal.aborted) setCatalogLoadFailed(true);
        nextPollDelay = retry.failure();
      } finally {
        if (!cancelled && !controller.signal.aborted) {
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
      controller.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [catalogRefreshKey, storedToken]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    let nextPollDelay = 60_000;
    let initialFailures = 0;
    let initialized = false;
    setUsageInitializing(true);
    const retry = createProviderUsageRetry();
    const refresh = createSerializedRefresh(
      (signal) => loadProviderUsage(storedToken || undefined, signal),
      (next) => {
        initialized = true;
        setUsageInitializing(false);
        const merged = mergeProviderUsageSnapshot(snapshotRef.current, next);
        snapshotRef.current = merged;
        setSnapshot(merged);
        const running = merged.providers.some((provider) => isProviderUsageRunning(provider, Date.now()));
        if (manualCheckPending.current) {
          if (running) setManualCheck('collecting');
          else {
            manualCheckPending.current = false;
            const failed = !next.available || !merged.available || Boolean(merged.error)
              || merged.providers.some((provider) => provider.refreshState === 'failed' || provider.refreshState === 'running' || provider.dataState === 'error');
            setManualCheck(failed ? 'failed' : 'complete');
          }
        }
        setRefreshFailed(!next.available || Boolean(next.error));
        retry.success();
        nextPollDelay = running ? 1_500 : 60_000;
      },
      setRefreshing,
      (error) => {
        if (manualCheckPending.current) {
          manualCheckPending.current = false;
          setManualCheck('failed');
        }
        const transient = error instanceof TypeError || error instanceof ProviderUsageTimeoutError
          || (error instanceof ProviderUsageHttpError && (error.status === 408 || error.status === 429 || error.status >= 500));
        // Keep the initial loader through two retries, not indefinitely. A valid
        // response (even unavailable), auth or invalid JSON ends initialization.
        const recovering = !initialized && transient && ++initialFailures < 3;
        if (!recovering) initialized = true;
        setUsageInitializing(recovering);
        setRefreshFailed(true);
        nextPollDelay = retry.failure();
      },
    );
    const run = async () => {
      await refresh.run();
      if (!cancelled) pollTimer = window.setTimeout(() => void run(), nextPollDelay);
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
    setDraftRevision(providerCatalog?.selectionRevision);
    setProviderSearch('');
    setSelectionError(null);
    setSelectionConflict(false);
    setCustomizeOpen(true);
  };

  const cancelSelectionRecovery = () => {
    const controller = reconcileAbortRef.current;
    if (!controller) return;
    // Release the cancelled owner's UI state here: its guarded finally must not
    // be allowed to clear a recovery belonging to a later dialog cycle.
    reconcileAbortRef.current = null;
    controller.abort();
    setRecoveringSelection(false);
  };

  const closeCustomize = () => {
    if (savingSelection) return;
    cancelSelectionRecovery();
    setCustomizeOpen(false);
  };

  const toggleProvider = (provider: string) => {
    setDraftSelection((current) => current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider]);
  };

  const checkNow = () => {
    if (manualCheckPending.current || refreshing || (manualCheck !== 'failed' && snapshot?.providers.some((provider) => isProviderUsageRunning(provider, Date.now())))) return;
    manualCheckPending.current = true;
    setManualCheck('checking');
    setRefreshFailed(false);
    setRefreshKey((key) => key + 1);
    forceCatalogRefreshRef.current = false;
    setCatalogRefreshKey((key) => key + 1);
  };

  const saveSelection = async () => {
    if (!selectionController.current.beginSave(draftRevision)) return;
    catalogAbortRef.current?.abort();
    // A newer save fences any in-flight recovery read.
    cancelSelectionRecovery();
    setCatalogLoading(false);
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    setSavingSelection(true);
    setSelectionError(null);
    setSelectionConflict(false);
    let uncertain = false;
    try {
      const result = await saveProviderUsageSelection(draftSelection, storedToken || undefined, controller.signal, draftRevision);
      if (!mountedRef.current) return;
      setProviderCatalog((current) => current ? { ...current, selectedProviders: result.selectedProviders, selectionRevision: result.selectionRevision } : current);
      setCustomizeOpen(false);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      uncertain = isProviderUsageSelectionUncertain(error);
      if (isProviderUsageSelectionConflict(error)) {
        // A definite conflict, not an uncertain outcome: keep the dialog open and
        // require an explicit reconcile against the canonical revision.
        setSelectionConflict(true);
        setSelectionError(t('provider.selectionConflict'));
      } else {
        setSelectionError(t(uncertain ? 'provider.selectionReconcile' : 'provider.selectionSaveFailed'));
      }
    } finally {
      selectionController.current.settleSave(uncertain);
      if (mountedRef.current) {
        setReconcilingSelection(uncertain);
        setSavingSelection(false);
        setCatalogRefreshKey((key) => key + 1);
      }
    }
  };

  const reconcileSelectionConflict = async () => {
    // Serialize the recovery: a second click must not start a concurrent read,
    // and an in-flight recovery must be fenced by any newer save or dialog cycle.
    if (!selectionController.current.canSave() || reconcileAbortRef.current) return;
    const captured = selectionController.current.beginRead();
    if (captured === null) return;
    const controller = new AbortController();
    reconcileAbortRef.current = controller;
    setRecoveringSelection(true);
    try {
      // Read the canonical revision directly: never depend on poll timing. A
      // plain read reflects the committed selection; no forced provider refresh.
      const catalog = await loadProviderUsageCatalog(storedToken || undefined, false, controller.signal);
      if (!mountedRef.current || controller.signal.aborted
        || !selectionController.current.acceptRead(captured, catalog.available, catalog.selectionRevision)) return;
      if (!catalog.available || !catalog.selectionRevision) {
        setSelectionError(t('provider.selectionReconcile'));
        return;
      }
      setProviderCatalog(catalog);
      setDraftSelection(catalog.selectedProviders);
      setDraftRevision(catalog.selectionRevision);
      setSelectionConflict(false);
      setSelectionError(t('provider.selectionConflictResolved'));
    } catch {
      if (mountedRef.current && !controller.signal.aborted) setSelectionError(t('provider.selectionReconcile'));
    } finally {
      if (reconcileAbortRef.current === controller) {
        reconcileAbortRef.current = null;
        if (mountedRef.current) setRecoveringSelection(false);
      }
    }
  };

  const providerNames = new Map((providerCatalog?.providers ?? []).map((provider) => [provider.provider, provider.displayName]));
  const catalogRows = getProviderUsageCatalogRows(providerCatalog?.providers ?? [], draftSelection, preferences);
  const filteredCatalogRows = catalogRows.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.displayName} ${provider.provider}`.toLowerCase().includes(query);
  });
  const canCustomize = canCustomizeProviderUsageCatalog(providerCatalog, catalogLoading);
  const writerRunning = snapshot?.providers.some((provider) => isProviderUsageRunning(provider, nowMs)) === true;
  const manualCheckInProgress = manualCheck === 'checking' || manualCheck === 'collecting';
  const usageRefreshInProgress = manualCheckInProgress || refreshing || (writerRunning && manualCheck !== 'failed');
  const providers = snapshot?.providers ?? [];
  const panelState = getProviderUsagePanelState(snapshot, refreshFailed, usageInitializing);
  const visibleProviders = getVisibleProviderUsageCards(
    providers,
    getProviderUsageSelectionForDisplay(
      providers,
      providerCatalog?.selectedProviders ?? null,
      providerCatalog?.available === true,
    ),
    preferences,
  );

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
            onClick={checkNow}
            disabled={usageRefreshInProgress}
            aria-busy={usageRefreshInProgress}
            aria-describedby="provider-usage-check-status"
            title={t('provider.refreshHelp')}
            className="inline-flex min-w-28 items-center justify-center gap-1.5 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-accent/40 hover:bg-surface-hover hover:text-text active:translate-y-px disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RefreshCw size={13} className={usageRefreshInProgress ? 'animate-spin' : ''} aria-hidden="true" />
            {usageRefreshInProgress ? t('provider.checking') : t('provider.refresh')}
          </button>
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
      <div id="provider-usage-check-status" className="flex min-h-8 items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs text-text-muted" role="status" aria-live="polite" aria-atomic="true">
        {usageRefreshInProgress ? <RefreshCw size={13} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
          : manualCheck === 'complete' ? <CheckCircle2 size={13} className="shrink-0 text-accent" aria-hidden="true" />
            : manualCheck === 'failed' ? <AlertCircle size={13} className="shrink-0 text-warning" aria-hidden="true" /> : null}
        <p>{manualCheck === 'failed' ? snapshot?.error || t('provider.checkFailed')
          : manualCheck === 'collecting' || writerRunning ? t('provider.updating')
            : manualCheck === 'checking' ? t('provider.checkProgress')
              : manualCheck === 'complete' ? t('provider.checkComplete') : t('provider.refreshHelp')}</p>
      </div>
      {(refreshFailed || snapshot?.error) && panelState !== 'loading' && manualCheck !== 'failed' ? <p className="break-words border-b border-border-subtle px-3 py-2 text-xs text-warning" role="status">{snapshot?.error || t('provider.refreshFailed')}</p> : null}
      {panelState !== 'ready' ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" role={panelState === 'unavailable' ? 'alert' : 'status'} aria-live="polite">
          {panelState === 'unavailable' ? <AlertCircle size={20} className="text-warning" aria-hidden="true" /> : <RefreshCw size={20} className="animate-spin text-text-subtle" aria-hidden="true" />}
          <p className="text-sm text-text-muted">{panelState === 'unavailable' ? t('provider.unavailable') : t('provider.loading')}</p>
          {panelState === 'unavailable' ? (
            <button type="button" onClick={checkNow} disabled={usageRefreshInProgress} className="text-xs font-medium text-accent hover:underline disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {t('provider.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="p-3">
            <div className="provider-usage-cards">
              {visibleProviders.length > 0 ? visibleProviders.map((provider) => (
                <ProviderCard key={provider.provider} provider={provider} displayName={providerNames.get(provider.provider)} view={preferences.view} locale={numberLocale} nowMs={nowMs} preferences={preferences} />
              )) : <p className="w-full text-sm text-text-muted" role="status">{t('provider.noneSelected')}</p>}
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
        catalogLoading={catalogLoading && !providerCatalog?.available}
        draftSelection={draftSelection}
        filteredCatalogRows={filteredCatalogRows}
        search={providerSearch}
        saving={savingSelection || reconcilingSelection || recoveringSelection || !draftRevision}
        error={selectionError}
        selectionConflict={selectionConflict}
        onReconcileSelection={reconcileSelectionConflict}
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
  selectionConflict,
  onSearch,
  onToggle,
  onRequestSetup,
  onSave,
  onReconcileSelection,
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
  selectionConflict: boolean;
  onSearch: (value: string) => void;
  onToggle: (provider: string) => void;
  onRequestSetup: (name: string, command: string | null) => void;
  onSave: () => void;
  onReconcileSelection: () => void;
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
    ? providerNames.get(activeProvider.provider) ?? activeProvider.provider
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
            {selectionConflict ? (
              <button
                type="button"
                onClick={onReconcileSelection}
                disabled={saving}
                className="text-xs font-medium text-accent underline decoration-border-subtle underline-offset-2 hover:brightness-110 disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >{t('provider.reviewChanges')}</button>
            ) : null}
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
                        disabled={isProviderUsageCollectionCheckboxDisabled({
                          source: provider?.source,
                          enabled: provider?.enabled,
                          selectable: provider?.selectable,
                          saving,
                          catalogLoading,
                        })}
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
                return (
                  <div key={id} className="mb-3 last:mb-0 rounded-xl border border-border-subtle bg-surface-raised/30 p-3">
                    <h3 className="mb-2 text-xs font-semibold text-text-muted">{t(label)}</h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {fields.map((field) => {
                        const visibility = getFieldVisibility(preferences, activeProvider.provider, id, field.id);
                        return (
                          <div key={field.id} className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2">
                            <span className="min-w-0 break-words text-sm text-text">
                              {field.label}
                              {'sectionLabel' in field && field.sectionLabel ? <small className="block text-text-subtle">{field.sectionLabel}</small> : null}
                              {'kind' in field && field.kind === 'chart' ? <small className="block text-text-subtle">{t('provider.chart')}</small> : null}
                            </span>
                            <div className="flex gap-1">
                              {(['both', 'detailed', 'hidden'] as const).map((v) => (
                                <label key={v} className="inline-flex items-center gap-1 text-xs text-text-muted">
                                  <input
                                    type="radio"
                                    name={`visibility-${activeProvider.provider}-${id}-${field.id}`}
                                    className="h-3 w-3 accent-accent"
                                    checked={visibility === v}
                                    onChange={() => setPreferences((current) => setFieldVisibility(current, activeProvider.provider, id, field.id, v))}
                                  />
                                  {t(`provider.visibility.${v}`)}
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
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
