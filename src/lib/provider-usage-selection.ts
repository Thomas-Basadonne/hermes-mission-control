import { ProviderUsageHttpError } from './provider-usage-request';

export function isProviderUsageSelectionUncertain(error: unknown): boolean {
  if (error instanceof ProviderUsageHttpError) return error.status >= 500;
  return !(error instanceof Error && error.name === 'MissionControlAuthError');
}

export function createProviderUsageGeneration() {
  let generation = 0;
  return { capture: () => generation, invalidate: () => { generation += 1; }, isCurrent: (captured: number) => captured === generation };
}

export function createProviderUsageSelectionController() {
  const generation = createProviderUsageGeneration();
  let saving = false;
  let uncertain = false;
  return {
    beginRead: (): number | null => saving ? null : generation.capture(),
    acceptRead: (captured: number | null, usable: boolean, revision?: string): boolean => {
      if (captured === null || saving || !generation.isCurrent(captured) || (uncertain && (!usable || !revision || !/^[0-9a-f]{64}$/.test(revision)))) return false;
      uncertain = false; return true;
    },
    beginSave: (revision?: string): boolean => {
      if (saving || uncertain || !revision || !/^[0-9a-f]{64}$/.test(revision)) return false;
      generation.invalidate(); saving = true; return true;
    },
    settleSave: (needsReconciliation: boolean): void => {
      generation.invalidate(); saving = false; uncertain = needsReconciliation;
    },
    canSave: (): boolean => !saving && !uncertain,
    invalidate: (): void => { generation.invalidate(); },
  };
}
