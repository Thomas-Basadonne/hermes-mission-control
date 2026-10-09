import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({ configFile: false, cacheDir: process.env.MC_DEV_CACHE,
  root: process.cwd(), appType: 'custom', logLevel: 'silent', plugins: [react()],
  server: { middlewareMode: true, hmr: false } });
const { DataFreshnessPanel } = await server.ssrLoadModule('/src/components/overview/DataFreshnessPanel.tsx');
const { I18nProvider } = await server.ssrLoadModule('/src/lib/i18n.tsx');

const now = Date.now();
const iso = (offsetSeconds) => new Date(now - offsetSeconds * 1000).toISOString();
const live = (name, seconds = 5) => [name, { state: 'live', source: `api-${name}`, lastSuccessAt: iso(seconds), lastAttemptAt: iso(seconds) }];

const render = (sources, { loading = false } = {}) => renderToStaticMarkup(
  createElement(I18nProvider, null, createElement(DataFreshnessPanel, { sources, loading })),
);

try {
  await test('a fully fresh dashboard collapses to one line, with no per-source timestamps', () => {
    const html = render([
      live('machine', 4), live('sessions', 5), live('cron', 6),
      live('alerts', 7), live('snapshot', 8), live('tools', 9), live('skills', 10),
    ]);

    assert.match(html, /Data freshness/, 'the panel keeps its title');
    assert.match(html, /All fresh/, 'the header badge states the outcome once');
    assert.match(html, /7/, 'the summary reports how many sources are live');
    assert.match(html, /Details/, 'the detail affordance is offered');
    assert.doesNotMatch(html, /Last success/, 'no absolute "last success" wall in the healthy state');
    assert.doesNotMatch(html, /Last attempt/, 'no absolute "last attempt" wall in the healthy state');
    // Exactly one freshness age for the whole panel, not one per source.
    assert.equal(html.match(/\d+(s|m|h|d) ago|just now/g)?.length ?? 0, 1, 'a single freshness age, not one per source');
    assert.doesNotMatch(html, />System</, 'the healthy state does not enumerate source names');

    // The header badge carries its own dot; the summary line adds exactly one health dot
    // for every source taken together, instead of one badge per source.
    const summaryDots = html.match(/h-2 w-2 shrink-0 rounded-full bg-positive/g)?.length ?? 0;
    assert.equal(summaryDots, 1, 'a single summary health dot, not one dot per source');
  });

  await test('only the sources that are not live get a row, and the absolute time appears once', () => {
    const html = render([
      live('sessions', 3),
      ['machine', { state: 'error', source: 'fallback', lastAttemptAt: iso(90) }],
      ['cron', { state: 'fallback', source: 'gateway-status-fallback', lastSuccessAt: iso(180), lastAttemptAt: iso(90) }],
    ]);

    assert.match(html, /System/, 'the unavailable source is named');
    assert.match(html, /Unavailable/, 'a source that never succeeded is unavailable');
    assert.match(html, /Cron/);
    assert.match(html, /Previous data/, 'a source with last-known-good data is previous, not unavailable');
    assert.match(html, /gateway-status-fallback/, 'provenance is shown for previous data');
    assert.match(html, /other source/, 'the healthy remainder is summarised, not enumerated');

    assert.equal(html.match(/Last attempt/g)?.length, 1, 'the absolute attempt time is stated once for the failing set');
    assert.doesNotMatch(html, /Last success/, 'past successes are expressed as relative ages, not absolute dates');
    assert.match(html, /2 to check|2/, 'the header counts what needs attention');
  });

  await test('the first paint does not report unpopulated sources as problems', () => {
    const html = render([
      ['machine', { state: 'fallback' }],
      ['sessions', { state: 'fallback' }],
    ], { loading: true });

    assert.match(html, /All fresh/, 'while the first refresh is in flight nothing is flagged');
    assert.doesNotMatch(html, /to check/, 'no false partial-data count on the first paint');
    assert.doesNotMatch(html, /Unavailable/, 'an unpopulated source is not called unavailable');
  });

  await test('with no source data at all the panel states that it is refreshing instead of showing an empty box', () => {
    const html = render([], { loading: true });
    assert.match(html, /Refreshing/, 'the panel is never an empty shell');
  });
} finally {
  await server.close();
}
