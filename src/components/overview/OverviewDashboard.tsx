import { useI18n } from '../../lib/i18n';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Clock3, List, MessageSquare, Rocket } from 'lucide-react';
import { useMissionControl, type MissionControlSourceStatus } from '../../lib/mission-control-store';
import { getPluginRegistry } from '../../core/plugin-registry';
import type { MCPluginAttentionContributor, MCPluginOverviewContributor } from '../../core/plugins/types';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { AgentStatusBar } from './AgentStatusBar';
import { SystemHealthPanel } from './SystemHealthPanel';
import { AttentionNeeded } from './AttentionNeeded';
import { QuickActions } from './QuickActions';
import { UsagePanel } from './UsagePanel';
import { ProviderUsagePanel } from './ProviderUsagePanel';
import { DashboardGrid, type DashboardWidget } from './DashboardGrid';
import { formatDateTime, formatRelativeSchedule, formatRelativeTime } from '../../lib/format';
import { type MissionControlCronJob } from '../../lib/hermes-api';
import { getSessionActionAvailability } from '../../lib/session-view';
import { usePullToReload } from '../../hooks/usePullToReload';
import { PullToReloadIndicator } from '../PullToReloadIndicator';

function SectionLink({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors duration-150 hover:bg-surface-sunken hover:text-accent sm:h-auto sm:w-auto sm:justify-start sm:gap-1.5 sm:rounded-none sm:bg-transparent"
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{children}</span>
      <span className="hidden sm:inline">{label}</span>
      <ArrowRight aria-hidden="true" className="hidden h-3 w-3 sm:inline" />
    </Link>
  );
}

function SectionCard({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  eyebrow: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card padding="none">
      <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-border-subtle">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">{eyebrow}</span>
          <h2 className="text-sm font-semibold text-text">{title}</h2>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="p-3">{children}</div>
    </Card>
  );
}

function cronHasError(job: MissionControlCronJob): boolean {
  return Boolean(job.lastError) || job.lastStatus === 'error' || job.lastStatus === 'failed';
}

function cronStatusLabel(job: MissionControlCronJob, t: (key: string) => string): string {
  if (cronHasError(job)) return t('cron.status.error');
  if (!job.enabled || job.state === 'paused') return t('cron.status.paused');
  if (job.state === 'running') return t('overview.cronStatusRunning');
  if (job.state === 'completed') return t('cron.status.completed');
  return t('overview.cronStatusScheduled');
}

function cronNextRunMs(job: MissionControlCronJob): number | null {
  if (!job.nextRunAt) return null;
  const parsed = Date.parse(job.nextRunAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function sortUpcomingCronJobs(jobs: MissionControlCronJob[]): MissionControlCronJob[] {
  const now = Date.now();
  return [...jobs]
    .filter((job) => job.enabled && job.state !== 'paused')
    .sort((a, b) => {
      const aNext = cronNextRunMs(a);
      const bNext = cronNextRunMs(b);
      const aUpcoming = aNext !== null && aNext >= now;
      const bUpcoming = bNext !== null && bNext >= now;
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      if (aNext !== null && bNext !== null && aNext !== bNext) return aNext - bNext;
      if (aNext !== null && bNext === null) return -1;
      if (aNext === null && bNext !== null) return 1;
      return a.label.localeCompare(b.label);
    });
}

export function OverviewDashboard() {
  const { t, locale } = useI18n();
  const attentionContributors: MCPluginAttentionContributor[] = getPluginRegistry().getAttentionContributors();
  const overviewContributors: MCPluginOverviewContributor[] = getPluginRegistry().getOverviewContributors();
  const {
    snapshot,
    loading,
    sources,
    actionLoading,
    gatewayActions,
    runGatewayAction,
  } = useMissionControl();

  const { machine, sessions, cron, alerts, backendHealth, gatewayStatus } = snapshot;
  const liveSessionItems = sessions.items.filter((session) => session.status === 'live').slice(0, 3);
  const cronItems = sortUpcomingCronJobs(cron.items).slice(0, 3);
  const runningCron = cron.items.filter((job) => job.state === 'running').length;
  const failedCron = cron.items.filter(cronHasError).length;
  const pausedCron = cron.items.filter((job) => !job.enabled || job.state === 'paused').length;
  const scheduledCron = cron.items.filter((job) => job.enabled && job.state !== 'paused' && job.state !== 'running' && !cronHasError(job)).length;
  const sourceStatuses = Object.entries(sources).filter((entry): entry is [string, MissionControlSourceStatus] => Boolean(entry[1]));
  const sourceIssues = computeSourceIssues(loading, sourceStatuses);
  const sessionIsLive = sources.sessions?.state === 'live';

  const widgets: DashboardWidget[] = [
    {
      id: 'health',
      label: 'System health',
      className: 'widget-health',
      content: (
        <SystemHealthPanel machine={machine} gatewayStatus={gatewayStatus} backendHealth={backendHealth} />
      ),
    },
    {
      id: 'provider-usage',
      label: 'Provider usage',
      className: 'widget-provider-usage',
      locked: true,
      content: <ProviderUsagePanel />,
    },
    {
      id: 'usage',
      label: 'Token usage',
      className: 'widget-usage',
      content: <UsagePanel />,
    },
    {
      id: 'attention',
      label: 'Attention needed',
      className: 'widget-attention',
      content: <AttentionNeeded alerts={loading ? [] : alerts.items} pluginContributors={attentionContributors} dataWarningCount={sourceIssues.length} />,
    },
    {
      id: 'current-session',
      label: 'Live sessions',
      className: 'widget-current-session',
      content: (
        <SectionCard
          eyebrow={t('overview.currentSession')}
          title={liveSessionItems.length > 0
            ? sessionIsLive
              ? t('overview.liveSessionsTitle', { count: liveSessionItems.length })
              : t('overview.previousSessionsTitle', { count: liveSessionItems.length })
            : t('overview.noActiveSession')}
          actions={
          <SectionLink to="/sessions" label={t('overview.allSessions')}>
            <List className="h-4 w-4" />
          </SectionLink>
          }
        >
          {liveSessionItems.length > 0 ? (
            <div className="flex flex-col gap-3">
              {liveSessionItems.map((session) => {
                const actions = getSessionActionAvailability(session);
                return (
                <div key={session.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-sunken/30 p-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${sessionIsLive ? 'bg-positive shadow-[0_0_0_3px_rgba(52,211,153,0.14)] animate-pulse' : 'bg-warning'}`} />
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-text">{session.title}</p>
                        {sessionIsLive ? <span className="sr-only">{t('sessions.liveStatus')}</span> : null}
                        {sessionIsLive ? <span className="hidden shrink-0 sm:inline-flex">
                          <Badge variant="positive" dot>{t('sessions.liveStatus')}</Badge>
                        </span> : null}
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-text-muted">{session.preview || t('overview.noPreview')}</p>
                    </div>
                    {actions.resumeChat ? (
                      <Link
                        to={`/sessions?chatSession=${encodeURIComponent(session.id)}`}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-accent text-white transition-colors hover:bg-accent/85 sm:h-auto sm:w-auto sm:gap-1 sm:px-2 sm:py-1 sm:text-[11px] sm:font-medium"
                        aria-label={t('sessions.resumeAria', { title: session.title })}
                        title={t('sessions.resumeAria', { title: session.title })}
                      >
                        <MessageSquare aria-hidden="true" className="h-4 w-4 sm:h-3 sm:w-3" />
                        <span className="hidden sm:inline">{t('sessions.resumeChat')}</span>
                      </Link>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-subtle">
                    <span className="flex items-center gap-1"><Rocket className="h-3 w-3" />{session.source}</span>
                    <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{session.messageCount} msgs</span>
                    <span>{formatRelativeTime(session.lastActive)}</span>
                  </div>
                </div>
              );
            })}
            </div>
          ) : (
            <p className="text-sm text-text-muted italic py-1">{t('overview.noActiveSessions')}</p>
          )}
        </SectionCard>
      ),
    },
    ...overviewContributors.map((contributor): DashboardWidget => {
      const Component = contributor.component;
      return {
        id: `plugin:${contributor.id}`,
        label: contributor.label,
        className: contributor.className,
        content: <Component />,
      };
    }),
    {
      id: 'quick-actions',
      label: 'Quick actions',
      className: 'widget-quick-actions',
      content: (
        <QuickActions
          gatewayActions={gatewayActions}
          runGatewayAction={runGatewayAction}
          actionLoading={actionLoading}
        />
      ),
    },
    ...(cronItems.length > 0
      ? [
          {
            id: 'cron',
            label: 'Scheduled jobs',
            className: 'widget-cron',
            content: (
              <SectionCard
                eyebrow={t('overview.scheduledJobs')}
                title={t('overview.cronStatusAtGlance')}
                actions={(
                  <SectionLink to="/cron" label={t('overview.cronViewAll')}>
                    <Clock3 className="h-4 w-4" />
                  </SectionLink>
                )}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge variant="default">{t('overview.cronTotal', { count: cron.items.length })}</Badge>
                  <Badge variant={scheduledCron > 0 ? 'positive' : 'default'}>{t('overview.cronScheduled', { count: scheduledCron })}</Badge>
                  {runningCron > 0 ? <Badge variant="accent">{t('overview.cronRunning', { count: runningCron })}</Badge> : null}
                  {failedCron > 0 ? <Badge variant="negative">{t('overview.cronFailed', { count: failedCron })}</Badge> : null}
                  {pausedCron > 0 ? <Badge variant="warning">{t('overview.cronPaused', { count: pausedCron })}</Badge> : null}
                </div>
                <div className="flex flex-col gap-2">
                  {cronItems.map((job) => (
                    <div key={job.id} className="rounded-lg bg-surface-sunken/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-2 text-sm">
                        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${cronHasError(job) ? 'bg-negative' : !job.enabled || job.state === 'paused' ? 'bg-warning' : job.state === 'running' ? 'bg-accent animate-pulse' : 'bg-positive'}`} />
                        <span className="min-w-0 flex-1 truncate font-medium text-text">{job.label}</span>
                        <span className="shrink-0 text-xs text-text-muted">
                          {formatRelativeSchedule(job.nextRunAt, locale) ?? t('overview.cronNoNextRun')}
                        </span>
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-subtle">
                        <span>{cronStatusLabel(job, t)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{job.lastRunAt ? t('overview.cronLastRun', { time: formatRelativeSchedule(job.lastRunAt, locale) ?? t('overview.cronNeverRun') }) : t('overview.cronNeverRun')}</span>
                      </div>
                      {job.lastError ? <p className="mt-1 truncate text-[11px] text-negative">{job.lastError}</p> : null}
                    </div>
                  ))}
                </div>
              </SectionCard>
            ),
          } as DashboardWidget,
        ]
      : []),
  ].filter((widget): widget is DashboardWidget => Boolean(widget.content));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const { refreshAll, storedToken } = useMissionControl();
  const { state: pullState } = usePullToReload({
    containerRef,
    onReload: async () => {
      await refreshAll(storedToken || undefined, { silent: false, includeReference: true, includeSnapshot: true });
    },
  });

  return (
    <div ref={containerRef} className="route-page-scroll flex flex-col h-full overflow-y-auto">
      <PullToReloadIndicator state={pullState} />
      <AgentStatusBar />
      <div className="p-4 sm:p-6">
        <DashboardGrid widgets={widgets} />
        <section className="mt-6 border-t border-border-subtle pt-4" aria-label={t('overview.dataFreshness')}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold text-text">{t('overview.dataFreshness')}</h2>
            {loading ? <span className="text-xs text-text-subtle">{t('overview.refreshing')}</span> : null}
          </div>
          {sourceIssues.length > 0 ? (
            <p role="alert" className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t('overview.partialDataWarning', { count: sourceIssues.length })}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sourceStatuses.map(([name, status]) => {
              const unavailable = status.state === 'error' && !status.lastSuccessAt;
              const previous = status.state !== 'live' && status.state !== 'loading' && Boolean(status.lastSuccessAt);
              const stateLabel = unavailable
                ? t('overview.sourceUnavailable')
                : previous
                  ? t('overview.sourcePrevious')
                  : status.state === 'live'
                    ? t('overview.sourceLive')
                    : status.state === 'loading'
                      ? status.lastSuccessAt ? t('overview.sourceRefreshingPrevious') : t('overview.refreshing')
                      : t('overview.sourceUnavailable');
              return (
                <div key={name} className="rounded-md bg-surface-sunken/40 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">{t(`overview.source.${name}`)}</span>
                    <Badge variant={status.state === 'live' ? 'positive' : status.state === 'loading' ? 'default' : previous ? 'warning' : 'negative'}>{stateLabel}</Badge>
                  </div>
                  {previous && status.source ? <p className="mt-1 truncate text-text-subtle">{t('overview.sourceProvenance', { source: status.source })}</p> : null}
                  <p className="mt-1 text-text-muted">{t('overview.lastSuccess')}: {status.lastSuccessAt ? formatDateTime(status.lastSuccessAt, locale) : t('overview.never')}</p>
                  <p className="text-text-muted">{t('overview.lastAttempt')}: {status.lastAttemptAt ? formatDateTime(status.lastAttemptAt, locale) : t('overview.never')}</p>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

// Only count a source as an issue once the first refresh has settled. Before that
// every source is still unpopulated and the dashboard still shows its fallback
// snapshot, so counting them flashed a burst of false warnings on the very first
// paint (transient, then collapsed to the one real item). A genuine outage keeps
// `loading` false after the failed load, so its warning survives.
export function computeSourceIssues(
  loading: boolean,
  sourceStatuses: Array<[string, MissionControlSourceStatus]>,
): Array<[string, MissionControlSourceStatus]> {
  if (loading) return [];
  return sourceStatuses.filter(([, status]) => status.state === 'error' || status.state === 'fallback');
}
