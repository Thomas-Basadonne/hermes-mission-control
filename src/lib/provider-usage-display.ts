export function getProviderUsagePanelState(snapshot: { available: boolean; providers: unknown[] } | null, failed: boolean): 'loading' | 'unavailable' | 'ready' {
  if (snapshot?.available || snapshot?.providers.length) return 'ready';
  return snapshot || failed ? 'unavailable' : 'loading';
}

export function selectCompactFields<T extends { featured?: boolean }>(fields: readonly T[], regularLimit: number): { visible: T[]; overflow: T[] } {
  const featured = fields.filter((field) => field.featured === true);
  const regular = fields.filter((field) => field.featured !== true);
  const limit = Math.max(0, Math.floor(regularLimit));
  return { visible: [...featured, ...regular.slice(0, limit)], overflow: regular.slice(limit) };
}

export function formatProviderUsagePercent(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const percent = (number: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(number / 100);
  if (value > 0 && value < 0.01) return `<${percent(0.01)}`;
  if (value < 0 && value > -0.01) return `>−${percent(0.01)}`;
  return percent(value);
}
