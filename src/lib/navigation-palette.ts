export type NavigationPaletteItem = {
  kind: 'route' | 'chat';
  label: string;
  to: string;
  icon: string;
};

export function filterNavigationPaletteItems<T extends NavigationPaletteItem>(items: T[], queryText: string): T[] {
  const query = queryText.trim().toLocaleLowerCase();
  if (!query) return items;
  return items.filter((item) => item.label.toLocaleLowerCase().includes(query) || item.to.toLocaleLowerCase().includes(query));
}

export function isNavigationPaletteTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, [role="textbox"]'));
}

/**
 * Merge the shell's nav catalogs into the single ordered list both the sidebar
 * order and the palette read from.
 *
 * The runtime plugin loader wires the same plugin list through BOTH the registry
 * and the `navItems` prop (App.tsx), so a naive concat lists every plugin twice.
 * Destinations are unique by definition: keep the first occurrence in merge
 * priority order (defaults, then registry, then runtime props).
 */
export function mergeNavigationItems<T extends { to: string; order?: number }>(...groups: T[][]): T[] {
  const merged = groups.flat();
  return merged
    .filter((item, index) => merged.findIndex((candidate) => candidate.to === item.to) === index)
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
