/** Graph composition and authorization outcomes with synthetic data; never calls a provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import type {
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import type { BoundContextReader } from '../../src/modules/assistant/tool-executor.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import type {
  PersonalCommandReceipt,
  PersonalOperation,
} from '../../src/modules/scheduling/scheduling.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import {
  compositeDeliverySchema,
  getBusinessReply,
  getPersonalDelivery,
} from '../../src/modules/messaging/delivery-evidence.js';

const now = Date.parse('2026-10-03T04:00:00Z');
const actor = { employeeId: 7, phoneE164: '+919000000007', chatId: '919000000007@s.whatsapp.net' };
const reminderText = 'review the synthetic proposal';
const businessText = 'The synthetic office opens at 9 am.';
const advice = 'Start by checking the proposed rent and the handover date.';
const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const signal = () => AbortSignal.timeout(5000);

async function scenario(options: {
  workflow: 'personal' | 'general';
  business?: boolean;
  supplement?: string;
  approve?: boolean;
  recallOnly?: boolean;
  recallBeforeWrite?: boolean;
  listOrder?: 'before' | 'after';
}) {
  const requestText = `Remind me in 20 minutes to ${reminderText}.${options.workflow === 'general' ? ' Also tell me what to check first.' : ''}${options.listOrder ? ' Also show my reminders.' : ''}`;
  const events: string[] = [];
  const trusted: TrustedReplyContext = {
    runId: randomUUID(),
    key: { remoteJid: actor.chatId },
    checkpointLease: { leaseToken: randomUUID() },
    commandMessages: [{ id: 'source', text: requestText, receivedAtMs: now, forwarded: false }],
    onToolActivity: () => {
      events.push('tool_activity');
    },
  };
  const requests: ModelRequest[] = [];
  const sessions: ToolSessionRequest[] = [];
  const applied: PersonalOperation[][] = [];
  let receipt: PersonalCommandReceipt | null = null;
  const list = {
    selectionId: randomUUID(),
    nextCursor: null,
    records: [
      {
        kind: 'reminder' as const,
        id: randomUUID(),
        text: 'Earlier synthetic reminder',
        state: 'scheduled',
        version: 2,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
  };
  const repository: PersonalRepositoryPort = {
    async getReceipt() {
      return receipt;
    },
    async applyBatch(context, operations, selectionIds = []) {
      events.push('commit');
      applied.push(structuredClone(operations));
      receipt = {
        commandId: randomUUID(),
        runId: context.runId,
        records: operations.map((operation) => {
          assert.equal(operation.kind, 'reminder_create');
          if (operation.kind !== 'reminder_create') throw new Error('Unexpected mutation');
          return {
            kind: 'reminder',
            id: randomUUID(),
            text: operation.text,
            state: 'scheduled',
            version: 1,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            schedule: operation.schedule,
            nextDueAt: operation.schedule.dueAt,
          };
        }),
        ...(options.listOrder ? { lists: [{ kind: 'reminder' as const, result: list }] } : {}),
      };
      assert.deepEqual(selectionIds, options.listOrder ? [list.selectionId] : []);
      return receipt;
    },
    async list() {
      assert.ok(options.listOrder);
      events.push('personal_list');
      return list;
    },
    async saveContext() {
      events.push('context_saved');
    },
    async recall() {
      assert.ok(options.recallOnly || options.recallBeforeWrite);
      return {
        kind: 'instructions',
        members: [
          {
            id: randomUUID(),
            runId: randomUUID(),
            text: 'Privately review the synthetic proposal.',
            receivedAtMs: now - 60000,
          },
        ],
      };
    },
    async resolveSelection() {
      throw new Error('Unexpected selection');
    },
    async finalizeSelections() {
      throw new Error('Unexpected selection finalization');
    },
  };
  const personalTools = new PersonalToolService(
    repository,
    async () => actor,
    () => now,
  );
  const reader: BoundContextReader = {
    employeeId: actor.employeeId,
    async discover() {
      return [
        {
          name: 'get_context',
          description: 'Read synthetic organization context.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ];
    },
    async call(name) {
      assert.equal(name, 'get_context');
      events.push('business_read');
      return {
        source_path: '/api/v1/context',
        status: 200,
        data: { office_opening: '9 am' },
        meta: { requestId: 'synthetic-context', generatedAt: new Date(now).toISOString() },
      };
    },
  };
  const business = new BusinessReadService(
    async () => ({
      employeeId: actor.employeeId,
      tools: reader,
      async search() {
        throw new Error('Unexpected legacy read');
      },
    }),
    'all',
    () => now,
    true,
  );
  const apply = {
    name: 'personal_apply',
    args: {
      operations: [
        {
          kind: 'reminder_create',
          text: reminderText,
          source: { messageId: 'source', quote: requestText },
          time: { afterMinutes: 20 },
        },
      ],
    },
  };
  const calls = [
    ...(options.business && options.workflow === 'general'
      ? [{ name: 'get_context', args: {} }]
      : []),
    ...(options.recallOnly || options.recallBeforeWrite
      ? [{ name: 'personal_recall', args: { kind: 'instructions' } }]
      : []),
    ...(options.listOrder === 'before'
      ? [{ name: 'personal_list', args: { kind: 'reminder' } }]
      : []),
    ...(options.recallOnly ? [] : [apply]),
    ...(options.listOrder === 'after'
      ? [{ name: 'personal_list', args: { kind: 'reminder' } }]
      : []),
  ];
  const model: TextModel = {
    async complete(request) {
      events.push(request.stage);
      requests.push(request);
      if (request.stage === 'converser')
        return result(
          JSON.stringify({
            route: 'work',
            workflow: options.workflow,
            objective: 'Complete the user request.',
            reply: '',
          }),
        );
      if (request.stage === 'planner')
        return result(
          JSON.stringify({
            objective: 'Complete the user request.',
            successCriteria: ['Answer the other question and save the requested reminder.'],
            steps: [
              {
                id: 'work',
                goal: 'Read as needed and propose the requested reminder.',
                dependsOn: [],
                toolNames: calls.map((call) => call.name),
              },
            ],
          }),
        );
      if (request.stage === 'formatter') {
        if (options.recallOnly) {
          assert.equal(request.jsonSchema, undefined);
          return result(options.supplement ?? 'You asked to review the synthetic proposal.');
        }
        assert.equal(request.jsonSchema?.name, 'ramesh_personal_supplement');
        const input = JSON.parse(request.messages.at(-1)!.content);
        assert.match(input.personal_result, /Pending personal changes/);
        assert.equal(applied.length, 0, 'formatter cannot claim a committed change yet');
        return result(JSON.stringify({ additional_reply: options.supplement ?? advice }));
      }
      if (request.stage === 'verifier') {
        assert.equal(applied.length, 0, 'verification must precede the mutation');
        const input = JSON.parse(request.messages.at(-1)!.content);
        if (!options.recallOnly) assert.match(input.answer, /Pending personal changes/);
        assert.doesNotMatch(input.answer, /Saved reminder/);
        return result(
          JSON.stringify({
            supported: options.approve !== false,
            feedback: options.approve === false ? 'The requested target is not verified.' : '',
            repair: 'format',
          }),
        );
      }
      throw new Error(`Unexpected stage ${request.stage}`);
    },
    startToolSession(request) {
      sessions.push(request);
      let next = 0;
      return {
        async next() {
          events.push('worker');
          const call = calls[next++];
          return {
            ...result(''),
            calls: call
              ? [{ id: `call-${next}`, name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
          };
        },
        accept(_id, output) {
          assert.equal((output as { ok?: boolean }).ok, true);
        },
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'synthetic-no-provider', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    undefined,
    options.business ? business : undefined,
    { now: () => now, personalTools },
  );
  const reply = await assistant.prepare(
    {
      chatId: actor.chatId,
      messageId: randomUUID(),
      sentAtMs: now,
      text: requestText,
      fromMe: false,
      isGroup: false,
      mentionsBot: false,
    },
    signal(),
    trusted,
  );
  return { reply, requests, sessions, applied, events, business, trusted, personalTools };
}

test('personal workflow saves the requested IST reminder using only router, worker and verifier inference', async () => {
  const h = await scenario({ workflow: 'personal', business: true });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.events.filter((event) => event === 'tool_activity').length, 2);
  assert.ok(h.events.indexOf('tool_activity') < h.events.indexOf('worker'));
  assert.deepEqual(
    h.events.filter((event) =>
      ['converser', 'planner', 'worker', 'formatter', 'verifier'].includes(event),
    ),
    ['converser', 'worker', 'worker', 'verifier'],
  );
  assert.equal(h.events.includes('business_read'), false);
  assert.equal(
    h.sessions[0]!.tools.some((tool) => tool.name === 'get_context'),
    false,
  );
  assert.ok(h.sessions[0]!.tools.some((tool) => tool.name === 'personal_apply'));
  assert.equal(h.applied.length, 1);
  assert.match(h.reply.text, /Saved reminder: review the synthetic proposal/);
  assert.match(h.reply.text, /9:50 am IST/i);
  assert.ok(h.events.indexOf('commit') > h.events.indexOf('verifier'));
  assert.ok(getPersonalDelivery(h.reply.businessEvidence)?.commandId);
});

test('personal graph completes requested lists on either side of a staged mutation', async () => {
  for (const listOrder of ['before', 'after'] as const) {
    const h = await scenario({ workflow: 'personal', listOrder });
    assert.equal(h.reply.trace.outcome, 'completed', listOrder);
    assert.match(h.reply.text, /Saved reminder: review the synthetic proposal/);
    assert.match(h.reply.text, /Your reminders \(this page\):\n1\. Earlier synthetic reminder/);
    assert.equal(h.applied.length, 1);
    assert.ok(h.events.indexOf('commit') > h.events.lastIndexOf('verifier'));
    assert.ok(h.events.indexOf('personal_list') < h.events.indexOf('commit'));
    const delivery = getPersonalDelivery(h.reply.businessEvidence);
    assert.ok(delivery?.commandId);
    assert.ok(delivery?.selectionId);
  }
});

test('rejected personal proposal never reaches persistence even on the short workflow', async () => {
  const h = await scenario({ workflow: 'personal', approve: false });
  assert.equal(h.applied.length, 0);
  assert.equal(h.reply.trace.outcome, 'unavailable');
  assert.doesNotMatch(h.reply.text, /Saved reminder/);
});

test('mixed advice survives composition alongside the exact committed personal receipt', async () => {
  const h = await scenario({ workflow: 'general', supplement: advice });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 1);
  assert.ok(h.reply.text.startsWith(advice));
  assert.match(h.reply.text, /Saved reminder: review the synthetic proposal/);
  assert.equal((h.reply.text.match(/Saved reminder/g) ?? []).length, 1);
  assert.equal(
    h.requests.filter((request) => request.jsonSchema?.name === 'ramesh_personal_supplement')
      .length,
    1,
  );
  assert.equal(getPersonalDelivery(h.reply.businessEvidence)?.kind, 'personal');
});

test('generated stock phrasing gets one formatting pass but never blocks an approved personal result', async () => {
  const h = await scenario({
    workflow: 'general',
    supplement: 'Certainly, I would leverage the available options.',
  });
  // Layout findings are not a reason to drop a reviewed, approved reminder.
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 1);
  const reviews = h.requests.filter((request) => request.stage === 'verifier');
  assert.ok(reviews.length > 0);
  const first = JSON.parse(reviews[0]!.messages[0]!.content);
  assert.match(first.presentation_issues.join(' '), /stock wording/);
  assert.match(first.answer, /Pending personal changes/);
  assert.ok(h.reply.trace.events?.some((e) => e.code === 'LAYOUT_ACCEPTED_AS_IS'));
  assert.ok(!h.reply.trace.events?.some((e) => e.code === 'REVIEW_EXHAUSTED_FALLBACK'));
});

test('mixed business answer has both authorities and business recall reveals only its business segment', async () => {
  const h = await scenario({ workflow: 'general', business: true, supplement: businessText });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 1);
  assert.match(h.reply.text, /The synthetic office opens at 9 am/);
  assert.match(h.reply.text, /Saved reminder/);
  const envelope = compositeDeliverySchema.parse(h.reply.businessEvidence);
  assert.equal(envelope.businessText, businessText);
  assert.equal(envelope.personal.employeeId, actor.employeeId);
  assert.equal(envelope.business.employeeId, actor.employeeId);
  assert.deepEqual(getBusinessReply({ text: h.reply.text, receipt: envelope }), {
    text: businessText,
    receipt: envelope.business,
  });
  const access = await h.business.openTools(h.trusted, signal());
  assert.ok(access.run);
  const recall = businessRecall(
    [
      {
        role: 'assistant',
        content: '[Private reply]',
        protectedReply: { text: h.reply.text, receipt: envelope },
      },
    ],
    access.run,
    now,
  );
  assert.equal(recall.available, true);
  const recalled = await recall.execute(JSON.stringify(recall.targets[0]), signal());
  assert.equal(recalled.previous_reply_verified, true);
  assert.equal(recalled.previous_reply, businessText);
  assert.doesNotMatch(JSON.stringify(recalled), /review the synthetic proposal|Saved reminder/);
});

test('composite delivery rejects mixed owners and malformed nested authority instead of treating either as valid', async () => {
  const h = await scenario({ workflow: 'general', business: true, supplement: businessText });
  const valid = compositeDeliverySchema.parse(h.reply.businessEvidence);
  for (const invalid of [
    { ...valid, personal: { ...valid.personal, employeeId: 8 } },
    { ...valid, business: { ...valid.business, employeeId: 8 } },
    { ...valid, personal: { ...valid.personal, scopes: ['admin'] } },
    { ...valid, businessText: '' },
    { kind: 'composite', version: 1, personal: valid.personal },
  ]) {
    assert.equal(compositeDeliverySchema.safeParse(invalid).success, false);
    assert.equal(getPersonalDelivery(invalid), undefined);
    const access = await h.business.openTools(h.trusted, signal());
    assert.equal(
      businessRecall(
        [
          {
            role: 'assistant',
            content: '[Private reply]',
            protectedReply: { text: h.reply.text, receipt: invalid },
          },
        ],
        access.run,
        now,
      ).available,
      false,
    );
  }
});

test('instruction-only recall still protects its answer without inventing a personal result or write', async () => {
  const h = await scenario({ workflow: 'personal', recallOnly: true });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 0);
  assert.match(h.reply.text, /You asked to review the synthetic proposal/);
  assert.equal(getPersonalDelivery(h.reply.businessEvidence)?.employeeId, actor.employeeId);
});

test('unsegmented personal recall and business prose needs both authorities and cannot enter business-only recall', async () => {
  const h = await scenario({
    workflow: 'general',
    business: true,
    recallOnly: true,
    supplement: `${businessText} You privately asked to review the synthetic proposal.`,
  });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 0);
  const evidence = compositeDeliverySchema.parse(h.reply.businessEvidence);
  assert.equal(evidence.businessRecallAllowed, false);
  assert.equal(getBusinessReply({ text: h.reply.text, receipt: evidence }), undefined);
  const access = await h.business.openTools(h.trusted, signal());
  const recalled = businessRecall(
    [
      {
        role: 'assistant',
        content: '[Private reply]',
        protectedReply: { text: h.reply.text, receipt: evidence },
      },
    ],
    access.run,
    now,
  );
  assert.equal(recalled.available, false);
  assert.doesNotMatch(JSON.stringify(recalled.messages), /synthetic proposal|office opens/);
  const freshPersonal = (await h.personalTools.open(
    { ...h.trusted, runId: randomUUID() },
    signal(),
  ))!;
  const visible = businessRecall(
    [
      {
        role: 'assistant',
        content: '[Private reply]',
        protectedReply: { text: h.reply.text, receipt: evidence },
      },
    ],
    access.run,
    now,
    freshPersonal,
  );
  assert.match(visible.messages[0]!.content, /synthetic proposal/);
  assert.match(visible.messages[0]!.content, /office opens/);
  assert.match(visible.messages[0]!.content, /personal_recall/);
  assert.equal(freshPersonal.usedPrivateData, true);
  assert.equal(freshPersonal.usedPrivateReads, true);
});

test('a committed result does not make recalled personal facts eligible for business-only recall', async () => {
  const h = await scenario({
    workflow: 'general',
    business: true,
    recallBeforeWrite: true,
    supplement: `${businessText} Prioritize your private reminder first.`,
  });
  assert.equal(h.reply.trace.outcome, 'completed');
  assert.equal(h.applied.length, 1);
  const evidence = compositeDeliverySchema.parse(h.reply.businessEvidence);
  assert.equal(evidence.businessRecallAllowed, false);
  assert.ok(evidence.personal.commandId);
  assert.equal(getBusinessReply({ text: h.reply.text, receipt: evidence }), undefined);
});
