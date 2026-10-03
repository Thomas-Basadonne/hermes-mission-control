import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  isBatchClarifyRequest, lockClarifyInteractionAnswer, normalizeClarifyInteraction,
} from '../src/lib/chat-interactions.ts';

// Execute the actual callback and event branches from the hook, not a copied implementation.
// Only transport and React setters are substituted; deferred replies exercise the same-turn
// gap before React effects update refs after cancellation.
const source = readFileSync(new URL('../src/lib/chat-gateway.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('chat-gateway.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let responder = '';
const branches = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'respondInteraction') {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    responder = node.initializer.arguments[0].getText(tree);
  }
  if (ts.isIfStatement(node)) {
    const condition = node.expression.getText(tree);
    for (const event of ['request.cancel', 'approval.cancelled', '.expire']) {
      if (condition === `parsed.event.type === '${event}'` || condition === `parsed.event.type.endsWith('${event}')`) {
        branches.set(event, node.getText(tree));
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(responder);
assert.equal(branches.size, 3);
function compile(expression: string, scope: Record<string, unknown>) {
  const output = ts.transpileModule(`const run = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // Trusted, locally-read application source only. No user input or network data is evaluated.
  return new Function(...Object.keys(scope), `${output}\nreturn run;`)(...Object.values(scope));
}
function harness() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const reply = new Promise((yes, no) => { resolve = yes; reject = no; });
  const interaction = { kind: 'clarify', requestId: 'srq-race', payload: {
    questions: [{ qid: 'q1', question: 'First?' }, { qid: 'q2', question: 'Second?' }],
  } };
  const cards: unknown[] = [];
  const errors: unknown[] = [];
  const calls: unknown[] = [];
  const scope = {
    interactionRef: { current: interaction as typeof interaction | null },
    openServerRequestsRef: { current: new Map([['srq-race', { method: 'clarify.request', responded: false }]]) },
    clarifyLocksInFlightRef: { current: new Set<string>() },
    sessionLifecycleGenerationRef: { current: 1 },
    sessionProfileRef: { current: 'default' },
    sessionIdRef: { current: 'session-ours' },
    sessionKeyRef: { current: 'session-ours' },
    pendingClarifyContentRef: { current: null },
    wsRef: { current: null },
    setInteraction: (card: unknown) => cards.push(card),
    setStatusText: () => {},
    setError: (error: unknown) => errors.push(error),
    request: (method: string, params: unknown) => { calls.push({ method, params }); return reply; },
    isBatchClarifyRequest, lockClarifyInteractionAnswer, normalizeClarifyInteraction,
    cancelledApprovalRequestIds: (payload: { request_ids: string[] }) => payload.request_ids,
  };
  const respond = compile(responder, scope);
  const cancel = (event: string) => compile(`(parsed) => { ${branches.get(event)} }`, scope)({
    event: { type: event === '.expire' ? 'clarify.expire' : event, payload: {
      id: 'srq-race', request_id: 'srq-race', request_ids: ['srq-race'],
      session_id: 'session-ours', profile: 'default',
    } },
  });
  return { respond, cancel, resolve, reject, cards, errors, calls, scope };
}

// Expiry must synchronously invalidate ownership, even before the next React render.
{
  const h = harness();
  const waiting = h.respond('A');
  h.cancel('.expire');
  h.resolve({ status: 'ok', remaining: ['q2'] });
  await waiting;
  assert.ok(h.cards.every((card) => card === null), 'Late clarify ack resurrected an expired card');
}
// A withdrawn request must not surface a late transport error in the current chat.
{
  const h = harness();
  const waiting = h.respond('A');
  h.cancel('request.cancel');
  h.reject(new Error('Late reply for withdrawn request'));
  await waiting;
  assert.deepEqual(h.errors, [], 'Cancelled request leaked a late error into the chat');
}
console.log('clarify cancellation/expiry races passed');
