import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
try {
  const { normalizeProviderUsageSnapshot: normalize } = await server.ssrLoadModule('/src/lib/hermes-api.ts');
  const { mergeProviderUsageSnapshot: merge } = await server.ssrLoadModule('/src/lib/provider-usage-refresh.ts');
  const snapshot = (group, fields) => ({ success: true, available: true, providers: [{
    provider: 'future-provider', available: true, dataState: 'ready', windows: [], balances: [], metrics: [], [group]: fields,
  }] });

  await test('semantic roles are optional validated metadata, not field validity', () => {
    const roles = ['quota', 'spend_limit', 'limit_remaining', 'account_balance', 'spendable_balance',
      'balance_component', 'credits', 'spend_today', 'spend_month', 'spend', 'paid_access', 'reset_credits', 'diagnostic'];
    for (const group of ['windows', 'balances', 'metrics']) {
      const field = { id: 'custom', label: 'Unchanged', ...(group === 'windows' ? { usedPercent: 7 } : { value: 7 }) };
      for (const role of roles) {
        const normalized = normalize(snapshot(group, [{ ...field, role }]));
        assert.deepEqual(normalized.providers[0][group], [{ ...field, role }]);
      }
      const previous = normalize(snapshot(group, [{ ...field, ...(group === 'windows' ? { usedPercent: 1 } : { value: 1 }) }]));
      for (const role of [null, 'unknown', 'QUOTA', 7, true, [], {}]) {
        const normalized = normalize(snapshot(group, [{ ...field, role }]));
        assert.deepEqual(normalized.providers[0][group], [field]);
        assert.equal(normalized.providers[0].available, true);
        assert.equal(normalized.providers[0].dataState, 'ready');
        assert.ok(normalized.providers[0].warnings.includes('invalid_field'));
        assert.equal(normalized.providers[0].malformedFields, undefined);
        assert.deepEqual(merge(previous, normalized).providers[0][group], [field], 'invalid role must not freeze valid data');
      }
      assert.deepEqual(normalize(snapshot(group, [field])).providers[0][group], [field]);
    }
  });
  await test('legacy stable IDs resolve shared roles with explicit metadata taking precedence', async () => {
    const { getProviderUsageFieldRole: role } = await server.ssrLoadModule('/src/lib/provider-usage-semantics.ts');
    assert.equal(typeof role, 'function');
    const examples = [
      ['windows', 'primary', 'quota'], ['windows', 'secondary', 'quota'], ['windows', 'tertiary', 'quota'],
      ['windows', 'extra:daily', 'quota'], ['windows', 'cost_budget', 'spend_limit'],
      ['balances', 'balance', 'account_balance'], ['balances', 'total_spendable', 'spendable_balance'],
      ['balances', 'subscription_remaining', 'balance_component'], ['balances', 'topup_remaining', 'balance_component'],
      ['balances', 'credits_remaining', 'credits'], ['metrics', 'cost_used', 'spend'],
      ['metrics', 'cost_personal_used', 'spend'], ['metrics', 'paid_access', 'paid_access'],
      ['metrics', 'reset_credits_available', 'reset_credits'],
    ];
    for (const [group, id, expected] of examples) {
      const field = { id, label: 'Original label' };
      assert.equal(role(group, field), expected, id);
      assert.equal(role(group, { ...field, role: 'diagnostic' }), 'diagnostic', 'explicit metadata wins');
      assert.deepEqual(field, { id, label: 'Original label' }, 'role lookup must not mutate legacy fields');
    }
    assert.equal(role('metrics', { id: 'unknown', label: 'Balance due', value: '$99.00' }), undefined);
    assert.equal(role('metrics', { id: 'primary', label: 'Quota' }), undefined, 'stable IDs are collection-scoped');
    assert.equal(role('windows', { id: 'unknown', label: 'Quota' }), undefined);
  });
  await test('legacy details use exact label/section vocabulary and never parse display strings', async () => {
    const { getProviderUsageFieldRole: role } = await server.ssrLoadModule('/src/lib/provider-usage-semantics.ts');
    const examples = [
      ['API key', 'API key limit', 'spend_limit'], ['API key', 'API key remaining', 'limit_remaining'],
      ['API key', 'API key used', 'diagnostic'], ['API key', 'Today', 'spend_today'],
      ['API key', 'This month', 'spend_month'], ['API key', 'This week', 'diagnostic'],
      ['Credits', 'Remaining', 'account_balance'], ['Credits', 'Used', 'diagnostic'], ['Credits', 'Total added', 'diagnostic'],
      ['Billing', 'Today', undefined], ['API key', 'today', undefined], ['API key', 'Today extra', undefined],
      ['Credits', 'Remaining balance', undefined], ['credits', 'Remaining', undefined],
    ];
    for (const [sectionLabel, label, expected] of examples) {
      const raw = { id: 'detail:custom', label, sectionLabel, value: '$12.34', legacyIds: ['detail-0-0'] };
      const field = normalize(snapshot('metrics', [raw])).providers[0].metrics[0];
      assert.equal(role('metrics', field), expected, `${sectionLabel}/${label}`);
      assert.equal(role('metrics', { ...field, role: 'credits' }), 'credits');
      assert.deepEqual(field, raw, 'classification must not rewrite text, aliases, IDs or infer amounts');
    }
    const chart = { id: 'detail:chart', label: 'Today', sectionLabel: 'API key', kind: 'chart',
      chart: { kind: 'line', points: [{ label: 'Day', value: 1 }] } };
    const field = normalize(snapshot('metrics', [chart])).providers[0].metrics[0];
    assert.equal(role('metrics', field), 'diagnostic', 'charts are diagnostic even with a recognized label');
    assert.equal(role('metrics', { ...field, role: 'spend_today' }), 'spend_today');
  });
} finally {
  await server.close();
}
