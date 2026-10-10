import { useI18n } from '../lib/i18n';
import { useMemo, useRef, useState } from 'react';
import { Blocks, CheckCircle2, Hammer, KeyRound } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/PageHeader';
import { useMissionControl } from '../lib/mission-control-store';
import { browserToolsets, matchingTools, toolsetMatches } from '../lib/tools-browser';
import { usePullToReload } from '../hooks/usePullToReload';
import { PullToReloadIndicator } from '../components/PullToReloadIndicator';

function MetricCard({ icon: Icon, label, value, hint, color }: {
  icon: React.ElementType; label: string; value: string; hint: string; color: string;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-sunken/35 p-4 transition-colors hover:bg-surface-sunken/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</span>
          <p className="mt-1 truncate text-xl font-semibold text-text tabular-nums">{value}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-subtle">{hint}</p>
        </div>
        <Icon className={`h-[18px] w-[18px] shrink-0 ${color}`} />
      </div>
    </div>
  );
}

export function ToolsRoute() {
  const { t } = useI18n();
  const { tools, refreshTools } = useMissionControl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expandedToolsets, setExpandedToolsets] = useState<Set<string>>(new Set());
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  // The hook keeps the spinner until this settles and ignores gestures while
  // it is pending, so one pull means exactly one Tools request.
  const { state: pullState } = usePullToReload({
    containerRef,
    onReload: async () => {
      const result = await refreshTools();
      setRefreshError(result.ok ? null : result.error);
    },
  });
  const needle = query.trim().toLowerCase();
  const toolsets = useMemo(() => browserToolsets(tools), [tools]);
  const filteredToolsets = toolsets.filter(item => toolsetMatches(item, query));
  const catalog = useMemo(() => [...new Map(tools.toolCatalog.map(item =>
    [JSON.stringify([item.toolset, item.name]), item] as const)).values()], [tools.toolCatalog]);
  const filteredCatalog = catalog.filter(item => !needle ||
    item.name.toLowerCase().includes(needle) || item.toolset.toLowerCase().includes(needle));
  const visibleCatalog = needle || catalogExpanded ? filteredCatalog : filteredCatalog.slice(0, 8);
  const readyCount = toolsets.filter(item => item.available).length;
  const blockedCount = toolsets.filter(item => !item.available).length;

  return (
    <div ref={containerRef} className="route-page-scroll flex h-full flex-col gap-5 overflow-y-auto sm:gap-6">
      <PullToReloadIndicator state={pullState} />
      {refreshError ? (
        <p role="status" className="text-xs text-warning">{t('tools.refreshFailed', { detail: refreshError })}</p>
      ) : null}
      <Card padding="none" className="!border-0">
        <PageHeader eyebrow={t('tools.eyebrow')} title={t('tools.title')} description={t('tools.description')}
          meta={(
            <div className="flex items-center gap-2">
              <span className="truncate">{t('tools.toolCount', { count: catalog.length })}</span>
              <Badge variant={tools.available ? 'positive' : 'warning'}>{t(tools.available ? 'tools.live' : 'tools.fallback')}</Badge>
            </div>
          )} />
        <div className="grid grid-cols-2 gap-2.5 p-3 sm:gap-3 sm:p-4 xl:grid-cols-4">
          <MetricCard icon={Blocks} label={t('tools.toolsets')} value={String(toolsets.length)} hint={t('tools.cataloguedGroups')} color="text-sky-400" />
          <MetricCard icon={CheckCircle2} label={t('tools.ready')} value={String(readyCount)} hint={t('tools.availableNow')} color="text-emerald-400" />
          <MetricCard icon={KeyRound} label={t('tools.needsKeys')} value={String(blockedCount)} hint={t('tools.waitingOnEnv')} color="text-amber-400" />
          <MetricCard icon={Hammer} label={t('tools.tools')} value={String(catalog.length)} hint={t('tools.registeredHandlers')} color="text-violet-400" />
        </div>
      </Card>
      <div className="flex min-w-0 items-center gap-2">
        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
          aria-label={t('tools.search')} placeholder={t('tools.search')} className="mc-input min-w-0 w-full" />
        <Button type="button" size="sm" variant="ghost" onClick={() => setQuery('')}>{t('tools.resetSearch')}</Button>
      </div>
      <Card padding="none" className="!border-0">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle/60 px-4 pb-3 pt-4">
          <div className="min-w-0">
            <span className="eyebrow">{t('tools.toolsets')}</span>
            <h3 className="text-sm font-semibold text-text">{t('tools.groupedByAvailability')}</h3>
          </div>
          <span className="shrink-0 text-xs text-text-subtle">{t('tools.toolCount', { count: toolsets.length })}</span>
        </div>
        <div className="space-y-1.5 p-3">
          {filteredToolsets.length > 0 ? filteredToolsets.map(toolset => {
            const allNames = matchingTools(toolset.resolvedTools, '');
            const toolSearch = !!needle && !toolset.name.toLowerCase().includes(needle);
            const candidates = toolSearch ? matchingTools(allNames, query) : allNames;
            const expanded = expandedToolsets.has(toolset.name);
            const visibleNames = toolSearch || expanded ? candidates : candidates.slice(0, 8);
            const listId = `tools-group-${encodeURIComponent(toolset.name)}`;
            return (
              <article key={toolset.name} data-toolset={toolset.name} className="rounded-lg bg-surface-sunken/25 p-3 transition-colors hover:bg-surface-sunken/50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{toolset.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-muted">{toolset.description || t('tools.noDescription')}</p>
                  </div>
                  <Badge variant={toolset.available ? 'positive' : 'warning'}>{t(toolset.available ? 'tools.available' : 'tools.unavailable')}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-subtle">
                  <span>{t('tools.toolCount', { count: toolset.toolCount })}</span><span>·</span>
                  <span>{t(toolset.isComposite ? 'tools.composite' : 'tools.direct')}</span>
                </div>
                {toolset.requirements.length > 0 ? <p className="mt-2 break-all text-xs text-text-muted">{t('tools.requirements')}: {toolset.requirements.join(', ')}</p> : null}
                {allNames.length > 0 ? (
                  <div id={listId} data-tool-list className="mt-2 flex flex-wrap gap-2">
                    {visibleNames.map(tool => <span key={tool} className="min-w-0 break-all"><Badge variant="default">{tool}</Badge></span>)}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-subtle" aria-live="polite">{t('tools.visibleCount', { visible: visibleNames.length, total: allNames.length })}</span>
                  {!toolSearch && candidates.length > 8 ? (
                    <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} aria-controls={listId}
                      onClick={() => setExpandedToolsets(previous => {
                        const next = new Set(previous);
                        if (next.has(toolset.name)) next.delete(toolset.name); else next.add(toolset.name);
                        return next;
                      })}>{t(expanded ? 'tools.showLess' : 'tools.showAll')}</Button>
                  ) : null}
                </div>
              </article>
            );
          }) : <p className="p-4 text-sm text-text-muted">{t(toolsets.length === 0 ? 'tools.notFound' : 'tools.noMatch')}</p>}
        </div>
      </Card>
      <Card padding="none" className="!border-0">
        <section data-tool-catalog className="p-4">
          <h3 className="text-sm font-semibold text-text">{t('tools.catalogTitle')}</h3>
          <p className="mt-1 text-xs text-text-subtle" aria-live="polite">{t('tools.visibleCount', { visible: visibleCatalog.length, total: catalog.length })}</p>
          <ul id="tools-catalog-list" className="mt-3 space-y-2">
            {visibleCatalog.map(item => (
              <li key={JSON.stringify([item.toolset, item.name])} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-surface-sunken/25 p-3">
                <span className="min-w-0 break-all text-sm text-text">{item.name}</span>
                <span className="min-w-0 break-all text-xs text-text-muted">{item.toolset}</span>
                <Badge variant={item.available ? 'positive' : 'warning'}>{t(item.available ? 'tools.available' : 'tools.unavailable')}</Badge>
              </li>
            ))}
          </ul>
          {visibleCatalog.length === 0 ? <p className="py-4 text-sm text-text-muted">{t(catalog.length === 0 ? 'tools.notFound' : 'tools.noMatch')}</p> : null}
          {!needle && filteredCatalog.length > 8 ? (
            <Button type="button" size="sm" variant="ghost" className="mt-3" aria-expanded={catalogExpanded}
              aria-controls="tools-catalog-list" onClick={() => setCatalogExpanded(value => !value)}>{t(catalogExpanded ? 'tools.showLess' : 'tools.showAll')}</Button>
          ) : null}
        </section>
      </Card>
    </div>
  );
}
