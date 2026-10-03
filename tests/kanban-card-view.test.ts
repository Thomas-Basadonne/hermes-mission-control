import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const route = readFileSync(new URL('../src/routes/KanbanRoute.tsx', import.meta.url), 'utf8');

test('cards preserve arbitrary priorities and show negative priorities', () => {
  assert.doesNotMatch(route, /PRIORITY_COLORS\[task\.priority[^\n]+PRIORITY_COLORS\[0\]/);
  assert.doesNotMatch(route, /task\.priority > 0/);
  assert.match(route, /getKanbanPriority\(task\.priority\)/);
});

test('both priority pickers share core ordering and preserve custom current values', () => {
  assert.doesNotMatch(route, /P1 — High|P3 — Low|P4 — Lowest/);
  assert.match(route, /getKanbanPriorityOptions\(detail\.priority/);
  assert.match(route, /getKanbanPriorityOptions\(newTaskPriority/);
});

test('drawer refreshes with board snapshots without clearing drafts', () => {
  assert.match(route, /refreshKey=\{board\}/);
  assert.match(route, /\[storedToken, taskId, board, refreshKey, actionBusy, postingComment\]/);
  assert.match(route, /if \(actionBusy \|\| postingComment\) return/);
  assert.match(route, /key=\{`\$\{activeBoard\}:\$\{openTaskId\}`\}/);
});

test('drawer cleanup aborts refresh requests and passes cancellation to the API', () => {
  assert.match(route, /new AbortController\(\)/);
  assert.match(route, /loadKanbanTaskDetail\(storedToken \|\| undefined, taskId, board, controller\.signal\)/);
  assert.match(route, /loadKanbanTaskLog\(storedToken \|\| undefined, taskId, board, controller\.signal\)/);
  assert.match(route, /return \(\) => \{ controller\.abort\(\); \}/);
  assert.doesNotMatch(route, /let cancelled = false/);
});

test('non-terminal run summaries are not presented as final results', () => {
  assert.ok(!route.includes('{(detail.result || detail.latest_summary) ? ('), 'review/running summaries are not final results');
  assert.ok(route.includes("detail.status === 'done' && (detail.result || detail.latest_summary)"));
});

test('lifecycle helpers use the current run, never the initial task start for retries', async () => {
  const file = new URL('../src/lib/kanban-card-view.ts', import.meta.url);
  assert.ok(existsSync(file), 'missing tested card view model');
  const { getKanbanPriority, getKanbanPriorityOptions, getKanbanCardState, formatKanbanDuration } = await import(file.href);
  for (const priority of [-10, -1, 0, 1, 3, 7, 100, 110]) {
    assert.equal(getKanbanPriority(priority)?.label, `P${priority}`);
    const options = getKanbanPriorityOptions(priority);
    assert.ok(options.some((p: { value: string }) => p.value === String(priority)));
    const values = options.map((p: { value: string }) => Number(p.value));
    assert.deepEqual(values, [...values].sort((a, b) => b - a));
  }
  assert.equal(getKanbanPriority(null), null);
  assert.equal(getKanbanPriority(NaN), null);
  assert.notEqual(getKanbanPriority(110).text, getKanbanPriority(-1).text);
  const base = { id: 't_fixture', title: 'Fixture', priority: 100, created_at: 100, started_at: 200 };
  const running = getKanbanCardState({ ...base, status: 'running', current_run_id: 2,
    current_run: { id: 2, profile: 'worker', status: 'running', started_at: 300, last_heartbeat_at: 410 } }, 420);
  assert.equal(running.ageKey, 'kanban.card.elapsed');
  assert.equal(running.age, '2m');
  assert.ok(running.lines.some((line: { key: string; value?: string }) => line.key === 'kanban.card.run' && line.value === '#2'));
  assert.ok(running.lines.some((line: { key: string }) => line.key === 'kanban.card.heartbeat'));
  const unknownRun = getKanbanCardState({ ...base, status: 'running', current_run_id: 2 }, 420);
  assert.notEqual(unknownRun.ageKey, 'kanban.card.elapsed');
  const done = getKanbanCardState({ ...base, status: 'done', completed_at: 400, result_preview: 'Delivered', latest_summary: 'Summary' }, 420);
  assert.equal(done.ageKey, 'kanban.card.completed');
  assert.equal(done.age, '20s');
  assert.equal(done.lines[0].value, 'Delivered');
  assert.equal(getKanbanCardState({ ...base, status: 'done', completed_at: null }, 420).ageKey, 'kanban.card.created');
  assert.equal(getKanbanCardState({ ...base, status: 'blocked', block_reason: 'Need input' }, 420).lines[0].value, 'Need input');
  assert.equal(getKanbanCardState({ ...base, status: 'review', latest_summary: 'Review evidence' }, 420).lines[0].value, 'Review evidence');
  assert.equal(getKanbanCardState({ ...base, status: 'scheduled', schedule_reason: 'Maintenance' }, 420).lines[0].value, 'Maintenance');
  assert.equal(getKanbanCardState({ ...base, status: 'scheduled' }, 420).lines[0].key, 'kanban.card.noScheduleTime');
  for (const status of ['triage', 'todo', 'ready']) assert.equal(getKanbanCardState({ ...base, status }, 420).ageKey, 'kanban.card.created');
  assert.equal(formatKanbanDuration(-1), '0s');
  assert.equal(formatKanbanDuration(3661), '1h 1m');
});
