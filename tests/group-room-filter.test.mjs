import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: browser.window,
  document: browser.window.document,
  HTMLElement: browser.window.HTMLElement,
  MutationObserver: browser.window.MutationObserver,
  localStorage: browser.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.window.navigator });
browser.window.HTMLElement.prototype.scrollTo = () => {};
// Tool trace transport is isolated; no requests ever reach the live sidecar.
globalThis.fetch = async () => new Response(JSON.stringify({ tools: [] }), { headers: { 'Content-Type': 'application/json' } });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent',
  plugins: [react()], server: { middlewareMode: true, hmr: false },
});
const [{ GroupRoomView }, { I18nProvider }] = await Promise.all([
  vite.ssrLoadModule('/src/components/chat/GroupRoomView.tsx'),
  vite.ssrLoadModule('/src/lib/i18n.tsx'),
]);
const members = [
  { id: 'a', profile: 'fixture-a', handle: 'crossnection', displayName: 'crossnection' },
  { id: 'b', profile: 'fixture-b', handle: 'crossnection-reviewer', displayName: 'crossnection-reviewer' },
];
const state = {
  room: { id: 'fixture-room', name: 'Fixture', members }, selectedRoomId: 'fixture-room',
  events: [], loading: false, error: null, serviceUnavailable: false, authorityChanged: false,
  driverStatus: { members: { a: { status: 'idle' }, b: { status: 'working' } } },
  pendingActions: [], approval: null, blocked: false, working: true, disbanded: false,
};
async function mount(overrides = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next) => act(async () => root.render(
    React.createElement(I18nProvider, null, React.createElement(GroupRoomView, { state: { ...state, ...next } })),
  ));
  await render(overrides);
  return {
    container, render,
    click: async (button) => act(async () => button.click()),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
const chips = (container) => [...container.querySelectorAll('.chat-room-filter-chip')];
const outsideNotices = (container) => [...container.querySelectorAll('[role="status"]')]
  .filter((notice) => /background|outside this view/.test(notice.textContent));

try {
  await test('member filters explain their purpose and expose each available status in text', async () => {
    const ui = await mount();
    try {
      const group = ui.container.querySelector('[role="group"][aria-label="Show messages from"]');
      assert.ok(group, 'filter needs an explicit label, not an ambiguous tablist');
      assert.match(ui.container.textContent, /Show messages from/);
      const buttons = chips(ui.container);
      assert.equal(buttons[0].textContent.trim(), 'All members');
      assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
      assert.match(buttons[1].textContent, /crossnection.*Idle/);
      assert.match(buttons[2].textContent, /crossnection-reviewer.*Working/);
      assert.equal(buttons[1].querySelector('.animate-spin'), null);
      assert.ok(buttons[2].querySelector('.animate-spin'));
    } finally { await ui.unmount(); }
  });
  await test('a filtered view names the hidden working member and Show all clears the filter', async () => {
    const ui = await mount();
    try {
      await ui.click(chips(ui.container)[1]);
      const notice = outsideNotices(ui.container)[0];
      assert.ok(notice);
      assert.match(notice.textContent, /crossnection-reviewer is working outside this view/);
      assert.equal(chips(ui.container)[1].getAttribute('aria-pressed'), 'true');
      const showAll = [...notice.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Show all');
      assert.ok(showAll);
      await ui.click(showAll);
      assert.equal(outsideNotices(ui.container).length, 0);
      assert.equal(chips(ui.container)[0].getAttribute('aria-pressed'), 'true');
    } finally { await ui.unmount(); }
  });
  await test('filtering keeps user messages and canonical event order, and All restores every member', async () => {
    const events = [
      { id: 'u1', seq: 1, kind: 'message.user', actor: { kind: 'user', id: 'user' }, message: { text: 'User question', member: null }, createdAt: 1700000000000 },
      { id: 'a2', seq: 2, kind: 'message.member', actor: { kind: 'member', id: 'a' }, message: { text: 'Alpha answer', member: { id: 'a' } }, createdAt: 1700000001000 },
      { id: 'b3', seq: 3, kind: 'message.member', actor: { kind: 'member', id: 'b' }, message: { text: 'Beta answer', member: { id: 'b' } }, createdAt: 1700000002000 },
    ];
    const ui = await mount({ events });
    const prose = () => [...ui.container.querySelectorAll('.chat-transcript article p')].map((p) => p.textContent);
    try {
      assert.deepEqual(prose(), ['User question', 'Alpha answer', 'Beta answer']);
      await ui.click(chips(ui.container)[1]);
      assert.deepEqual(prose(), ['User question', 'Alpha answer']);
      await ui.click(chips(ui.container)[2]);
      assert.deepEqual(prose(), ['User question', 'Beta answer']);
      assert.equal(outsideNotices(ui.container).length, 0, 'focused worker is visible');
      await ui.click(chips(ui.container)[0]);
      assert.deepEqual(prose(), ['User question', 'Alpha answer', 'Beta answer']);
      assert.deepEqual(events.map((event) => event.id), ['u1', 'a2', 'b3']);
    } finally { await ui.unmount(); }
  });
  await test('hidden activity updates with live state and includes all hidden workers', async () => {
    const extra = { id: 'c', profile: 'fixture-c', handle: 'third' };
    const overrides = {
      room: { ...state.room, members: [...members, extra] },
      driverStatus: { members: { a: { status: 'idle' }, b: { status: 'working' }, c: { status: 'working' } } },
    };
    const ui = await mount(overrides);
    try {
      await ui.click(chips(ui.container)[1]);
      assert.match(outsideNotices(ui.container)[0].textContent, /crossnection-reviewer, @third are working outside this view/);
      await ui.render({ ...overrides, driverStatus: { members: { a: { status: 'idle' }, b: { status: 'settled' }, c: { status: 'unavailable' } } } });
      assert.equal(outsideNotices(ui.container).length, 0);
      assert.match(chips(ui.container)[2].textContent, /Settled/);
      assert.match(chips(ui.container)[3].textContent, /Unavailable/);
      assert.equal(ui.container.querySelector('.chat-room-filterbar .animate-spin'), null);
    } finally { await ui.unmount(); }
  });
  await test('Italian locale translates filter labels and names hidden activity', async () => {
    localStorage.setItem('mission-control-locale', 'it');
    const ui = await mount();
    try {
      assert.ok(ui.container.querySelector('[role="group"][aria-label="Mostra messaggi di"]'));
      assert.equal(chips(ui.container)[0].textContent.trim(), 'Tutti i membri');
      await ui.click(chips(ui.container)[1]);
      assert.match(ui.container.querySelector('.chat-room-outside-activity').textContent, /crossnection-reviewer sta lavorando fuori da questa vista.*Mostra tutti/);
    } finally { await ui.unmount(); localStorage.removeItem('mission-control-locale'); }
  });
  await test('showing all members never reports a working member as outside the view', async () => {
    const ui = await mount();
    try {
      assert.equal(chips(ui.container).length, 3);
      assert.equal(outsideNotices(ui.container).length, 0);
    } finally { await ui.unmount(); }
  });
} finally {
  await vite.close(); browser.window.close();
}
