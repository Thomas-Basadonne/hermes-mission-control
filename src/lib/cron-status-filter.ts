export type CronStatusFilter = 'active' | 'paused' | 'all';

interface CronFilterJob {
  enabled: boolean;
  state: string;
  profile?: string;
}

export function isCronPaused(job: CronFilterJob): boolean {
  return !job.enabled || job.state === 'paused';
}

/** Filter the view, not the inventory: disabled jobs remain available under All. */
export function filterCronJobs<T extends CronFilterJob>(
  jobs: readonly T[],
  status: CronStatusFilter = 'active',
  profile: string = 'all',
): T[] {
  return jobs
    .filter((job) => profile === 'all' || (job.profile || 'default') === profile)
    .filter((job) => status === 'all' || isCronPaused(job) === (status === 'paused'))
    .sort((left, right) => Number(isCronPaused(left)) - Number(isCronPaused(right)));
}
