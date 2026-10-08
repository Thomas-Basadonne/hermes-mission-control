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

/** Width (px) at or below which the shell is considered mobile, matching the CSS breakpoint. */
export const NAVIGATION_PALETTE_MOBILE_QUERY = '(max-width: 640px)';

/**
 * Move the palette selection by `delta` (normally +1 / -1), wrapping around the
 * filtered list. With no prior selection (index -1) the first option is taken
 * going down and the last going up. Returns -1 for an empty result set.
 */
export function stepNavigationPaletteIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  const base = current % length;
  return (((base + delta) % length) + length) % length;
}

/**
 * Clamp a selection index onto the current result set. A stale index (the query
 * shrank the list) falls back to the first entry, which is what lets `Enter`
 * activate a single match without an explicit arrow press.
 */
export function resolveNavigationPaletteIndex(length: number, index: number): number {
  if (length <= 0) return -1;
  if (index < 0 || index >= length) return 0;
  return index;
}

/**
 * The selection index to carry across a re-render of the result set.
 *
 * The index is positional, so it only means something for the exact list it was
 * chosen on: editing the query can leave the same number pointing at a different
 * destination, and `Enter` would then activate an item the user never selected.
 * Any query change therefore clears the selection (the resolved first / single
 * match is what `Enter` falls back to); a result-set change under the same query
 * keeps a still-in-range selection and drops one that fell out of range.
 */
export function paletteSelectionIndexAfterChange(
  previousQuery: string,
  nextQuery: string,
  currentIndex: number,
  resultLength: number,
): number {
  if (previousQuery !== nextQuery) return -1;
  if (currentIndex < 0) return -1;
  return currentIndex < resultLength ? currentIndex : -1;
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
