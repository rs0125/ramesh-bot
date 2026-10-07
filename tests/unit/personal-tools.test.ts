/** Personal persistence through the real graph, with fake models, identity and repository only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type {
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import {
  PersonalToolService,
  renderList,
  renderReceipt,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import {
  SchedulingError,
  type PersonalActor,
  type PersonalCommandContext,
  type PersonalCommandReceipt,
  type PersonalOperation,
  type PersonalRecord,
  type PersonalRecallResult,
} from '../../src/modules/scheduling/scheduling.types.js';
import { planningResult } from '../fixtures/planning-model.js';
import type { AgentCheckpointStore } from '../../src/modules/assistant/checkpoint.types.js';
import { businessRecall } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { getPersonalDelivery } from '../../src/modules/messaging/delivery-evidence.js';
import { contextFixture } from '../fixtures/chat-context.js';

const now = Date.parse('2026-10-03T04:00:00Z');
const jid = '919999000111@s.whatsapp.net';
const actor: PersonalActor = { employeeId: 7, phoneE164: '+919999000111', chatId: jid };
const input = 'Add a task to review the lease and remind me in 30 days to review the lease.';
const trusted: TrustedReplyContext = {
  runId: 'personal-run',
  key: { remoteJid: jid },
  checkpointLease: { leaseToken: 'live-lease' },
  commandMessages: [{ id: 'member-1', text: input, receivedAtMs: now, forwarded: false }],
};
const message = {
  chatId: jid,
  messageId: 'message-1',
  sentAtMs: now,
  text: input,
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
};
const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const signal = () => AbortSignal.timeout(5000);
const source = { messageId: 'member-1', quote: input };
const batch = {
  operations: [
    { kind: 'task_create', source, text: 'review the lease', alias: 'lease' },
    {
      kind: 'reminder_create',
      source,
      text: 'review the lease',
      time: { afterMinutes: 30 * 24 * 60 },
      taskRef: 'lease',
    },
  ],
};

function fakeModel(
  calls: Array<{ name: string; args: unknown }>,
  events: string[] = [],
  approved = true,
) {
  const requests: ModelRequest[] = [],
    sessions: ToolSessionRequest[] = [],
    outputs: unknown[] = [];
  const model: TextModel = {
    async complete(request) {
      events.push(request.stage);
      requests.push(request);
      return (
        planningResult(request) ??
        result(
          request.stage === 'verifier'
            ? JSON.stringify({
                supported: approved,
                feedback: approved ? '' : 'Not authorized by the user.',
                repair: 'format',
              })
            : request.jsonSchema?.name === 'ramesh_personal_supplement'
              ? JSON.stringify({ additional_reply: '' })
              : 'The proposed personal change is ready for application review.',
        )
      );
    },
    startToolSession(request) {
      sessions.push(request);
      let index = 0;
      return {
        async next(remaining) {
          const call = remaining > 0 ? calls[index++] : undefined;
          return {
            ...result(call ? '' : 'The proposed personal change is ready for application review.'),
            calls: call
              ? [{ id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
          };
        },
        accept(_id, output) {
          outputs.push(output);
        },
      };
    },
  };
  return { model, requests, sessions, outputs };
}

function harness(events: string[] = []) {
  let current: PersonalActor | null = actor;
  let receipt: PersonalCommandReceipt | null = null;
  let applyFailure = false;
  let listFailure = false;
  let afterCommit: (() => void) | undefined;
  const applied: PersonalOperation[][] = [];
  const appliedSelections: string[][] = [];
  let receiptLists: PersonalCommandReceipt['lists'];
  const contexts: PersonalCommandContext[] = [];
  const finalized: string[][] = [];
  const selected: unknown[][] = [];
  const recalled: unknown[][] = [];
  const savedContexts: unknown[][] = [];
  const listCalls: unknown[][] = [];
  let recallResult: PersonalRecallResult = { kind: 'instructions', members: [] };
  let listPages: Array<{
    records: PersonalRecord[];
    selectionId: string;
    nextCursor: string | null;
  }> = [];
  let listRecords: PersonalRecord[] = [
    {
      kind: 'task',
      id: 'original-second',
      text: 'Check the quote',
      state: 'open',
      version: 3,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    },
  ];
  const repository: PersonalRepositoryPort = {
    async getReceipt(context) {
      contexts.push(context);
      return receipt;
    },
    async applyBatch(context, operations, selectionIds = []) {
      events.push('commit');
      if (applyFailure) throw new Error('synthetic DB unavailable');
      contexts.push(context);
      applied.push(structuredClone(operations));
      appliedSelections.push(selectionIds);
      receipt = {
        commandId: 'saved-command',
        runId: context.runId,
        records: operations.map((operation, index) => ({
          kind: operation.kind.startsWith('task_') ? 'task' : 'reminder',
          id: `saved-${index}`,
          text: 'text' in operation ? operation.text! : 'Check the quote',
          state:
            operation.kind === 'task_complete'
              ? 'done'
              : operation.kind.endsWith('_cancel')
                ? 'cancelled'
                : operation.kind.startsWith('task_')
                  ? 'open'
                  : 'scheduled',
          version: 1,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          ...('schedule' in operation ? { schedule: operation.schedule } : {}),
        })),
        ...(receiptLists ? { lists: receiptLists } : {}),
      };
      afterCommit?.();
      return receipt;
    },
    async list(...args) {
      if (listFailure) throw new Error('synthetic read unavailable');
      listCalls.push(args);
      if (listPages.length) return listPages.shift()!;
      return { records: listRecords, selectionId: 'saved-selection', nextCursor: null };
    },
    async saveContext(...args) {
      savedContexts.push(args);
    },
    async recall(...args) {
      recalled.push(args);
      return recallResult;
    },
    async resolveSelection(...args) {
      selected.push(args);
      return { id: 'original-second', expectedVersion: 3 };
    },
    async finalizeSelections(_context, ids) {
      finalized.push(ids);
    },
  };
  const service = new PersonalToolService(
    repository,
    async () => current,
    () => now,
  );
  const assistant = (model: TextModel) =>
    new AssistantService(
      { model: 'offline-personal-fake', timeoutMs: 5000 },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      { now: () => now, personalTools: service },
    );
  return {
    service,
    assistant,
    applied,
    appliedSelections,
    contexts,
    finalized,
    selected,
    recalled,
    savedContexts,
    listCalls,
    setRecall: (value: PersonalRecallResult) => {
      recallResult = value;
    },
    setPages: (value: typeof listPages) => {
      listPages = value;
    },
    setIdentity: (value: PersonalActor | null) => {
      current = value;
    },
    failApply: () => {
      applyFailure = true;
    },
    failList: () => {
      listFailure = true;
    },
    onCommit: (callback: () => void) => {
      afterCommit = callback;
    },
    setList: (value: PersonalRecord[]) => {
      listRecords = value;
    },
    setReceiptLists: (value: PersonalCommandReceipt['lists']) => {
      receiptLists = value;
    },
  };
}

test('personal call, committed result and delivered text survive compaction without rerunning the mutation', async () => {
  const h = harness();
  const assistant = h.assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model);
  const reply = await assistant.prepare(message, signal(), trusted);
  const receipt = getPersonalDelivery(reply.businessEvidence)!;
  assert.deepEqual(
    receipt.history?.activity.map((item) => item.status),
    ['staged', 'committed'],
  );
  assert.deepEqual(receipt.history?.activity[0]?.arguments, batch);
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
  const restored = await memory.create().prepare(...memory.turn(45, 'What did you save earlier?'));
  const fresh = (await h.service.open({ ...trusted, runId: 'follow-up' }, signal()))!;
  const history = businessRecall(restored!.history, undefined, memory.now(), fresh);
  assert.ok(
    history.messages.some(
      (entry) => entry.content.includes('committed') && entry.content.includes('review the lease'),
    ),
  );
  assert.equal(h.applied.length, 1);
  assert.equal(fresh.usedPrivateData, true);
  assert.equal(await h.service.canDeliver(trusted.key, fresh.deliveryReference, signal()), true);
  assert.ok(
    !JSON.stringify(businessRecall(restored!.history, undefined, memory.now()).messages).includes(
      'saved-0',
    ),
  );
  await memory.context.prepare(...memory.turn(46, '/forget context'));
  assert.ok(
    !(await memory.create().prepare(...memory.turn(47, 'Continue')))!.history.some(
      (entry) => entry.protectedReply,
    ),
  );
});

test('an uncertain personal commit is retained without a false success and recovery is a separate outcome', async () => {
  const failed = harness();
  failed.failApply();
  const answer = await failed
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  const trail = getPersonalDelivery(answer.businessEvidence)!.history!.activity;
  assert.deepEqual(
    trail.map((item) => item.status),
    ['staged', 'uncertain'],
  );
  assert.doesNotMatch(JSON.stringify(trail), /synthetic DB unavailable/);
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  await run.finish(signal());
  const recovery = await (await h.service.open(trusted, signal()))!.recover(signal());
  assert.equal(recovery!.delivery.history!.activity[0]!.phase, 'recovery');
  assert.equal(recovery!.delivery.history!.activity[0]!.status, 'committed');
  assert.equal(h.applied.length, 1);
});

test('personal tools work without CRM; task and long-future reminder commit once after verification', async () => {
  const events: string[] = [];
  const h = harness(events);
  const fake = fakeModel([{ name: 'personal_apply', args: batch }], events);
  const reply = await h.assistant(fake.model).prepare(message, signal(), trusted);
  assert.equal(reply.trace.outcome, 'completed');
  assert.deepEqual(
    fake.sessions[0]!.tools.map((tool) => tool.name),
    ['personal_list', 'personal_recall', 'personal_apply'],
  );
  assert.equal(fake.sessions[0]!.tools[2]!.annotations?.readOnlyHint, false);
  assert.equal(fake.sessions[0]!.tools[2]!.annotations?.idempotentHint, false);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0]!.length, 2);
  assert.ok(events.indexOf('commit') > events.lastIndexOf('verifier'));
  const reminder = h.applied[0]![1]!;
  assert.equal(reminder.kind, 'reminder_create');
  if (reminder.kind === 'reminder_create')
    assert.equal(reminder.schedule.dueAt, '2026-11-02T04:00:00.000Z');
  assert.match(reply.text, /Saved task: review the lease/);
  assert.match(reply.text, /2 November 2026/);
  assert.equal((reply.businessEvidence as { kind: string }).kind, 'personal');
  for (const stage of ['formatter', 'verifier']) {
    const body = JSON.parse(
      fake.requests.find((request) => request.stage === stage)!.messages[0]!.content,
    );
    assert.equal(body.personal_evidence[0].status, 'staged_not_committed');
    assert.deepEqual(body.evidence, []);
  }
});

test('literal task text is not rewritten or rejected as assistant stock phrasing', async () => {
  for (const taskText of ['review leverage ratios', 'Read the Great Question briefing']) {
    const h = harness();
    const instruction = `Add a task to ${taskText}.`;
    const fake = fakeModel([
      {
        name: 'personal_apply',
        args: {
          operations: [
            {
              kind: 'task_create',
              text: taskText,
              source: { messageId: 'member-1', quote: instruction },
            },
          ],
        },
      },
    ]);
    const reply = await h
      .assistant(fake.model)
      .prepare({ ...message, text: instruction }, signal(), {
        ...trusted,
        commandMessages: [
          { id: 'member-1', text: instruction, receivedAtMs: now, forwarded: false },
        ],
      });
    assert.equal(reply.trace.outcome, 'completed');
    assert.ok(reply.text.includes(`Saved task: ${taskText}`));
    assert.equal(h.applied.length, 1);
    assert.equal((h.applied[0]![0] as { text: string }).text, taskText);
    const reviews = fake.requests.filter((request) => request.stage === 'verifier');
    assert.equal(reviews.length, 1);
    const reviewed = JSON.parse(reviews[0]!.messages[0]!.content);
    assert.deepEqual(reviewed.presentation_issues, []);
    assert.equal(reviewed.personal_proposal[0].text, taskText);
    assert.ok(
      reviewed.answer.includes(taskText),
      'semantic review still sees the full literal request',
    );
  }
});

test('retrieved personal task labels retain literal wording without bypassing semantic review', async () => {
  const h = harness();
  const text = 'review leverage ratios';
  h.setList([
    {
      kind: 'task',
      id: 'literal-record',
      text,
      state: 'open',
      version: 1,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    },
  ]);
  const instruction = 'Show my tasks.';
  const context = {
    ...trusted,
    commandMessages: [{ id: 'member-1', text: instruction, receivedAtMs: now, forwarded: false }],
  };
  const fake = fakeModel([{ name: 'personal_list', args: { kind: 'task' } }]);
  const reply = await h
    .assistant(fake.model)
    .prepare({ ...message, text: instruction }, signal(), context);
  assert.equal(reply.trace.outcome, 'completed');
  assert.ok(reply.text.includes(text));
  const review = JSON.parse(
    fake.requests.find((request) => request.stage === 'verifier')!.messages[0]!.content,
  );
  assert.deepEqual(review.presentation_issues, []);
  assert.ok(review.answer.includes(text));
  assert.deepEqual(h.finalized, [['saved-selection']]);
  const rejected = harness();
  const invalid = await rejected
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }], [], false).model)
    .prepare(message, signal(), trusted);
  assert.equal(invalid.trace.outcome, 'unavailable');
  assert.equal(rejected.applied.length, 0);
});

test('committed recovery returns the durable receipt without any model invocation or another write', async () => {
  const h = harness();
  const before = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const after = await h.assistant(never).prepare(message, signal(), trusted);
  assert.equal(after.text, before.text);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(after.trace.stages, []);
});

test('a committed receipt is recovered before an expired model deadline, without renewing model work', async () => {
  const h = harness();
  await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  let checkpointBegins = 0;
  const checkpoints: AgentCheckpointStore = {
    async begin() {
      checkpointBegins++;
      return {
        metadata: {
          requestTimeMs: now,
          startedAtMs: Date.now() - 60000,
          deadlineAtMs: Date.now() - 1,
        },
        async read() {
          return undefined;
        },
        async save() {},
        async consume() {
          return true;
        },
        async policy() {
          return undefined;
        },
      };
    },
  };
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const make = (personalTools: PersonalToolService) =>
    new AssistantService(
      { model: 'offline-personal-fake', timeoutMs: 5000 },
      never,
      undefined,
      undefined,
      undefined,
      undefined,
      { personalTools, checkpoints },
    );
  const recovered = await make(h.service).prepare(message, signal(), trusted);
  assert.match(recovered.text, /Saved task/);
  assert.equal(checkpointBegins, 0);
  assert.equal(h.applied.length, 1);
  const empty = harness();
  const expired = await make(empty.service).prepare(message, signal(), trusted);
  assert.equal(expired.trace.failureCode, 'DEADLINE_EXCEEDED');
  assert.equal(checkpointBegins, 1);
  assert.equal(empty.applied.length, 0);
});

test('relative time is anchored to the command-bearing member rather than first batched member', async () => {
  const h = harness();
  const shifted = {
    ...trusted,
    commandMessages: [
      { id: 'unrelated', text: 'Good morning.', receivedAtMs: now - 86400000, forwarded: false },
      ...trusted.commandMessages!,
    ],
  };
  const run = (await h.service.open(shifted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  await run.finish(signal());
  const reminder = h.applied[0]![1]!;
  assert.equal(
    reminder.kind === 'reminder_create' && reminder.schedule.dueAt,
    '2026-11-02T04:00:00.000Z',
  );
});

test('a correction uses the later member clock while retaining exact user text from an earlier member', async () => {
  const h = harness();
  const correctedAt = now + 90000;
  const command = {
    ...trusted,
    commandMessages: [
      {
        id: 'first',
        text: 'Remind me in 20 minutes to call the owner.',
        receivedAtMs: now,
        forwarded: false,
      },
      {
        id: 'correction',
        text: 'Actually make that 40 minutes.',
        receivedAtMs: correctedAt,
        forwarded: false,
      },
    ],
  };
  const run = (await h.service.open(command, signal()))!;
  const proposal = {
    operations: [
      {
        kind: 'reminder_create',
        source: { messageId: 'correction', quote: 'Actually make that 40 minutes.' },
        text: 'call the owner',
        time: { afterMinutes: 40 },
      },
    ],
  };
  assert.equal((await run.execute('personal_apply', JSON.stringify(proposal), signal())).ok, true);
  await run.finish(signal());
  const saved = h.applied[0]![0]!;
  assert.equal(
    saved.kind === 'reminder_create' && saved.schedule.dueAt,
    new Date(correctedAt + 40 * 60000).toISOString(),
  );
  const forwarded = (await h.service.open(
    {
      ...command,
      commandMessages: command.commandMessages.map((member) =>
        member.id === 'first' ? { ...member, forwarded: true } : member,
      ),
    },
    signal(),
  ))!;
  assert.equal(
    (await forwarded.execute('personal_apply', JSON.stringify(proposal), signal())).code,
    'TEXT_MUST_BE_USER_AUTHORED',
  );
});

test('recurring lists show the next due date and snooze receipts retain the explicitly saved occurrence time', () => {
  const record: PersonalRecord = {
    kind: 'reminder',
    id: 'reminder',
    text: 'Review the pipeline',
    state: 'scheduled',
    version: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    schedule: {
      dueAt: '2026-10-01T03:30:00.000Z',
      timezone: 'Asia/Kolkata',
      recurrence: { frequency: 'daily' },
    },
    nextDueAt: '2026-10-04T03:30:00.000Z',
    occurrenceId: 'old',
    occurrenceState: 'sent',
    occurrenceDueAt: '2026-10-03T03:30:00.000Z',
  };
  const list = renderList('reminder', { records: [record], selectionId: 'list', nextCursor: null });
  assert.match(list, /next 4 October 2026/);
  assert.match(list, /last occurrence sent/);
  assert.doesNotMatch(list, /1 October 2026|3 October 2026/);
  const snoozed = {
    ...record,
    occurrenceState: 'pending',
    occurrenceDueAt: '2026-10-05T04:00:00.000Z',
  };
  const receipt = renderReceipt({ commandId: 'snooze-command', runId: 'run', records: [snoozed] });
  assert.match(receipt, /5 October 2026/);
  assert.doesNotMatch(receipt, /4 October 2026/);
  const snoozedList = renderList('reminder', {
    records: [snoozed],
    selectionId: 'list',
    nextCursor: null,
  });
  assert.match(snoozedList, /next 4 October 2026/);
  assert.match(snoozedList, /pending notification 5 October 2026/);
});

test('forwarded instructions, missing trusted metadata and unknown/group identities cannot open writes', async () => {
  const h = harness();
  assert.equal(
    await h.service.open({ ...trusted, commandMessages: undefined }, signal()),
    undefined,
  );
  assert.equal(
    await h.service.open({ ...trusted, checkpointLease: undefined }, signal()),
    undefined,
  );
  assert.equal(
    await h.service.open(
      {
        ...trusted,
        commandMessages: trusted.commandMessages!.map((member) => ({ ...member, forwarded: true })),
      },
      signal(),
    ),
    undefined,
  );
  assert.equal(
    await h.service.open({ ...trusted, key: { remoteJid: 'group@g.us' } }, signal()),
    undefined,
  );
  h.setIdentity(null);
  assert.equal(await h.service.open(trusted, signal()), undefined);
  assert.equal(h.applied.length, 0);
});

test('protected/copied text and omitted business conditions cannot be saved as personal text', async () => {
  for (const kind of ['copied', 'conditional'] as const) {
    const h = harness();
    const command =
      kind === 'conditional'
        ? {
            ...trusted,
            commandMessages: [
              {
                id: 'member-1',
                text: 'Remind me to review the lease if the deal still has no follow-up.',
                receivedAtMs: now,
                forwarded: false,
              },
            ],
          }
        : trusted;
    const run = (await h.service.open(command, signal()))!;
    const proposal =
      kind === 'copied'
        ? { kind: 'task_create', source, text: 'Private CRM figure: 42 crore' }
        : {
            kind: 'reminder_create',
            source: { messageId: 'member-1', quote: 'review the lease' },
            text: 'review the lease',
            time: { afterMinutes: 60 },
          };
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({ operations: [proposal] }),
      signal(),
    );
    assert.equal(output.ok, false);
    assert.equal(
      output.code,
      kind === 'copied' ? 'TEXT_MUST_BE_USER_AUTHORED' : 'CONDITIONAL_REMINDERS_UNAVAILABLE',
    );
    const reply = await run.finish(signal());
    assert.match(reply!.text, /couldn't save/);
    assert.equal(h.applied.length, 0);
  }
});

test('a revised proposal replaces the uncommitted batch and only the final verified proposal commits', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  const revision = await run.execute(
    'personal_apply',
    JSON.stringify({ operations: [batch.operations[0]] }),
    signal(),
  );
  assert.equal(revision.status, 'staged_not_committed');
  assert.equal(run.pendingOperations.length, 1);
  assert.equal(run.evidence.length, 1);
  await run.finish(signal());
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0]!.length, 1);
});

test('rejected review, storage failure and abort do not produce a successful mutation acknowledgement', async () => {
  const h = harness();
  const rejected = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }], [], false).model)
    .prepare(message, signal(), trusted);
  assert.equal(h.applied.length, 0);
  assert.doesNotMatch(rejected.text, /Saved task/);
  h.failApply();
  const unavailable = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  assert.equal(unavailable.trace.outcome, 'unavailable');
  assert.doesNotMatch(unavailable.text, /Saved task/);
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  const aborted = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(run.finish(aborted), /cancelled/);
  assert.equal(h.applied.length, 0);
});

test('list presentation is deterministic and finalized only after successful review', async () => {
  const h = harness();
  const fake = fakeModel([{ name: 'personal_list', args: { kind: 'task' } }]);
  const reply = await h
    .assistant(fake.model)
    .prepare({ ...message, text: 'Show my tasks.' }, signal(), {
      ...trusted,
      commandMessages: [
        { id: 'member-1', text: 'Show my tasks.', receivedAtMs: now, forwarded: false },
      ],
    });
  assert.match(reply.text, /^Your tasks \(this page\):\n1\. Check the quote \[open\]/);
  assert.deepEqual(h.finalized, [['saved-selection']]);
  assert.equal(h.applied.length, 0);
  const rejected = harness();
  await rejected
    .assistant(fakeModel([{ name: 'personal_list', args: { kind: 'task' } }], [], false).model)
    .prepare(message, signal(), trusted);
  assert.deepEqual(rejected.finalized, []);
});

test('a mixed personal receipt retains its transaction-reconciled list and selection on recovery', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_list', JSON.stringify({ kind: 'task' }), signal());
  await run.execute(
    'personal_apply',
    JSON.stringify({ operations: [batch.operations[0]] }),
    signal(),
  );
  const savedList = {
    selectionId: 'saved-selection',
    nextCursor: null,
    records: [
      {
        kind: 'task' as const,
        id: 'updated-record',
        text: 'Authoritative refreshed task',
        state: 'open',
        version: 5,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
  };
  h.setReceiptLists([{ kind: 'task', result: savedList }]);
  assert.match(run.preview()!, /Pending personal changes/);
  assert.match(run.preview()!, /Your tasks/);
  const reply = (await run.finish(signal()))!;
  assert.match(reply.text, /Saved task: review the lease/);
  assert.match(reply.text, /1\. Authoritative refreshed task/);
  assert.doesNotMatch(reply.text, /Check the quote/);
  assert.equal(reply.delivery.commandId, 'saved-command');
  assert.equal(reply.delivery.selectionId, 'saved-selection');
  assert.deepEqual(h.appliedSelections, [['saved-selection']]);
  assert.deepEqual(h.finalized, [], 'mutation transaction owns selection finalization');
  const recovered = (await h.service.open(trusted, signal()))!;
  const replay = (await recovered.recover(signal()))!;
  assert.deepEqual(
    { ...replay, delivery: { ...replay.delivery, history: reply.delivery.history } },
    reply,
  );
  assert.equal(replay.delivery.history?.activity[0]?.phase, 'recovery');
  assert.equal(h.applied.length, 1);
});

test('a rejected staged mutation still presents and finalizes an already requested personal list', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_list', JSON.stringify({ kind: 'task' }), signal());
  await run.execute(
    'personal_apply',
    JSON.stringify({ operations: [{ kind: 'task_create', source, text: 'fabricated text' }] }),
    signal(),
  );
  const reply = (await run.finish(signal()))!;
  assert.match(reply.text, /couldn't save/);
  assert.match(reply.text, /1\. Check the quote/);
  assert.deepEqual(h.finalized, [['saved-selection']]);
  assert.equal(h.applied.length, 0);
});

test('unrelated conditional read requests do not block an ordinary reminder', async () => {
  for (const text of [
    'Remind me in 20 minutes to call Acme. Also check if Acme has an open deal.',
    'Remind me in 20 minutes to call Acme and check if Acme has an open deal.',
    'Remind me in 20 minutes to call Acme; please check if Acme has an open deal.',
    'Remind me in 20 minutes to call Acme. Also tell me if the warehouse is available.',
    'Check if Acme has an open deal. Also remind me in 20 minutes to call Acme.',
  ]) {
    const h = harness();
    const run = (await h.service.open(
      { ...trusted, commandMessages: [{ id: 'm', text, receivedAtMs: now, forwarded: false }] },
      signal(),
    ))!;
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [
          {
            kind: 'reminder_create',
            source: { messageId: 'm', quote: text },
            text: 'call Acme',
            time: { afterMinutes: 20 },
          },
        ],
      }),
      signal(),
    );
    assert.equal(output.ok, true, text);
    assert.match((await run.finish(signal()))!.text, /Saved reminder: call Acme/);
  }
});

test('separate-sentence conditions, shortened source quotes, and conditions hidden in reminder text stay blocked', async () => {
  for (const text of [
    'Remind me in 20 minutes to call Acme if the deal is open.',
    'Remind me in 20 minutes to call Acme. Only if the deal is open.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open before sending the reminder.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open; only then send it.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open, and only then do it.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open and then do that.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open, otherwise skip it.',
    'Remind me in 20 minutes to call Acme. Also check if the deal is open before proceeding with it.',
  ]) {
    const h = harness();
    const run = (await h.service.open(
      { ...trusted, commandMessages: [{ id: 'm', text, receivedAtMs: now, forwarded: false }] },
      signal(),
    ))!;
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [
          {
            kind: 'reminder_create',
            source: { messageId: 'm', quote: 'Remind me in 20 minutes to call Acme' },
            text: text.startsWith('Remind me in 20 minutes to call Acme if')
              ? 'call Acme if the deal is open'
              : 'call Acme',
            time: { afterMinutes: 20 },
          },
        ],
      }),
      signal(),
    );
    assert.equal(output.code, 'CONDITIONAL_REMINDERS_UNAVAILABLE', text);
    assert.equal(h.applied.length, 0);
  }
});

test('a model cannot turn a condition into content by copying an unrelated check-if clause', async () => {
  for (const text of [
    'Check if Acme signed before reminding me. Remind me in 20 minutes to call Acme.',
    'Remind me in 20 minutes to check if Acme signed before reminding me.',
  ]) {
    const h = harness();
    const run = (await h.service.open(
      { ...trusted, commandMessages: [{ id: 'm', text, receivedAtMs: now, forwarded: false }] },
      signal(),
    ))!;
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [
          {
            kind: 'reminder_create',
            source: { messageId: 'm', quote: text },
            text: text.startsWith('Check')
              ? 'Check if Acme signed before reminding me'
              : 'check if Acme signed before reminding me',
            time: { afterMinutes: 20 },
          },
        ],
      }),
      signal(),
    );
    assert.equal(output.code, 'CONDITIONAL_REMINDERS_UNAVAILABLE');
    assert.equal(h.applied.length, 0);
  }
});

test('ordinal changes resolve the previous presented selection and use its observed version', async () => {
  const h = harness();
  const text = 'Mark the second task done.';
  const command = {
    ...trusted,
    commandMessages: [{ id: 'member-1', text, receivedAtMs: now, forwarded: false }],
  };
  const run = (await h.service.open(command, signal()))!;
  await run.execute(
    'personal_apply',
    JSON.stringify({
      operations: [
        {
          kind: 'task_complete',
          source: { messageId: 'member-1', quote: text },
          target: { selectionId: 'latest', ordinal: 2 },
        },
      ],
    }),
    signal(),
  );
  await run.finish(signal());
  assert.deepEqual(h.selected[0]!.slice(1), ['task', 'latest', 2]);
  assert.deepEqual(h.applied[0], [
    { kind: 'task_complete', id: 'original-second', expectedVersion: 3 },
  ]);
});

test('identity change blocks both commit and private delivery, including a reassigned phone', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  h.setIdentity({ ...actor, employeeId: 8 });
  await assert.rejects(run.finish(signal()), SchedulingError);
  assert.equal(h.applied.length, 0);
  assert.equal(
    await h.service.canDeliver(
      trusted.key,
      {
        kind: 'personal',
        version: 1,
        employeeId: 7,
        phoneE164: actor.phoneE164,
        runId: trusted.runId,
      },
      signal(),
    ),
    false,
  );
  h.setIdentity(actor);
  assert.equal(
    await h.service.canDeliver(
      trusted.key,
      {
        kind: 'personal',
        version: 1,
        employeeId: 7,
        phoneE164: actor.phoneE164,
        runId: trusted.runId,
      },
      signal(),
    ),
    true,
  );
});

test('identity failure after committed mutation never claims nothing changed and receipt remains recoverable', async () => {
  const h = harness();
  h.onCommit(() => h.setIdentity(null));
  const reply = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  assert.equal(h.applied.length, 1);
  assert.equal(reply.trace.outcome, 'unavailable');
  assert.doesNotMatch(reply.text, /nothing.*changed|not.*saved|Saved task/);
  h.setIdentity(actor);
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const recovered = await h.assistant(never).prepare(message, signal(), trusted);
  assert.match(recovered.text, /Saved task: review the lease/);
  assert.equal(h.applied.length, 1);
});

test('plain when in reminder content and conditional cancellation are not business-condition creation', async () => {
  const h = harness();
  for (const [text, operation] of [
    [
      'Remind me in one hour to ask when the shipment arrives.',
      {
        kind: 'reminder_create',
        text: 'ask when the shipment arrives',
        time: { afterMinutes: 60 },
      },
    ],
    [
      'Cancel that reminder if it exists.',
      { kind: 'reminder_cancel', target: { id: 'existing', expectedVersion: 1 } },
    ],
  ] as const) {
    const run = (await h.service.open(
      {
        ...trusted,
        commandMessages: [{ id: 'member-1', text, receivedAtMs: now, forwarded: false }],
      },
      signal(),
    ))!;
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [{ ...operation, source: { messageId: 'member-1', quote: text } }],
      }),
      signal(),
    );
    assert.equal(output.ok, true);
  }
});

test('a direct clarification recalls earlier owned text while current source controls authorization and time', async () => {
  const h = harness();
  h.setRecall({
    kind: 'instructions',
    members: [
      {
        runId: 'earlier-run',
        id: 'earlier-message',
        text: 'Remind me to call the owner.',
        receivedAtMs: now - 60000,
      },
    ],
  });
  const later = {
    ...trusted,
    commandMessages: [
      { id: 'current-message', text: 'In 40 minutes please.', receivedAtMs: now, forwarded: false },
    ],
  };
  const run = (await h.service.open(later, signal()))!;
  await run.execute('personal_recall', JSON.stringify({ kind: 'instructions' }), signal());
  const proposal = {
    kind: 'reminder_create',
    source: { messageId: 'current-message', quote: 'In 40 minutes please.' },
    text: 'call the owner',
    time: { afterMinutes: 40 },
  };
  assert.equal(
    (await run.execute('personal_apply', JSON.stringify({ operations: [proposal] }), signal())).ok,
    true,
  );
  await run.finish(signal());
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.applied[0], [
    {
      kind: 'reminder_create',
      text: 'call the owner',
      schedule: { dueAt: '2026-10-03T04:40:00.000Z', timezone: 'Asia/Kolkata' },
      sourceMessageId: 'current-message',
    },
  ]);
  const forged = (await h.service.open(later, signal()))!;
  await forged.execute('personal_recall', JSON.stringify({ kind: 'instructions' }), signal());
  const result = await forged.execute(
    'personal_apply',
    JSON.stringify({
      operations: [
        {
          ...proposal,
          source: { messageId: 'earlier-message', quote: 'Remind me to call the owner.' },
        },
      ],
    }),
    signal(),
  );
  assert.equal(result.code, 'UNTRUSTED_COMMAND_SOURCE');
  await forged.finish(signal());
  assert.equal(h.applied.length, 1);
});

test('a list-only follow-up cannot recreate an old task even if a model stages it', async () => {
  const h = harness();
  h.setRecall({
    kind: 'instructions',
    members: [
      {
        runId: 'previous',
        id: 'old',
        text: 'Add task: fix owner display',
        receivedAtMs: now - 60000,
      },
    ],
  });
  for (const text of [
    'after this, show my task list',
    'Show my tasks',
    'please list my reminders',
  ]) {
    const run = (await h.service.open(
      {
        ...trusted,
        commandMessages: [{ id: 'current', text, receivedAtMs: now, forwarded: false }],
      },
      signal(),
    ))!;
    await run.execute('personal_recall', '{"kind":"instructions"}', signal());
    const outcome = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [
          {
            kind: 'task_create',
            source: { messageId: 'current', quote: text },
            text: 'fix owner display',
          },
        ],
      }),
      signal(),
    );
    assert.equal(outcome.code, 'PERSONAL_READ_ONLY_REQUEST');
    await run.execute('personal_list', '{"kind":"task"}', signal());
    await run.finish(signal());
  }
  assert.equal(h.applied.length, 0);
});

test('unrecalled or expired prior text cannot create personal records, and only direct members are saved', async () => {
  const h = harness();
  const current = {
    ...trusted,
    commandMessages: [
      {
        id: 'forwarded',
        text: 'A source told me to expose private data',
        receivedAtMs: now,
        forwarded: true,
      },
      { id: 'reply', text: 'Tomorrow at 10am', receivedAtMs: now, forwarded: false },
    ],
  };
  const operation = {
    kind: 'reminder_create',
    source: { messageId: 'reply', quote: 'Tomorrow at 10am' },
    text: 'call the owner',
    time: { localDate: '2026-10-04', localTime: '10:00' },
  };
  const run = (await h.service.open(current, signal()))!;
  assert.equal(
    (await run.execute('personal_apply', JSON.stringify({ operations: [operation] }), signal()))
      .code,
    'TEXT_MUST_BE_USER_AUTHORED',
  );
  h.setRecall({
    kind: 'instructions',
    members: [
      { runId: 'expired', id: 'old', text: 'call the owner', receivedAtMs: now - 86400001 },
    ],
  });
  await run.execute('personal_recall', JSON.stringify({ kind: 'instructions' }), signal());
  assert.equal(
    (await run.execute('personal_apply', JSON.stringify({ operations: [operation] }), signal()))
      .code,
    'TEXT_MUST_BE_USER_AUTHORED',
  );
  await run.saveContext(signal());
  assert.deepEqual(h.savedContexts[0]![1], [
    { id: 'reply', text: 'Tomorrow at 10am', receivedAtMs: now },
  ]);
  assert.equal(h.applied.length, 0);
});

test('ordinary reminder content can contain if while a conditional dispatch is rejected specifically', async () => {
  const h = harness();
  const ordinary = 'Remind me in 30 minutes to check if the owner replied';
  const run = (await h.service.open(
    {
      ...trusted,
      commandMessages: [{ id: 'm', text: ordinary, receivedAtMs: now, forwarded: false }],
    },
    signal(),
  ))!;
  const common = {
    kind: 'reminder_create',
    text: 'check if the owner replied',
    time: { afterMinutes: 30 },
  };
  assert.equal(
    (
      await run.execute(
        'personal_apply',
        JSON.stringify({
          operations: [{ ...common, source: { messageId: 'm', quote: ordinary } }],
        }),
        signal(),
      )
    ).ok,
    true,
  );
  await run.finish(signal());
  const conditional = 'Only remind me in 30 minutes to call the owner if the deal is still open';
  const rejected = (await h.service.open(
    {
      ...trusted,
      commandMessages: [{ id: 'm', text: conditional, receivedAtMs: now, forwarded: false }],
    },
    signal(),
  ))!;
  const output = await rejected.execute(
    'personal_apply',
    JSON.stringify({
      operations: [
        { ...common, text: 'call the owner', source: { messageId: 'm', quote: conditional } },
      ],
    }),
    signal(),
  );
  assert.equal(output.code, 'CONDITIONAL_REMINDERS_UNAVAILABLE');
  assert.match((await rejected.finish(signal()))!.text, /can't check a business condition/);
  assert.equal(h.applied.length, 1);
});

test('an invalid revised proposal clears the earlier stage rather than committing obsolete work', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  const bad = await run.execute(
    'personal_apply',
    JSON.stringify({
      operations: [{ kind: 'task_create', source, text: 'Invented private source content' }],
    }),
    signal(),
  );
  assert.equal(bad.code, 'TEXT_MUST_BE_USER_AUTHORED');
  assert.deepEqual(run.pendingOperations, []);
  assert.equal(
    run.evidence.some((entry) => (entry as { status?: string }).status === 'staged_not_committed'),
    false,
  );
  await run.finish(signal());
  assert.equal(h.applied.length, 0);
});

test('list continuation appends the prior snapshot and a later show-more requests the delivered cursor', async () => {
  const h = harness();
  const record = (id: string): PersonalRecord => ({
    kind: 'task',
    id,
    text: id,
    state: 'done',
    version: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  const first = record('first page task'),
    second = record('second page task');
  h.setPages([
    { records: [first], selectionId: 'page-one', nextCursor: 'next-page' },
    { records: [first, second], selectionId: 'combined-pages', nextCursor: null },
  ]);
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_list', JSON.stringify({ kind: 'task', state: 'done' }), signal());
  await run.execute(
    'personal_list',
    JSON.stringify({ kind: 'task', cursor: 'next-page' }),
    signal(),
  );
  assert.deepEqual(h.listCalls[1]![3], {
    cursor: 'next-page',
    state: 'done',
    limit: 10,
    appendSelectionId: 'page-one',
  });
  const reply = await run.finish(signal());
  assert.match(reply!.text, /1\. first page task/);
  assert.match(reply!.text, /2\. second page task/);
  assert.deepEqual(h.finalized, [['combined-pages']]);
  const later = (await h.service.open({ ...trusted, runId: 'later-run' }, signal()))!;
  await later.execute(
    'personal_list',
    JSON.stringify({ kind: 'task', continuation: 'latest' }),
    signal(),
  );
  assert.deepEqual(h.listCalls[2]![3], { continuation: 'latest', limit: 10 });
});

test('latest delivered reminder recall supplies the exact owned occurrence for snooze', async () => {
  const h = harness();
  h.setRecall({
    kind: 'reminder',
    records: [
      {
        kind: 'reminder',
        id: 'delivered-reminder',
        text: 'Call owner',
        state: 'completed',
        version: 2,
        occurrenceId: 'delivered-occurrence',
        occurrenceState: 'sent',
        occurrenceDueAt: new Date(now - 60000).toISOString(),
        createdAt: new Date(now - 3600000).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
  });
  const text = 'Snooze that for 30 minutes';
  const run = (await h.service.open(
    { ...trusted, commandMessages: [{ id: 'm', text, receivedAtMs: now, forwarded: false }] },
    signal(),
  ))!;
  const recalled = await run.execute(
    'personal_recall',
    JSON.stringify({ kind: 'reminder' }),
    signal(),
  );
  assert.equal(recalled.ok, true);
  const output = await run.execute(
    'personal_apply',
    JSON.stringify({
      operations: [
        {
          kind: 'reminder_snooze',
          source: { messageId: 'm', quote: text },
          target: { id: 'delivered-reminder', expectedVersion: 2 },
          occurrenceId: 'delivered-occurrence',
          time: { afterMinutes: 30 },
        },
      ],
    }),
    signal(),
  );
  assert.equal(output.ok, true);
  await run.finish(signal());
  assert.deepEqual(h.applied[0], [
    {
      kind: 'reminder_snooze',
      id: 'delivered-reminder',
      expectedVersion: 2,
      occurrenceId: 'delivered-occurrence',
      dueAt: '2026-10-03T04:30:00.000Z',
    },
  ]);
});

test('stored delivery outcome remains visible after reminder occurrence history is pruned', () => {
  const text = renderList('reminder', {
    selectionId: 'finished-selection',
    nextCursor: null,
    records: [
      {
        kind: 'reminder',
        id: 'finished',
        text: 'Call owner',
        state: 'completed',
        version: 1,
        lastOutcome: 'missed',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
  });
  assert.match(text, /last delivery missed/);
});
