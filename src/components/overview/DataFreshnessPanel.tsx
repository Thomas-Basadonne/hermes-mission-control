import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import type { MissionControlSourceStatus } from '../../lib/mission-control-store';

export type FreshnessRow = {
  name: string;
  state: MissionControlSourceStatus['state'];
  source: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  kind: 'live' | 'previous' | 'unavailable' | 'loading';
  isIssue: boolean;
};

export type FreshnessSummary = {
  rows: FreshnessRow[];
  issues: FreshnessRow[];
  liveCount: number;
  lastIssueAttemptAt: string | null;
  newestSuccessAt: string | null;
};

/**
 * Classify every source for the freshness widget.
 *
 * `isIssue` is gated on `loading`: while the first refresh is still in flight every
 * source is unpopulated and the dashboard still renders its fallback snapshot, so
 * counting them flashed a burst of false warnings on the first paint. A genuine
 * outage keeps `loading` false after the failed load, so its warning survives.
 *
 * A source with a last known good response is `previous` (the values on screen are
 * stale but real); one that never succeeded is `unavailable`.
 */
export function summarizeFreshness(
  entries: Array<[string, MissionControlSourceStatus]>,
  loading: boolean,
): FreshnessSummary {
  const rows: FreshnessRow[] = entries.map(([name, status]) => {
    const lastSuccessAt = status.lastSuccessAt ?? null;
    const lastAttemptAt = status.lastAttemptAt ?? null;
    const kind: FreshnessRow['kind'] = status.state === 'live'
      ? 'live'
      : status.state === 'loading'
        ? 'loading'
        : lastSuccessAt
          ? 'previous'
          : 'unavailable';
    return {
      name,
      state: status.state,
      source: status.source ?? null,
      lastSuccessAt,
      lastAttemptAt,
      kind,
      isIssue: !loading && kind !== 'live' && kind !== 'loading',
    };
  });

  const issues = rows.filter((row) => row.isIssue);
  // ISO-8601 UTC strings compare chronologically, so a plain sort finds the extremes.
  const successTimestamps = rows
    .map((row) => row.lastSuccessAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const issueAttemptTimestamps = issues
    .map((row) => row.lastAttemptAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  return {
    rows,
    issues,
    liveCount: rows.filter((row) => row.kind === 'live').length,
    lastIssueAttemptAt: issueAttemptTimestamps.at(-1) ?? null,
    newestSuccessAt: successTimestamps.at(-1) ?? null,
  };
}

const KIND_DOT: Record<FreshnessRow['kind'], string> = {
  live: 'bg-positive',
  previous: 'bg-warning',
  unavailable: 'bg-negative',
  loading: 'bg-text-subtle',
};

function SourceRow({ row }: { row: FreshnessRow }) {
  const { t } = useI18n();
  const label = row.kind === 'live'
    ? t('overview.sourceLive')
    : row.kind === 'previous'
      ? t('overview.sourcePrevious')
      : row.kind === 'unavailable'
        ? t('overview.sourceUnavailable')
        : t('overview.refreshing');
  return (
    <div className="flex min-w-0 items-center gap-2 py-1.5 text-xs">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${KIND_DOT[row.kind]}`} />
      <span className="shrink-0 font-medium text-text">{t(`overview.source.${row.name}`)}</span>
      <span className="min-w-0 flex-1 truncate text-text-muted">
        {label}
        {row.kind === 'previous' && row.source ? ` · ${t('overview.sourceProvenance', { source: row.source })}` : ''}
      </span>
      <span className="shrink-0 text-[11px] text-text-subtle">
        {row.lastSuccessAt ? formatRelativeTime(row.lastSuccessAt) : t('overview.never')}
      </span>
    </div>
  );
}

/**
 * Data freshness widget.
 *
 * Healthy is the default, so the panel collapses to a single line: no wall of `Live`
 * badges and no absolute timestamps repeated for every source. Only the sources that
 * are not live get a row of their own, and the absolute attempt time appears only
 * where it carries information — next to the failing sources, where it helps decide
 * whether to retry.
 */
export function DataFreshnessPanel({
  sources,
  loading,
  onRetry,
}: {
  sources: Array<[string, MissionControlSourceStatus]>;
  loading: boolean;
  onRetry?: () => void | Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { rows, issues, liveCount, lastIssueAttemptAt, newestSuccessAt } = summarizeFreshness(sources, loading);
  const hasIssues = issues.length > 0;

  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Card padding="none">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 pb-2 pt-3">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">{t('nav.overview')}</span>
          <h2 className="text-sm font-semibold text-text">{t('overview.dataFreshness')}</h2>
        </div>
        {hasIssues ? (
          <Badge variant={issues.some((row) => row.kind === 'unavailable') ? 'negative' : 'warning'}>
            {t('overview.freshnessNeedsAttention', { count: issues.length })}
          </Badge>
        ) : (
          <Badge variant="positive" dot>{t('overview.freshnessAllFresh')}</Badge>
        )}
      </div>

      <div className="flex flex-col p-3">
        {hasIssues ? (
          <div className="flex flex-col">
            {issues.map((row) => <SourceRow key={row.name} row={row} />)}
            {liveCount > 0 ? (
              <div className="flex items-center gap-2 py-1.5 text-xs text-text-subtle">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${KIND_DOT.live}`} />
                <span className="min-w-0 flex-1 truncate">
                  {t('overview.freshnessOtherSources', { count: liveCount })}
                </span>
              </div>
            ) : null}
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
              <span className="text-[11px] text-text-subtle">
                {lastIssueAttemptAt
                  ? t('overview.freshnessLastAttempt', { time: formatDateTime(lastIssueAttemptAt, locale) })
                  : t('overview.notYetSynced')}
              </span>
              {onRetry ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />}
                  disabled={retrying}
                  onClick={retry}
                >
                  {t('overview.refresh')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-1 text-sm italic text-text-muted">{t('overview.refreshing')}</p>
        ) : (
          <div className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2 py-1 text-xs">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${KIND_DOT.live}`} />
              <span className="min-w-0 flex-1 truncate text-text-muted">
                {newestSuccessAt
                  ? t('overview.freshnessLiveSummary', { count: liveCount, time: formatRelativeTime(newestSuccessAt) })
                  : t('overview.freshnessAllFresh')}
              </span>
              <button
                type="button"
                className="shrink-0 text-[11px] font-medium text-accent transition-colors hover:text-accent/80"
                aria-expanded={showAll}
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll ? t('overview.freshnessHideDetails') : t('overview.freshnessDetails')}
              </button>
            </div>
            {showAll ? rows.map((row) => <SourceRow key={row.name} row={row} />) : null}
          </div>
        )}
      </div>
    </Card>
  );
}
