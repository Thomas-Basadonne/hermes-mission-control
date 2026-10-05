import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Cloud, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Card } from '../ui/Card';
import { Modal } from '../Modal';
import {
  loadProviderUsage,
  type MissionControlProviderUsage,
  type MissionControlProviderUsageBalance,
  type MissionControlProviderUsageSnapshot,
  type MissionControlProviderUsageWindow,
} from '../../lib/hermes-api';
import { useI18n } from '../../lib/i18n';
import {
  formatCurrency as formatLocalizedCurrency,
  formatDateTime,
  formatNumber as formatLocalizedNumber,
  formatPercent,
} from '../../lib/format';
import { useMissionControl } from '../../lib/mission-control-store';
import { createSerializedRefresh } from '../../lib/provider-usage-refresh';
import {
  applyProviderUsagePreferences,
  DEFAULT_PROVIDER_USAGE_PREFERENCES,
  loadProviderUsagePreferences,
  moveProviderUsagePreference,
  orderProviderUsage,
  saveProviderUsagePreferences,
  setProviderUsageFieldVisible,
  setProviderUsageProviderVisible,
  type ProviderUsagePreferences,
  type ProviderUsageFieldGroup,
  type ProviderUsageView,
} from '../../lib/provider-usage-preferences';

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  ollama: 'Ollama Cloud',
  openrouter: 'OpenRouter',
  nous: 'Nous Portal',
};

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
  if (window.id === 'primary') return t('provider.session');
  if (window.id === 'secondary') return t('provider.weekly');
  if (window.id === 'subscription') return t('provider.subscription');
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
  return metric.id === 'reset_credits_available' ? t('provider.resetCredits') : metric.label;
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
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={percent ?? t('provider.unavailableShort')}
      >
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

function MetricRow({ metric, locale, t }: {
  metric: MissionControlProviderUsage['metrics'][number];
  locale: string;
  t: Translate;
}) {
  return (
    <div key={metric.id} className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <dt className="text-sm text-text-muted">{metricLabel(metric, t)}</dt>
      <dd className="text-sm font-medium tabular-nums text-text text-right">{metricValue(metric.value, metric.unit, locale, t)}</dd>
    </div>
  );
}

export function ProviderCard({ provider, view, locale }: {
  provider: MissionControlProviderUsage;
  view: ProviderUsageView;
  locale: string;
}) {
  const { t } = useI18n();
  const label = PROVIDER_LABELS[provider.provider] ?? provider.provider;
  const unavailable = !provider.available;
  const balances = (Array.isArray(provider.balances) ? provider.balances : []).filter((balance) => typeof balance.value === 'number');
  const primaryBalance = balances.find((balance) => balance.id === 'total_spendable' || balance.id === 'balance') ?? balances[0];
  const secondaryBalances = balances.filter((balance) => balance !== primaryBalance);
  const metrics = (Array.isArray(provider.metrics) ? provider.metrics : []).filter((metric) => metric.value !== null && metric.value !== undefined);
  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  const resetCreditMetrics = provider.provider === 'codex' ? metrics.filter((metric) => metric.id === 'reset_credits_available') : [];
  const displayMetrics = metrics.filter((metric) => !resetCreditMetrics.includes(metric));
  const featuredMetrics = metrics.filter((metric) => metric.featured && !resetCreditMetrics.includes(metric));
  const regularMetrics = metrics.filter((metric) => !metric.featured && !resetCreditMetrics.includes(metric));
  const status = unavailable ? t('provider.unavailableShort') : provider.stale ? t('provider.stale') : t('provider.available');
  const updated = formatDate(provider.updatedAt, locale);
  const renews = formatRenews(provider.renewsAt, locale, t);

  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface/50 p-3 shadow-sm"
      role="group"
      aria-label={`${label}: ${status}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-text">{label}</h3>
          {provider.plan ? <p className="mt-0.5 truncate text-xs text-text-muted">{provider.plan}</p> : null}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${unavailable ? 'border-warning/30 text-warning' : provider.stale ? 'border-warning/30 text-warning' : 'border-positive/30 text-positive'}`} role="status">
          {unavailable || provider.stale ? <AlertCircle size={12} aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
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
          {windows.length === 0 && balances.length === 0 && metrics.length === 0 ? (
            <p className="text-sm text-text-muted">{t('provider.noFields')}</p>
          ) : null}
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

function ProviderUsageCustomizeDialog({
  open,
  onClose,
  providers,
  preferences,
  setPreferences,
}: {
  open: boolean;
  onClose: () => void;
  providers: MissionControlProviderUsage[];
  preferences: ProviderUsagePreferences;
  setPreferences: Dispatch<SetStateAction<ProviderUsagePreferences>>;
}) {
  const { t } = useI18n();
  const orderedProviders = orderProviderUsage(providers, preferences);
  const [activeProviderId, setActiveProviderId] = useState(providers[0]?.provider ?? '');
  const [activeSection, setActiveSection] = useState<'data' | 'display'>('data');
  const activeProvider = orderedProviders.find(({ provider }) => provider === activeProviderId) ?? orderedProviders[0];
  const activeProviderLabel = activeProvider
    ? PROVIDER_LABELS[activeProvider.provider] ?? activeProvider.provider
    : '';
  const activeFields = activeProvider
    ? FIELD_GROUPS.some(({ id }) => (activeProvider[id] ?? []).length > 0)
    : false;

  return (
    <Modal
      open={open}
      title={t('provider.customize')}
      eyebrow={t('overview.providerUsage')}
      subtitle={t('provider.preferencesHelp')}
      onClose={onClose}
      className="provider-usage-customize-dialog sm:max-w-[680px]"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-text-subtle">{t('provider.changesApplyImmediately')}</span>
          <button
            type="button"
            onClick={() => setPreferences({ ...DEFAULT_PROVIDER_USAGE_PREFERENCES })}
            className="shrink-0 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-muted hover:border-warning/40 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >{t('provider.resetPreferences')}</button>
        </div>
      )}
    >
      <div className="flex flex-col gap-5">
        <div role="group" aria-label={t('provider.customizeSection')} className="grid grid-cols-2 gap-1 rounded-xl border border-border-subtle bg-surface-raised/50 p-1">
          {(['data', 'display'] as const).map((section) => (
            <button
              key={section}
              type="button"
              aria-pressed={activeSection === section}
              onClick={() => setActiveSection(section)}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${activeSection === section ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
            >{t(`provider.customize.${section}`)}</button>
          ))}
        </div>

        {activeSection === 'data' ? (
        <div className="flex flex-col gap-5">
        <fieldset className="min-w-0">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.providers')}</legend>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle">
            {orderedProviders.map((provider, index) => {
              const label = PROVIDER_LABELS[provider.provider] ?? provider.provider;
              const visible = !preferences.hiddenProviders.includes(provider.provider);
              return (
                <div key={provider.provider} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(event) => setPreferences((current) => setProviderUsageProviderVisible(current, provider.provider, event.target.checked))}
                    />
                    <span className="min-w-0 truncate font-medium">{label}</span>
                    {!provider.available ? <span className="shrink-0 text-[11px] text-text-subtle">{t('provider.unavailableShort')}</span> : null}
                  </label>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label={t('provider.moveUp', { provider: label })}
                      title={t('provider.moveUp', { provider: label })}
                      disabled={index === 0}
                      onClick={() => setPreferences((current) => ({
                        ...current,
                        providerOrder: moveProviderUsagePreference(
                          orderProviderUsage(providers, current).map((item) => item.provider),
                          provider.provider,
                          -1,
                        ),
                      }))}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-muted hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    ><ArrowUp size={14} aria-hidden="true" /></button>
                    <button
                      type="button"
                      aria-label={t('provider.moveDown', { provider: label })}
                      title={t('provider.moveDown', { provider: label })}
                      disabled={index === orderedProviders.length - 1}
                      onClick={() => setPreferences((current) => ({
                        ...current,
                        providerOrder: moveProviderUsagePreference(
                          orderProviderUsage(providers, current).map((item) => item.provider),
                          provider.provider,
                          1,
                        ),
                      }))}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-muted hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    ><ArrowDown size={14} aria-hidden="true" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>

        <section aria-labelledby="provider-usage-fields-heading" className="min-w-0">
          <h4 id="provider-usage-fields-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.fields')}</h4>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('provider.fields')}>
            {orderedProviders.map((provider) => {
              const label = PROVIDER_LABELS[provider.provider] ?? provider.provider;
              const selected = activeProvider?.provider === provider.provider;
              return (
                <button
                  key={provider.provider}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setActiveProviderId(provider.provider)}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected ? 'border-accent/40 bg-accent/10 text-text' : 'border-border-subtle text-text-muted hover:bg-surface-hover hover:text-text'}`}
                >{label}</button>
              );
            })}
          </div>
          {activeProvider ? (
            <div className="rounded-xl border border-border-subtle bg-surface/40 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h5 className="text-sm font-semibold text-text">{activeProviderLabel}</h5>
                {!activeProvider.available ? <span className="rounded-full border border-warning/30 px-2 py-0.5 text-[10px] text-warning">{t('provider.unavailableShort')}</span> : null}
              </div>
              {activeFields ? (
                <div className="flex flex-col gap-4">
                  {FIELD_GROUPS.map((group) => {
                    const fields = activeProvider[group.id] ?? [];
                    if (fields.length === 0) return null;
                    return (
                      <section key={group.id} aria-labelledby={`provider-usage-${group.id}-heading`}>
                        <h6 id={`provider-usage-${group.id}-heading`} className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">{t(group.label)}</h6>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {fields.map((field) => {
                            const hidden = preferences.hiddenFields[activeProvider.provider]?.[group.id]?.includes(field.id) ?? false;
                            const label = group.id === 'windows'
                              ? windowLabel(field as MissionControlProviderUsageWindow, t)
                              : group.id === 'balances'
                                ? balanceLabel(field as MissionControlProviderUsageBalance, t)
                                : metricLabel(field, t);
                            return (
                              <label key={field.id} className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${hidden ? 'border-border-subtle text-text-muted' : 'border-accent/25 bg-accent/5 text-text'}`}>
                                <input
                                  className="mt-0.5 shrink-0"
                                  type="checkbox"
                                  checked={!hidden}
                                  onChange={(event) => setPreferences((current) => setProviderUsageFieldVisible(
                                    current,
                                    activeProvider.provider,
                                    group.id,
                                    field.id,
                                    event.target.checked,
                                  ))}
                                />
                                <span className="min-w-0 break-words">{label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : <p className="text-sm text-text-subtle">{t('provider.noConfigurableFields')}</p>}
            </div>
          ) : <p className="rounded-xl border border-dashed border-border-subtle p-4 text-sm text-text-subtle">{t('provider.noProviders')}</p>}
        </section>
        </div>
        ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset className="min-w-0">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.view')}</legend>
            <div className="flex flex-col gap-2">
              {(['compact', 'detailed'] as const).map((view) => (
                <label key={view} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${preferences.view === view ? 'border-accent/40 bg-accent/5' : 'border-border-subtle hover:bg-surface-hover'}`}>
                  <input
                    className="mt-0.5 shrink-0"
                    type="radio"
                    name="provider-usage-view"
                    checked={preferences.view === view}
                    onChange={() => setPreferences((current) => ({ ...current, view }))}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text">{t(`provider.view.${view}`)}</span>
                    <span className="mt-0.5 block text-xs text-text-subtle">{t(`provider.view.${view}Help`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t('provider.layout')}</legend>
            <div className="grid grid-cols-3 gap-2">
              {([1, 2, 3] as const).map((columns) => (
                <label key={columns} className={`flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border px-2 py-2 text-xs font-medium transition-colors ${preferences.columns === columns ? 'border-accent/40 bg-accent/5 text-text' : 'border-border-subtle text-text-muted hover:bg-surface-hover'}`}>
                  <input
                    type="radio"
                    name="provider-usage-columns"
                    checked={preferences.columns === columns}
                    onChange={() => setPreferences((current) => ({ ...current, columns }))}
                  />
                  {t('provider.columnsOption', { count: columns })}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        )}
      </div>
    </Modal>
  );
}

export function ProviderUsagePanel() {
  const { t, locale } = useI18n();
  const { storedToken } = useMissionControl();
  const [snapshot, setSnapshot] = useState<MissionControlProviderUsageSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [preferences, setPreferences] = useState(loadProviderUsagePreferences);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const customizeWasOpen = useRef(false);
  const numberLocale = locale === 'it' ? 'it-IT' : 'en-US';

  useEffect(() => {
    saveProviderUsagePreferences(preferences);
  }, [preferences]);

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
      if (!first || !last) return;
      const outsideDialog = !dialog.contains(document.activeElement);
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

  useEffect(() => {
    const refresh = createSerializedRefresh(
      (signal) => loadProviderUsage(storedToken || undefined, signal),
      (next) => {
        setSnapshot((current) => next.available || !current?.available ? next : current);
        setRefreshFailed(!next.available);
      },
      setRefreshing,
    );
    void refresh.run();
    const interval = window.setInterval(() => void refresh.run(), 60_000);
    return () => {
      window.clearInterval(interval);
      refresh.cancel();
    };
  }, [storedToken, refreshKey]);

  const providers = snapshot?.providers ?? [];
  const orderedProviders = orderProviderUsage(providers, preferences);
  const visibleProviders = applyProviderUsagePreferences(providers, preferences);
  const gridColumns = [
    'grid-cols-1',
    'grid-cols-1 sm:grid-cols-2',
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  ][preferences.columns - 1];

  return (
    <Card padding="none" role="region" aria-labelledby="provider-usage-title" aria-busy={refreshing}>
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
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1.5 text-xs font-medium text-text-muted hover:text-text disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            {t('provider.refresh')}
          </button>
          {snapshot?.available ? (
            <button
              ref={customizeButtonRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={customizeOpen}
              onClick={() => setCustomizeOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-accent/30 hover:bg-surface-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              {t('provider.customize')}
            </button>
          ) : null}
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
          <div className={`grid ${gridColumns} gap-3 p-3`}>
            {visibleProviders.map((provider) => (
              <ProviderCard key={provider.provider} provider={provider} view={preferences.view} locale={numberLocale} />
            ))}
            {visibleProviders.length === 0 ? <p className="text-sm text-text-muted" role="status">{t('provider.noVisibleProviders')}</p> : null}
          </div>
        </>
      )}
      <ProviderUsageCustomizeDialog
        open={customizeOpen && Boolean(snapshot?.available)}
        onClose={() => setCustomizeOpen(false)}
        providers={providers}
        preferences={preferences}
        setPreferences={setPreferences}
      />
    </Card>
  );
}
