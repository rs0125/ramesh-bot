/**
 * The router's personal-only route is a latency hint. When review finds that a mixed request
 * also needed business work, the turn re-plans with every tool. Synthetic data; no provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
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

const now = Date.parse('2026-10-03T04:00:00Z');
const actor = { employeeId: 7, phoneE164: '+919000000007', chatId: '919000000007@s.whatsapp.net' };
const reminderText = 'review the synthetic proposal';
const requestText = `Remind me in 20 minutes to ${reminderText}. Also tell me the office opening time.`;
const businessText = 'The synthetic office opens at 9 am.';
const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });

test('a mixed request misrouted as personal-only re-plans with business tools after review', async () => {
  const trusted: TrustedReplyContext = {
    runId: randomUUID(),
    key: { remoteJid: actor.chatId },
    checkpointLease: { leaseToken: randomUUID() },
    commandMessages: [{ id: 'source', text: requestText, receivedAtMs: now, forwarded: false }],
  };
  const applied: PersonalOperation[][] = [];
  let receipt: PersonalCommandReceipt | null = null;
  const repository: PersonalRepositoryPort = {
    async getReceipt() {
      return receipt;
    },
    async applyBatch(context, operations) {
      applied.push(structuredClone(operations));
      receipt = {
        commandId: randomUUID(),
        runId: context.runId,
        records: operations.map((operation) => {
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
      };
      return receipt;
    },
    async list() {
      throw new Error('Unexpected list');
    },
    async saveContext() {},
    async recall() {
      throw new Error('Unexpected recall');
    },
    async resolveSelection() {
      throw new Error('Unexpected selection');
    },
    async finalizeSelections() {
      throw new Error('Unexpected selection finalization');
    },
  };
  let businessReads = 0;
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
    async call() {
      businessReads++;
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
    arguments: JSON.stringify({
      operations: [
        {
          kind: 'reminder_create',
          text: reminderText,
          source: { messageId: 'source', quote: requestText },
          time: { afterMinutes: 20 },
        },
      ],
    }),
  };
  // The narrowed session can only stage the reminder; the widened one also reads, and
  // re-proposes the reminder, which replaces the staged proposal rather than adding to it.
  const scripts = [
    [[apply], 'I cannot check the office opening time here.'],
    [[{ name: 'get_context', arguments: '{}' }], [apply], businessText],
  ] as const;
  const requests: ModelRequest[] = [];
  const sessions: ToolSessionRequest[] = [];
  let reviews = 0;
  const model: TextModel = {
    async complete(request) {
      requests.push(request);
      if (request.stage === 'converser')
        return result(
          JSON.stringify({
            route: 'work',
            workflow: 'personal',
            objective: 'Set the reminder.',
            reply: '',
          }),
        );
      if (request.stage === 'planner') {
        const input = JSON.parse(request.messages.at(-1)!.content);
        assert.match(input.review_feedback, /office opening time/);
        return result(
          JSON.stringify({
            objective: 'Answer both parts.',
            successCriteria: ['Read the opening time and save the reminder.'],
            steps: [
              {
                id: 'work',
                goal: 'Read context and propose the reminder.',
                dependsOn: [],
                toolNames: ['get_context', 'personal_apply'],
              },
            ],
          }),
        );
      }
      if (request.stage === 'formatter')
        return result(JSON.stringify({ additional_reply: businessText }));
      if (request.stage === 'verifier')
        return result(
          JSON.stringify(
            reviews++ === 0
              ? {
                  supported: false,
                  feedback: 'The office opening time was requested but not checked.',
                  repair: 'tools',
                  reason: 'incomplete_answer',
                }
              : { supported: true, feedback: '', repair: 'none' },
          ),
        );
      throw new Error(`Unexpected stage ${request.stage}`);
    },
    startToolSession(request) {
      const script = scripts[sessions.length]!;
      sessions.push(request);
      let step = 0;
      return {
        async next() {
          const item = script[step++];
          return typeof item === 'string'
            ? { ...result(item), calls: [] }
            : {
                ...result(''),
                calls: item!.map((call, index) => ({
                  ...call,
                  id: `s${sessions.length}-${step}-${index}`,
                })),
              };
        },
        accept(_id, output) {
          assert.equal((output as { ok?: boolean }).ok, true);
        },
        revise() {
          throw new Error('A personal-only session cannot add business tools; re-plan instead.');
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
    business,
    {
      now: () => now,
      personalTools: new PersonalToolService(
        repository,
        async () => actor,
        () => now,
      ),
    },
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
    AbortSignal.timeout(5000),
    trusted,
  );

  assert.equal(reply.trace.outcome, 'completed');
  assert.equal(sessions.length, 2);
  assert.ok(!sessions[0]!.tools.some((tool) => tool.name === 'get_context'));
  assert.ok(sessions[1]!.tools.some((tool) => tool.name === 'get_context'));
  assert.equal(businessReads, 1);
  // One reminder, committed once, after the approving review.
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.length, 1);
  assert.match(reply.text, /9 am/);
  assert.match(reply.text, /Saved reminder: review the synthetic proposal/);
  const widened = reply.trace.events?.find((event) => event.code === 'ROUTE_WIDENED');
  assert.equal(widened?.detail?.from, 'personal');
  assert.ok(!reply.trace.events?.some((event) => event.code === 'REVIEW_EXHAUSTED_FALLBACK'));
});
