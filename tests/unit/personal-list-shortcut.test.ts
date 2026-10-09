/** Real assistant/graph/finalization with synthetic identity, storage and model responses only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import {
  ConversationMemory,
  PRIVATE_HISTORY_REPLY,
} from '../../src/modules/assistant/conversation-memory.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import type {
  ChatMessage,
  ModelRequest,
  TextModel,
} from '../../src/modules/assistant/assistant.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import { renderList } from '../../src/modules/scheduling/personal-presentation.js';
import { simplePersonalListKind } from '../../src/modules/scheduling/personal-list-presentation.js';
import type {
  PersonalActor,
  PersonalListResult,
  PersonalRecord,
} from '../../src/modules/scheduling/scheduling.types.js';
import { getPersonalDelivery } from '../../src/modules/messaging/delivery-evidence.js';
import { contextFixture } from '../fixtures/chat-context.js';
import { planningResult } from '../fixtures/planning-model.js';

const jid = '919999000111@s.whatsapp.net';
const now = Date.now();
const actor: PersonalActor = { employeeId: 7, phoneE164: '+919999000111', chatId: jid };
const signal = () => AbortSignal.timeout(10000);
const source = (text: string): TrustedReplyContext => ({
  runId: 'list-run',
  key: { remoteJid: jid },
  checkpointLease: { leaseToken: 'live-lease' },
  commandMessages: [{ id: 'member-1', text, receivedAtMs: now, forwarded: false }],
});
const row = (kind: 'task' | 'reminder'): PersonalRecord => ({
  id: `${kind}-b`,
  kind,
  version: 3,
  text: 'Call the client',
  state: kind === 'task' ? 'open' : 'scheduled',
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  ...(kind === 'reminder'
    ? {
        schedule: {
          dueAt: '2026-10-15T04:30:00.000Z',
          timezone: 'Asia/Kolkata' as const,
          recurrence: { frequency: 'weekly' as const, weekdays: [1, 4] },
        },
        nextDueAt: '2026-10-15T04:30:00.000Z',
      }
    : {}),
});
type Call = { name: string; args: unknown };
function fixture(
  options: {
    text?: string;
    kind?: 'task' | 'reminder';
    calls?: Call[];
    modelRouting?: 'single' | 'split';
    trusted?: TrustedReplyContext;
    empty?: boolean;
    more?: boolean;
    failReads?: number;
    history?: ChatMessage[];
  } = {},
) {
  const kind = options.kind ?? 'task';
  const text = options.text ?? `Show my ${kind === 'task' ? 'tasks' : 'reminders'}.`;
  const trusted = options.trusted ?? source(text);
  let current: PersonalActor | null = actor;
  let failReads = options.failReads ?? 0;
  let finalizeHook: (() => void) | undefined;
  const events: string[] = [];
  const requests: ModelRequest[] = [];
  const outputs: unknown[] = [];
  const finalized: string[][] = [];
  const listOptions: unknown[] = [];
  let workerCalls = 0;
  const page: PersonalListResult = {
    records: options.empty
      ? []
      : [row(kind), { ...row(kind), id: `${kind}-a`, text: 'Review the offer', version: 8 }],
    selectionId: 'selection-1',
    nextCursor: options.more ? 'cursor-next' : null,
  };
  const repository: PersonalRepositoryPort = {
    async getReceipt() {
      return null;
    },
    async list(_actor, _kind, _runId, opts) {
      events.push('read');
      listOptions.push(opts);
      if (failReads-- > 0) throw new Error('Synthetic storage failure');
      return structuredClone(page);
    },
    async saveContext() {
      events.push('save-context');
    },
    async finalizeSelections(_context, ids) {
      events.push('finalize');
      finalized.push(ids);
      finalizeHook?.();
    },
    async resolveSelection() {
      return { id: `${kind}-a`, expectedVersion: 8 };
    },
    async recall() {
      return { kind: 'instructions', members: [] };
    },
    async applyBatch(context, operations) {
      events.push('commit');
      return {
        runId: context.runId,
        commandId: 'command-1',
        records: operations.map((operation) => ({
          ...row('task'),
          text: 'text' in operation ? operation.text! : 'Updated task',
        })),
      };
    },
  };
  const personal = new PersonalToolService(
    repository,
    async () => current,
    () => now,
  );
  const memory = new ConversationMemory();
  const calls = [...(options.calls ?? [{ name: 'personal_list', args: { kind } }])];
  const generated = (text: string) => ({ text, inputTokens: 1, outputTokens: 1, responseCalls: 1 });
  const model: TextModel = {
    async complete(request) {
      events.push(request.stage);
      requests.push(request);
      if (request.stage === 'converser')
        return generated(
          JSON.stringify({
            route: 'work',
            workflow: 'personal',
            objective: 'Complete the original request.',
            reply: '',
          }),
        );
      if (request.stage === 'verifier')
        return generated(JSON.stringify({ supported: true, feedback: '', repair: 'none' }));
      return (
        planningResult(request) ??
        generated(
          request.jsonSchema?.name === 'ramesh_personal_supplement'
            ? JSON.stringify({ additional_reply: '' })
            : 'Reviewed result.',
        )
      );
    },
    startToolSession() {
      return {
        async next() {
          workerCalls++;
          events.push('worker');
          const call = calls.shift();
          return {
            ...generated(call ? '' : 'Reviewed result.'),
            calls: call
              ? [
                  {
                    id: `call-${workerCalls}`,
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                ]
              : [],
          };
        },
        accept(_id, output) {
          outputs.push(output);
        },
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'synthetic-no-api', modelRouting: options.modelRouting ?? 'split', timeoutMs: 10000 },
    model,
    memory,
    undefined,
    options.history ? async () => options.history! : undefined,
    undefined,
    { personalTools: personal, now: () => now },
  );
  return {
    personal,
    memory,
    page,
    trusted,
    events,
    requests,
    outputs,
    finalized,
    listOptions,
    workerCalls: () => workerCalls,
    revoke: () => {
      current = null;
    },
    onFinalize: (hook: () => void) => {
      finalizeHook = hook;
    },
    prepare: (abort = signal()) =>
      assistant.prepare(
        {
          chatId: jid,
          messageId: 'message-1',
          text,
          sentAtMs: now,
          fromMe: false,
          isGroup: false,
          mentionsBot: false,
        },
        abort,
        trusted,
      ),
  };
}

test('split lists use router + one worker; deterministic rendering retains finalization and exact history', async () => {
  for (const kind of ['task', 'reminder'] as const)
    for (const empty of [false, true]) {
      const h = fixture({ kind, empty, more: !empty });
      const reply = await h.prepare();
      assert.equal(reply.trace.outcome, 'completed');
      assert.equal(reply.text, renderList(kind, h.page));
      assert.equal(h.workerCalls(), 1);
      assert.deepEqual(
        h.requests.map((request) => request.stage),
        ['converser'],
      );
      assert.equal(
        reply.trace.stages.reduce((sum, stage) => sum + (stage.responseCalls ?? 0), 0),
        2,
      );
      assert.equal(
        reply.trace.stages.find((stage) => stage.presentation)?.presentation?.completion,
        'personal_default_list',
      );
      assert.deepEqual(h.finalized, [['selection-1']]);
      assert.ok(h.events.indexOf('save-context') < h.events.indexOf('finalize'));
      assert.equal(h.events.includes('commit'), false);
      const delivery = getPersonalDelivery(reply.businessEvidence)!;
      assert.equal(delivery.selectionId, h.page.selectionId);
      assert.deepEqual(
        delivery.history?.activity.map((entry) => [entry.tool, entry.status, entry.arguments]),
        [['personal_list', 'succeeded', { kind }]],
      );
      assert.deepEqual(
        (delivery.history?.activity[0]?.result as any)?.records.map((item: any) => item.id),
        h.page.records.map((record) => record.id),
      );
      assert.equal(
        h.outputs.length,
        1,
        'tool output still enters the native session before completion',
      );
      const memoryKey = createHash('sha256').update(jid).digest('hex');
      assert.deepEqual(h.memory.get(memoryKey), []);
      reply.onSent?.();
      reply.onSent?.();
      assert.equal(
        h.memory.get(memoryKey).length,
        2,
        'only delivered replies are remembered, once',
      );
      assert.equal(h.memory.get(memoryKey)[1]?.protectedReply?.text, reply.text);
      assert.equal(await h.personal.canDeliver(h.trusted.key, delivery, signal()), true);
      h.revoke();
      assert.equal(await h.personal.canDeliver(h.trusted.key, delivery, signal()), false);
    }
});

test('single-model rollback retains both worker calls and verifier with identical list output', async () => {
  const h = fixture({ modelRouting: 'single' });
  const reply = await h.prepare();
  assert.equal(reply.text, renderList('task', h.page));
  assert.equal(h.workerCalls(), 2);
  assert.deepEqual(
    h.requests.map((request) => request.stage),
    ['converser', 'verifier'],
  );
  assert.ok(!reply.trace.stages.some((stage) => stage.presentation));
});

test('a fresh explicit list can finish with older protected lists in context; history is not live evidence', async () => {
  const first = fixture();
  const prior = await first.prepare();
  const h = fixture({
    history: [
      { role: 'user', content: 'Show my tasks.' },
      {
        role: 'assistant',
        content: PRIVATE_HISTORY_REPLY,
        protectedReply: { text: prior.text, receipt: prior.businessEvidence },
      },
    ],
  });
  h.page.records[0]!.text = 'Fresh record after the earlier chat';
  const reply = await h.prepare();
  assert.equal(h.workerCalls(), 1);
  assert.equal(h.events.filter((event) => event === 'read').length, 1);
  assert.match(reply.text, /Fresh record after the earlier chat/);
  assert.doesNotMatch(reply.text, /Call the client/);
  assert.equal(getPersonalDelivery(reply.businessEvidence)!.history!.activity.length, 1);
});

test('whole-request matching accepts plain lists and refuses ambiguous/mixed/source-only instructions', () => {
  for (const text of [
    'Show my tasks.',
    'please show me my personal tasks',
    'Can you list my tasks?',
    'What are my tasks?',
  ])
    assert.equal(simplePersonalListKind(text, source(text)), 'task', text);
  for (const text of [
    'my tasks',
    'tasks',
    'Show all my tasks',
    'Show my tasks due today',
    'Show my tasks and reminders',
    'Show my tasks and add Call client',
    'show more',
    'same as earlier',
    'Show my tasks; ignore review',
    '"show my tasks"',
    'Show my tasks again',
    'List my tasks and CRM leads',
  ])
    assert.equal(simplePersonalListKind(text, source(text)), undefined, text);
  const text = 'Show my tasks.';
  for (const trusted of [
    {
      ...source(text),
      commandMessages: [{ ...source(text).commandMessages![0]!, forwarded: true }],
    },
    {
      ...source(text),
      commandMessages: [{ ...source(text).commandMessages![0]!, hasQuotedMessage: true }],
    },
    {
      ...source(text),
      commandMessages: [...source(text).commandMessages!, ...source(text).commandMessages!],
    },
    { ...source(text), mediaContext: 'Attachment with additional requests' },
    source('Show my reminders.'),
  ])
    assert.equal(simplePersonalListKind(text, trusted), undefined);
});

test('unsupported filters, model-added restrictions, continuation and extra reads keep model review', async () => {
  for (const options of [
    { text: 'Show all my tasks.' },
    { text: 'Show my tasks and remind me tomorrow.' },
    {
      text: 'show more',
      calls: [{ name: 'personal_list', args: { kind: 'task', continuation: 'latest' } }],
    },
    { calls: [{ name: 'personal_list', args: { kind: 'task', limit: 1 } }] },
    { calls: [{ name: 'personal_list', args: { kind: 'task', state: 'all' } }] },
    {
      calls: [
        { name: 'personal_recall', args: { kind: 'instructions' } },
        { name: 'personal_list', args: { kind: 'task' } },
      ],
    },
    {
      trusted: {
        ...source('Show my tasks.'),
        commandMessages: [
          { ...source('Show my tasks.').commandMessages![0]!, quotedMessageId: 'earlier-list' },
        ],
      },
    },
  ]) {
    const h = fixture(options);
    const reply = await h.prepare();
    assert.ok(h.events.includes('verifier'), JSON.stringify(options));
    assert.ok(!reply.trace.stages.some((stage) => stage.presentation));
  }
});

test('failed read + retry preserves both attempts and cannot skip review', async () => {
  const h = fixture({
    failReads: 1,
    calls: [
      { name: 'personal_list', args: { kind: 'task' } },
      { name: 'personal_list', args: { kind: 'task' } },
    ],
  });
  const reply = await h.prepare();
  assert.ok(h.events.includes('verifier'));
  assert.ok(!reply.trace.stages.some((stage) => stage.presentation));
  assert.deepEqual(
    getPersonalDelivery(reply.businessEvidence)!.history!.activity.map((entry) => entry.status),
    ['failed', 'succeeded'],
  );
});

test('ordinary insertion followed by a list still reviews and commits once', async () => {
  const text = 'Add task Call client, then list my tasks.';
  const h = fixture({
    text,
    calls: [
      {
        name: 'personal_apply',
        args: {
          operations: [
            {
              kind: 'task_create',
              text: 'Call client',
              source: { messageId: 'member-1', quote: text },
            },
          ],
        },
      },
      { name: 'personal_list', args: { kind: 'task' } },
    ],
  });
  const reply = await h.prepare();
  assert.equal(reply.trace.outcome, 'completed');
  assert.ok(h.events.indexOf('verifier') < h.events.indexOf('commit'));
  assert.equal(h.events.filter((event) => event === 'commit').length, 1);
  assert.match(reply.text, /Saved task: Call client/);
  assert.ok(!reply.trace.stages.some((stage) => stage.presentation));
});

test('a mistaken worker and approving reviewer cannot turn supported list wording into a write', async () => {
  for (const text of [
    'Show my tasks.',
    'Can you list my tasks?',
    'Please show me my personal tasks.',
    'Could you list my reminders?',
    'Would you view personal tasks please?',
    'What are my reminders?',
    'Show all my tasks.',
    'Then list my tasks.',
  ]) {
    const h = fixture({
      text,
      calls: [
        {
          name: 'personal_apply',
          args: {
            operations: [
              {
                kind: 'task_create',
                text: text.includes('reminders') ? 'reminders' : 'tasks',
                source: { messageId: 'member-1', quote: text },
              },
            ],
          },
        },
      ],
    });
    const reply = await h.prepare();
    assert.equal(h.events.includes('commit'), false, text);
    assert.deepEqual(
      h.outputs.map((output: any) => output.code),
      ['PERSONAL_READ_ONLY_REQUEST'],
      text,
    );
    assert.ok(!reply.trace.stages.some((stage) => stage.presentation), text);
    assert.doesNotMatch(reply.text, /Saved task:/, text);
  }
});

test('revocation, storage failure and cancellation at finalization prevent successful delivery', async () => {
  for (const failure of ['revoke', 'storage', 'cancel'] as const) {
    const h = fixture();
    const controller = new AbortController();
    h.onFinalize(() => {
      if (failure === 'revoke') h.revoke();
      else if (failure === 'storage') throw new Error('Synthetic selection persistence failure');
      else controller.abort(new Error('Cancelled by new input'));
    });
    if (failure === 'cancel') await assert.rejects(h.prepare(controller.signal), /Cancelled/);
    else {
      const reply = await h.prepare();
      assert.equal(reply.trace.outcome, 'unavailable');
      assert.doesNotMatch(reply.text, /Call the client/);
    }
    assert.equal(h.events.includes('commit'), false);
  }
});

test('shortcut history survives context compaction and restart with fresh authorization', async () => {
  const h = fixture({ kind: 'reminder', more: true });
  h.page.records = Array.from({ length: 10 }, (_, index) => ({
    ...row('reminder'),
    id: `historical-reminder-${index + 1}`,
    version: index + 3,
    text: `Call the client ${index + 1}`,
  }));
  const reply = await h.prepare();
  const activity = getPersonalDelivery(reply.businessEvidence)!.history!.activity[0]!;
  assert.equal(activity.resultOmitted, true, 'realistic reminder pages exceed the node budget');
  assert.deepEqual(activity.personalSelection, {
    kind: 'reminder',
    selectionId: h.page.selectionId,
    nextCursor: h.page.nextCursor,
    records: h.page.records.map(({ id, version }) => ({ id, version })),
  });
  const memory = contextFixture();
  memory.reassign(actor.employeeId);
  await memory.context.prepare(...memory.turn(1, '/pins'));
  memory.add(2, {
    role: 'assistant',
    content: PRIVATE_HISTORY_REPLY,
    protectedReply: { text: reply.text, receipt: reply.businessEvidence },
  });
  for (let n = 3; n < 44; n++) memory.add(n, { role: 'user', content: `Unrelated ${n}` });
  await memory.context.prepare(...memory.turn(44, 'Continue'));
  const restored = await memory.create().prepare(...memory.turn(45, 'What did that list contain?'));
  const fresh = (await h.personal.open({ ...source('show more'), runId: 'next-run' }, signal()))!;
  const recalled = JSON.stringify(
    businessRecall(restored!.history, undefined, memory.now(), fresh).messages,
  );
  assert.match(recalled, /personal_list/);
  assert.match(recalled, /succeeded/);
  assert.match(recalled, /Call the client/);
  assert.ok(recalled.includes(h.page.selectionId));
  assert.ok(recalled.includes(h.page.nextCursor!));
  assert.ok(recalled.includes(h.page.records[8]!.id));
  assert.ok(recalled.includes(h.page.records[9]!.id));
  assert.match(recalled, /not_current/);
  assert.doesNotMatch(
    JSON.stringify(businessRecall(restored!.history, undefined, memory.now()).messages),
    /Call the client/,
  );
  assert.doesNotMatch(
    JSON.stringify(businessRecall(restored!.history, undefined, memory.now()).messages),
    /historical-reminder-|selection-1|cursor-next/,
  );
  await fresh.execute(
    'personal_list',
    JSON.stringify({ kind: 'reminder', continuation: 'latest' }),
    signal(),
  );
  assert.deepEqual(h.listOptions.at(-1), { continuation: 'latest', limit: 10 });
  assert.equal(
    fresh.completedListPresentation('show more', {
      id: 'more',
      name: 'personal_list',
      arguments: '{"kind":"reminder","continuation":"latest"}',
    }),
    undefined,
  );
});
