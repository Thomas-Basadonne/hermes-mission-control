export function getProviderUsagePanelState(snapshot: { available: boolean; providers: unknown[] } | null, failed: boolean): 'loading' | 'unavailable' | 'ready' {
  if (snapshot?.available || snapshot?.providers.length) return 'ready';
  return snapshot || failed ? 'unavailable' : 'loading';
}

export function selectCompactFields<T extends { featured?: boolean }>(fields: readonly T[], totalLimit: number): { visible: T[]; overflow: T[] } {
  const ordered = [...fields.filter((field) => field.featured === true), ...fields.filter((field) => field.featured !== true)];
  const limit = Math.max(0, Math.floor(totalLimit));
  return { visible: ordered.slice(0, limit), overflow: ordered.slice(limit) };
}

import type { MissionControlProviderUsage } from './hermes-api';
import { getProviderUsageFieldRole } from './provider-usage-semantics';
import type { ProviderUsageFieldRef } from './provider-usage-preferences';
import { MAX_PROVIDER_USAGE_COMPACT_FIELDS } from './provider-usage-preferences';

const ROLE_PRIORITY: Record<string, number> = {
  spendable_balance: 100, limit_remaining: 95, spend_limit: 90, quota: 85,
  spend_today: 80, spend_month: 75, account_balance: 70, paid_access: 65,
  reset_credits: 60, credits: 50, spend: 45, balance_component: 10,
};

interface PriorityField {
  id: string;
  label?: string;
  role?: string;
  featured?: boolean;
  value?: number | string | boolean | null;
  unit?: string;
  currency?: string;
}

function fieldPriority(group: string, field: PriorityField): number {
  if (field.featured) return 200;
  const role = field.role ?? getProviderUsageFieldRole(group as 'windows' | 'balances' | 'metrics', { id: field.id, label: field.label ?? '' });
  if (!role) return 5;
  const base = ROLE_PRIORITY[role] ?? 5;
  if ((role === 'credits' || role === 'spend') && typeof field.value === 'number' && field.value === 0) return base - 20;
  return base;
}

export function selectProviderUsageSummary(
  provider: MissionControlProviderUsage,
  configured?: readonly ProviderUsageFieldRef[],
): { visible: Array<{ group: 'windows' | 'balances' | 'metrics'; field: PriorityField }>; overflow: Array<{ group: 'windows' | 'balances' | 'metrics'; field: PriorityField }> } {
  const groups = ['windows', 'balances', 'metrics'] as const;
  const allFields = groups.flatMap((group) => {
    const fields = provider[group] ?? [];
    return fields.map((field) => ({ group, field: field as unknown as PriorityField }));
  });
  if (configured !== undefined) {
    const selected = configured
      .map((ref) => {
        const found = allFields.find((item) => item.group === ref.group && item.field.id === ref.id);
        return found ?? null;
      })
      .filter((item): item is { group: 'windows' | 'balances' | 'metrics'; field: PriorityField } => item !== null);
    const selectedKeys = new Set(selected.map((item) => `${item.group}:${item.field.id}`));
    const overflow = allFields.filter((item) => !selectedKeys.has(`${item.group}:${item.field.id}`));
    return { visible: selected.slice(0, MAX_PROVIDER_USAGE_COMPACT_FIELDS), overflow };
  }
  const scored = allFields.map((item) => ({
    ...item,
    priority: fieldPriority(item.group, item.field),
  }));
  scored.sort((a, b) => b.priority - a.priority);
  const visible = scored.slice(0, MAX_PROVIDER_USAGE_COMPACT_FIELDS);
  const visibleKeys = new Set(visible.map((item) => `${item.group}:${item.field.id}`));
  const overflow = scored.filter((item) => !visibleKeys.has(`${item.group}:${item.field.id}`));
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
