import {
  extractClarifyToolContent,
  mergeClarifyInteractionContent,
  normalizeClarifyInteraction,
  buildClarifyAnswers,
  cancelledApprovalRequestIds,
  lockClarifyInteractionAnswer,
} from '../src/lib/chat-interactions.ts';

function assertEqual<T>(actual: T, expected: T) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}

const structuredClarify = {
  responses: [{
    question: 'Quale model/provider vuoi assegnare alla Kanban lane?',
    choices_offered: ['OpenRouter', 'oMLX locale', 'Router automatico'],
    user_response: '',
  }],
};

assertDeepEqual(normalizeClarifyInteraction(structuredClarify), {
  question: 'Quale model/provider vuoi assegnare alla Kanban lane?',
  choices: ['OpenRouter', 'oMLX locale', 'Router automatico'],
  multiSelect: false,
  questionId: null,
});

const toolContent = extractClarifyToolContent({
  type: 'tool.started',
  payload: {
    tool_name: 'clarify',
    args: {
      question: 'Quale model/provider vuoi assegnare alla Kanban lane?',
      choices: ['OpenRouter', 'oMLX locale', 'Router automatico'],
    },
  },
});
assertDeepEqual(toolContent, {
  question: 'Quale model/provider vuoi assegnare alla Kanban lane?',
  choices: ['OpenRouter', 'oMLX locale', 'Router automatico'],
  multiSelect: false,
  questionId: null,
});

assertDeepEqual(mergeClarifyInteractionContent({ request_id: 'clarify-1' }, toolContent), {
  request_id: 'clarify-1',
  question: 'Quale model/provider vuoi assegnare alla Kanban lane?',
  choices: ['OpenRouter', 'oMLX locale', 'Router automatico'],
});

assertDeepEqual(normalizeClarifyInteraction({
  questions: [{ qid: 'planet-1', question: 'Quale ambiente?', choices: ['Locale', 'Cloud'], multi_select: true }],
}), {
  question: 'Quale ambiente?',
  choices: ['Locale', 'Cloud'],
  multiSelect: true,
  questionId: 'planet-1',
});

assertEqual(extractClarifyToolContent({ type: 'tool.completed', payload: { tool_name: 'terminal', result: '{}' } }), null);

const replayedBatch = {
  questions: [
    { qid: 'q1', question: 'First?', choices: ['A'] },
    { qid: 'q2', question: 'Second?', choices: ['B'] },
  ],
  answers: { q1: null },
};
assertEqual(normalizeClarifyInteraction(replayedBatch).questionId, 'q2');
assertDeepEqual(buildClarifyAnswers(replayedBatch, 'B'), { q1: null, q2: 'B' });

const lockedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const progressing = { questions: replayedBatch.questions };
const firstLock = await lockClarifyInteractionAnswer(progressing, 'srq-7', 'A', 'default', async (method, params) => {
  lockedCalls.push({ method, params });
  return { status: 'ok', remaining: ['q2'] };
});
assertEqual(firstLock.pending, true);
assertEqual(normalizeClarifyInteraction(firstLock.payload).questionId, 'q2');
assertDeepEqual(lockedCalls, [{ method: 'clarify.lock', params: {
  request_id: 'srq-7', question_id: 'q1', answer: 'A', profile: 'default',
} }]);
const lastLock = await lockClarifyInteractionAnswer(firstLock.payload, 'srq-7', 'B', 'default', async () => ({ status: 'ok', remaining: [] }));
assertEqual(lastLock.pending, false);
assertDeepEqual(lastLock.payload.answers, { q1: 'A', q2: 'B' });

assertDeepEqual(normalizeClarifyInteraction({
  ...replayedBatch, question: 'First?', choices: ['A'], multi_select: true,
}), { question: 'Second?', choices: ['B'], multiSelect: false, questionId: 'q2' });
assertDeepEqual(normalizeClarifyInteraction({ ...progressing, answers: { q1: 'A', q2: null } }), {
  question: '', choices: [], multiSelect: false, questionId: null,
});

assertDeepEqual(cancelledApprovalRequestIds({ session_id: 'foreign', request_ids: ['srq-7'] }, ['ours'], 'default'), []);
assertDeepEqual(cancelledApprovalRequestIds({ stored_session_id: 'ours', profile: 'another', request_ids: ['srq-7'] }, ['ours'], 'default'), []);
assertDeepEqual(cancelledApprovalRequestIds({ stored_session_id: 'ours', request_ids: ['srq-7', 42, ' srq-exact '] }, ['ours'], 'default'), ['srq-7', ' srq-exact ']);

console.log('chat interaction tests passed');
