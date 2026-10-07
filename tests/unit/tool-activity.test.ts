/** Activity signals use scripted models and synthetic sources; no transport or provider calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSalesFixture, FIXTURE_JID, salesEvidence } from '../../scripts/lib/sales-fixture.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import { buildBusinessGraph } from '../../src/modules/assistant/business.graph.js';
import { notifyToolActivity } from '../../src/modules/assistant/tool-activity.js';
import { UtilityToolRun } from '../../src/modules/assistant/utility-tools.js';
import { toolDelivery } from '../../src/modules/assistant/tool-evidence.js';
import { RECALL_TOOL } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import type { ChatMessage, TextModel } from '../../src/modules/assistant/assistant.types.js';
import { planningResult } from '../fixtures/planning-model.js';
import { recallTurnId } from '../fixtures/business-recall.js';

const output = (text: string) => ({ text, inputTokens: 0, outputTokens: 0 });
const answer = 'The requested check is complete.';

function model(call?: { name: string; arguments: string }): TextModel {
  return {
    async complete(request) {
      if (!call && request.stage === 'converser')
        return output(
          JSON.stringify({ route: 'direct', objective: 'Greet the user', reply: 'Hello.' }),
        );
      return (
        planningResult(request) ??
        output(
          request.stage === 'verifier'
            ? JSON.stringify({ supported: true, feedback: '', repair: 'none' })
            : call
              ? answer
              : 'Hello.',
        )
      );
    },
    startToolSession() {
      let next = 0;
      return {
        async next() {
          return {
            ...output(answer),
            calls: call && next++ === 0 ? [{ id: 'call', ...call }] : [],
          };
        },
        accept(_id, value) {
          assert.equal((value as { ok?: boolean }).ok, true);
        },
      };
    },
  };
}

for (const kind of ['read', 'utility', 'recall'] as const) {
  test(`dynamic ${kind} activity starts before planning and execution; feedback failure cannot stop the answer`, async () => {
    const now = Date.now();
    const fixture = createSalesFixture(() => now);
    const utilities = new UtilityToolRun();
    let activity = 0;
    fixture.state.mutate = (_result, tool) => {
      if (tool === 'read_warehouse') assert.equal(activity, 2);
    };
    const executeUtility = utilities.execute.bind(utilities);
    utilities.execute = async (...args) => {
      assert.equal(activity, 2);
      return executeUtility(...args);
    };
    const history: ChatMessage[] =
      kind === 'recall'
        ? [
            {
              role: 'assistant',
              content: PRIVATE_HISTORY_REPLY,
              protectedReply: {
                text: answer,
                receipt: toolDelivery(
                  23,
                  [
                    {
                      id: 'earlier-read',
                      tool: 'read_warehouse',
                      arguments: { id: 101 },
                      result: salesEvidence('read_warehouse', { id: 101 }, now),
                    },
                  ],
                  now,
                ),
              },
            },
          ]
        : [];
    const call =
      kind === 'utility'
        ? { name: 'calculate', arguments: '{"expression":"2+2"}' }
        : kind === 'recall'
          ? {
              name: RECALL_TOOL,
              arguments: JSON.stringify({ turn_id: recallTurnId(history[0]!.protectedReply!) }),
            }
          : { name: 'read_warehouse', arguments: '{"id":101}' };
    const scripted = model(call);
    const complete = scripted.complete.bind(scripted);
    scripted.complete = async (request, signal) => {
      if (request.stage === 'planner')
        assert.equal(activity, 1, 'Signal precedes planner inference');
      return complete(request, signal);
    };
    const response = await buildSalesGraph(
      scripted,
      (signal) =>
        fixture.service.openTools({ key: { remoteJid: FIXTURE_JID }, runId: 'activity' }, signal),
      {
        now: () => now,
        utilities,
        onContext: () => assert.equal(activity, 0, 'Discovery must remain silent'),
        onToolActivity: (...args) => {
          assert.equal(args.length, 0, 'No arguments or results reach transport');
          activity++;
          throw new Error('Synthetic presentation failure');
        },
      },
    ).invoke({ input: 'Perform the requested check.', history, audience: 'dm' });
    assert.equal(response.reply, answer);
    assert.equal(activity, 2);
    if (kind === 'utility') assert.equal(utilities.evidence.length, 1);
    else assert.equal(response.business?.delivery.checks.length, 1);
  });
}

test('ordinary chat remains silent even when business catalogue initialization succeeds', async () => {
  const fixture = createSalesFixture();
  let activity = 0;
  const response = await buildSalesGraph(
    model(),
    (signal) =>
      fixture.service.openTools({ key: { remoteJid: FIXTURE_JID }, runId: 'chat' }, signal),
    {
      onToolActivity: () => {
        activity++;
      },
    },
  ).invoke({ input: 'Hello', history: [], audience: 'dm' });
  assert.equal(response.reply, 'Hello.');
  assert.equal(activity, 0);
  assert.ok(fixture.state.discoveries > 0);
});

for (const kind of ['chat', 'group', 'read'] as const) {
  test(`legacy ${kind} route only signals an actual private read`, async () => {
    let activity = 0,
      reads = 0;
    const response = await buildBusinessGraph(
      {
        async complete(request) {
          return output(
            request.stage === 'converser'
              ? JSON.stringify({
                  intent: kind === 'chat' ? 'chat' : 'assigned_followups_today',
                  language: 'en',
                  draft: 'Hello.',
                })
              : 'Hello.',
          );
        },
      },
      async () => {
        assert.equal(activity, 1);
        reads++;
        return { outcome: 'denied' };
      },
      () => {
        activity++;
        throw new Error('Synthetic presentation failure');
      },
    ).invoke({
      input: 'Synthetic request',
      history: [],
      audience: kind === 'group' ? 'group' : 'dm',
    });
    assert.ok(response.reply);
    assert.equal(activity, kind === 'read' ? 1 : 0);
    assert.equal(reads, activity);
  });
}

test('activity notification never waits for transport and contains asynchronous rejection', async () => {
  assert.equal(
    notifyToolActivity(() => new Promise<void>(() => {})),
    undefined,
  );
  assert.equal(
    notifyToolActivity(async () => {
      throw new Error('Synthetic reaction failure');
    }),
    undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});
