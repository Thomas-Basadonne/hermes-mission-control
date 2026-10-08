import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterNavigationPaletteItems, isNavigationPaletteTextTarget, mergeNavigationItems } from '../src/lib/navigation-palette.ts';

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

console.log('navigation palette filtering, catalog merge, shortcut target and Escape-layer behavior passed');
