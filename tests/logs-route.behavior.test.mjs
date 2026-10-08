import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost/logs', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};
let timerId = 0;
const intervals = new Map();
window.setInterval = (fn, delay) => { const id = ++timerId; intervals.set(id, { fn, delay }); return id; };
window.clearInterval = id => intervals.delete(id);
let clipboardText = null;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { clipboardText = text; } } });

const file = (name, lines) => ({
  name, path: `/fixture/${name}`, updatedAt: null, sizeBytes: 0, entryCount: lines.length,
  entries: lines.map(({ text, level }, index) => ({ lineNumber: index + 1, level, text })),
});
let snapshots = [];
let loadCount = 0;
globalThis.__logsFixtures = { get snapshots() { return snapshots; }, get loadCount() { return loadCount; }, loaded() { loadCount++; } };
const cacheDir = mkdtempSync(path.join(tmpdir(), 'mc-logs-behavior-'));
const server = await createServer({
  root: process.cwd(), configFile: false, cacheDir, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  plugins: [react(), {
    name: 'logs-route-fixtures', enforce: 'pre',
    resolveId(id) {
      if (/\/i18n(?:\.tsx)?$/.test(id)) return '\0fixture-i18n';
      if (/\/hermes-api(?:\.ts)?$/.test(id)) return '\0fixture-api';
      if (/\/mission-control-store(?:\.tsx?)?$/.test(id)) return '\0fixture-store';
      if (/\/usePullToReload(?:\.tsx?)?$/.test(id)) return '\0fixture-pull';
      if (/\/PullToReloadIndicator(?:\.tsx?)?$/.test(id)) return '\0fixture-pull-indicator';
    },
    load(id) {
      if (id === '\0fixture-i18n') return `export const useI18n = () => ({ t: (key, values) => ({'logs.pause':'Pause','logs.resume':'Resume','logs.searchLabel':'Search loaded lines','logs.searchPlaceholder':'Search loaded lines','logs.levelFilterLabel':'Level filter','logs.level.all':'All','logs.level.error':'Errors','logs.level.warn':'Warnings','logs.copyFiltered':'Copy filtered lines','logs.copySuccess':'Copied','logs.copyFailed':'Copy failed','logs.copyLine':'Copy line {number}','logs.searchLoadedOnly':'Search applies only to loaded lines, not history.','logs.noMatchingLines':'No loaded lines match these filters.','logs.noLines':'No lines','logs.noFiles':'No files','logs.filters':'Filters','logs.streamTitle':'Log stream','logs.title':'Logs','logs.description':'Loaded log tail','logs.eyebrow':'Diagnostics','logs.loading':'Loading','logs.live':'Live','logs.unavailable':'Unavailable','logs.errors':'Errors','logs.warnings':'Warnings','logs.files':'Files','logs.inCurrentTail':'Current tail','logs.path':'Path','logs.lines':'{count} lines','logs.updatedUnknown':'Unknown','logs.updated':'Updated {time}','logs.line':'Line {number}','logs.autoRefreshLabel':'Auto refresh','logs.autoRefresh1':'1 second','logs.autoRefresh2':'2 seconds','logs.autoRefresh5':'5 seconds','logs.scrollToTop':'Scroll to top','logs.authRequired':'Authentication required','logs.failedLoad':'Failed to load'}[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(values?.[name] ?? '')) });`;
      if (id === '\0fixture-api') return `export class MissionControlAuthError extends Error {}\nexport async function loadMissionControlLogs() { globalThis.__logsFixtures.loaded(); return globalThis.__logsFixtures.snapshots[0]; }`;
      if (id === '\0fixture-store') return 'export const useMissionControl = () => ({ storedToken: null });';
      if (id === '\0fixture-pull') return 'export const usePullToReload = () => ({ state: null });';
      if (id === '\0fixture-pull-indicator') return 'export const PullToReloadIndicator = () => null;';
    },
  }],
});
const apiServer = await createServer({
  root: process.cwd(), configFile: false, cacheDir, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false }, plugins: [react()],
});
const { createRoot } = await import('react-dom/client');
let root;
const settle = () => new Promise(resolve => setImmediate(resolve));
async function flush(action = () => {}) {
  await act(async () => { await action(); for (let i = 0; i < 5; i++) await settle(); });
}
function button(label) {
  const found = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
async function click(label) { await flush(() => button(label).click()); }
async function tickActiveIntervals() {
  for (const [id, timer] of [...intervals]) {
    if (intervals.has(id)) await flush(() => timer.fn());
  }
}
async function type(input, value) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
try {
  const rawSnapshot = { available: true, path: '/fixture', fileCount: 2, totalEntries: 6, generatedAt: null, files: [
    file('alpha.log', [
      { level: 'info', text: 'INFO startup <img src=x onerror=alert(1)>' },
      { level: 'warn', text: 'WARNING disk nearly full' },
      { level: 'error', text: 'ERROR database failed' },
      { level: 'error', text: 'CRITICAL disk failed' },
    ]),
    file('beta.log', [{ level: 'info', text: 'INFO second file' }, { level: 'error', text: 'ERROR second database failed' }]),
  ] };
  const realApi = await apiServer.ssrLoadModule('/src/lib/hermes-api.ts');
  globalThis.fetch = async () => Response.json(rawSnapshot);
  snapshots = [await realApi.loadMissionControlLogs(undefined, { maxFiles: 10, maxLines: 160 })];
  assert.deepEqual(snapshots[0].files[0].entries.map(entry => entry.level), ['info', 'warn', 'error', 'error'], 'The real API loader preserves normalized mixed levels, including CRITICAL as error');
  const { LogsRoute } = await server.ssrLoadModule('/src/routes/LogsRoute.tsx');
  root = createRoot(document.getElementById('root'));
  await flush(() => root.render(React.createElement(LogsRoute)));

  assert.ok(loadCount >= 1, 'Initial render loads the log tail');
  assert.equal(document.querySelectorAll('img').length, 0, 'Log text is rendered as text, not HTML');
  assert.ok(document.body.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(document.body.textContent.includes('Search applies only to loaded lines, not history.'));
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 4, 'All mixed-level entries render');
  await click('Errors');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 2, 'Error filter selects error and critical entries');
  await click('Warnings');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 1, 'Warning filter selects warning entries');
  await click('Errors');
  await type(document.querySelector('input[type="search"]'), 'database');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 1, 'Search combines with the selected level filter');
  assert.ok(document.body.textContent.includes('ERROR database failed'));
  await click('Copy filtered lines');
  assert.equal(clipboardText, 'ERROR database failed', 'Filtered copy contains only the matching loaded line');

  await type(document.querySelector('input[type="search"]'), 'nothing-matches');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 0);
  assert.ok(document.body.textContent.includes('No loaded lines match these filters.'));
  assert.equal(button('Copy filtered lines').disabled, true);

  await type(document.querySelector('input[type="search"]'), 'second');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 0, 'Search remains scoped to the selected file');
  const loadsBeforeFileSelection = loadCount;
  const timerBeforeFileSelection = [...intervals.keys()];
  await click('beta.log');
  assert.equal(document.querySelectorAll('button[aria-label^="Copy line"]').length, 1, 'Changing file refreshes results for the new file');
  assert.equal(loadCount, loadsBeforeFileSelection, 'Selecting a loaded file does not restart the log fetch or refresh timer');
  assert.deepEqual([...intervals.keys()], timerBeforeFileSelection, 'Selecting a loaded file preserves the existing refresh timer');
  assert.ok(document.body.textContent.includes('ERROR second database failed'));
  const copyLine = [...document.querySelectorAll('button[aria-label]')].find(el => el.getAttribute('aria-label') === 'Copy line 2');
  assert.ok(copyLine, 'Each row exposes a single-line copy control');
  await flush(() => copyLine.click());
  assert.equal(clipboardText, 'ERROR second database failed', 'Single-line copy writes only the chosen line');

  const interval = [...intervals.values()][0];
  assert.ok(interval, 'Live refresh interval is installed');
  await click('Pause');
  assert.equal(intervals.size, 0, 'Pause removes the active interval');
  const loadsWhilePaused = loadCount;
  await tickActiveIntervals();
  assert.equal(loadCount, loadsWhilePaused, 'No active timer polls while paused');
  await click('Resume');
  assert.equal(loadCount, loadsWhilePaused + 1, 'Resume immediately reloads the tail');
  assert.equal(intervals.size, 1, 'Resume installs exactly one interval');
  await tickActiveIntervals();
  assert.equal(loadCount, loadsWhilePaused + 2, 'A resumed timer tick refreshes logs');

  await flush(() => root.unmount()); root = null;
  assert.equal(intervals.size, 0, 'Unmount cleans up the refresh timer');
  console.log('Logs route behavior: filtering, file selection, pause/resume, rendering and copy passed.');
} finally {
  if (root) await flush(() => root.unmount());
  await apiServer.close();
  await server.close();
  dom.window.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
