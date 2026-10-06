import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE, root: process.cwd(), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
try {
  const { normalizeProviderUsageSnapshot: normalize } = await server.ssrLoadModule('/src/lib/hermes-api.ts');
  const { mergeProviderUsageSnapshot: merge } = await server.ssrLoadModule('/src/lib/provider-usage-refresh.ts');
  const good = { provider: 'healthy', available: true, windows: [{ id: 'primary', label: 'Quota', usedPercent: 12 }], balances: [], metrics: [] };
  const result = normalize({ schemaVersion: 2, success: true, available: true, providers: [good, { ...good, provider: 'damaged', windows: [null, good.windows[0]] }] });
  assert.ok(result, 'one broken field must not discard the snapshot');
  assert.equal(result.providers[0].provider, 'healthy');
  assert.equal(result.providers[1].windows.length, 1);
  assert.ok(result.providers[1].warnings.includes('invalid_field'));
  const extras = normalize({ schemaVersion: 2, success: true, available: true, error: 'Safe failure', warnings: ['unsupported_extension'], providers: [{ ...good,
    source: 'portal-account', dataState: 'ready', dataConfidence: 'estimated', refreshState: 'failed', staleAfterSeconds: 900,
    updatedAt: 'invalid', lastAttemptAt: '2026-10-06T01:00:00Z', freshUntil: '2026-10-06T01:05:00Z', nextRetryAt: '2026-10-06T01:01:00Z',
    refreshStartedAt: null, refreshDeadlineAt: null, warnings: ['truncated'], privateMarker: 'discard',
    windows: [{ id: 'primary', label: 'Cap', usageKnown: false, nextRegenPercent: 0, resetDescription: 'Tomorrow', legacyIds: ['old'] }],
    balances: [{ id: 'balance', label: 'Balance', value: -2, currency: 'EUR', scope: 'workspace', updatedAt: '2026-10-01T00:00:00Z' }],
    metrics: [{ id: 'detail:chart', label: 'History', kind: 'chart', value: null, secondaryValue: 'Month', sectionLabel: 'Usage', progress: { used: 12, total: 10 }, usageValue: 12,
      currency: 'EUR', chart: { kind: 'line', title: 'History', unit: 'calls', points: [{ label: 'Mon', value: -1 }] }, privateMarker: 'discard' }],
  }] });
  assert.equal(extras.providers[0].dataState, 'ready');
  assert.equal(extras.providers[0].metrics[0].chart.points[0].value, -1);
  assert.equal(extras.providers[0].updatedAt, null);
  assert.equal(extras.providers[0].balances[0].scope, 'workspace');
  assert.equal(extras.providers[0].windows[0].usageKnown, false);
  assert.equal(extras.providers[0].metrics[0].progress.used, 12);
  assert.equal(extras.error, 'Safe failure');
  assert.equal(JSON.stringify(extras).includes('privateMarker'), false);
  assert.equal(normalize({ schemaVersion: 99, success: true, available: true, providers: [good] }), null);
  const duplicates = normalize({ success: true, available: true, providers: [{ ...good, windows: [good.windows[0], good.windows[0]] }] });
  assert.equal(duplicates.providers[0].windows.length, 1);
  const privateFields = normalize({ success: true, available: true, providers: [{ ...good,
    metrics: [null, { id: 'secret', label: 'Secret', value: 'token=private-example' }, { id: 'literal', label: 'Safe\u0000 label', value: '$12.34', secondaryValue: 'example@example.test', currency: 'BAD!', chart: { kind: 'bars', points: [{ label: 'safe', value: 0 }, { label: 'private@example.test', value: 5 }] } }],
  }] });
  assert.equal(privateFields.providers[0].metrics.length, 1);
  assert.equal(privateFields.providers[0].metrics[0].value, '$12.34', 'display text must never be parsed into a number');
  assert.equal(privateFields.providers[0].metrics[0].secondaryValue, undefined);
  assert.equal(privateFields.providers[0].metrics[0].currency, undefined);
  assert.equal(privateFields.providers[0].metrics[0].label, 'Safe label');
  assert.equal(privateFields.providers[0].metrics[0].chart.points.length, 1);
  assert.equal(JSON.stringify(privateFields).includes('private-example'), false);
  const noData = normalize({ schemaVersion: 2, success: true, available: true, providers: [{ provider: 'native', source: 'portal-account', available: false, dataState: 'no_data', refreshState: 'idle', windows: [], balances: [], metrics: [] }] });
  assert.equal(noData.providers[0].dataState, 'no_data');
  assert.equal(noData.providers[0].source, 'portal-account');
  assert.equal(noData.providers[0].error, undefined);
  const failed = normalize({ success: true, available: true, providers: [{ ...noData.providers[0], dataState: 'error', refreshState: 'failed', error: 'Safe native failure' }] });
  assert.equal(failed.providers[0].dataState, 'error');
  assert.equal(failed.providers[0].error, 'Safe native failure');
  const filteredReady = normalize({ schemaVersion: 2, success: true, available: true, providers: [{ provider: 'native', available: true, dataState: 'ready', windows: [], balances: [], metrics: [] }] });
  assert.equal(filteredReady.providers[0].available, true, 'hidden fields do not turn ready data into no-data');
  for (const id of ['detail:api.requests', `detail:${'x'.repeat(153)}`]) {
    const detailed = normalize({ schemaVersion: 2, success: true, available: true, providers: [{
      ...good, windows: [], metrics: [{ id, label: 'API requests', value: 7, legacyIds: ['api.requests', id] }],
    }] });
    assert.equal(detailed.providers[0].available, true, 'backend-valid field IDs must keep detail-only providers available');
    assert.equal(detailed.providers[0].metrics[0]?.id, id);
    assert.deepEqual(detailed.providers[0].metrics[0].legacyIds, ['api.requests', id]);
  }
  const invalidIds = normalize({ success: true, available: true, providers: [{ ...good, metrics: [
    { id: 'x'.repeat(161), label: 'Too long', value: 1 },
    { id: 'invalid/id', label: 'Invalid separator', value: 2 },
  ] }] });
  assert.equal(invalidIds.providers[0].metrics.length, 0);
  const lastGood = normalize({ success: true, available: true, providers: [good] });
  const optionalWarning = normalize({ success: true, available: true, providers: [{
    ...good, windows: [{ ...good.windows[0], usedPercent: 20 }], warnings: ['invalid_field'],
  }] });
  assert.equal(merge(lastGood, optionalWarning).providers[0].windows[0].usedPercent, 20,
    'an upstream warning for an omitted optional field must not freeze a healthy quota');
  const locallyMalformed = normalize({ success: true, available: true, providers: [{
    ...good, windows: [null], balances: [{ id: 'balance', label: 'Balance', value: 5 }],
  }] });
  const partialMerge = merge(lastGood, locallyMalformed).providers[0];
  assert.equal(partialMerge.windows[0].usedPercent, 12, 'locally malformed quota keeps its last-good value');
  assert.equal(partialMerge.balances[0].value, 5, 'healthy collections still update');
  assert.equal(partialMerge.stale, true);
  const healthyAndMalformed = normalize({ success: true, available: true, providers: [{
    ...good, windows: [{ ...good.windows[0], usedPercent: 25 }, null],
  }] });
  assert.equal(merge(lastGood, healthyAndMalformed).providers[0].windows[0].usedPercent, 25,
    'a malformed neighbour must not freeze a valid field in the same collection');
  const corruptNoData = normalize({ success: true, available: true, providers: [{
    ...good, available: false, dataState: 'no_data', windows: [null],
  }] });
  assert.equal(corruptNoData.providers[0].dataState, 'error', 'malformed no_data is not a valid empty observation');
  const retainedNoData = merge(lastGood, corruptNoData).providers[0];
  assert.equal(retainedNoData.windows[0].usedPercent, 12);
  assert.equal(retainedNoData.stale, true);
  const validEmpty = { ...noData, providers: [{ ...noData.providers[0], provider: good.provider }] };
  const cleared = merge(lastGood, validEmpty).providers[0];
  assert.equal(cleared.dataState, 'no_data', 'valid empty data remains authoritative');
  assert.equal(cleared.windows.length, 0, 'valid no_data clears the prior quota');
  const unsafeId = normalize({ success: true, available: true, providers: [{
    ...good, metrics: [{ id: 'sk-privateexamplelong', label: 'token=private-example', value: 1 }],
  }] });
  assert.equal(JSON.stringify(unsafeId).includes('privateexample'), false, 'validation metadata must not retain rejected secrets');
  console.log('field/provider isolation, v2 metadata, native state and safe allowlist reconstruction passed');
} finally { await server.close(); }
