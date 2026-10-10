import type { MissionControlToolsSnapshot, MissionControlToolsetItem } from './hermes-api';
export function browserToolsets(tools: MissionControlToolsSnapshot): MissionControlToolsetItem[] {
  const byName = new Map<string, MissionControlToolsetItem>();
  for (const item of [...tools.toolsets, ...tools.availableToolsets]) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  return [...byName.values()];
}
export function matchingTools(names: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return [...new Set(names)].filter(name => !needle || name.toLowerCase().includes(needle));
}
export function toolsetMatches(item: MissionControlToolsetItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || item.name.toLowerCase().includes(needle) || matchingTools(item.resolvedTools, needle).length > 0;
}
