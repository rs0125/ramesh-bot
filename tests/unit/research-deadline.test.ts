import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssistantService,
  UNAVAILABLE_REPLY,
} from '../../src/modules/assistant/assistant.service.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import type { TextModel, ModelResult } from '../../src/modules/assistant/assistant.types.js';
const result = (text: string): ModelResult => ({ text, inputTokens: 1, outputTokens: 1 });
const message = {
  chatId: FIXTURE_JID,
  messageId: 'deadline-test',
  text: 'Find Bengaluru supply and CRM priorities.',
  sentAtMs: Date.now(),
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
};
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'deadline-test' };
const waitForAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
function modelForDeadline(): TextModel {
  return {
    async complete(request, signal) {
      if (request.stage === 'converser')
        return result(JSON.stringify({ route: 'work', objective: 'Prepare a brief', reply: '' }));
      if (request.stage === 'planner')
        return result(
          JSON.stringify({
            objective: 'Prepare a brief',
            successCriteria: ['Return supported priorities and supply'],
            steps: [
              {
                id: 'read',
                goal: 'Read the required context',
                dependsOn: [],
                toolNames: ['search_warehouses', 'crm_briefing'],
              },
            ],
          }),
        );
      if (request.stage === 'verifier')
        return result('{"supported":true,"feedback":"","repair":"none"}');
      assert.equal(JSON.parse(request.messages[0]!.content).research_limited, true);
      return result(
        'I found five recorded Bengaluru warehouses. Current availability needs confirmation. I could not finish checking CRM priorities in this reply.',
      );
    },
    startToolSession() {
      let n = 0;
      return {
        async next(_remaining, signal) {
          if (n++ === 0)
            return {
              ...result(''),
              calls: [
                { id: 'supply', name: 'search_warehouses', arguments: '{"city":"Bengaluru"}' },
              ],
            };
          return waitForAbort(signal);
        },
        accept() {},
      };
    },
  };
}
test('research deadline finalizes retained evidence under the original authority and tool budget', async () => {
  const fixture = createSalesFixture();
  const reply = await new AssistantService(
    { model: 'fixture', timeoutMs: 1200 },
    modelForDeadline(),
    undefined,
    undefined,
    undefined,
    fixture.service,
  ).prepare(message, undefined, trusted);
  assert.equal(reply.trace.outcome, 'completed');
  assert.equal(reply.trace.limitedBy, 'research_deadline');
  assert.match(reply.text, /five recorded/);
  assert.ok(reply.businessEvidence);
  assert.deepEqual(
    fixture.state.calls.map((c) => c.tool),
    ['search_warehouses'],
  );
  assert.deepEqual(
    reply.trace.stages.map((s) => s.stage),
    ['converser', 'planner', 'worker', 'executor', 'formatter', 'verifier'],
  );
});
test('hard finalization timeout preserves completed stages and emits no unverified evidence', async () => {
  const fixture = createSalesFixture();
  const model = modelForDeadline();
  model.complete = async (request, signal) =>
    request.stage === 'converser'
      ? result('{"route":"direct","objective":"Say hello","reply":"Hi"}')
      : waitForAbort(signal!);
  const reply = await new AssistantService(
    { model: 'fixture', timeoutMs: 250 },
    model,
    undefined,
    undefined,
    undefined,
    fixture.service,
  ).prepare({ ...message, text: 'Hi' }, undefined, trusted);
  assert.equal(reply.text, UNAVAILABLE_REPLY);
  assert.equal(reply.trace.failureCode, 'DEADLINE_EXCEEDED');
  assert.deepEqual(
    reply.trace.stages.map((s) => s.stage),
    ['converser'],
  );
  assert.equal(reply.businessEvidence, undefined);
});
test('caller cancellation remains cancellation rather than a partial answer', async () => {
  const fixture = createSalesFixture();
  const abort = new AbortController();
  const model = modelForDeadline();
  const original = model.startToolSession!;
  model.startToolSession = (request) => {
    const session = original(request);
    return {
      ...session,
      next: async (n, signal) => {
        abort.abort(new Error('Caller cancelled'));
        return session.next(n, signal);
      },
    };
  };
  await assert.rejects(
    new AssistantService(
      { model: 'fixture', timeoutMs: 5000 },
      model,
      undefined,
      undefined,
      undefined,
      fixture.service,
    ).prepare(message, abort.signal, trusted),
    /Caller cancelled/,
  );
});
