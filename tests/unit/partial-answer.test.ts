/**
 * When review runs out, an answer whose only problem was missing scope is delivered with a
 * partial note instead of the generic fallback. Factual and execution findings, and turns
 * with an uncommitted change, still fail closed. Synthetic data; no provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { PARTIAL_ANSWER_NOTE } from '../../src/modules/assistant/review-diagnostics.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { BoundContextReader } from '../../src/modules/assistant/tool-executor.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import type { PersonalOperation } from '../../src/modules/scheduling/scheduling.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';

const now = Date.parse('2026-10-03T04:00:00Z');
const actor = { employeeId: 7, phoneE164: '+919000000007', chatId: '919000000007@s.whatsapp.net' };
const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
type Kind = 'scope' | 'factual' | 'execution_status';

async function turn(options: {
  verdicts: Kind[];
  drafts: string[];
  reminder?: boolean;
  reason?: string;
}) {
  const requestText = options.reminder
    ? 'Remind me in 20 minutes to review the synthetic proposal. Also tell me the office opening time.'
    : 'Tell me the office opening time and the GA4 overview.';
  const trusted: TrustedReplyContext = {
    runId: randomUUID(),
    key: { remoteJid: actor.chatId },
    checkpointLease: { leaseToken: randomUUID() },
    commandMessages: [{ id: 'source', text: requestText, receivedAtMs: now, forwarded: false }],
  };
  const applied: PersonalOperation[][] = [];
  const repository: PersonalRepositoryPort = {
    async getReceipt() {
      return null;
    },
    async applyBatch(_context, operations) {
      applied.push(operations);
      throw new Error('An unapproved change must never be committed');
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
  const reminder = {
    name: 'personal_apply',
    arguments: JSON.stringify({
      operations: [
        {
          kind: 'reminder_create',
          text: 'review the synthetic proposal',
          source: { messageId: 'source', quote: requestText },
          time: { afterMinutes: 20 },
        },
      ],
    }),
  };
  // One session: read (and stage the reminder), then one draft per review pass.
  const script: Array<Array<{ name: string; arguments: string }> | string> = [
    [{ name: 'get_context', arguments: '{}' }],
    ...(options.reminder ? [[reminder]] : []),
    ...options.drafts,
  ];
  let reviews = 0;
  let step = 0;
  let composedDraft = options.drafts[0]!;
  const model: TextModel = {
    async complete(request) {
      if (request.stage === 'converser')
        return result(
          JSON.stringify({ route: 'work', workflow: 'general', objective: 'Answer.', reply: '' }),
        );
      if (request.stage === 'planner')
        return result(
          JSON.stringify({
            objective: 'Answer.',
            successCriteria: ['Answer every part.'],
            steps: [
              {
                id: 'work',
                goal: 'Read and answer.',
                dependsOn: [],
                toolNames: options.reminder ? ['get_context', 'personal_apply'] : ['get_context'],
              },
            ],
          }),
        );
      // Composition around a staged personal change is a model step; echo the worker draft.
      if (request.stage === 'formatter' || request.stage === 'worker')
        return result(
          request.jsonSchema ? JSON.stringify({ additional_reply: composedDraft }) : composedDraft,
        );
      if (request.stage === 'verifier') {
        const kind = options.verdicts[Math.min(reviews++, options.verdicts.length - 1)]!;
        return result(
          JSON.stringify({
            supported: false,
            feedback: `Synthetic ${kind} finding.`,
            repair: 'tools',
            reason:
              options.reason ?? (kind === 'scope' ? 'incomplete_answer' : 'unsupported_claim'),
            findings: [
              {
                severity: 'blocking',
                kind,
                message: `Synthetic ${kind} finding.`,
                quote: '',
                replacement: null,
                references: [],
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected stage ${request.stage}`);
    },
    startToolSession() {
      return {
        async next() {
          const item = script[Math.min(step++, script.length - 1)]!;
          if (typeof item === 'string') {
            composedDraft = item;
            return { ...result(item), calls: [] };
          }
          return {
            ...result(''),
            calls: item.map((call, index) => ({ ...call, id: `c${step}-${index}` })),
          };
        },
        accept() {},
        revise() {},
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
  return { reply, applied, codes: reply.trace.events?.map((event) => event.code) ?? [] };
}

const first = 'The synthetic office opens at 9 am. GA4 could not be read: access was denied.';
const second = 'The synthetic office opens at 9 am. GA4 shows strong growth.';

test('an answer that is only incomplete is delivered with a partial note when review runs out', async () => {
  const { reply, codes } = await turn({ verdicts: ['scope', 'scope'], drafts: [first, second] });
  assert.equal(reply.trace.outcome, 'completed');
  assert.equal(reply.text, `${second}\n\n${PARTIAL_ANSWER_NOTE}`);
  assert.ok(codes.includes('PARTIAL_DELIVERED'));
  assert.ok(!codes.includes('REVIEW_EXHAUSTED_FALLBACK'));
});

test('a later factual finding falls back to the earlier draft that was only incomplete', async () => {
  const { reply, codes } = await turn({ verdicts: ['scope', 'factual'], drafts: [first, second] });
  assert.equal(reply.text, `${first}\n\n${PARTIAL_ANSWER_NOTE}`);
  assert.ok(codes.includes('PARTIAL_DELIVERED'));
});

test('factual and execution findings still end in the generic fallback', async () => {
  for (const kind of ['factual', 'execution_status'] as const) {
    const { reply, codes } = await turn({ verdicts: [kind, kind], drafts: [first, second] });
    assert.equal(reply.trace.outcome, 'unavailable', kind);
    assert.ok(!reply.text.includes(PARTIAL_ANSWER_NOTE), kind);
    assert.ok(codes.includes('REVIEW_EXHAUSTED_FALLBACK'), kind);
  }
});

test('an incomplete answer with an unapproved staged change is not delivered and not committed', async () => {
  const { reply, applied, codes } = await turn({
    verdicts: ['scope', 'scope'],
    drafts: [first, second],
    reminder: true,
  });
  assert.equal(reply.trace.outcome, 'unavailable');
  assert.equal(applied.length, 0);
  assert.ok(!codes.includes('PARTIAL_DELIVERED'));
  assert.ok(codes.includes('REVIEW_EXHAUSTED_FALLBACK'));
});

test('an access problem labelled as missing scope is never delivered as partial', async () => {
  // Permission problems are reported through the review reason, not the finding kind.
  const { reply, codes } = await turn({
    verdicts: ['scope', 'scope'],
    drafts: [first, second],
    reason: 'access',
  });
  assert.equal(reply.trace.outcome, 'unavailable');
  assert.ok(!reply.text.includes(PARTIAL_ANSWER_NOTE));
  assert.ok(!codes.includes('PARTIAL_DELIVERED'));
});
