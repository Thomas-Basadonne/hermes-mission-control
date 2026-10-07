export function getProviderUsagePanelState(
  snapshot: { available: boolean; providers: unknown[] } | null,
  failed: boolean,
  catalogLoading = false,
): 'loading' | 'unavailable' | 'ready' {
  if (snapshot?.available || snapshot?.providers.length) return 'ready';
  if (catalogLoading) return 'loading';
  return snapshot || failed ? 'unavailable' : 'loading';
}

export function selectCompactFields<T extends { featured?: boolean }>(fields: readonly T[], totalLimit: number): { visible: T[]; overflow: T[] } {
  const ordered = [...fields.filter((field) => field.featured === true), ...fields.filter((field) => field.featured !== true)];
  const limit = Math.max(0, Math.floor(totalLimit));
  return { visible: ordered.slice(0, limit), overflow: ordered.slice(limit) };
}

import type { MissionControlProviderUsage } from './hermes-api';
import { getProviderUsageFieldRole, type ProviderUsageFieldRole } from './provider-usage-semantics';
import { getFieldVisibility, type ProviderUsagePreferences } from './provider-usage-preferences';

const ROLE_PRIORITY: Record<string, number> = {
  spendable_balance: 100, limit_remaining: 95, spend_limit: 90, quota: 85,
  spend_today: 80, spend_month: 75, account_balance: 70, paid_access: 65,
  reset_credits: 60, credits: 50, spend: 45, balance_component: 10,
};

interface PriorityField {
  id: string;
  label?: string;
  role?: ProviderUsageFieldRole;
  sectionLabel?: string;
  kind?: string;
  featured?: boolean;
  value?: number | string | boolean | null;
  unit?: string;
  currency?: string;
}

function fieldPriority(group: string, field: PriorityField): number {
  if (field.featured) return 200;
  const role = field.role ?? getProviderUsageFieldRole(group as 'windows' | 'balances' | 'metrics', { ...field, label: field.label ?? '' });
  if (!role) return 5;
  const base = ROLE_PRIORITY[role] ?? 5;
  if ((role === 'credits' || role === 'spend') && typeof field.value === 'number' && field.value === 0) return base - 20;
  return base;
}

export function selectProviderUsageSummary(
  provider: MissionControlProviderUsage,
  preferences: Pick<ProviderUsagePreferences, 'fieldVisibility' | 'groupFieldVisibility'> = {},
): { visible: Array<{ group: 'windows' | 'balances' | 'metrics'; field: PriorityField }>; overflow: Array<{ group: 'windows' | 'balances' | 'metrics'; field: PriorityField }> } {
  const groups = ['windows', 'balances', 'metrics'] as const;
  const allFields = groups.flatMap((group) => {
    const fields = provider[group] ?? [];
    return fields
      .filter((field) => getFieldVisibility(preferences, provider.provider, group, field.id) !== 'hidden')
      .map((field) => ({ group, field: field as unknown as PriorityField }));
  });
  const scored = allFields.map((item) => ({
    ...item,
    priority: fieldPriority(item.group, item.field),
    isCompact: getFieldVisibility(preferences, provider.provider, item.group, item.field.id) !== 'detailed',
  }));
  const compactFields = scored.filter((item) => item.isCompact);
  const detailedOnly = scored.filter((item) => !item.isCompact);
  compactFields.sort((a, b) => b.priority - a.priority);
  const visible = compactFields.slice(0, 5);
  const visibleKeys = new Set(visible.map((item) => `${item.group}:${item.field.id}`));
  const overflow = [...compactFields.slice(5), ...detailedOnly]
    .filter((item) => !visibleKeys.has(`${item.group}:${item.field.id}`));
  return {
    visible: visible.map(({ group, field }) => ({ group, field })),
    overflow: overflow.map(({ group, field }) => ({ group, field })),
  };
}

export function formatProviderUsagePercent(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const percent = (number: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(number / 100);
  if (value > 0 && value < 0.01) return `<${percent(0.01)}`;
  if (value < 0 && value > -0.01) return `>−${percent(0.01)}`;
  return percent(value);
}
