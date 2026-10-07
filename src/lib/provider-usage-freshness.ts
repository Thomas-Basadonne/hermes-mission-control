import type { MissionControlProviderUsage } from './hermes-api';

export function isProviderUsageRunning(provider: MissionControlProviderUsage, nowMs: number): boolean {
  const started = Date.parse(provider.refreshStartedAt ?? '');
  const deadline = Date.parse(provider.refreshDeadlineAt ?? '');
  return provider.refreshState === 'running' && Number.isFinite(started) && started <= nowMs
    && Number.isFinite(deadline) && deadline > nowMs;
}

export function getProviderUsageStatus(provider: MissionControlProviderUsage, nowMs: number): 'available' | 'stale' | 'updating' | 'no_data' | 'unavailable' {
  const running = isProviderUsageRunning(provider, nowMs);
  if (!provider.available) return running ? 'updating' : provider.dataState === 'no_data' ? 'no_data' : 'unavailable';
  const updated = Date.parse(provider.updatedAt ?? '');
  const until = Date.parse(provider.freshUntil ?? '');
  const ageLimit = Number.isFinite(provider.staleAfterSeconds) && (provider.staleAfterSeconds ?? 0) > 0
    ? (provider.staleAfterSeconds as number) * 1000 : 300_000;
  const expiry = Number.isFinite(until) ? until : updated + ageLimit;
  if (provider.stale || provider.error || provider.refreshState === 'failed' || !Number.isFinite(updated) || updated > nowMs
    || !Number.isFinite(expiry) || expiry <= nowMs) return 'stale';
  return running ? 'updating' : 'available';
}
