/** Common semantics, independent of provider identity and formatted values. */
export const PROVIDER_USAGE_FIELD_ROLES = [
  'quota', 'spend_limit', 'limit_remaining', 'account_balance', 'spendable_balance',
  'balance_component', 'credits', 'spend_today', 'spend_month', 'spend',
  'paid_access', 'reset_credits', 'diagnostic',
] as const;

export type ProviderUsageFieldRole = typeof PROVIDER_USAGE_FIELD_ROLES[number];
export type ProviderUsageFieldGroup = 'windows' | 'balances' | 'metrics';

export interface ProviderUsageSemanticField {
  id: string;
  label: string;
  role?: ProviderUsageFieldRole;
}

const COMMON_FIELD_ROLES: Record<ProviderUsageFieldGroup, ReadonlyMap<string, ProviderUsageFieldRole>> = {
  windows: new Map([['cost_budget', 'spend_limit']]),
  balances: new Map([
    ['balance', 'account_balance'], ['total_spendable', 'spendable_balance'],
    ['subscription_remaining', 'balance_component'], ['topup_remaining', 'balance_component'], ['credits_remaining', 'credits'],
  ]),
  metrics: new Map([
    ['cost_used', 'spend'], ['cost_personal_used', 'spend'], ['cost_next_regen', 'diagnostic'],
    ['paid_access', 'paid_access'], ['reset_credits_available', 'reset_credits'],
  ]),
};

const DETAIL_VOCABULARY: Record<string, Record<string, ProviderUsageFieldRole>> = {
  'API key': {
    'API key limit': 'spend_limit', 'API key remaining': 'limit_remaining',
    'API key used': 'diagnostic', 'Today': 'spend_today',
    'This month': 'spend_month', 'This week': 'diagnostic',
  },
  'Credits': {
    'Remaining': 'account_balance', 'Used': 'diagnostic', 'Total added': 'diagnostic',
  },
};

export function getProviderUsageFieldRole(group: ProviderUsageFieldGroup, field: ProviderUsageSemanticField): ProviderUsageFieldRole | undefined {
  if (isProviderUsageFieldRole(field.role)) return field.role;
  const role = COMMON_FIELD_ROLES[group].get(field.id);
  if (role) return role;
  if (group === 'windows' && (['primary', 'secondary', 'tertiary'].includes(field.id) || field.id.startsWith('extra:'))) return 'quota';
  if (group === 'metrics' && 'sectionLabel' in field && 'label' in field) {
    const kind = (field as Record<string, unknown>).kind;
    if (kind === 'chart') return 'diagnostic';
    const section = DETAIL_VOCABULARY[field.sectionLabel as string];
    if (section) return section[field.label as string];
  }
  return undefined;
}

export function isProviderUsageFieldRole(value: unknown): value is ProviderUsageFieldRole {
  return typeof value === 'string' && (PROVIDER_USAGE_FIELD_ROLES as readonly string[]).includes(value);
}
