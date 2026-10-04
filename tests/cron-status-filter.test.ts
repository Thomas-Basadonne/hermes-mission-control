import assert from 'node:assert/strict';
import test from 'node:test';
import { filterCronJobs } from '../src/lib/cron-status-filter.ts';

const jobs = [
  { id: 'disabled', enabled: false, state: 'scheduled', profile: 'default' },
  { id: 'active', enabled: true, state: 'scheduled', profile: 'default' },
  { id: 'paused', enabled: true, state: 'paused', profile: 'example-bot' },
  { id: 'running', enabled: true, state: 'running', profile: 'example-bot' },
  { id: 'failed', enabled: true, state: 'scheduled', profile: 'example-bot', lastStatus: 'failed' },
  { id: 'legacy', enabled: true, state: 'scheduled' },
];

const ids = (items: typeof jobs) => items.map((job) => job.id);

test('cron list defaults to active jobs, including running and failed enabled jobs', () => {
  assert.deepEqual(ids(filterCronJobs(jobs)), ['active', 'running', 'failed', 'legacy']);
});

test('status and profile filters compose without mutating the full inventory', () => {
  const before = structuredClone(jobs);
  assert.deepEqual(ids(filterCronJobs(jobs, 'paused')), ['disabled', 'paused']);
  assert.deepEqual(ids(filterCronJobs(jobs, 'all')), ['active', 'running', 'failed', 'legacy', 'disabled', 'paused']);
  assert.deepEqual(ids(filterCronJobs(jobs, 'active', 'example-bot')), ['running', 'failed']);
  assert.deepEqual(ids(filterCronJobs(jobs, 'paused', 'default')), ['disabled']);
  assert.deepEqual(ids(filterCronJobs(jobs, 'active', 'default')), ['active', 'legacy']);
  assert.deepEqual(filterCronJobs(jobs, 'paused', 'missing-profile'), []);
  assert.deepEqual(jobs, before);
});
