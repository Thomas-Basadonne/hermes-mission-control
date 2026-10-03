import type { MissionControlKanbanTask } from './hermes-api';

/** Core dispatches descending integer priority; no bounded P0–P5 enum exists. */
export function getKanbanPriority(priority?: number | null) {
  if (priority == null || !Number.isSafeInteger(priority)) return null;
  const tone = priority >= 3 ? { bg: 'bg-red-500/15', text: 'text-red-400' }
    : priority === 2 ? { bg: 'bg-amber-500/15', text: 'text-amber-400' }
    : priority === 1 ? { bg: 'bg-sky-500/15', text: 'text-sky-400' }
    : { bg: 'bg-surface-sunken', text: 'text-text-subtle' };
  return { ...tone, label: `P${priority}` };
}

export function getKanbanPriorityOptions(current: number = 0) {
  const values = [...new Set([3, 2, 1, 0, -1, ...(Number.isSafeInteger(current) ? [current] : [])])];
  return values.sort((a, b) => b - a).map((priority) => ({
    value: String(priority),
    labelKey: priority === 3 ? 'kanban.priorityHigher'
      : priority === 2 ? 'kanban.priorityElevated'
      : priority === 1 ? 'kanban.priorityAboveNormal'
      : priority === 0 ? 'kanban.priorityNormal'
      : priority === -1 ? 'kanban.priorityBelowNormal' : 'kanban.priorityCustom',
    priority,
  }));
}

export function formatKanbanDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

type CardLine = { key: string; value?: string };

export function getKanbanCardState(task: MissionControlKanbanTask, now = Date.now() / 1000) {
  let ageKey = 'kanban.card.created';
  let timestamp = task.created_at;
  const lines: CardLine[] = [];
  const run = task.current_run;
  if (task.status === 'running') {
    // started_at on the TASK may be the first-ever attempt. Only the current run is elapsed.
    if (run && run.id === task.current_run_id && run.ended_at == null) {
      ageKey = 'kanban.card.elapsed';
      timestamp = run.started_at;
      lines.push({ key: 'kanban.card.run', value: `#${run.id}` });
      const heartbeat = run.last_heartbeat_at;
      if (heartbeat != null) lines.push({ key: 'kanban.card.heartbeat', value: formatKanbanDuration(now - heartbeat) });
    } else {
      lines.push({ key: 'kanban.card.runUnavailable' });
    }
  } else if (task.status === 'done') {
    if (task.completed_at != null) { ageKey = 'kanban.card.completed'; timestamp = task.completed_at; }
    const result = task.result_preview || task.latest_summary;
    lines.push(result ? { key: 'kanban.card.result', value: result } : { key: 'kanban.card.noResult' });
  } else if (task.status === 'blocked') {
    lines.push(task.block_reason ? { key: 'kanban.card.blocked', value: task.block_reason } : { key: 'kanban.card.noBlockReason' });
    if (task.block_kind) lines.push({ key: 'kanban.card.blockKind', value: task.block_kind });
  } else if (task.status === 'review') {
    lines.push(task.latest_summary ? { key: 'kanban.card.review', value: task.latest_summary } : { key: 'kanban.card.noReviewSummary' });
  } else if (task.status === 'scheduled') {
    lines.push(task.schedule_reason ? { key: 'kanban.card.scheduled', value: task.schedule_reason } : { key: 'kanban.card.noScheduleTime' });
  }
  const age = timestamp != null && Number.isFinite(timestamp) ? formatKanbanDuration(now - timestamp) : null;
  return { ageKey, age, lines };
}
