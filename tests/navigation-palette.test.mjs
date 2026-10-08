import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterNavigationPaletteItems, isNavigationPaletteTextTarget, mergeNavigationItems, paletteSelectionIndexAfterChange, resolveNavigationPaletteIndex, stepNavigationPaletteIndex, NAVIGATION_PALETTE_MOBILE_QUERY } from '../src/lib/navigation-palette.ts';

class FakeElement {
  constructor({ editable = false, matched = false } = {}) {
    this.isContentEditable = editable;
    this.matched = matched;
  }
  closest() { return this.matched ? {} : null; }
}
const previousHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = FakeElement;
try {
  const items = [
    { kind: 'route', label: 'Overview', to: '/', icon: 'LayoutDashboard' },
    { kind: 'route', label: 'Plugin reports', to: '/plugin/reports', icon: 'Chart' },
    { kind: 'chat', label: 'Open chat', to: '', icon: 'MessageSquare' },
  ];
  assert.deepEqual(filterNavigationPaletteItems(items, ''), items, 'empty search preserves the complete core/plugin/chat catalog');
  assert.deepEqual(filterNavigationPaletteItems(items, '  PlUgIn '), [items[1]], 'search trims and ignores case');
  assert.deepEqual(filterNavigationPaletteItems(items, '/plugin'), [items[1]], 'search matches route paths');
  assert.deepEqual(filterNavigationPaletteItems(items, 'chat'), [items[2]], 'chat is searchable like a route');
  assert.deepEqual(filterNavigationPaletteItems(items, 'missing'), [], 'unmatched search is empty');

  assert.equal(isNavigationPaletteTextTarget(new FakeElement()), false, 'non-editable drawer/background targets may use the global shortcut');
  assert.equal(isNavigationPaletteTextTarget(new FakeElement({ editable: true })), true, 'contenteditable targets retain their own shortcut');
  assert.equal(isNavigationPaletteTextTarget(new FakeElement({ matched: true })), true, 'inputs, CodeMirror and textbox targets retain their own shortcut');
  assert.equal(isNavigationPaletteTextTarget(null), false, 'window-level shortcut events are not treated as text entry');

  // The runtime loader feeds the same plugin list through the registry AND the
  // navItems prop, so the merged catalog must not list a destination twice.
  const defaults = [
    { to: '/', label: 'Overview', order: 10 },
    { to: '/cron', label: 'Cron', order: 60 },
    { to: '/config', label: 'Config', order: 80 },
  ];
  const plugin = { to: '/reports', label: 'Plugin reports', order: 25 };
  const merged = mergeNavigationItems(defaults, [plugin], [{ ...plugin }]);
  assert.deepEqual(merged.map((item) => item.to), ['/', '/reports', '/cron', '/config'], 'duplicate destinations collapse into one ordered entry');
  assert.equal(merged.length, 4, `merged ${merged.length} entries`);
  assert.deepEqual(mergeNavigationItems([], [], []), [], 'empty catalogs stay empty');
  assert.deepEqual(
    mergeNavigationItems([{ to: '/x', label: 'first', order: 1 }], [{ to: '/x', label: 'second', order: 1 }])[0].label,
    'first',
    'the first occurrence in merge priority order wins',
  );

  // Arrow-key cycling: wraps around both ends, tolerates a stale index and
  // reports -1 (nothing selectable) for an empty result set.
  assert.equal(stepNavigationPaletteIndex(-1, 3, 1), 0, 'ArrowDown from no selection picks the first option');
  assert.equal(stepNavigationPaletteIndex(-1, 3, -1), 2, 'ArrowUp from no selection picks the last option');
  assert.equal(stepNavigationPaletteIndex(0, 3, 1), 1, 'ArrowDown advances');
  assert.equal(stepNavigationPaletteIndex(2, 3, 1), 0, 'ArrowDown wraps to the top');
  assert.equal(stepNavigationPaletteIndex(0, 3, -1), 2, 'ArrowUp wraps to the bottom');
  assert.equal(stepNavigationPaletteIndex(7, 3, 1), 2, 'a stale index is normalised before stepping');
  assert.equal(stepNavigationPaletteIndex(0, 0, 1), -1, 'an empty result set has no selectable option');

  // Enter activation index: a collapsed (single-result) list anchors on the
  // first option so Enter navigates without an explicit arrow press.
  assert.equal(resolveNavigationPaletteIndex(0, -1), -1, 'empty list resolves to no selection');
  assert.equal(resolveNavigationPaletteIndex(1, -1), 0, 'single match activates on Enter with no selection');
  assert.equal(resolveNavigationPaletteIndex(5, -1), 0, 'unset selection resolves to the first option');
  assert.equal(resolveNavigationPaletteIndex(5, 3), 3, 'a valid selection is preserved');
  assert.equal(resolveNavigationPaletteIndex(2, 5), 0, 'a selection past the shrunk list falls back to the first match');

  // Regression (PR #105 review): the selection is positional, so editing the
  // query must not carry the old index onto a different destination — otherwise
  // Enter navigates to an item the user never selected.
  assert.equal(paletteSelectionIndexAfterChange('', 's', 2, 6), -1, 'a query change clears the selection even when the index is still in range');
  assert.equal(paletteSelectionIndexAfterChange('s', 'sk', 2, 4), -1, 'every keystroke clears the stale selection');
  assert.equal(paletteSelectionIndexAfterChange('s', 's', 2, 6), 2, 'a same-query re-render keeps a still-valid selection');
  assert.equal(paletteSelectionIndexAfterChange('s', 's', 5, 3), -1, 'a same-query shrink past the list clears the selection');
  assert.equal(paletteSelectionIndexAfterChange('', '', -1, 6), -1, 'no selection stays unset');

  // End-to-end on the real helpers: open, arrow down to a mid-list item, then
  // narrow the query. Enter must not activate the item the stale index now hits.
  {
    const full = ['Logs', 'Cron', 'Config', 'Kanban', 'Sessions', 'Skills', 'System', 'Bots']
      .map((label, order) => ({ kind: 'route', label, to: `/${label.toLowerCase()}`, icon: 'x', order }));
    const selectedBefore = stepNavigationPaletteIndex(stepNavigationPaletteIndex(stepNavigationPaletteIndex(-1, full.length, 1), full.length, 1), full.length, 1);
    assert.equal(full[selectedBefore].label, 'Config', 'three ArrowDown presses select the third entry');

    const narrowed = filterNavigationPaletteItems(full, 's');
    const staleIndex = selectedBefore < narrowed.length ? selectedBefore : -1;
    assert.equal(staleIndex, 2, 'the naive length-only guard would keep index 2');
    assert.notEqual(narrowed[staleIndex].label, 'Config', 'but index 2 on the narrowed list is a different destination');

    const guarded = paletteSelectionIndexAfterChange('', 's', selectedBefore, narrowed.length);
    const activated = resolveNavigationPaletteIndex(narrowed.length, guarded);
    assert.equal(activated, 0, 'after the guard, Enter falls back to the first match');
    assert.equal(narrowed[activated].label, 'Logs', 'and activates the first match, not the stale position');
  }

  // The breakpoint is shared between the stylesheet and the matchMedia gate, so
  // a drift between the two would silently break the mobile hiding.
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const breakpoint = /max-width:\s*(\d+)px/.exec(NAVIGATION_PALETTE_MOBILE_QUERY);
  assert.ok(breakpoint, `mobile query must carry a px breakpoint: ${NAVIGATION_PALETTE_MOBILE_QUERY}`);
  assert.match(styles, new RegExp(`@media \\(max-width: ${breakpoint[1]}px\\)[\\s\\S]*?\\.palette-open-button\\s*\\{[^}]*display:\\s*none`), 'mobile stylesheet must hide the header trigger');
  assert.match(styles, new RegExp(`@media \\(max-width: ${breakpoint[1]}px\\)[\\s\\S]*?\\.navigation-palette-backdrop\\s*\\{[^}]*display:\\s*none`), 'mobile stylesheet must hide the palette overlay');
} finally {
  if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = previousHTMLElement;
}

// Source contract: the palette is the topmost layer, so Escape must be consumed
// in the capture phase, before the chat drawer / sidebar handlers underneath.
const shell = readFileSync(new URL('../src/components/MissionControlShell.tsx', import.meta.url), 'utf8');
assert.match(shell, /addEventListener\('keydown', onDialogKeyDown, true\)/, 'palette Escape handler must be capture-phase');
assert.match(shell, /stopImmediatePropagation\(\)/, 'palette Escape must not fall through to lower layers');
assert.match(shell, /insideOpenPalette/, 'the palette search field must still toggle the palette closed');
// Keyboard navigation and mobile gating are wired into the real shell.
assert.match(shell, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/, 'the palette must handle Up/Down arrows');
assert.match(shell, /stepNavigationPaletteIndex\(/, 'arrow handling must use the cyclic selection helper');
assert.match(shell, /paletteSelectionIndexAfterChange\(/, 'the shell must clear a stale selection when the query changes');
assert.match(shell, /event\.key === 'Enter'[\s\S]*?activatePaletteItemRef\.current/, 'Enter must activate the selected/resolved option');
assert.match(shell, /paletteOpen && !paletteMobile/, 'the palette overlay must not render on mobile');
assert.match(shell, /paletteMobile \? null : \(/, 'the header trigger must not render on mobile');
assert.match(shell, /if \(paletteMobile\) return;/, 'the shortcut must be inert on mobile');

console.log('navigation palette filtering, catalog merge, keyboard selection, mobile gating, shortcut target and Escape-layer behavior passed');
