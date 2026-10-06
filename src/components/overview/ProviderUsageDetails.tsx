import type { MissionControlProviderUsageMetric, ProviderUsageChart } from '../../lib/hermes-api';
import { formatCurrency, formatDateTime, formatNumber } from '../../lib/format';
import { formatProviderUsagePercent } from '../../lib/provider-usage-display';

interface ChartProps { chart: ProviderUsageChart; locale: string; dataLabel: string }
export function ProviderUsageChartView({ chart, locale, dataLabel }: ChartProps) {
  if (!chart.points.length) return null;
  const points = chart.points;
  const minimum = Math.min(0, ...points.map(point => point.value));
  const maximum = Math.max(0, ...points.map(point => point.value));
  const span = maximum - minimum || 1;
  const y = (value: number) => 90 - (value - minimum) / span * 80;
  const x = (index: number) => 10 + (index + 0.5) / points.length * 280;
  const baseline = y(0);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return <figure className="min-w-0 w-full provider-usage-chart">
    {chart.title ? <figcaption className="break-words text-xs text-text-muted">{chart.title}</figcaption> : null}
    <svg viewBox="0 0 300 100" className="w-full h-24" aria-hidden="true" focusable="false">
      <line x1="10" x2="290" y1={baseline} y2={baseline} stroke="currentColor" opacity="0.2" />
      {chart.kind === 'line' ? <>
        <polyline points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
        {points.map((point, index) => <circle key={index} cx={x(index)} cy={y(point.value)} r="2.5" fill="currentColor" />)}
      </> : points.map((point, index) => <rect key={index} x={x(index) - 100 / points.length} y={Math.min(baseline, y(point.value))}
        width={200 / points.length} height={Math.abs(baseline - y(point.value))} fill="currentColor" />)}
    </svg>
    <details className="min-w-0 text-xs">
      <summary className="cursor-pointer break-words">{dataLabel}{chart.unit ? ` (${chart.unit})` : ''}</summary>
      <table className="w-full table-fixed">
        <caption className="sr-only">{chart.title ?? dataLabel}{chart.unit ? ` (${chart.unit})` : ''}</caption>
        <tbody>{points.map((point, index) => <tr key={index}>
          <th scope="row" className="text-left break-words font-medium">{point.label}</th>
          <td className="text-right break-words tabular-nums">{number.format(point.value)}</td>
        </tr>)}</tbody>
      </table>
    </details>
  </figure>;
}

interface MetricProps {
  metric: MissionControlProviderUsageMetric; locale: string; label: string; dataLabel: string;
  enabledLabel: string; disabledLabel: string; detailed: boolean;
  showSectionLabel?: boolean; numericLabel?: string;
}
export function ProviderUsageMetricRow({ metric, locale, label, dataLabel, enabledLabel, disabledLabel, detailed, showSectionLabel = true, numericLabel }: MetricProps) {
  let value = metric.value == null ? '—' : String(metric.value);
  if (metric.kind === 'timestamp') {
    const date = new Date(String(metric.value ?? ''));
    value = Number.isFinite(date.getTime()) ? formatDateTime(date, locale) : '—';
  } else if (typeof metric.value === 'number') {
    value = metric.currency ? formatCurrency(metric.value, metric.currency, locale)
      : `${formatNumber(metric.value, locale)}${metric.unit && metric.unit !== 'count' ? ` ${metric.unit}` : ''}`;
  } else if (typeof metric.value === 'boolean') value = metric.value ? enabledLabel : disabledLabel;
  else if (metric.value != null && metric.unit) value += ` ${metric.unit}`;
  const progress = metric.progress;
  const percent = progress ? progress.used / progress.total * 100 : undefined;
  const chart = metric.chart ? <ProviderUsageChartView chart={metric.chart} locale={locale} dataLabel={dataLabel} /> : null;
  return <div data-field-id={metric.id} className={`min-w-0 border-b border-border-subtle py-2 last:border-0 ${metric.featured ? 'rounded-lg border border-accent/20 bg-accent/5 p-2' : ''}`}>
    {showSectionLabel && metric.sectionLabel ? <div className="mb-1 break-words text-[11px] text-text-subtle">{metric.sectionLabel}</div> : null}
    <div className="flex min-w-0 items-start justify-between gap-3">
      <dt className="min-w-0 break-words text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium tabular-nums text-text text-right">
        {metric.kind !== 'chart' ? value : null}
        {metric.secondaryValue ? <span className="mt-1 block break-words text-xs font-normal text-text-subtle">{metric.secondaryValue}</span> : null}
      </dd>
    </div>
    {progress && percent !== undefined ? <div className="mt-2">
      <div className="mb-1 flex min-w-0 flex-wrap justify-between gap-2 text-xs text-text-muted">
        <span>{formatNumber(progress.used, locale)} / {formatNumber(progress.total, locale)}</span>
        <span>{formatProviderUsagePercent(percent, locale)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label={label}
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={Math.max(0, Math.min(progress.total, progress.used))}
        aria-valuetext={`${formatNumber(progress.used, locale)} / ${formatNumber(progress.total, locale)} (${formatProviderUsagePercent(percent, locale)})`}>
        <div className="h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
    </div> : null}
    {chart ? <dd className="mt-2 min-w-0">{detailed ? chart : <details className="min-w-0"><summary className="cursor-pointer break-words text-xs text-accent">{metric.chart?.title ?? label}</summary>{chart}</details>}</dd> : null}
    {detailed && numericLabel && typeof metric.usageValue === 'number' ? <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-text-subtle"><dt>{numericLabel}</dt><dd className="tabular-nums">{new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(metric.usageValue)}</dd></div> : null}
  </div>;
}
