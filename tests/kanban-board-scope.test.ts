import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({
  configFile: false,
  cacheDir: process.env.MC_DEV_CACHE,
  root: new URL('..', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  plugins: [react(), {
    name: 'kanban-test-context',
    enforce: 'pre',
    resolveId(id) {
      if (/\/mission-control-store(?:\.tsx)?$/.test(id)) return '\0kanban-test-store';
      if (/\/i18n(?:\.tsx)?$/.test(id)) return '\0kanban-test-i18n';
    },
    load(id) {
      if (id === '\0kanban-test-store') return "export const useMissionControl = () => ({ storedToken: 'fixture-token' });";
      if (id === '\0kanban-test-i18n') return 'export const useI18n = () => ({ t: key => key });';
    },
  }],
});
after(() => server.close());

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}

// Follow the existing lifecycle-test pattern: execute the route's hooks and
// rendered callbacks, leaving the real API serializer intact. No live requests.
function mount(Route) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots = [];
  let index = 0, dirty = true, tree, effects;
  const memo = (factory, deps) => {
    const i = index++;
    const previous = slots[i];
    if (!previous || !deps || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
      slots[i] = { value: factory(), deps };
    }
    return slots[i].value;
  };
  const dispatcher = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, next => {
        const value = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {
      const i = index++;
      const slot = slots[i] ?? (slots[i] = {});
      if (!slot.deps || !deps || deps.some((value, j) => !Object.is(value, slot.deps[j]))) {
        effects.push(() => { slot.cleanup?.(); slot.deps = deps; slot.cleanup = effect(); });
      }
    },
  };
  return {
    async flush() {
      for (let round = 0; round < 20; round++) {
        if (dirty) {
          dirty = false; index = 0; effects = [];
          const previous = internals.H;
          internals.H = dispatcher;
          try { tree = Route(); } finally { internals.H = previous; }
          for (const effect of effects) effect();
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(dirty, false, 'route lifecycle must settle');
    },
    elements: () => nodes(tree),
    unmount: () => { for (const slot of slots) slot.cleanup?.(); },
  };
}

async function withRoute(context, run) {
  const writes = [];
  const task = { id: 't_fixture', title: 'Fixture', status: 'todo', priority: 0 };
  const board = { columns: [{ name: 'todo', tasks: [task] }, { name: 'triage', tasks: [] }] };
  const boards = ['default', 'project-alpha', 'project-beta'].map(slug => ({ slug, name: slug }));
  context.mock.method(globalThis, 'setInterval', () => 0);
  context.mock.method(globalThis, 'clearInterval', () => {});
  context.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    let payload;
    if (init?.method === 'POST') {
      writes.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      payload = { id: 't_created', task: null };
    } else if (url.pathname === '/api/local/kanban/boards') {
      payload = { boards, current: 'default' };
    } else {
      assert.equal(url.pathname, '/api/local/kanban/board');
      payload = structuredClone(board);
    }
    return Response.json(payload);
  });
  const { KanbanRoute } = await server.ssrLoadModule('/src/routes/KanbanRoute.tsx');
  const harness = mount(KanbanRoute);
  try {
    await harness.flush();
    await run(harness, writes);
  } finally {
    harness.unmount();
  }
}

test('rendered drop callback scopes updates to the selected board, including after switching', async context => {
  await withRoute(context, async (harness, writes) => {
    const slugs = ['project-alpha', 'project-beta', 'default'];
    for (const [index, slug] of slugs.entries()) {
      harness.elements().find(node => typeof node.props.onSelect === 'function').props.onSelect(slug);
      await harness.flush();
      harness.elements().find(node => typeof node.props.onDropTask === 'function').props.onDropTask('t_fixture', 'triage');
      await harness.flush();
      const request = writes.at(-1);
      assert.equal(writes.length, index + 1);
      assert.equal(request.url.pathname, '/api/local/kanban/tasks/t_fixture');
      assert.equal(request.url.searchParams.get('board'), slug);
      assert.equal(request.method, 'POST');
      assert.deepEqual(request.body, { status: 'triage' });
      const column = harness.elements().find(node => node.props.name === 'triage' && node.props.onDropTask);
      assert.deepEqual(column.props.tasks.map(task => task.id), ['t_fixture']);
    }
  });
});

test('rendered create form scopes new tasks to the selected board', async context => {
  await withRoute(context, async (harness, writes) => {
    harness.elements().find(node => typeof node.props.onSelect === 'function').props.onSelect('project-alpha');
    await harness.flush();
    harness.elements().find(node => typeof node.props.onAddTask === 'function').props.onAddTask('todo');
    await harness.flush();
    harness.elements().find(node => node.type === 'input' && node.props.autoFocus).props.onChange({ target: { value: 'Scoped fixture' } });
    await harness.flush();
    harness.elements().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await harness.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url.pathname, '/api/local/kanban/tasks');
    assert.equal(writes[0].url.searchParams.get('board'), 'project-alpha');
    assert.equal(writes[0].method, 'POST');
    assert.deepEqual(writes[0].body, { title: 'Scoped fixture', priority: 0, status: 'todo', workspace_kind: 'scratch' });
    const column = harness.elements().find(node => node.props.name === 'todo' && node.props.onDropTask);
    assert.ok(column.props.tasks.some(task => task.id === 't_created'));
  });
});

test('task update serializes an explicit board and preserves the optional-board API', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  try {
    const { moveKanbanTask } = await server.ssrLoadModule('/src/lib/hermes-api.ts');
    globalThis.fetch = async (input, init) => {
      requests.push({ url: new URL(String(input), 'http://localhost'), body: JSON.parse(String(init?.body)) });
      return Response.json({ task: null });
    };
    await moveKanbanTask(undefined, 't_fixture', 'triage', 'project-alpha');
    await moveKanbanTask(undefined, 't_fixture', 'triage');
    assert.equal(requests[0].url.pathname, '/api/local/kanban/tasks/t_fixture');
    assert.equal(requests[0].url.searchParams.get('board'), 'project-alpha');
    assert.deepEqual(requests[0].body, { status: 'triage' });
    assert.equal(requests[1].url.search, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
